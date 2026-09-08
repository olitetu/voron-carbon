// CURRENT JOB + top-bar actions: print pause/resume/cancel, emergency stop / firmware restart,
// SAVE_CONFIG, EXCLUDE_OBJECT include/exclude. Contract: CONTRACT.md "Exact gcode per action".
//
//   printPause()          → api.pausePrint()            (only while printing)
//   printResume()         → api.resumePrint()           (only while paused)
//   printCancel()         → api.cancelPrint()           (only while printing/paused; the UI confirms first via ctx.ui.confirmCancel)
//   printClear()          → SDCARD_RESET_FILE            (only once a job has finished — complete / cancelled / error)
//   printAction(a)        → the design's print("PAUSE"|"RESUME"|"CANCEL"|"CLEAR") dispatcher
//   estop()               → api.emergencyStop()         (M112 — no confirm: it is the emergency button)
//   firmwareRestart()     → api.firmwareRestart()       (the button while klippy is 'shutdown' / 'error')
//   klipperRestart()      → api.serviceRestart('klipper') (the button while klippy is 'disconnected' — firmware_restart cannot reach it)
//   estopButton()         → one of the three above, by store.state.klippy
//   saveConfig()          → api.gcode('SAVE_CONFIG')    (refused while a print is active; the UI confirms first via ctx.ui.confirmSave)
//   excludeObject(name)   → EXCLUDE_OBJECT NAME=<name>
//   includeObject(name)   → EXCLUDE_OBJECT RESET=1 NAME=<name>
//
// The confirm steps (CANCEL, SAVE_CONFIG) are UI state handled by src/pages/dashboard/adapters/job.js; these actions run the
// real command as soon as they are called. Every action logs its intent, awaits the RPC, logs errors instead of throwing and
// resolves true when the printer accepted the command (false when refused or failed).
import { has } from "../caps.js";

