// Carbon's persisted preferences: ONE object in Moonraker's database (namespace `carbon`, key `prefs`), shared
// by every Carbon client — the Orca dashboard and the touchscreen read the same values, so a jog speed set in
// one is the jog speed in the other. Before this, both hard-coded their own copies (G1 F6000/F600 in two files).
//
//   prefs.control  jog steps + speeds, extrude lengths + speeds     (the settings panel behind the top-bar cog)
//   prefs.general  printer display name
//   prefs.macros   macro tile layout                                (owned by actions/macros.js)
//
// Readers go through controlPrefs()/generalPrefs(), which sanitise whatever is stored: a hand-edited or
// half-written database entry degrades to the defaults field by field instead of reaching a G1 command.

/** Defaults. Jog steps/speeds are what Carbon shipped with; extrude presets are the owner's (2026-09-23). */
export const CONTROL_DEFAULTS = Object.freeze({
  stepsXY: [100, 50, 1],            // mm — coarse, medium, fine: the dashboard draws exactly three a side
  stepsZ: [50, 10, 1],
  feedXY: 100,                      // mm/s
  feedZ: 10,                        // mm/s
  extrudeLengths: [10, 25, 50, 100], // mm
  extrudeRates: [5, 10, 20, 25],     // mm/s
});
export const GENERAL_DEFAULTS = Object.freeze({ printerName: "VORON 2.4" });

/** Hard bounds. Anything outside them is refused by the panel and ignored if found stored. */
export const LIMITS = Object.freeze({
  step: [0.01, 500], feedXY: [1, 500], feedZ: [0.5, 50], extrudeLength: [1, 200], extrudeRate: [0.5, 50],
});

const inRange = (v, [lo, hi]) => typeof v === "number" && isFinite(v) && v >= lo && v <= hi;
const list = (v, n, lim, fallback) =>
  Array.isArray(v) && v.length === n && v.every(x => inRange(x, lim)) ? v.slice() : fallback.slice();
const one = (v, lim, fallback) => (inRange(v, lim) ? v : fallback);

/** Sanitised control prefs: every field either valid or its default. */
export function controlPrefs(state) {
  const c = ((state && state.prefs) || {}).control || {};
  const d = CONTROL_DEFAULTS;
  return {
    stepsXY: list(c.stepsXY, 3, LIMITS.step, d.stepsXY),
    stepsZ: list(c.stepsZ, 3, LIMITS.step, d.stepsZ),
    feedXY: one(c.feedXY, LIMITS.feedXY, d.feedXY),
    feedZ: one(c.feedZ, LIMITS.feedZ, d.feedZ),
    extrudeLengths: list(c.extrudeLengths, 4, LIMITS.extrudeLength, d.extrudeLengths),
    extrudeRates: list(c.extrudeRates, 4, LIMITS.extrudeRate, d.extrudeRates),
  };
}

export function generalPrefs(state) {
  const g = ((state && state.prefs) || {}).general || {};
  const name = typeof g.printerName === "string" ? g.printerName.trim().slice(0, 24) : "";
  return { printerName: name || GENERAL_DEFAULTS.printerName };
}

/** Jog feed in mm/min for G1, per axis. */
export function jogFeed(state, axis) {
  const c = controlPrefs(state);
  return Math.round((String(axis).toUpperCase() === "Z" ? c.feedZ : c.feedXY) * 60);
}

/**
 * Write one or more slices of prefs in ONE database write. The store updates first (optimistic — whatever reads it
 * reacts at once), then the WHOLE prefs object is written, so untouched slices survive. Resolves true only when the
 * printer accepted it.
 */
export function savePrefSlice(ctx, key, value) { return savePrefSlices(ctx, { [key]: value }); }

export async function savePrefSlices({ api, store, log }, patch) {
  const say = (m, k) => { try { if (typeof log === "function") log(m, k); } catch (e) { /* best-effort */ } };
  const cur = (store && store.state && store.state.prefs) || {};
  const prefs = Object.assign({}, typeof cur === "object" ? cur : {}, patch);
  if (store && typeof store.set === "function") store.set({ prefs });
  if (!api || typeof api.dbSet !== "function") { say("Settings kept for this session only — no printer connection", "warn"); return false; }
  try {
    await api.dbSet("prefs", prefs);
    return true;
  } catch (e) {
    say("Settings not saved to the printer: " + ((e && e.message) || e), "err");
    return false;
  }
}
