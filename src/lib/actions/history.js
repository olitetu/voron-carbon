// HISTORY page actions: re-print a past job, delete one history record, wipe the whole history.
// Contract: CONTRACT.md "Pages → history" (reprint → api.startPrint, delete → server.history.delete_job).
//
//   reprint(filename)      → api.startPrint(filename)     (refused while a print is active / Klipper is not ready)
//   deleteJob(uid, label)  → api.historyDelete(uid)       (the UI confirms first — Confirm strip in the JOBS panel)
//   deleteAll(count)       → api.historyDeleteAll()       (the UI double-confirms; refused while a print is active)
//
// Same contract as the other action modules: every action logs its intent, awaits the RPC, logs failures instead of
// throwing, and resolves true only when Moonraker accepted the command.
//
// Deleting a history record touches ONLY Moonraker's job database — the g-code file stays on disk. The reverse is
// also true (a job whose file was deleted keeps its record, with `exists:false`), which is why reprint can only be
// refused here for printer-state reasons: whether the file still exists is a property of the job row, so the page
// disables the button for `exists:false` before it ever gets here.
export function makeHistoryActions({ api, store, log } = {}) {
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
    /** Re-print a file straight from its history row. The UI confirms first (a print starts immediately). */
    reprint(filename) {
      if (noApi()) return Promise.resolve(false);
      const f = String(filename || "").trim();
      if (!f) { L("Reprint — no filename in this history entry", "warn"); return Promise.resolve(false); }
      if (isActive()) { L("Reprint refused — " + (isPaused() ? "a print is paused on the bed" : "a print is already running"), "err"); return Promise.resolve(false); }
      if (klippy() !== "ready") { L("Reprint needs Klipper ready (state: " + klippy() + ")", "warn"); return Promise.resolve(false); }
      return run("PRINT " + f, "ok", () => api.startPrint(f));
    },
    /** Delete one job record. `label` is only for the log line — Moonraker addresses jobs by uid (job_id). */
    deleteJob(uid, label) {
      if (noApi()) return Promise.resolve(false);
      const id = String(uid == null ? "" : uid).trim();
      if (!id) { L("Delete refused — this history entry has no job id", "err"); return Promise.resolve(false); }
      return run("Deleting history job " + id + (label ? " — " + label : ""), "warn", () => api.historyDelete(id));
    },
    /**
     * Erase every job record. Refused while a print is active: the running job is itself a row (status
     * `in_progress`), so wiping the table mid-print throws away the record Moonraker is still writing to.
     */
    deleteAll(count) {
      if (noApi()) return Promise.resolve(false);
      if (isActive()) { L("Delete-all refused — the running print is still writing its history row", "err"); return Promise.resolve(false); }
      const n = typeof count === "number" && isFinite(count) ? count : null;
      return run("Deleting ALL history records" + (n === null ? "" : " (" + n + " jobs)"), "err", () => api.historyDeleteAll());
    },
  };
  return actions;
}

export default makeHistoryActions;
