// ---------------------------------------------------------------------------
// UPDATES — Moonraker's update manager on the panel: every component, installed -> available, how far
// behind, what Moonraker says is odd about it, and one UPDATE per component.
//
// WHAT THIS PRINTER REPORTS (machine.update.status?refresh=false, read-only, 2026-09-23). Eleven entries:
//   system        98 upgradable apt packages — among them linux-image-rpi-2712, raspi-firmware, rpi-eeprom,
//                 nginx and xserver-xorg-core. Moonraker gives no installed count for `system`, only this one.
//   moonraker     v0.10.0-21 -> v0.11.0-1, 18 behind.   anomaly: untracked moonraker/components/mmu_server.py
//   klipper       v0.13.0-745 -> v0.13.0-770, 25 behind. anomaly: 7 untracked klippy/extras/mmu_*.py
//   KlipperScreen moggieuk's Happy Hare edition, v3.0.1-34 -> v4.0.0-292: 311 behind, only 31 commits cached.
//   Klipper-Adaptive-Meshing-Purging 1 behind; mainsail (`web`, no commit count) v2.17.0 -> v2.19.0;
//   happy-hare (branch v3), crowsnest, cartographer, belay, sonar current. cartographer carries "Unofficial
//   remote url" (a gitee mirror). is_dirty / corrupt false and is_valid true everywhere, so RECOVER is
//   offered nowhere today. github_requests_remaining is null (no GitHub call since Moonraker started).
// Moonraker has enable_auto_refresh off here (moonraker.conf sets only channel: dev and refresh_interval: 168),
// so this cached status is re-checked against GitHub only by REFRESH, or when Moonraker starts and the last
// check is older than 168 h. The screen reads it on mount and never refreshes by itself: REFRESH is slow, uses
// the 60/h anonymous GitHub budget, and Moonraker answers it 503 while printing.
//
// WHAT MOONRAKER DOES (its source at the installed commit 9bceead, components/update_manager):
//   · machine.update.{klipper,moonraker,system,client} and .recover answer only when the job FINISHES. The
//     client's rpc() gives up after 30 s, so a timeout here means "still running" (the same lie
//     screen/actions.js documents for long g-code), and the progress comes as notify_update_response lines.
//   · Updates and recovery are refused while Klippy is printing. makeMachineActions (lib/actions/machine.js)
//     refuses earlier and stricter — printing OR paused — and is the only path used here.
//   · GitDeploy.update() aborts on a repo that is not valid or is dirty, so a broken repo shows RECOVER where
//     UPDATE would be.
//   · WHICH RECOVER is repoRecovery() in lib/actions/machine.js, shared with the desktop MACHINE page; its
//     header carries the Moonraker source behind it. In short: is_valid:false alone is also what ONE failed
//     fetch leaves behind, so HARD RECOVER (a re-clone, which deletes Happy Hare's untracked files) is offered
//     up front only when Moonraker says `corrupt`. Every other broken state gets the soft reset (the bare
//     is_valid:false case with a note that REFRESH re-validates without touching anything); HARD appears only
//     after Moonraker has actually run a soft recovery of that repo (failedRecovery: its recover_<name>
//     completion notice) and the repo still reads broken. A refusal or a dropped socket is not an attempt.
//
// HAPPY HARE LIVES UNTRACKED INSIDE THE KLIPPER AND MOONRAKER CHECKOUTS. An UPDATE pulls and leaves untracked
// files alone; a HARD recover deletes them, after which Klipper cannot get past this printer's [mmu] config
// and Moonraker stops loading mmu_server. The shared recoverText() names every file Moonraker lists, plus the
// klippy/extras/mmu package it never lists, and falls back to HH_HOME when a damaged repo lists nothing.
//
// WHAT EACH UPDATE RESTARTS is managed_services in this printer's moonraker.conf (read 2026-09-23). The status
// does not report it, so it is the one printer fact kept in the shared restartOf(); an unknown name gets
// generic words.
//
// KLIPPERSCREEN IS NOT IRRELEVANT ONCE CARBON OWNS THE PANEL. tools/kiosk/install_kiosk.sh only DISABLES it: it
// stays as carbon-kiosk's OnFailure fallback and carbon-panel-rollback's target. And updating it restarts
// KlipperScreen.service (managed_services: KlipperScreen) — which starts a stopped unit — while
// carbon-kiosk.service declares Conflicts=KlipperScreen.service: the update takes the panel away from this
// screen until carbon-kiosk is started again. Who owns the panel is read from system_info.service_state;
// today KlipperScreen is active and carbon-kiosk is not in Moonraker's service list.
//
// Carbon itself is not in the update manager: its [update_manager voron-carbon] block is deliberately
// commented out in moonraker.conf until Carbon cuts a release (tools/enable_updates.sh turns it on). The list
// says so rather than silently omitting it.
//
// NO "UPDATE ALL". machine.update.full would, in one tap, run apt with a kernel in it, restart Klipper,
// Moonraker, crowsnest and sonar, and update KlipperScreen — the one that takes the panel. Each consequence
// belongs in its own confirm.
//
// Nothing here is sent on render or mount: the only automatic call is the read-only status. Every write is
// confirmed and re-checked against the guards at the moment CONFIRM is tapped.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { useAsync } from "../../lib/useStore.js";
import { makeMachineActions, isPrintActive, throttleSummary, behindOf, unknownVersion, updateOrder, updateSummary,
         repoRecovery, repoFlags, failedRecovery, recoveryNotes, recoverText, restartOf, untrackedFiles,
         isHappyHareFile } from "../../lib/actions/machine.js";
