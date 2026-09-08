// MACHINE LIMITS actions — real gcode behind the dashboard panel.
//   setLimit(key, v)
//     velocity → SET_VELOCITY_LIMIT VELOCITY=<v>                       (mm/s)
//     accel    → SET_VELOCITY_LIMIT ACCEL=<v>                          (mm/s²)
//     scv      → SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=<v>         (mm/s)
//     cruise   → SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=<v/100>       (panel shows %, Klipper wants a 0..1 ratio)
//     zoffset  → SET_GCODE_OFFSET Z=<v> MOVE=1                         (mm, absolute)
// Only the changed key is sent — never a combined SET_VELOCITY_LIMIT line (contract §"Exact gcode per action").
// Every action logs the command (or a short intent line), awaits api.gcode and logs errors; nothing throws.
// Usage: const act = makeLimitsActions({ api, store, log });   (merged with the other panels' actions by the integrator)

/** Canonical keys accepted by setLimit (aliases below map onto these). */
export const LIMIT_KEYS = ["velocity", "accel", "scv", "cruise", "zoffset"];

/**
 * Per-key definition: Klipper parameter, clamp range, decimals kept in the command, unit for log lines.
 * Ranges: SET_VELOCITY_LIMIT requires VELOCITY/ACCEL > 0, SQUARE_CORNER_VELOCITY ≥ 0, MINIMUM_CRUISE_RATIO in [0, 1);
 * the upper caps are sanity caps (a mistyped 70000 mm/s is far more likely than an intended one). Z offset ±5 mm as in the design's setZ.
 */
export const LIMIT_DEFS = {
  velocity: { param: "VELOCITY",               min: 1,   max: 5000,   dec: 1, unit: "mm/s",  label: "Velocity" },
  accel:    { param: "ACCEL",                  min: 1,   max: 100000, dec: 0, unit: "mm/s²", label: "Acceleration" },
  scv:      { param: "SQUARE_CORNER_VELOCITY", min: 0,   max: 500,    dec: 2, unit: "mm/s",  label: "Square corner velocity" },
  cruise:   { param: "MINIMUM_CRUISE_RATIO",   min: 0,   max: 99,     dec: 1, unit: "%",     label: "Min cruise ratio" },
  zoffset:  { param: "Z",                      min: -5,  max: 5,      dec: 3, unit: "mm",    label: "Z offset" }
};

const ALIASES = {
  velocity: "velocity", maxvelocity: "velocity", vel: "velocity",
  accel: "accel", acceleration: "accel", maxaccel: "accel",
  scv: "scv", squarecornervelocity: "scv", squarecornervel: "scv",
  cruise: "cruise", minimumcruiseratio: "cruise", mincruiseratio: "cruise", cruiseratio: "cruise",
  zoffset: "zoffset", zoff: "zoffset", z: "zoffset", homingorigin: "zoffset"
};

/** 'Square Corner Vel' / 'square_corner_velocity' / 'scv' → 'scv'; unknown → null. */
export function normalizeLimitKey(key) {
  if (key === null || key === undefined) return null;
  const k = String(key).toLowerCase().replace(/[\s_\-.]+/g, "");
  return ALIASES[k] || null;
}

/** Number → shortest decimal string with at most `dec` decimals ("1000", "9.5", "0.170" stays "0.17" for gcode). */
function fmtCmd(n, dec) {
  const s = (+n.toFixed(dec)).toString();
  return s.indexOf("e") >= 0 ? n.toFixed(dec) : s;
}

/**
 * Pure: build the gcode for one key. Returns { key, cmd, value, clamped, def } or { key, error }.
 * `value` is the clamped value in panel units (%, mm/s, mm…); the ratio conversion happens only inside `cmd`.
 */
export function limitCommand(key, v) {
  const k = normalizeLimitKey(key);
  if (!k) return { key, error: "Unknown limit '" + key + "'" };
  const def = LIMIT_DEFS[k];
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  if (!isFinite(n)) return { key: k, error: def.label + " ignored — not a number" };
  const value = +Math.max(def.min, Math.min(def.max, n)).toFixed(def.dec);
  const clamped = Math.abs(value - n) > Math.pow(10, -def.dec) / 2;
  let cmd;
  if (k === "zoffset") cmd = "SET_GCODE_OFFSET Z=" + value.toFixed(3) + " MOVE=1";
  else if (k === "cruise") cmd = "SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=" + fmtCmd(value / 100, 3);
  else cmd = "SET_VELOCITY_LIMIT " + def.param + "=" + fmtCmd(value, def.dec);
  return { key: k, cmd, value, clamped, def };
}

export function makeLimitsActions({ api, store, log } = {}) {
  const say = (m, kind) => { try { if (typeof log === "function") log(m, kind || "info"); } catch {} };
  const state = () => (store && store.state) || {};
  const raw = () => state().raw || {};

  /** Klipper unavailable → reject like the design's blocked(). */
  function blocked() {
    const k = state().klippy;
    if (k === "shutdown" || k === "disconnected" || k === "startup" || k === "error") {
      say("Command rejected — Klipper is " + k + (k === "shutdown" ? " (FIRMWARE_RESTART required)" : ""), "err");
      return true;
    }
    if (!api || typeof api.gcode !== "function") { say("Command rejected — no printer connection", "err"); return true; }
    return false;
  }

  async function run(script, okMsg) {
    try {
      await api.gcode(script);
      if (okMsg) say(okMsg, "ok");
      return true;
    } catch (e) {
      say((e && e.message) || String(e), "err");
      return false;
    }
  }

  /**
   * key: 'velocity' | 'accel' | 'scv' | 'cruise' (percent) | 'zoffset' (mm) — design labels and Klipper field names are accepted too.
   * Sends only that one limit. Resolves true when the printer accepted the command.
   */
  async function setLimit(key, v) {
    if (blocked()) return false;
    const c = limitCommand(key, v);
    if (c.error) { say(c.error, "warn"); return false; }
    if (c.clamped) say(c.def.label + " clamped to " + c.def.min + "…" + c.def.max + " " + c.def.unit, "warn");
    const th = raw().toolhead;
    if (c.key === "cruise" && th && (th.minimum_cruise_ratio === undefined || th.minimum_cruise_ratio === null) &&
        typeof th.max_accel_to_decel === "number") {
      say("This Klipper has no MINIMUM_CRUISE_RATIO (legacy max_accel_to_decel) — update Klipper to edit it", "warn");
      return false;
    }
    let cmd = c.cmd;
    if (c.key === "zoffset") {
      // MOVE=1 makes Klipper apply the new offset with a G1 — which raises "Must home axis first" when Z is unhomed
      // (the offset is still stored, but the command errors). Store-only in that case and say so.
      const homed = String((th && th.homed_axes) || "").toLowerCase();
      if (th && homed.indexOf("z") < 0) {
        cmd = "SET_GCODE_OFFSET Z=" + c.value.toFixed(3);
        say("Z not homed — offset stored, toolhead not moved", "warn");
      }
    }
    say(cmd);
    const shown = c.key === "zoffset" ? c.value.toFixed(3) : fmtCmd(c.value, c.def.dec);
    return run(cmd, c.def.label + " → " + shown + " " + c.def.unit);
  }

  return { setLimit };
}

export default makeLimitsActions;
