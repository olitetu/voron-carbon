// MACROS actions — real gcode / prefs behind the dashboard MACROS panel and its macro-library picker.
//   runMacro(name)            api.gcode(name)   (name = the real gcode_macro name, e.g. "SMART_HOME", "MMU__UNLOAD")
//   savePrefs(macros)         api.dbSet('prefs', { ...store.state.prefs, macros }) + store.set({ prefs })
//                             macros = { keys:[…visible tile names], meta:{ [name]: { g:'⌂', t:'HOME' } } }
//   setMacroMeta(name, patch) convenience: merge {g,t} into prefs.macros.meta[name] and save
//   setMacroKeys(keys)        convenience: replace the visible tile list and save
//   resetMacroPrefs()         convenience: drop all macro prefs (tiles fall back to the adapter's defaults)
// Every action logs the command (or a short intent line), awaits the API call and logs errors; nothing throws and
// nothing runs at import time.
// Usage (integrator): const act = { ...makeMacrosActions({ api, store, log }), ...otherActions };

export const MAX_MACRO_LABEL = 10;

// Klipper rejects everything but a handful of commands while it is not ready — refuse locally like the design's blocked().
const NOT_READY = new Set(["shutdown", "disconnected", "startup", "error"]);

// Macros that move the toolhead / MMU are refused while a job is actively printing (paused is fine) — the same policy
// the TOOL & EXTRUDER actions apply to tool changes. Everything else (STATUS, PAUSE, CANCEL_PRINT, timelapse frames,
// SET_PAUSE_*, Z_OFFSET_LEARN, …) runs freely. Pass { force: true } to bypass.
const MOTION_RE = /HOME|G28|G32|QGL|QUAD_GANTRY|MESH|CALIBRATE|PARK|PURGE|BLOBIFIER|CLEAN|SCRUB|LOAD|EJECT|CHECK_GATE|COLD_PULL|MOTORS|M84|SERVO|SELECT|CHANGE_TOOL|FORM_TIP|CUT|PROBE|^T\d+$/;

const errMsg = e => (e && e.message) || String(e);

/**
 * Sanitize a macros pref object: { keys?: string[], meta: { [name]: { g?: string, t?: string } } }.
 * `keys` is omitted (→ adapter defaults) unless it is an array. Empty meta entries are dropped.
 */
export function normalizeMacroPrefs(p) {
  const src = p && typeof p === "object" ? p : {};
  const out = {};
  if (Array.isArray(src.keys)) {
    const seen = new Set();
    out.keys = [];
    for (const k of src.keys) {
      if (typeof k !== "string") continue;
      const name = k.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.keys.push(name);
    }
  }
  const meta = {};
  if (src.meta && typeof src.meta === "object") {
    for (const [name, v] of Object.entries(src.meta)) {
      if (!name || !v || typeof v !== "object") continue;
      const m = {};
      if (typeof v.g === "string" && v.g.trim()) m.g = Array.from(v.g.trim()).slice(0, 2).join("");
      if (typeof v.t === "string" && v.t.trim()) m.t = v.t.toUpperCase().slice(0, MAX_MACRO_LABEL);
      if (Object.keys(m).length) meta[name] = m;
    }
  }
  out.meta = meta;
  return out;
}

export function makeMacrosActions({ api, store, log } = {}) {
  const say = (m, kind) => { try { if (typeof log === "function") log(m, kind || "info"); } catch {} };
  const state = () => (store && store.state) || {};
  const raw = () => state().raw || {};

  function blocked() {
    const k = state().klippy;
    if (k && NOT_READY.has(k)) {
      say("Command rejected — Klipper is " + k + (k === "shutdown" ? " (FIRMWARE_RESTART required)" : ""), "err");
      return true;
    }
    if (!api || typeof api.gcode !== "function") { say("Command rejected — no printer connection", "err"); return true; }
    return false;
  }

  /** True while a job is actively printing (paused does not count). */
  function printingNow() {
    const ps = raw().print_stats || {};
    const paused = !!((raw().pause_resume || {}).is_paused);
    return ps.state === "printing" && !paused;
  }

  /**
   * Run a macro (or any single gcode line) by its real name. Returns true on success.
   * opts.force skips the "moves the toolhead while printing" refusal.
   */
  async function runMacro(name, opts) {
    const cmd = String(name == null ? "" : name).trim();
    if (!cmd) { say("No macro selected", "warn"); return false; }
    if (blocked()) return false;
    const head = cmd.split(/\s+/)[0].toUpperCase();
    if (!(opts && opts.force) && printingNow() && MOTION_RE.test(head)) {
      say("Refused — " + head + " moves the toolhead/MMU while a print is running (pause first)", "warn");
      return false;
    }
    const mmu = raw().mmu;
    if (mmu && mmu.is_locked && /^(MMU_|T\d+$)/.test(head) && !/^MMU__?(RECOVER|UNLOCK|STATUS|RESET)/.test(head)) {
      say("MMU is locked — Happy Hare may refuse " + head + " until MMU_UNLOCK / MMU_RECOVER", "warn");
    }
    say(cmd);
    try {
      await api.gcode(cmd);
      return true;
    } catch (e) {
      say(errMsg(e), "err");
      return false;
    }
  }

  /**
   * Persist the macro prefs slice. The store is updated first (optimistic — the picker reacts instantly), then the
   * whole prefs object is written to Moonraker's DB (namespace carbon, key prefs). Other panels' pref keys are preserved.
   */
  async function savePrefs(macros) {
    const next = normalizeMacroPrefs(macros);
    const cur = state().prefs;
    const prefs = Object.assign({}, cur && typeof cur === "object" ? cur : {}, { macros: next });
    if (store && typeof store.set === "function") store.set({ prefs });
    if (!api || typeof api.dbSet !== "function") { say("Macro prefs kept for this session only — no printer connection", "warn"); return false; }
    try {
      await api.dbSet("prefs", prefs);
      return true;
    } catch (e) {
      say("Macro prefs not saved to printer: " + errMsg(e), "err");
      return false;
    }
  }

  const current = () => normalizeMacroPrefs((state().prefs || {}).macros);

  /** Merge { g, t } into one macro's override; an empty string clears that field (back to the default glyph/label). */
  function setMacroMeta(name, patch) {
    const key = String(name == null ? "" : name).trim();
    if (!key) return Promise.resolve(false);
    const cur = current();
    const m = Object.assign({}, cur.meta[key] || {});
    const p = patch && typeof patch === "object" ? patch : {};
    if (p.g !== undefined) { if (typeof p.g === "string" && p.g.trim()) m.g = p.g; else delete m.g; }
    if (p.t !== undefined) { if (typeof p.t === "string" && p.t.trim()) m.t = p.t; else delete m.t; }
    const meta = Object.assign({}, cur.meta);
    if (Object.keys(m).length) meta[key] = m; else delete meta[key];
    return savePrefs(Object.assign({}, cur, { meta }));
  }

  /** Replace the list of visible tiles (in display order). */
  function setMacroKeys(keys) {
    const cur = current();
    return savePrefs(Object.assign({}, cur, { keys: Array.isArray(keys) ? keys : [] }));
  }

  /** Forget every macro pref — the panel goes back to the adapter's default tiles, glyphs and labels. */
  function resetMacroPrefs() {
    return savePrefs({ meta: {} });
  }

  return { runMacro, savePrefs, setMacroMeta, setMacroKeys, resetMacroPrefs };
}

export default makeMacrosActions;