import { fmtAgo } from "../../lib/history.js";
import { num } from "../../lib/spools.js";
import { C, F, L, TAP, mono } from "../tokens.js";
import { badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";

const DASH = "—";
// Every RPC issued before the socket is up rejects with "not connected"; staying pending until st.connected
// flips keeps the screen in its loading state instead of latching that error (the desktop pages' idiom).
const PENDING = new Promise(() => {});
const KIND = { system: "APT", git_repo: "GIT", web: "WEB", zip: "ZIP", python: "PIP", executable: "BIN" };

const cap = t => t.charAt(0).toUpperCase() + t.slice(1);

/** The RPC each UPDATE sends — display only, for the confirm; the call itself is makeMachineActions().runUpdate. */
const RPC = { system: "machine.update.system", klipper: "machine.update.klipper", moonraker: "machine.update.moonraker" };
const rpcOf = name => RPC[name] || `machine.update.client · name=${name}`;

const base = p => String(p).split("/").pop();
const major = v => { const m = /^v?(\d+)\./.exec(String(v || "")); return m ? Number(m[1]) : null; };
/** Packages that only take effect after a reboot, and the wider set the package list highlights. */
const REBOOT_PKG = /^linux-image-|^raspi-firmware$|^rpi-eeprom$/;
const NOTABLE_PKG = new RegExp(`${REBOOT_PKG.source}|^nginx$|^xserver-xorg-core$`);
/** RPC failures that mean Moonraker never ran the job: not an attempt, so they unlock nothing. */
const NOT_AN_ATTEMPT = /not connected|socket closed|^timeout:|refused|busy|currently updating|printing|not available/i;

/**
 * Everything the list row, the detail and the confirms need to know about one component. `tried` = a soft
 * recovery of it already ran and failed (repoRecovery then offers HARD as well).
 */
function describe(r, tried) {
  const sys = r.configured_type === "system";
  const b = behindOf(r);   // null, not 0, for a git repo whose remote is "?" (see behindOf)
  const notes = [].concat(r.anomalies || [], r.warnings || [], r.git_messages || [], r.last_error ? [r.last_error] : [])
    .filter(Boolean).map(String);
  const untracked = untrackedFiles(r);
  const rec = repoRecovery(r, tried);
  const target = sys ? `${b} package${b === 1 ? "" : "s"}` : unknownVersion(r.remote_version) ? "the latest release" : r.remote_version;
  return {
    sys, git: rec.git, b, notes, untracked, hh: untracked.filter(isHappyHareFile), broken: rec.broken, rec,
    flags: repoFlags(r),   // most specific first: the row badge shows flags[0]
    target, kind: KIND[r.configured_type] || String(r.configured_type || "?").toUpperCase(),
  };
}

/** Who has the panel. carbon-kiosk only shows up if install_kiosk.sh added it to moonraker.asvc. */
function panelOwner(st) {
  const ss = (st.systemInfo || {}).service_state || {};
  const on = n => !!(ss[n] && ss[n].active_state === "active");
  if (on("carbon-kiosk")) return "carbon";
  if (on("KlipperScreen")) return "klipperscreen";
  return ss.KlipperScreen ? "stopped" : null;
}

/** Notes Moonraker does not write but this printer makes true. [kind, text]. */
function derivedNotes(r, d, ctx) {
  const out = [];
  if (!d.sys && unknownVersion(r.remote_version)) out.push(["off", "Moonraker has no remote version for this one — GitHub unreachable, rate limited or never checked. That is not the same as up to date."]);
  const a = major(r.version), z = major(r.remote_version);
  if (a !== null && z !== null && z > a) out.push(["warn", `Major version jump: v${a} → v${z}.`]);
  if (r.name === "KlipperScreen") {
    out.push(ctx.owner === "carbon"
      ? ["warn", "Carbon owns the panel. KlipperScreen stays installed but disabled — it is the kiosk's automatic fallback and carbon-panel-rollback's target, so it still has to work. Updating it restarts KlipperScreen.service, and carbon-kiosk declares Conflicts=KlipperScreen: the panel goes to KlipperScreen until carbon-kiosk is started again (a reboot does it)."]
      : ctx.owner === "klipperscreen"
        ? ["off", "KlipperScreen is running the panel right now. Once install_kiosk.sh swaps Carbon in, it is only disabled — it stays as the fallback, so its updates still matter. From then on, updating it restarts KlipperScreen.service, and carbon-kiosk's Conflicts=KlipperScreen stops this screen's kiosk."]
        : ctx.owner === "stopped"
          ? ["warn", "KlipperScreen is not running. It is kept as Carbon's fallback panel. If Carbon's kiosk owns the panel, updating it restarts KlipperScreen.service and carbon-kiosk's Conflicts=KlipperScreen hands the panel to KlipperScreen until carbon-kiosk is started again."]
          // No system_info in the store (the shell only reads it while Klippy is ready): say we cannot tell.
          : ["warn", "Moonraker's service state has not been read, so this screen cannot tell who owns the panel. KlipperScreen stays installed as Carbon's fallback. If carbon-kiosk has the panel, updating KlipperScreen restarts KlipperScreen.service and its Conflicts=KlipperScreen hands the panel over until carbon-kiosk is started again."]);
  }
  // Recovery advice and Happy Hare's files: the same words the desktop MACHINE page shows.
  out.push(...recoveryNotes(r.name, r, !!(ctx.tried && ctx.tried.has(r.name))));
  if (d.sys) {
    const pk = r.package_list || [];
    if (pk.some(p => REBOOT_PKG.test(p))) out.push(["warn", "Includes a new kernel / Pi firmware — it takes effect only after a reboot."]);
    if (pk.includes("nginx")) out.push(["off", "nginx is in the list. This screen is served through nginx: if apt restarts it, the connection drops briefly and comes back."]);
    if (ctx.thr.now.length) out.push(["err", `The Pi is under-volting RIGHT NOW (${ctx.thr.now.join(", ")}). A reset in the middle of apt leaves packages half-configured.`]);
    else if (ctx.thr.past.length) out.push(["warn", `This Pi has under-volted since boot (${ctx.thr.past.join(", ")}). A brownout in the middle of apt leaves packages half-configured.`]);
  }
  return out;
}

/** One-line consequences for the UPDATE confirm. */
function updateText(r, d, ctx) {
  const parts = [d.sys ? `Upgrade ${d.target}?` : `Update ${r.name} from ${r.version || DASH} to ${d.target}?`, cap(restartOf(r.name)) + "."];
  if (r.name === "KlipperScreen" && ctx.owner === "carbon") parts.push("carbon-kiosk declares Conflicts=KlipperScreen, so KlipperScreen takes the panel from this screen until carbon-kiosk is started again (a reboot does it).");
  else if (r.name === "KlipperScreen" && ctx.owner === "klipperscreen") parts.push("It is the panel's UI right now, so the panel restarts with it.");
  else if (r.name === "KlipperScreen") parts.push("If Carbon's kiosk has the panel, its Conflicts=KlipperScreen hands the panel to KlipperScreen until carbon-kiosk is started again (a reboot does it).");
  const a = major(r.version), z = major(r.remote_version);
  if (a !== null && z !== null && z > a) parts.push(`This is a major version jump (v${a} → v${z}).`);
  if (d.hh.length) parts.push("Happy Hare's untracked files stay put — an update pulls, it does not re-clone.");
  if (d.sys) {
    const pk = r.package_list || [];
    if (pk.some(p => REBOOT_PKG.test(p))) parts.push("The new kernel / firmware needs a reboot afterwards.");
    if (ctx.thr.now.length) parts.push("The Pi is under-volting RIGHT NOW — a reset mid-upgrade leaves packages half-configured.");
    else if (ctx.thr.past.length) parts.push("This Pi has under-volted since boot — a brownout mid-upgrade leaves packages half-configured.");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
function KV({ k, v, color = C.body, span }) {
  return (
    <div style={S(`display:flex; flex-direction:column; gap:3px; min-width:0${span ? "; grid-column:1 / -1" : ""}`)}>
      <span style={S(microLabel(C.faint))}>{k}</span>
      <span style={S(mono(F.body, `color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
    </div>
  );
}

function Note({ kind, children }) {
  const col = { err: C.accent, warn: C.bed, ok: C.cool }[kind] || C.faint;
  return (
    <div style={S("display:flex; gap:9px; align-items:flex-start; min-width:0")}>
      <span style={S(`flex:none; width:6px; height:6px; border-radius:50%; margin-top:7px; background:${col}`)} />
      <span style={S(`flex:1; min-width:0; font-size:${F.label}px; line-height:1.45; color:${kind === "err" ? C.text : C.body}; overflow-wrap:anywhere; text-wrap:pretty`)}>{children}</span>
    </div>
  );
}

function Row({ r, on, onTap }) {
  const d = describe(r);
  const upd = !d.sys && d.b > 0 && !unknownVersion(r.remote_version);
  const ver = d.sys ? (d.b > 0 ? `${d.b} upgradable` : "no upgrades") : upd ? `${r.version || DASH} → ${r.remote_version}` : (r.version || DASH);
  const badge = d.flags.length ? [d.flags[0][0], d.flags[0][1]]
    : d.b === null ? ["UNKNOWN", "off"]
    : d.b > 0 ? [d.sys ? `${d.b} PKG` : r.configured_type === "web" ? "NEW" : `${d.b} BEHIND`, "warn"]
    : ["CURRENT", "ok"];
  // The remote is only worth the width when it is not the usual origin.
  const where = d.sys ? "" : d.git ? [r.remote_alias && r.remote_alias !== "origin" ? r.remote_alias : "", r.branch].filter(Boolean).join("/") : r.channel || "";
  const sub = d.flags.length ? d.flags.map(f => f[0]).join(" · ")
    : [d.kind, where, d.notes.length ? `${d.notes.length} NOTE${d.notes.length > 1 ? "S" : ""}` : ""].filter(Boolean).join(" · ");
  return (
    <Hv as="div" onClick={onTap} active={`background:${C.line1}`}
      style={`position:relative; display:grid; grid-template-columns:minmax(0,1fr) 210px 124px; gap:10px; align-items:center; height:52px; padding:0 12px 0 15px; border-bottom:1px solid ${C.line1}; cursor:pointer; background:${on ? C.rowOn : "transparent"}`}>
      <span style={S(`position:absolute; left:0; top:8px; bottom:8px; width:3px; border-radius:2px; background:${on ? C.accent : "transparent"}`)} />
      <div style={S("display:flex; flex-direction:column; gap:3px; min-width:0")}>
        <span title={r.name} style={S(mono(F.label, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{r.name}</span>
        <span style={S(mono(F.micro, `letter-spacing:.06em; color:${d.flags.length ? C.bed : C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{sub}</span>
      </div>
      <span style={S(mono(F.label, `color:${upd || (d.sys && d.b > 0) ? C.body : C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{ver}</span>
      <span style={S(`justify-self:end; ${badgeStyle(badge[1])}`)}>{badge[0]}</span>
    </Hv>
  );
}

/** Not a control: something the update manager does NOT manage, said out loud. */
function GhostRow({ name, badge, sub }) {
  return (
    <div style={S(`display:grid; grid-template-columns:minmax(0,1fr) 124px; gap:10px; align-items:center; min-height:52px; padding:6px 12px 6px 15px; border-bottom:1px solid ${C.line1}; opacity:.8`)}>
      <div style={S("display:flex; flex-direction:column; gap:3px; min-width:0")}>
        <span style={S(mono(F.label, `color:${C.mute}`))}>{name}</span>
        <span style={S(mono(F.micro, `letter-spacing:.04em; color:${C.faint}; overflow-wrap:anywhere`))}>{sub}</span>
      </div>
      <span style={S(`justify-self:end; ${badgeStyle("off")}`)}>{badge}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Updates({ st, api, act, say }) {
  const s = useAsync(() => (st.connected ? api.updateStatus(false) : PENDING), [api, st.connected]);
  const reload = s.reload;
  const [sel, setSel] = React.useState(null);
  const [confirm, setConfirm] = React.useState(null);
  const [feed, setFeed] = React.useState([]);
  const [inflight, setInflight] = React.useState(null);   // { label, kind } of the job THIS screen started
  const [triedSoft, setTriedSoft] = React.useState(() => new Set());
  const feedRef = React.useRef(null);
  const markTried = React.useCallback(n => setTriedSoft(t => (t.has(n) ? t : new Set(t).add(n))), []);

  // Moonraker narrates every update and recovery; this feed is the only progress there is.
  React.useEffect(() => {
    const offs = [
      api.on("notify_update_response", u => {
        const line = String((u && u.message) || "").trim();
        if (line) setFeed(f => f.concat(line).slice(-80));
        if (u && u.complete) {
          // Moonraker names the recovery only once it really ran, so its failure notice — not our RPC's
          // outcome — is what unlocks HARD (failedRecovery, lib/actions/machine.js).
          const failed = failedRecovery(u);
          if (failed) markTried(failed);
          setInflight(null); reload();
        }
      }),
      // A refresh answers with this event; it says nothing about an update or recovery still running.
      api.on("update_refreshed", () => { setInflight(f => (f && f.kind === "refresh" ? null : f)); reload(); }),
    ];
    return () => offs.forEach(off => { try { off(); } catch (e) { /* already gone */ } });
  }, [api, reload, markTried]);
  React.useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [feed]);
  // A Moonraker update restarts the very socket its notifications travel on; once it is back the job is over.
  React.useEffect(() => { if (st.connected) setInflight(null); }, [st.connected]);
  // Backstop for a job whose completion notice was lost: nothing Moonraker runs here takes 20 minutes.
  React.useEffect(() => {
    if (!inflight) return undefined;
    const t = setTimeout(() => setInflight(null), 20 * 60 * 1000);
    return () => clearTimeout(t);
  }, [inflight]);

  // makeMachineActions reads store.state at CALL time, so a view over the latest render is all it needs.
  const stRef = React.useRef(st); stRef.current = st;
  // The guards are re-asked when CONFIRM is tapped, from the confirm the user opened earlier: they read
  // this ref, not the closure of the render that opened it.
  const live = React.useRef({ inflight: null, busy: false });
  const lastErr = React.useRef("");
  const note = React.useCallback((msg, kind) => {
    const m = String(msg);
    if (kind === "err") lastErr.current = m;
    // Not failures: machine.update.* answers only when done, and a Moonraker update drops the socket.
    if (/^timeout: machine\.update\./i.test(m)) { say("Still running — Moonraker reports back when it finishes"); return; }
    if (/^socket closed$/i.test(m)) { say("Connection dropped — a service is restarting"); return; }
    act.log(m, kind);                // st.screenLog; warn/err also toast
  }, [act, say]);
  const mach = React.useMemo(() => makeMachineActions({ api, store: { get state() { return stRef.current; } }, log: note }), [api, note]);

  const data = s.data || null;
  const vi = (data && data.version_info) || {};
  const rows = Object.keys(vi).sort(updateOrder).map(n => Object.assign({ name: n }, vi[n]));
  const ctx = { owner: panelOwner(st), thr: throttleSummary((st.procStats || {}).throttled_state), tried: triedSoft };
  const printState = String((st.raw.print_stats || {}).state || "standby");
  const printing = isPrintActive(st);
  const busy = !!(data && data.busy);
  live.current = { inflight, busy };

  /** Why a write cannot run right now; null = it can. Re-asked at CONFIRM time. */
  const whyNot = () => {
    const now = stRef.current, { inflight: job, busy: bz } = live.current;
    if (!now.connected) return "Moonraker is not connected";
    if (isPrintActive(now)) return `a print is ${String((now.raw.print_stats || {}).state || "active")} — every update restarts what it patched`;
    if (job) return `${job.label} is still running`;
    if (bz) return "the update manager is already running a job";
    return null;
  };
  const gate = whyNot();

  const start = (label, fn, after, kind) => {
    setFeed([]); lastErr.current = ""; setInflight({ label, kind: kind || "job" });
    Promise.resolve(fn()).then(ok => {
      reload();
      // A timeout or a dropped socket means the job is still going; its completion notice clears this.
      const going = !ok && /^timeout:|^socket closed/i.test(lastErr.current);
      if (after) after(ok, going);
      if (!going) setInflight(null);
    }).catch(() => setInflight(null));
  };
  const ask = a => setConfirm(a);
  const yes = () => {
    const c = confirm; setConfirm(null);
    if (!c) return;
    const why = (c.why || whyNot)();
    if (why) { act.refuse(c.label, why); return; }
    start(c.label, c.run, c.after, c.kind);
  };

  // REFRESH installs and restarts nothing, but it replaces Moonraker's cached status, takes a while and spends
  // GitHub quota — so it is confirmed like everything else, with its own refusal wording.
  const refreshWhyNow = () => {
    const now = stRef.current, { inflight: job, busy: bz } = live.current;
    if (!now.connected) return "Moonraker is not connected";
    if (isPrintActive(now)) return "Moonraker refuses to refresh while a print is running";
    if (job) return `${job.label} is still running`;
    if (bz) return "the update manager is busy";
    return null;
  };
  const refreshWhy = refreshWhyNow();
  const refresh = () => ask({
    label: "REFRESH", kind: "refresh", cmd: "machine.update.refresh", why: refreshWhyNow,
    confirm: `Re-check all ${Object.keys(vi).length} components against their remotes and the system package list? It is slow, and GitHub rate-limits it. Nothing is installed or restarted.`,
    run: () => mach.refreshUpdates(),
  });

  // ---- no data yet --------------------------------------------------------------------------------------
  if (!data) {
    const e = !st.connected
      ? ["MOONRAKER OFFLINE", "The update manager lives in Moonraker. This screen reads it once the connection is back."]
      : s.error ? ["UPDATE STATUS UNAVAILABLE", `machine.update.status failed: ${s.error}`]
      : ["READING UPDATE STATUS", "machine.update.status — Moonraker's cached copy. No GitHub request is made."];
    return (
      <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>
        <Panel title="UPDATE MANAGER" style="flex:1; min-height:0"><Empty title={e[0]} hint={e[1]} /></Panel>
        <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 220px; gap:8px`)}>
          <span />
          <PanelBtn label="READ AGAIN" sub="CACHED · NO GITHUB" disabled={!st.connected || s.loading}
            why={!st.connected ? "Moonraker is not connected" : s.loading ? "already reading" : undefined} onTap={reload} />
        </div>
      </div>
    );
  }

  // ---- the list --------------------------------------------------------------------------------------------
  const pickName = rows.some(r => r.name === sel) ? sel
    : ((rows.find(r => { const d = describe(r); return d.broken || (!d.sys && d.b > 0); }) || rows[0] || {}).name || null);
  const r = rows.find(x => x.name === pickName) || null;
  // The same counts as the MORE tile (updateSummary); `unknown` is not "current": Moonraker could not tell.
  const { pending: behindN, unknown: unknownN, packages: pkgN } = updateSummary(data);
  // Every broken state (dirty, diverged, detached, corrupt) reads is_valid:false, so INVALID is Moonraker's
  // own word for all of them — and "BROKEN" overstated the failed-fetch case.
  const brokenN = rows.filter(x => describe(x).broken).length;
  const rate = num(data.github_requests_remaining);
  const umWarn = (((st.serverInfo || {}).warnings) || []).map(String).filter(w => /update_manager/i.test(w));
  const carbonManaged = rows.some(x => /carbon/i.test(x.name));

  const listRight = (
    <>
      {busy || inflight ? <span style={S(badgeStyle("warn"))}>RUNNING</span> : null}
      {brokenN ? <span style={S(badgeStyle("err"))}>{brokenN} INVALID</span> : null}
      <span style={S(badgeStyle(behindN ? "warn" : unknownN ? "off" : "ok"))}>{behindN ? `${behindN} BEHIND` : unknownN ? `${unknownN} UNKNOWN` : "ALL CURRENT"}</span>
      {pkgN !== null ? <span style={S(badgeStyle(pkgN ? "warn" : "off"))}>{pkgN} PKG</span> : null}
    </>
  );

  // ---- the detail -------------------------------------------------------------------------------------------
  let detail = <Empty title="NOTHING SELECTED" hint="Pick a component on the left." />;
  let actions = null;
  let headRight = null;
  if (r) {
    const d = describe(r, triedSoft.has(r.name));
    const derived = derivedNotes(r, d, ctx);
    const own = d.notes.filter(n => !(d.untracked.length && /untracked source files/i.test(n)));
    headRight = <span style={S(badgeStyle(d.broken ? "err" : "off"))}>{[d.kind, r.channel ? String(r.channel).toUpperCase() : ""].filter(Boolean).join(" · ")}</span>;

    const installed = d.sys ? DASH : (r.version || DASH);
    const available = d.sys ? (d.b > 0 ? `${d.b} upgradable` : "nothing to upgrade")
      : unknownVersion(r.remote_version) ? "unknown" : r.remote_version;
    const behindTxt = d.b === null ? "unknown" : d.sys ? `${d.b} package${d.b === 1 ? "" : "s"}`
      : r.configured_type === "web" ? (d.b ? "newer release" : "current") : `${d.b} commit${d.b === 1 ? "" : "s"}`;
    const dist = ((st.systemInfo || {}).distribution || {}).name;
    const source = d.sys ? `apt${dist ? " · " + dist : ""}` : [r.owner, r.repo_name].filter(Boolean).join("/") || DASH;
    const where = d.git ? [r.remote_alias, r.branch].filter(Boolean).join("/") || DASH : r.channel || DASH;
    const commits = Array.isArray(r.commits_behind) ? r.commits_behind : [];
    const count = num(r.commits_behind_count);

    detail = (
      <>
        <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:10px 14px")}>
          <KV k="INSTALLED" v={installed} color={d.sys ? C.ghost : C.text} />
          <KV k="AVAILABLE" v={available} color={d.b > 0 ? C.bed : C.mute} />
          <KV k="BEHIND" v={behindTxt} color={d.b > 0 ? C.bed : C.mute} />
          <KV k={d.git ? "BRANCH" : d.sys ? "TYPE" : "CHANNEL"} v={d.sys ? "system packages" : where} />
          <KV k="SOURCE" v={source} color={C.dim} span />
        </div>

        <div className="scroll" style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:10px")}>
          {feed.length ? (
            <div style={S("flex:none; display:flex; flex-direction:column; gap:6px")}>
              <span style={S(microLabel(C.bed))}>{`PROGRESS · ${inflight ? inflight.label : "LAST JOB"}`}</span>
              <div ref={feedRef} className="scroll" style={S(`max-height:150px; overflow-y:auto; border:1px solid ${C.line3}; border-radius:${L.radiusSm}px; background:${C.panelSunk}; padding:8px 10px`)}>
                {feed.map((l, i) => (
                  <div key={i} style={S(mono(F.micro, `color:${i === feed.length - 1 ? C.text : C.mute}; line-height:1.5; white-space:pre-wrap; word-break:break-word`))}>{l}</div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Two sources, labelled apart: Moonraker's own anomalies/warnings, then what this printer makes of them. */}
          {d.untracked.length || own.length ? (
            <div style={S("flex:none; display:flex; flex-direction:column; gap:8px")}>
              <span style={S(microLabel(C.faint))}>MOONRAKER REPORTS</span>
              {d.untracked.length ? (
                <Note kind="off">
                  <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.dim}`))}>UNTRACKED </span>
                  {d.untracked.map(base).join(" · ")}
                </Note>
              ) : null}
              {own.map((n, i) => <Note key={"o" + i} kind={/corrupt|invalid|failed|error/i.test(n) ? "err" : "warn"}>{n}</Note>)}
            </div>
          ) : null}
          {derived.length ? (
            <div style={S("flex:none; display:flex; flex-direction:column; gap:8px")}>
              <span style={S(microLabel(C.faint))}>ON THIS PRINTER</span>
              {derived.map(([k, t], i) => <Note key={"d" + i} kind={k}>{t}</Note>)}
            </div>
          ) : null}

          {d.sys ? (
            <div style={S("flex:none; display:flex; flex-direction:column; gap:6px")}>
              <span style={S(microLabel(C.faint))}>{`UPGRADABLE PACKAGES · ${(r.package_list || []).length}`}</span>
              <div style={S(mono(F.micro, `color:${C.body}; line-height:1.75; overflow-wrap:anywhere`))}>
                {(r.package_list || []).map((p, i) => (
                  <span key={p} style={S(`color:${NOTABLE_PKG.test(p) ? C.bed : C.body}`)}>{(i ? "  " : "") + p}</span>
                ))}
                {!(r.package_list || []).length ? <span style={S(`color:${C.mute}`)}>none</span> : null}
              </div>
            </div>
          ) : d.git ? (
            <div style={S("flex:none; display:flex; flex-direction:column")}>
              <span style={S(`${microLabel(C.faint)}; margin-bottom:4px`)}>
                {d.b === null ? "COMMITS BEHIND · UNKNOWN"
                  : count ? `${count} COMMIT${count === 1 ? "" : "S"} BEHIND${commits.length < count ? ` · ${commits.length} CACHED` : ""}` : "NO COMMITS BEHIND"}
              </span>
              {commits.map((c, i) => (
                <div key={c.sha || i} style={S(`display:grid; grid-template-columns:58px 76px minmax(0,1fr); gap:8px; align-items:baseline; padding:6px 0; border-bottom:1px solid ${C.line1}`)}>
                  <span style={S(mono(F.micro, `color:${C.faint}`))}>{String(c.sha || "").slice(0, 7)}</span>
                  <span style={S(mono(F.micro, `color:${C.mute}; white-space:nowrap`))}>{c.date ? fmtAgo(Number(c.date)) : DASH}</span>
                  <span style={S(`font-size:${F.label}px; color:${C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}>
                    {c.tag ? <span style={S(mono(F.micro, `color:${C.bed}`))}>{c.tag} </span> : null}{c.subject || DASH}
                  </span>
                </div>
              ))}
              {count && !commits.length ? <span style={S(mono(F.micro, `color:${C.mute}; padding:6px 0`))}>Moonraker did not cache the commit list for this repo.</span> : null}
            </div>
          ) : (
            <span style={S(`flex:none; font-size:${F.label}px; color:${C.faint}; line-height:1.45; text-wrap:pretty`)}>
              A {d.kind.toLowerCase()} component has no commit log: Moonraker only compares release tags.
            </span>
          )}
        </div>
      </>
    );

    // ---- actions ---------------------------------------------------------------------------------------------
    const btns = [];
    if (d.git && d.broken) {
      // GitDeploy.update() refuses a dirty or invalid repo, so on a broken one RECOVER replaces UPDATE (the
      // notes say why). Which RECOVER is repoRecovery's call: soft first; HARD up front only for `corrupt`,
      // otherwise only after Moonraker has actually run a soft recovery of this repo (a bare is_valid:false
      // can be a failed fetch).
      const tone = gate ? undefined : "danger";
      if (d.rec.soft) {
        btns.push(
          <PanelBtn key="soft" label="RECOVER" sub="KEEPS UNTRACKED" tone={tone} h={TAP.primary}
            disabled={!!gate} why={gate || undefined}
            onTap={() => ask({ label: `RECOVER ${r.name.toUpperCase()}`, cmd: `machine.update.recover · name=${r.name} hard=false`,
              confirm: recoverText(r.name, r, false),
              run: () => mach.recoverUpdate(r.name, false),
              // Backstop for a lost completion notice: a Moonraker-side failure counts, a refusal or a dropped
              // socket does not — neither ran the recovery.
              after: (ok, going) => { if (!ok && !going && !NOT_AN_ATTEMPT.test(lastErr.current)) markTried(r.name); } })} />
        );
      }
      if (d.rec.hard) {
        const hardWhy = gate || (d.rec.noClone ? "Moonraker has no recovery URL for this repo, so it cannot re-clone it" : null);
        btns.push(
          <PanelBtn key="hard" label="HARD RECOVER" sub="RE-CLONES THE REPO" tone={hardWhy ? undefined : "danger"} h={TAP.primary}
            disabled={!!hardWhy} why={hardWhy || undefined}
            onTap={() => ask({ label: `HARD RECOVER ${r.name.toUpperCase()}`, cmd: `machine.update.recover · name=${r.name} hard=true`,
              confirm: recoverText(r.name, r, true),
              run: () => mach.recoverUpdate(r.name, true) })} />
        );
      }
    } else {
      const updWhy = gate
        || (r.is_valid === false ? "Moonraker reports this component invalid and will not update it" : null)
        || (d.b === null ? "Moonraker has no remote version to compare against — REFRESH first" : null)
        || (d.b === 0 ? "already at the remote version" : null);
      btns.push(
        <PanelBtn key="upd" label={d.b === 0 ? "UP TO DATE" : d.b === null ? "UNKNOWN" : "UPDATE"} tone={updWhy ? undefined : "accent"} h={TAP.primary}
          sub={d.b > 0 ? (d.sys ? d.target.toUpperCase() : `→ ${d.target}`) : undefined}
          disabled={!!updWhy} why={updWhy || undefined}
          onTap={() => ask({ label: `UPDATE ${r.name.toUpperCase()}`, cmd: rpcOf(r.name), confirm: updateText(r, d, ctx),
            run: () => mach.runUpdate(r.name) })} />
      );
    }
    actions = (
      <div style={S(`flex:none; display:grid; grid-template-columns:repeat(${btns.length}, minmax(0,1fr)); gap:8px`)}>{btns}</div>
    );
  }

  const info = !st.connected ? ["OFFLINE · LAST STATUS SHOWN", C.accent]
    : printing ? [`${printState.toUpperCase()} · UPDATES LOCKED`, C.bed]
    : inflight ? [`${inflight.label} · RUNNING`, C.bed]
    : busy ? ["UPDATE MANAGER BUSY", C.bed]
    : rate !== null ? [`GITHUB ${rate}/${num(data.github_rate_limit) || 60} REQUESTS LEFT`, C.faint]
    : ["CACHED · REFRESH TO RE-CHECK", C.faint];
  const shortTitle = n => (n.length > 24 ? n.slice(0, 23) + "…" : n).toUpperCase();

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:minmax(0,1fr) 420px; grid-template-rows:minmax(0,1fr); gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>
      <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0; min-width:0`)}>
        <Panel title="UPDATE MANAGER" right={listRight} style="flex:1; min-height:0">
          <div className="scroll" style={S("flex:1; min-height:0; overflow-y:auto")}>
            {rows.length ? rows.map(x => <Row key={x.name} r={x} on={x.name === pickName} onTap={() => setSel(x.name)} />)
              : <Empty title="NOTHING MANAGED" hint="Moonraker's update manager reported no components." />}
            {umWarn.map((w, i) => <GhostRow key={"w" + i} name="NOT LOADED" badge="SKIPPED" sub={w} />)}
            {!carbonManaged ? (
              <GhostRow name="voron-carbon" badge="NOT MANAGED"
                sub="This UI. Off in moonraker.conf until Carbon's first release — tools/enable_updates.sh turns it on." />
            ) : null}
          </div>
        </Panel>
        <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 200px minmax(0,1fr); gap:8px; align-items:center`)}>
          <span />
          <PanelBtn label="REFRESH" sub="ASK GITHUB · SLOW" disabled={!!refreshWhy} why={refreshWhy || undefined} onTap={refresh} />
          <span style={S(mono(F.micro, `letter-spacing:.1em; color:${info[1]}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{info[0]}</span>
        </div>
      </div>

      <Panel title={r ? shortTitle(r.name) : "COMPONENT"} right={headRight} accent={r && describe(r).broken ? C.accent : C.bed}
        style="min-height:0" bodyStyle="padding:12px; gap:10px">
        {detail}
        {actions}
      </Panel>

      {confirm ? <ConfirmBox a={confirm} onNo={() => setConfirm(null)} onYes={yes} /> : null}
    </div>
  );
}
