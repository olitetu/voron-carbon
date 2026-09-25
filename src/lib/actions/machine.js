// MACHINE page actions — services, host power, the update manager, config-file writes and the
// endstop query. Contract: CONTRACT.md "machine /machine".
//
//   serviceAction(name, 'restart'|'start'|'stop') → machine.services.{restart,start,stop}
//   klipperRestart()    → printer.restart            (host restart — re-reads every config file)
//   firmwareRestart()   → printer.firmware_restart
//   moonrakerRestart()  → machine.services.restart moonraker  (drops this UI's socket; it reconnects itself)
//   hostReboot() / hostShutdown() → machine.reboot / machine.shutdown
//   estop()             → printer.emergency_stop     (never refused — it is the emergency button)
//   refreshUpdates()    → machine.update.refresh     (slow + GitHub rate limited: user-triggered only)
//   runUpdate(name) / updateAll() / recoverUpdate(name, hard)
//   saveConfig(path, text, {restart}) → server.files.upload of the edited text back into root "config"
//   queryEndstops()     → printer.query_endstops.status, resolved to the status object or null
//
// It also owns the READING of machine.update.status that the desktop MACHINE page, the touchscreen
// UPDATES and SYSTEM screens and the touchscreen's MORE tile all do (updateOrder, behindOf,
// updateSummary, repoRecovery, recoverText, …), and the MCU link thresholds both MCU panels use. One
// copy, because the surfaces disagreeing about "up to date" or about when a re-clone is safe is the bug.
//
// One guard rail, applied in one place: everything that would interrupt a running print — host
// power, klipper/firmware restart, EVERY update (they restart the service they patched), SAVE &
// RESTART, and the endstop query (it flushes the move queue, which shows up as a blob in the part)
// — is refused while print_stats is printing or paused, and says why in the console. Moonraker
// refuses updates mid-print too, but only after the user has already confirmed a scary dialog.
// The one exemption is a Klippy that has shut down or dropped: see isPrintActive().
//
// The UI confirms first; these functions run the real command as soon as they are called, log their
// intent, log errors instead of throwing, and resolve true only when Moonraker accepted the command.
import { num } from "../spools.js";

/** machine.update.* has a dedicated endpoint for these three; everything else goes through `client`. */
const UPDATE_ENDPOINT = { system: "updateSystem", klipper: "updateKlipper", moonraker: "updateMoonraker" };

/** Restarting or stopping these takes Klipper — and any running print — down with it. */
export const KLIPPER_SERVICES = ["klipper", "klipper-mcu"];

/** Klippy states in which nothing can still be printing, whatever print_stats says. */
const KLIPPY_DOWN = ["shutdown", "error", "disconnected"];

/**
 * Is a print actually in progress? print_stats keeps reporting the state Klipper died IN, so after a
 * shutdown it still reads "printing" — and a guard trusting that would lock out FIRMWARE_RESTART,
 * the one command that recovers from a shutdown. The job is already lost by then; let the user out.
 * Only the states that positively mean "Klipper is gone" unlock: "unknown" and "startup" still guard.
 */
export function isPrintActive(state) {
  const s = state || {};
  if (KLIPPY_DOWN.includes(String(s.klippy || "unknown"))) return false;
  const raw = s.raw || {};
  const ps = String((raw.print_stats || {}).state || "standby").toLowerCase();
  return ps === "printing" || ps === "paused" || !!(raw.pause_resume || {}).is_paused;
}

/** vcgencmd's throttled bitfield. Bits 0-3 are happening NOW, bits 16-19 are "has happened since boot". */
const THROTTLE_BITS = [
  [0, "Under-voltage"], [1, "ARM frequency capped"], [2, "Currently throttled"], [3, "Soft temperature limit"],
  [16, "Under-voltage occurred"], [17, "Frequency capping occurred"], [18, "Throttling occurred"], [19, "Temperature limit occurred"],
];

