// UPLOAD & PRINT — the top-bar button and the drop-anywhere overlay both end here. Contract: CONTRACT.md "Upload & Print".
//
//   uploadAndPrint(files, onState) → api.fileUpload(file, 'gcodes', '', onPct, { print: 'true' })   FIRST file, printGate().canPrint
//                                    api.fileUpload(file, 'gcodes', '', onPct)                      every other case
//
// The `print` form field is what starts the job server-side (Moonraker's file_manager reads the literal string
// "true"). It is NEVER sent unless printGate() says so — never while print_stats.state is printing/paused
// (queue_gcode_uploads is false on this printer, so such an upload answers 201 and silently does nothing, and a
// UI that then said "PRINTING" would lie), and never while this client has no print_stats / Klipper snapshot.
// Files go one at a time: they run to 400 MB and land on the SD card Klipper is streaming the current print from.
//
// onState(s) is called on every whole-percent step and at each outcome; the dashboard's top-bar button renders it:
//   { phase:'uploading', name, index, count, pct (0..1), loaded, total, wantPrint, busy }
//   { phase:'done', outcome:'printing'|'uploaded'|'uploaded_busy', name, count, printed, busy }
//   { phase:'error', name, reason, index, count }
// Same shape as the other action modules: log the intent, await the RPC, log the failure instead of throwing.

/** What UPLOAD & PRINT accepts (a deliberately narrower set than the Files page: no .ufp archives here). */
export const UPLOAD_EXT = /\.(gcode|gco|g)$/i;
export const isUploadable = name => UPLOAD_EXT.test(String(name || ""));
/** bytes -> "12.3" (MB, one decimal; whole numbers past 100 MB so "398/398 MB" stays short). */
export const mb = n => { const v = (Number(n) || 0) / 1048576; return v >= 100 ? String(Math.round(v)) : v.toFixed(1); };

const errMsg = e => (e && e.message) || String(e);
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const KLIPPY_WORD = { startup: "starting up", shutdown: "shut down", error: "in error", disconnected: "disconnected", unknown: "not ready yet" };

/**
 * The ONE place that decides whether an upload may carry `print=true`, shared by this action and by the
 * top-bar label (adapters/shell.js) so the button can never promise a print the upload will not start.
 *   canPrint = we have a print_stats snapshot AND Klipper is ready AND nothing is printing/paused
 * `known` matters: for the first second of a page load (and Orca reloads the page constantly) print_stats
 * has not arrived yet, and "no state" must read as "do not start anything", never as "standby" — dropping a
 * file into that window used to send print=true against a printer whose state this client had never seen.
 */
export function printGate(state) {
  const s = state || {};
  const raw = s.raw || {};
  const ps = raw.print_stats || null;
  const phase = String((ps && ps.state) || "").toLowerCase();
  const paused = phase === "paused" || !!(raw.pause_resume || {}).is_paused;
  const busy = phase === "printing" || paused;
  const known = !!ps;
  const klippy = String(s.klippy || "unknown");
  const ready = klippy === "ready";
  return {
    known, busy, paused, ready, klippy, phase: phase || "standby",
    canPrint: known && ready && !busy,
    // lower-case sentence fragment: "… — <why>, uploaded and not started"
    why: busy ? "a print is " + (paused ? "paused" : "running")
      : !known ? "the printer state is not known yet"
        : !ready ? "Klipper is " + (KLIPPY_WORD[klippy] || klippy) : "",
  };
}

export function makeUploadActions({ api, store, log } = {}) {
  const L = (m, k) => { try { if (typeof log === "function") log(m, k || "info"); } catch (e) { /* console-panel logging is best-effort */ } };
  const state = () => (store && store.state) || {};
  const gate = () => printGate(state());

  const actions = {
    /** True while a job is printing or paused — the moment `print=true` must not be sent. */
    printBusy: () => gate().busy,

    /**
     * @param opts.noPrint  Upload only; never send print=true. Used by the drag-and-drop path: a drop is easy
     *   to do by accident (a file dragged past the window, a fumbled Finder drag) and starting a print is a
     *   physical action. The top-bar button is the deliberate "upload AND print" affordance.
     */
    async uploadAndPrint(files, onState, opts) {
      const emit = s => { try { if (typeof onState === "function") onState(s); } catch (e) { /* the button re-render is best-effort */ } };
      const fail = (reason, extra) => { const s = Object.assign({ phase: "error", reason }, extra || {}); emit(s); return s; };
      const list = Array.from(files || []).filter(f => f && f.name);
      if (!api) { L("Upload rejected — no printer connection", "err"); return fail("no printer connection"); }
      if (!list.length) { L("UPLOAD — nothing to send", "warn"); return fail("nothing to send"); }
      const good = list.filter(f => isUploadable(f.name));
      for (const f of list) if (!isUploadable(f.name)) L("Skipped " + f.name + " — UPLOAD & PRINT takes .gcode / .gco / .g only", "warn");
      if (!good.length) return fail("ONLY .GCODE FILES");

      // Decided ONCE, up front: the print flag goes on the first file only, and only when nothing is running.
      const g = gate();
      const busy = g.busy;
      if (!g.canPrint) L(cap(g.why) + " — " + (good.length > 1 ? good.length + " files" : good[0].name) + " will be uploaded, not started", "warn");

      let printed = null;
      for (let i = 0; i < good.length; i++) {
        const f = good[i];
        const wantPrint = i === 0 && g.canPrint && !(opts && opts.noPrint);
        const base = { phase: "uploading", name: f.name, index: i, count: good.length, total: f.size || 0, loaded: 0, pct: 0, wantPrint, busy };
        emit(base);
        L("UPLOAD " + f.name + " (" + mb(f.size) + " MB)" + (wantPrint ? " → print when it lands" : ""), wantPrint ? "ok" : "info");
        try {
          let last = -1;
          const res = await api.fileUpload(f, "gcodes", "", p => {
            // XHR reports every few KB; repaint on whole percent only or a 400 MB file re-renders the top bar thousands of times.
            const pct = Math.round(p * 100);
            if (pct === last) return;
            last = pct;
            emit(Object.assign({}, base, { pct: p, loaded: Math.round(p * (f.size || 0)) }));
          }, wantPrint ? { print: "true" } : undefined);
          // Moonraker answers { item, print_started, print_queued, action } (wrapped in `result` over REST).
          const r = (res && res.result) || res || {};
          if (wantPrint) {
            if (r.print_started === false) L("Uploaded " + f.name + " — Moonraker did not start it" + (r.print_queued ? " (queued)" : ""), "warn");
            else { printed = f.name; L("PRINT " + f.name + " — started by the upload", "ok"); }
          } else {
            L("Uploaded " + f.name + (busy ? " — a print is running, not started" : ""), "ok");
          }
        } catch (e) {
          L("Upload failed: " + f.name + " — " + errMsg(e), "err");
          return fail(errMsg(e), { name: f.name, index: i, count: good.length });   // stop the sequence: the rest would land in the same state
        }
      }
      const done = { phase: "done", outcome: printed ? "printing" : busy ? "uploaded_busy" : "uploaded", name: good[good.length - 1].name, count: good.length, printed, busy };
      emit(done);
      return done;
    },
  };
  return actions;
}

export default makeUploadActions;
