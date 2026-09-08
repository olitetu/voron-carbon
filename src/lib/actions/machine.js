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
// One guard rail, applied in one place: everything that would interrupt a running print — host
// power, klipper/firmware restart, EVERY update (they restart the service they patched), SAVE &
// RESTART, and the endstop query (it flushes the move queue, which shows up as a blob in the part)
// — is refused while print_stats is printing or paused, and says why in the console. Moonraker
// refuses updates mid-print too, but only after the user has already confirmed a scary dialog.
// The one exemption is a Klippy that has shut down or dropped: see isPrintActive().
//
// The UI confirms first; these functions run the real command as soon as they are called, log their
// intent, log errors instead of throwing, and resolve true only when Moonraker accepted the command.

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
     * machine.update.recover — re-clones (hard) or resets a repo the update manager flagged dirty
     * or invalid. `hard` throws away local modifications to the checkout, which is the point.
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