/**
 * Split `procStats.throttled_state` into what is wrong right now and what merely happened earlier.
 * The distinction is the whole point on a Pi: a live under-voltage bit means the print is at risk,
 * the sticky one only means the PSU browned out at some point since boot.
 */
export function throttleSummary(ts) {
  const bits = ts && Number.isFinite(ts.bits) ? ts.bits : 0;
  const now = [], past = [];
  for (const [b, label] of THROTTLE_BITS) if (bits & (1 << b)) (b < 16 ? now : past).push(label);
  // Non-Pi hosts report no bitfield at all; Moonraker still ships pre-worded flags, so fall back to those.
  if (!now.length && !past.length && ts && Array.isArray(ts.flags)) {
    for (const f of ts.flags) (/^previously/i.test(f) ? past : now).push(f);
  }
  return { bits, now, past, clean: !now.length && !past.length, known: !!ts };
}

/** seconds → "2d 23h" / "4h 07m" / "12m". fmtDur() would render three days as "71:51:13". */
export function fmtUptime(s) {
  if (!Number.isFinite(s) || s < 0) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

// ---- MCU link statistics ----------------------------------------------------------------
/** s — the MCU stats period: `mcu_awake` is seconds awake per this window (idle here: ~0.002 s of 5). */
export const KLIPPER_STATS_INTERVAL = 5;

// bytes_retransmit is a BYTE count, not a packet count, and every link re-sends a handful of bytes
// just establishing itself (measured on this printer with nothing wrong with it: 9 B on `mcu`, 9 B on
// `mcu mmu`, 0 elsewhere). Warning at >0 therefore painted a permanent yellow "18 B RETRANSMITTED"
// header on a healthy machine — a crying-wolf alarm. Kilobytes are the point at which a CAN/USB link
// is actually losing data, which is what the per-MCU note already said.
export const RT_WARN = 1024, RT_BAD = 65536;

// ---- update manager: reading machine.update.status ----------------------------------------
// Facts from Moonraker's source at the installed commit (9bceead, components/update_manager/git_deploy.py):
//   · is_valid:false is NOT proof of damage. GitDeploy._update_repo_state() sets _is_valid = False BEFORE
//     the fetch, sets it back only if refresh_repo_state() succeeds, and persists the flag. One failed check
//     (GitHub down, DNS, a wifi blip) leaves a healthy checkout reading INVALID, with no dirty / diverged /
//     detached / corrupt flag, until the next successful REFRESH.
//   · GitRepo.is_damaged() (not a git repo, or `corrupt`) needs a re-clone; has_recoverable_errors()
//     (dirty, diverged, detached) needs only a reset. `corrupt`, `is_dirty` and `detached` are status
//     fields; "diverged" is not — it exists only as the anomaly line "Repo has diverged from remote"
//     (report_anomalies defaults on, and this printer's status carries anomalies).
//   · RECOVER, soft: `git checkout -- .`, check out the primary branch, `git reset --hard` to the current
//     commit if it is an ancestor of <remote>/<primary> (get_recovery_ref), else to that remote ref.
//     Local edits to TRACKED files are lost; untracked files stay.
//     RECOVER, hard: clone into a backup dir, rmtree the checkout, move the clone in. Every untracked file goes.
//   · `anomalies` lists untracked files from `git status --porcelain`, kept only for *.py/*.c/*.cpp
//     (SRC_EXTS), so a directory is never listed — and a corrupt repo may not answer `git status` at all.
//
// HAPPY HARE LIVES UNTRACKED INSIDE THE KLIPPER AND MOONRAKER CHECKOUTS on this printer (live anomalies,
// 2026-09-23: seven klippy/extras/mmu_*.py, and moonraker/components/mmu_server.py). Its core is the
// klippy/extras/mmu/ package, which Moonraker never names: HH v3.4.2's mmu.py imports `from ..homing`.
// A hard recover of either repo deletes all of it; Klipper then cannot get past this printer's [mmu]
// config and Moonraker stops loading mmu_server. Hence the rule every surface follows (repoRecovery):
// the re-clone is offered up front only when Moonraker says `corrupt`, otherwise only after Moonraker has
// actually run a soft recovery of that repo and it still reads broken (failedRecovery).

/** Moonraker orders version_info by config order; pin the two that matter to the top, system last. */
export function updateOrder(a, b) {
  const rank = n => (n === "klipper" ? 0 : n === "moonraker" ? 1 : n === "system" ? 3 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Moonraker writes "?" for a version it could not determine — rate limited, offline, or an invalid repo. */
export const unknownVersion = v => !v || v === "?";

/**
 * How far behind a component is, in whatever unit it counts in (commits, or apt packages).
 * null = Moonraker does not know, which is NOT the same as "up to date":
 *   · a `web` client whose remote version came back "?" used to compare "v2.17.0" against "?", conclude
 *     1 behind, and offer an UPDATE whose confirm read "Update mainsail to ?";
 *   · a git repo whose remote_version is "?" still reports commits_behind_count 0 (reproduced on
 *     crowsnest), so it is tested before the count — otherwise the row read UP TO DATE next to "unknown";
 *   · otherwise a git repo's count is the answer: version strings that merely differ can mean local
 *     commits AHEAD of the remote, with nothing to pull. `web` clients count nothing; the strings decide.
 */
export function behindOf(v) {
  if (!v) return null;
  if (v.configured_type === "system") return num(v.package_count) || 0;
  if (v.configured_type === "git_repo" && unknownVersion(v.remote_version)) return null;
  const c = num(v.commits_behind_count);
  if (c !== null) return c;
  if (unknownVersion(v.version) || unknownVersion(v.remote_version)) return null;
  return v.version !== v.remote_version ? 1 : 0;
}

/**
 * Is there a list behind the BEHIND badge? `system` has package_list and a git repo has
 * commits_behind; a `web` client has neither — its "1" is "an update exists", not one commit, and
 * opening it produced a panel headed "COMMITS BEHIND" apologising that nothing was cached.
 */
export const canExpand = v => v.configured_type === "system" || v.configured_type === "git_repo" || Array.isArray(v.commits_behind);

/**
 * The header counts, in two units that must not be added together: `pending` components (git repos,
 * web clients) that are behind, and apt `packages`. Summing them read "103 pending" for 5 components
 * and 98 packages. `unknown` counts the components Moonraker could not check — not "all current".
 */
export function updateSummary(status) {
  const vi = (status && status.version_info) || {};
  const all = Object.values(vi).filter(Boolean);
  const comps = all.filter(v => v.configured_type !== "system").map(behindOf);
  const sys = vi.system || all.find(v => v.configured_type === "system");
  return {
    pending: comps.filter(b => b > 0).length,
    unknown: comps.filter(b => b === null).length,
    packages: sys ? behindOf(sys) : null,
  };
}

/** Paths out of a Moonraker note that embeds a Python list: "Repo has untracked source files: ['a.py', 'b.py']". */
function pathsIn(lines, re) {
  const hit = [].concat(lines || []).map(String).find(l => re.test(l));
  return hit ? Array.from(hit.matchAll(/'([^']+)'/g), m => m[1]) : [];
}
/** Untracked source files Moonraker lists for a git repo (only *.py/*.c/*.cpp — see above). */
export const untrackedFiles = v => pathsIn(v && v.anomalies, /untracked source files/i);
/** Modified tracked files, from "Repo is dirty.  Detected the following modified files: [...]". */
export const modifiedFiles = v => pathsIn(v && v.warnings, /modified files/i);
/** Happy Hare names every file it installs mmu_*. */
export const isHappyHareFile = p => /(^|\/)mmu_/.test(String(p));
const base = p => String(p).split("/").pop();

/** Where Happy Hare sits untracked on THIS printer, including the mmu/ package Moonraker never lists.
 *  Used when a damaged checkout reports no untracked list of its own: an empty list is not "no HH here". */
export const HH_HOME = {
  klipper: "klippy/extras/mmu_*.py and the klippy/extras/mmu package, plus Cartographer's idm.py, cartographer.py and scanner.py links (hidden by .git/info/exclude)",
  moonraker: "moonraker/components/mmu_server.py",
};

/** What each UPDATE / RECOVER restarts: managed_services in this printer's moonraker.conf, read 2026-09-23.
 *  The status does not report it; an unknown name gets generic words. */
const RESTARTS = {
  klipper: "Klipper restarts — heaters off, axes unhomed",
  moonraker: "Moonraker restarts — the connection drops and reconnects by itself",
  // managed_services STARTS the unit even though the kiosk cutover left it disabled, and Conflicts= then
  // stops carbon-kiosk. Every UPDATE or RECOVER of KlipperScreen hands it the panel.
  KlipperScreen: "KlipperScreen.service restarts. It STARTS even though it is disabled and takes the 7\" panel from Carbon (Conflicts=). Bring Carbon back: sudo systemctl reset-failed carbon-kiosk; sudo systemctl enable --now carbon-kiosk && sudo systemctl disable KlipperScreen",
  "happy-hare": "Klipper restarts — heaters off, axes unhomed",
  "Klipper-Adaptive-Meshing-Purging": "Klipper restarts — heaters off, axes unhomed",
  cartographer: "Klipper restarts — heaters off, axes unhomed",
  belay: "Klipper restarts — heaters off, axes unhomed",
  crowsnest: "crowsnest restarts — the camera stream drops for a moment",
  sonar: "sonar (the wifi keepalive) restarts",
  mainsail: "nothing restarts — Moonraker swaps Mainsail's web files",
  system: "Moonraker runs apt; nothing is restarted for you",
};
export const restartOf = name => RESTARTS[name] || "Moonraker restarts the service this component manages";

/**
 * What a component's repo state calls for. `tried` = Moonraker has already run a soft recovery of it and
 * it still reads broken (see failedRecovery). `soft` / `hard` are the RECOVER buttons to offer:
 *   · corrupt           -> hard only (a reset cannot repair it);
 *   · dirty / diverged / detached -> soft; hard too once a soft recovery has failed;
 *   · bare is_valid:false (`unverified`) -> soft, with REFRESH advised first (a failed fetch leaves this).
 * The re-clone is never the first thing offered for a repo Moonraker has not called corrupt.
 */
export function repoRecovery(v, tried = false) {
  const r = v || {};
  const git = r.configured_type === "git_repo";
  const diverged = [].concat(r.anomalies || [], r.warnings || []).map(String).some(n => /diverged/i.test(n));
  const broken = !!(r.is_dirty || r.corrupt || r.is_valid === false);
  const resettable = !!(r.is_dirty || diverged || r.detached);
  const needsHard = git && !!r.corrupt;
  const unverified = git && broken && !resettable && !r.corrupt;
  const recover = git && broken;
  return {
    git, broken, diverged, resettable, needsHard, unverified,
    noClone: unknownVersion(r.recovery_url),   // Moonraker aborts a clone from "?"
    soft: recover && !needsHard,
    hard: recover && (needsHard || !!tried),
  };
}

/** The flags worth showing, most specific first (every one of them also reads is_valid:false, so a
 *  badge showing only the first one must not say INVALID for a dirty repo). [label, "err" | "warn"]. */
export function repoFlags(v) {
  const r = v || {}, rec = repoRecovery(r), out = [];
  if (r.corrupt) out.push(["CORRUPT", "err"]);
  if (r.is_dirty) out.push(["DIRTY", "warn"]);
  if (r.detached) out.push(["DETACHED", "warn"]);
  if (rec.diverged) out.push(["DIVERGED", "warn"]);
  if (r.is_valid === false) out.push(["INVALID", "err"]);
  if (r.channel_invalid) out.push(["BAD CHANNEL", "err"]);
  return out;
}

/**
 * The repo a notify_update_response says Moonraker just failed to recover, or null. `application` is
 * "recover_<name>" only once _handle_repo_recovery got past its refusals (printing, unknown updater) and
 * really ran GitDeploy.recover(); success ends on "Reinstall Complete", a failure on the error text with
 * complete:true. So this — not the RPC's outcome, which also fails on a dropped socket or a 503 — is what
 * proves a soft recovery was attempted.
 */
export function failedRecovery(u) {
  if (!u || !u.complete) return null;
  const app = String(u.application || "");
  if (!/^recover_/.test(app) || /reinstall complete/i.test(String(u.message || ""))) return null;
  return app.slice("recover_".length) || null;
}

/** Notes about a broken repo's recovery and Happy Hare's files in it, as [kind, text], kind err | warn | off. */
export function recoveryNotes(name, v, tried = false) {
  const rec = repoRecovery(v, tried), out = [];
  const untracked = untrackedFiles(v), hh = untracked.filter(isHappyHareFile);
  if (rec.git && rec.broken) {
    if (rec.needsHard) out.push(["err", "Moonraker reports this repo corrupt. Only a re-clone (HARD RECOVER) repairs that, and a re-clone deletes every untracked file in the checkout."]);
    else if (rec.unverified) out.push(["warn", "Moonraker marks this repo invalid but reports nothing a reset would fix — no local edits, no divergence, no detached HEAD, not corrupt. A failed check leaves exactly this (the flag is cleared before the fetch and set again only if the fetch works), so try REFRESH first: it re-validates without touching the checkout. RECOVER (a reset that keeps untracked files) is the next step."]);
    else out.push(["err", "Moonraker refuses to UPDATE a modified or invalid repo, so RECOVER comes first. A reset keeps untracked files; a re-clone deletes them."]);
    if (tried && !rec.needsHard) out.push(["err", "Moonraker already ran a reset of this repo and it still reads broken, so HARD RECOVER (a re-clone) is offered too."]);
  }
  if (hh.length) {
    const whose = hh.length === untracked.length ? "These are Happy Hare's files." : `${hh.map(base).join(", ")} ${hh.length === 1 ? "is" : "are"} Happy Hare's.`;
    out.push(["off", `${whose} An UPDATE pulls and leaves untracked files alone; only a HARD recover (a re-clone) deletes them${rec.hard ? "" : " — none is offered here"}.`]);
  } else if (rec.broken && HH_HOME[name]) {
    // An empty or HH-free list is not "no Happy Hare here" (a damaged repo may not answer git status).
    const listed = untracked.length ? "None of the untracked files Moonraker lists here is Happy Hare's" : "Moonraker lists no untracked files for this repo right now";
    out.push(["warn", `${listed}, but on this printer it holds Happy Hare's ${HH_HOME[name]}. A HARD recover deletes them.`]);
  }
  return out;
}

/** The RECOVER confirm, soft or hard. The hard one always names Happy Hare's files for klipper / moonraker. */
// What to run over SSH after a HARD recover re-cloned the checkout: the re-clone deletes the untracked files.
const REINSTALL = {
  klipper: " Afterwards run ~/cartographer-klipper/install.sh, then ~/Happy-Hare/install.sh -z.",
  moonraker: " Afterwards run ~/Happy-Hare/install.sh -z, then sudo systemctl restart moonraker.",
  KlipperScreen: " This also deletes the voron-carbon theme in styles/ (Moonraker lists only .py/.c/.cpp).",
};

export function recoverText(name, v, hard) {
  const r = v || {}, rec = repoRecovery(r);
  const restart = restartOf(name);
  const untracked = untrackedFiles(r), hh = untracked.filter(isHappyHareFile), modified = modifiedFiles(r);
  if (!hard) {
    const what = modified.length ? `the modified files (${modified.map(base).join(", ")})` : "every modified tracked file";
    const keep = hh.length ? `, including Happy Hare's ${hh.map(base).join(", ")}` : "";
    const to = rec.diverged
      ? "hard-resets it. This repo has DIVERGED: if its current commit is not on the remote branch, the reset goes to the remote's latest commit instead — local commits are lost and it is effectively an update"
      : "hard-resets it to the current commit (to the remote's latest, if that commit is not on the remote branch)";
    // A bare is_valid:false: the fix may be a REFRESH, which touches nothing. Say so where the decision is made.
    const first = rec.unverified ? "Moonraker reports nothing a reset would fix here, and one failed check leaves exactly this state: REFRESH first re-validates without touching the checkout. " : "";
    return `${first}Reset ${name}? Moonraker restores ${what}, checks out its primary branch and ${to}. Local edits to tracked files are lost. Untracked files stay${keep}. Then ${restart}.`;
  }
  const t = `Delete ${name}'s checkout and re-clone it from ${rec.noClone ? "its origin" : r.recovery_url}? Every local change and every untracked file goes`;
  const hhWhat = hh.length
    ? `Happy Hare's ${hh.map(base).join(", ")}${name === "klipper" ? ", plus its klippy/extras/mmu package, which Moonraker does not list" : ""}`
    : HH_HOME[name] ? `Happy Hare's ${HH_HOME[name]} — Moonraker lists none of them right now, but this printer keeps them there` : "";
  if (!hhWhat) return `${t}${untracked.length ? ` — ${untracked.map(base).join(", ")}` : ""}. Then ${restart}.${REINSTALL[name] || ""}`;
  // Name the other untracked files as well: the confirm is the last place anyone reads what is deleted.
  const rest = untracked.filter(p => !isHappyHareFile(p)).map(base);
  const after = name === "klipper" ? "Klipper then restarts and will not get past this printer's [mmu] config"
    : name === "moonraker" ? "Moonraker then restarts without Happy Hare's mmu_server component"
    : `Then ${restart}, and the MMU stops working`;
  return `${t} — ${rest.length ? `${rest.join(", ")} and ` : "including "}${hhWhat}. ${after} until Happy Hare's installer is re-run over SSH.${REINSTALL[name] || ""}`;
}

/** "mmu/mmu_hardware.cfg" → { dir: "mmu", name: "mmu_hardware.cfg" } — the two halves the upload endpoint wants. */
export function splitConfigPath(path) {
  const p = String(path || "").replace(/^\/+/, "");
  const i = p.lastIndexOf("/");
  return { dir: i < 0 ? "" : p.slice(0, i), name: i < 0 ? p : p.slice(i + 1) };
}

/** File built from a string. Moonraker's upload reads `file.name`, so a bare Blob will not do. */
function textFile(name, text) {
  try { return new File([text], name, { type: "text/plain" }); }
  catch (e) {                                   // pre-2020 webviews: a Blob with the name pinned on
    const b = new Blob([text], { type: "text/plain" });
    b.name = name;
    return b;
  }
}

export function makeMachineActions({ api, store, log } = {}) {
  const L = (m, k) => { try { if (typeof log === "function") log(m, k || "info"); } catch (e) { /* console-panel logging is best-effort */ } };
  const state = () => (store && store.state) || {};
  const raw = () => state().raw || {};
  const printState = () => String((raw().print_stats || {}).state || "standby").toLowerCase();
  const isActive = () => isPrintActive(state());
  const noApi = () => { if (api) return false; L("Command rejected — no printer connection", "err"); return true; };
  /** True (and logs) when `what` must not run because a print is in progress. */
  const busyPrinting = what => {
    if (!isActive()) return false;
    L(what + " refused — a print is " + printState() + ". Cancel it first.", "err");
    return true;
  };

  async function run(intent, kind, fn) {
    L(intent, kind);
    try { await fn(); return true; }
    catch (e) { L((e && e.message) || String(e), "err"); return false; }
  }

  const actions = {
    // ---- services ---------------------------------------------------------------------
    /** machine.services.<action> for one systemd unit from system_info.available_services. */
    serviceAction(name, action) {
      if (noApi()) return Promise.resolve(false);
      const n = String(name || "").trim();
      const a = String(action || "").toLowerCase();
      if (!n) { L("Service action — no service name", "warn"); return Promise.resolve(false); }
      if (!["restart", "start", "stop"].includes(a)) { L("Unknown service action: " + action, "warn"); return Promise.resolve(false); }
      // Stopping Moonraker kills the very socket this UI would need to start it again — only the
      // host's shell can undo it, so the button must not exist as a one-way door.
      if (a === "stop" && n === "moonraker") { L("Refused — stopping Moonraker leaves no way to start it again from this UI", "err"); return Promise.resolve(false); }
      if (KLIPPER_SERVICES.includes(n) && a !== "start" && busyPrinting(a.toUpperCase() + " " + n)) return Promise.resolve(false);
      const fn = { restart: "serviceRestart", start: "serviceStart", stop: "serviceStop" }[a];
      const note = n === "moonraker" && a === "restart" ? " — this UI will reconnect" : "";
      return run(a.toUpperCase() + " service " + n + note, a === "stop" ? "err" : "warn", () => api[fn](n));
    },
    /** machine.services.restart moonraker — the websocket drops and reconnects on its own backoff. */
    moonrakerRestart() { return actions.serviceAction("moonraker", "restart"); },

    // ---- host power / klipper ---------------------------------------------------------
    /** printer.restart — restarts the Klipper HOST process, which re-reads every config file. */
    klipperRestart() {
      if (noApi()) return Promise.resolve(false);
      if (busyPrinting("RESTART")) return Promise.resolve(false);
      return run("RESTART — restarting Klipper and re-reading the config", "warn", () => api.printerRestart());
    },
    /** printer.firmware_restart — resets the MCUs as well; the only way out of a shutdown. */
    firmwareRestart() {
      if (noApi()) return Promise.resolve(false);
      if (busyPrinting("FIRMWARE_RESTART")) return Promise.resolve(false);
      return run("FIRMWARE_RESTART", "warn", () => api.firmwareRestart());
    },
    /** machine.reboot — the whole host goes down. */
    hostReboot() {
      if (noApi()) return Promise.resolve(false);
      if (busyPrinting("Host reboot")) return Promise.resolve(false);
      return run("Rebooting the host — the connection will drop", "err", () => api.reboot());
    },
    /** machine.shutdown — powering back on needs physical access, so this one is worded plainly. */
    hostShutdown() {
      if (noApi()) return Promise.resolve(false);
      if (busyPrinting("Host shutdown")) return Promise.resolve(false);
      return run("Shutting the host down — it will need to be powered on by hand", "err", () => api.shutdown());
    },
    /** M112. Never refused and never guarded: it is the emergency button. */
    estop() {
      if (noApi()) return Promise.resolve(false);
      return run("M112 — EMERGENCY STOP, MCU shut down", "err", () => api.emergencyStop());
    },

    // ---- update manager ---------------------------------------------------------------
    /**
     * machine.update.refresh — walks every repo against GitHub. Slow, and rate limited to 60/h.
     * Moonraker answers it with a 503 while Klippy is printing, so the guard belongs here too: the
     * page disables the button, but the button was the only thing stopping it (this function is the
     * documented refusal point, and it is the one every caller shares).
     */
    refreshUpdates() {
      if (noApi()) return Promise.resolve(false);
      if (busyPrinting("Update refresh")) return Promise.resolve(false);
      return run("Refreshing update status from GitHub", "info", () => api.updateRefresh());
    },
    /** Update one component. Every update restarts what it patched, so none of them run mid-print. */
    runUpdate(name) {
      if (noApi()) return Promise.resolve(false);
      const n = String(name || "").trim();
      if (!n) { L("Update — no component name", "warn"); return Promise.resolve(false); }
      if (busyPrinting("Update of " + n)) return Promise.resolve(false);
      const ep = UPDATE_ENDPOINT[n];
      return run("Updating " + n, "warn", () => (ep ? api[ep]() : api.updateClient(n)));
    },
    /** machine.update.full — every component plus the system packages, in Moonraker's own order. */
    updateAll() {
      if (noApi()) return Promise.resolve(false);
      if (busyPrinting("Update all")) return Promise.resolve(false);
      return run("Updating every component", "warn", () => api.updateFull());
    },
    /**
     * machine.update.recover — resets (soft) or re-clones (hard) a repo the update manager flagged.
     * `hard` deletes every untracked file in the checkout, and on this printer that is Happy Hare:
     * callers decide soft vs hard with repoRecovery(), never by default.
     */
    recoverUpdate(name, hard = false) {
      if (noApi()) return Promise.resolve(false);
      const n = String(name || "").trim();
      if (!n) { L("Recover — no component name", "warn"); return Promise.resolve(false); }
      if (busyPrinting("Recovery of " + n)) return Promise.resolve(false);
      return run("Recovering " + n + (hard ? " (hard — local changes discarded)" : ""), "err", () => api.updateRecover(n, !!hard));
    },

    // ---- config files -----------------------------------------------------------------
    /**
     * Write an edited config file back. Moonraker has no "write file" RPC — the supported way is to
     * re-upload it, which overwrites in place and keeps the printer's own backup behaviour.
     * `restart` chains printer.restart so the new config is actually loaded.
     */
    async saveConfig(path, text, { restart } = {}) {
      if (noApi()) return false;
      const p = String(path || "").replace(/^\/+/, "");
      if (!p) { L("Save — no file selected", "warn"); return false; }
      if (typeof text !== "string") { L("Save — nothing to write", "warn"); return false; }
      if (restart && busyPrinting("SAVE & RESTART of " + p)) return false;
      // Moonraker rejects a path that climbs out of the root, but a client that can be asked to write
      // "../../.ssh/authorized_keys" should not put the request on the wire in the first place.
      if (p.split("/").includes("..")) { L("Save refused — path escapes the config root: " + p, "err"); return false; }
      const { dir, name } = splitConfigPath(p);
      // text.length counts UTF-16 code units, not bytes; a config with a ° or a — in a comment logged
      // a byte count that did not match what Moonraker then stored.
      let bytes = text.length;
      try { bytes = new Blob([text]).size; } catch (e) { /* no Blob: the code-unit count is close enough */ }
      L("Writing config/" + p + " (" + bytes + " bytes)", "warn");
      try {
        await api.fileUpload(textFile(name, text), "config", dir);
      } catch (e) {
        L("Save failed: " + ((e && e.message) || String(e)), "err");
        return false;
      }
      L("config/" + p + " saved", "ok");
      if (!restart) return true;
      return run("RESTART — loading the saved config", "warn", () => api.printerRestart());
    },

    // ---- diagnostics ------------------------------------------------------------------
    /**
     * printer.query_endstops.status → { stepper_x: "open", stepper_z: "TRIGGERED", … } or null.
     * Klipper answers this by flushing the move queue, so it is refused mid-print: the pause it
     * inserts lands in the part as a blob.
     */
    async queryEndstops() {
      if (noApi()) return null;
      if (busyPrinting("QUERY_ENDSTOPS")) return null;
      L("QUERY_ENDSTOPS", "info");
      try { return await api.rpc("printer.query_endstops.status"); }
      catch (e) { L((e && e.message) || String(e), "err"); return null; }
    },
  };
  return actions;
}

export default makeMachineActions;