export function makeJobActions({ api, store, log } = {}) {
  const L = (m, k) => { try { if (typeof log === "function") log(m, k || "info"); } catch (e) { /* console-panel logging is best-effort */ } };
  const state = () => (store && store.state) || {};
  const raw = () => state().raw || {};
  const klippy = () => String(state().klippy || "unknown");
  const printState = () => String((raw().print_stats || {}).state || "standby").toLowerCase();
  const isPaused = () => printState() === "paused" || !!(raw().pause_resume || {}).is_paused;
  const isPrinting = () => printState() === "printing" && !isPaused();
  const isActive = () => isPrinting() || isPaused();
  const noApi = () => { if (api) return false; L("Command rejected — no printer connection", "err"); return true; };

  async function run(intent, kind, fn) {
    L(intent, kind);
    try { await fn(); return true; }
    catch (e) { L((e && e.message) || String(e), "err"); return false; }
  }

  const actions = {
    /** PAUSE → printer.print.pause (only while printing). */
    printPause() {
      if (noApi()) return Promise.resolve(false);
      if (!isPrinting()) { L(isPaused() ? "Print is already paused" : "Nothing to pause — no print running", "warn"); return Promise.resolve(false); }
      return run("PAUSE — parking toolhead", "warn", () => api.pausePrint());
    },
    /** RESUME → printer.print.resume (only while paused). */
    printResume() {
      if (noApi()) return Promise.resolve(false);
      if (!isPaused()) { L("Nothing to resume — print is not paused", "warn"); return Promise.resolve(false); }
      return run("RESUME", "ok", () => api.resumePrint());
    },
    /** CANCEL → printer.print.cancel. The UI asks for confirmation first (ui.confirmCancel). */
    printCancel() {
      if (noApi()) return Promise.resolve(false);
      if (!isActive()) { L("Nothing to cancel — no active print", "warn"); return Promise.resolve(false); }
      return run("CANCEL_PRINT", "err", () => api.cancelPrint());
    },
    /**
     * CLEAR — put the printer back in standby after a job has finished.
     *
     * Klipper leaves print_stats.state at `complete` / `cancelled` / `error` and virtual_sdcard still
     * holding the file, so the panel keeps showing the finished job (its filename, its progress, its
     * stats) until something resets it. SDCARD_RESET_FILE unloads the file and returns the state to
     * `standby`, which is what every other frontend calls "clear".
     *
     * Refused while a print is active: SDCARD_RESET_FILE on a live job would unload the file from under
     * Klipper. Cancel first — cancelling is what makes this available.
     */
    printClear() {
      if (noApi()) return Promise.resolve(false);
      if (isActive()) {
        L("CLEAR refused — a print is " + printState() + ". Cancel it first.", "warn");
        return Promise.resolve(false);
      }
      const s = printState();
      if (s === "standby") { L("Nothing to clear — already in standby", "warn"); return Promise.resolve(false); }
      // has() returns null when the command catalogue has not loaded yet, so stay optimistic.
      if (has(state(), "SDCARD_RESET_FILE") === false) {
        L("SDCARD_RESET_FILE is not registered on this printer — no [virtual_sdcard] section?", "err");
        return Promise.resolve(false);
      }
      const f = (raw().print_stats || {}).filename;
      return run("SDCARD_RESET_FILE — clearing " + (f ? "'" + f + "'" : "the finished job") + " (" + s + ") and returning to standby", "ok",
        () => api.gcode("SDCARD_RESET_FILE"));
    },
    /** Design's print(action) dispatcher: "PAUSE" | "RESUME" | "CANCEL". */
    printAction(action) {
      const a = String(action || "").toUpperCase();
      if (a === "PAUSE") return actions.printPause();
      if (a === "RESUME") return actions.printResume();
      if (a === "CANCEL") return actions.printCancel();
      if (a === "CLEAR") return actions.printClear();
      L("Unknown print action: " + action, "warn");
      return Promise.resolve(false);
    },
    /** M112 — no confirmation by design: it is the emergency button. */
    estop() {
      if (noApi()) return Promise.resolve(false);
      return run("M112 — EMERGENCY STOP, MCU shut down", "err", () => api.emergencyStop());
    },
    /** FIRMWARE_RESTART (the E-stop button becomes RESTART FIRMWARE while Klipper is shut down). */
    firmwareRestart() {
      if (noApi()) return Promise.resolve(false);
      return run("FIRMWARE_RESTART", "warn", () => api.firmwareRestart());
    },
    /** Klipper host process restart — used when klippy is 'disconnected' (FIRMWARE_RESTART cannot reach it). */
    klipperRestart() {
      if (noApi()) return Promise.resolve(false);
      if (typeof api.serviceRestart !== "function") return actions.firmwareRestart();
      return run("Restarting the klipper service", "warn", () => api.serviceRestart("klipper"));
    },
    /** The top-bar E-stop button: what it does depends on the Klipper state. */
    estopButton() {
      const k = klippy();
      if (k === "shutdown" || k === "error") return actions.firmwareRestart();
      if (k === "disconnected") return actions.klipperRestart();
      return actions.estop();
    },
    /** SAVE_CONFIG (restarts Klipper). The UI confirms first (ui.confirmSave). */
    saveConfig() {
      if (noApi()) return Promise.resolve(false);
      if (klippy() !== "ready") { L("SAVE_CONFIG needs Klipper ready (state: " + klippy() + ")", "warn"); return Promise.resolve(false); }
      if (isActive()) { L("SAVE_CONFIG refused — it restarts Klipper and would kill the running print", "err"); return Promise.resolve(false); }
      return run("SAVE_CONFIG — restarting Klipper", "warn", () => api.gcode("SAVE_CONFIG"));
    },
    /** EXCLUDE_OBJECT NAME=<name> — Klipper stores object names upper-cased, so the name is sent as it appears in exclude_object.objects. */
    excludeObject(name) {
      if (noApi()) return Promise.resolve(false);
      const n = String(name || "").trim();
      if (!n) { L("EXCLUDE_OBJECT — no object name", "warn"); return Promise.resolve(false); }
      if (/\s/.test(n)) { L("EXCLUDE_OBJECT — object name contains whitespace: " + n, "err"); return Promise.resolve(false); }
      const eo = raw().exclude_object || {};
      const defined = Array.isArray(eo.objects) ? eo.objects.map(o => String((o && o.name) || "")) : [];
      if (defined.length && !defined.includes(n)) { L("EXCLUDE_OBJECT — " + n + " is not an object of the current print", "warn"); return Promise.resolve(false); }
      if ((eo.excluded_objects || []).includes(n)) { L(n + " is already excluded", "warn"); return Promise.resolve(false); }
      return run("EXCLUDE_OBJECT NAME=" + n, "warn", () => api.gcode("EXCLUDE_OBJECT NAME=" + n));
    },
    /** EXCLUDE_OBJECT RESET=1 NAME=<name> — un-excludes one object. */
    includeObject(name) {
      if (noApi()) return Promise.resolve(false);
      const n = String(name || "").trim();
      if (!n) { L("EXCLUDE_OBJECT RESET — no object name", "warn"); return Promise.resolve(false); }
      if (/\s/.test(n)) { L("EXCLUDE_OBJECT RESET — object name contains whitespace: " + n, "err"); return Promise.resolve(false); }
      const eo = raw().exclude_object || {};
      if (Array.isArray(eo.excluded_objects) && eo.excluded_objects.length && !eo.excluded_objects.includes(n)) { L(n + " is not excluded", "warn"); return Promise.resolve(false); }
      return run("EXCLUDE_OBJECT RESET=1 NAME=" + n, "ok", () => api.gcode("EXCLUDE_OBJECT RESET=1 NAME=" + n));
    },
  };
  return actions;
}

export default makeJobActions;
