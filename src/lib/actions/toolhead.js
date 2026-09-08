// TOOLHEAD actions — real gcode behind the dashboard panel (CONTRACT.md "Exact gcode per action").
//   jog(axis, d)    G91 \n G1 <axis><d> F<Z: 600 | X/Y: 6000> \n G90
//                   refused when <axis> is not in toolhead.homed_axes ("Must home axis first (G28)") or while a print is
//                   running (a paused print is fine). The target is clamped to the printer's travel: Klipper's live
//                   toolhead.axis_minimum / axis_maximum (0..335 / 0..355 / −2..320 on this Voron) with the contract's
//                   0..350 / 0..350 / 0..310 as the fallback before the first status update.
//   home(kind)      HOME → G28 · XY → G28 X Y · QGL → QUAD_GANTRY_LEVEL · MESH → BED_MESH_CALIBRATE   (+ X / Y / Z → G28 <axis>)
//                   refused while printing. QGL / MESH are pre-checked for homing ("Must home axis first (G28)") unless
//                   printer.cfg wraps the command in a gcode_macro of the same name (this printer wraps BED_MESH_CALIBRATE).
//   nudgeZ(d)       SET_GCODE_OFFSET Z_ADJUST=<d> MOVE=1     baby-stepping — allowed while printing (that is what it is for)
//   setZ(v)         SET_GCODE_OFFSET Z=<v> MOVE=1            absolute offset, clamped to ±5 mm like the design's setZ
//   saveZ()         Z_OFFSET_APPLY_PROBE → "… SAVE_CONFIG pending"  (Cartographer touch mode; SAVE_CONFIG is the shell's own button)
//   MOVE=1 is dropped (the offset applies on the next move) when Z is not homed — Klipper would otherwise raise "Must home axis first".
// Long-running scripts (G28 / QUAD_GANTRY_LEVEL / BED_MESH_CALIBRATE) can outlive Moonraker.rpc's 30 s timeout while Klipper is
// still busy: that timeout is reported as "still running" (info), not as an error — the real result arrives via gcode_response.
// Every action logs the command (or a short intent line), awaits api.gcode and logs errors; nothing throws.
// Usage: const act = makeToolheadActions({ api, store, log });   (merged with the other panels' actions by the integrator)

/** Contract travel limits — used only until Klipper reports toolhead.axis_minimum / axis_maximum. */
export const AXIS_MAX = { X: 350, Y: 350, Z: 310 };
export const AXIS_MIN = { X: 0, Y: 0, Z: 0 };
/** Jog feedrates in mm/min: 100 mm/s on X/Y, 10 mm/s on Z (contract). */
export const JOG_FEED = { X: 6000, Y: 6000, Z: 600 };
/** Absolute Z offset accepted by setZ (design: Math.max(-5, Math.min(5, v))). */
export const Z_OFFSET_LIMIT = 5;
/** Largest single Z_ADJUST nudge accepted (the panel offers ±0.005 / ±0.025). */
export const Z_STEP_LIMIT = 1;

export const HOME_CMDS = {
  HOME: "G28", XY: "G28 X Y", X: "G28 X", Y: "G28 Y", Z: "G28 Z",
  QGL: "QUAD_GANTRY_LEVEL", MESH: "BED_MESH_CALIBRATE"
};
const HOME_ALIASES = {
  home: "HOME", all: "HOME", xyz: "HOME", g28: "HOME",
  xy: "XY", g28xy: "XY", x: "X", y: "Y", z: "Z",
  qgl: "QGL", quadgantrylevel: "QGL", mesh: "MESH", bedmesh: "MESH", bedmeshcalibrate: "MESH"
};

/** Finite number or null (Moonraker fields can be null/undefined before the first status update). */
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

/** Number → shortest decimal string with at most `dec` decimals ("100", "-0.005", "34.56"); never exponent notation. */
export function fmtNum(n, dec = 3) {
  const s = (+n.toFixed(dec)).toString();
  return s.indexOf("e") >= 0 ? n.toFixed(dec) : s;
}

/** 'x' / 'X' → 'X'; anything else → null. */
export function normalizeAxis(axis) {
  const a = String(axis === null || axis === undefined ? "" : axis).trim().toUpperCase();
  return a === "X" || a === "Y" || a === "Z" ? a : null;
}

/** 'HOME' / 'XY' / 'QGL' / 'MESH' (design labels) or the Klipper command names → canonical kind; unknown → null. */
export function normalizeHomeKind(kind) {
  if (kind === null || kind === undefined) return null;
  const k = String(kind).toLowerCase().replace(/[\s_\-.]+/g, "");
  return HOME_ALIASES[k] || null;
}

/** Index of an axis in Klipper's position arrays. */
const AXIS_INDEX = { X: 0, Y: 1, Z: 2 };

/**
 * Travel limits per axis from live toolhead.axis_minimum / axis_maximum, falling back to the contract's numbers.
 * → { X: { min, max, live }, Y: {…}, Z: {…} } — `live` says whether Klipper (not the fallback) supplied the value.
 */
export function axisLimits(raw) {
  const th = (raw && raw.toolhead) || {};
  const mins = Array.isArray(th.axis_minimum) ? th.axis_minimum : [];
  const maxs = Array.isArray(th.axis_maximum) ? th.axis_maximum : [];
  const out = {};
  for (const ax of ["X", "Y", "Z"]) {
    const i = AXIS_INDEX[ax];
    const lo = num(mins[i]), hi = num(maxs[i]);
    const live = hi !== null && hi > 0 && lo !== null && lo < hi;
    out[ax] = { min: live ? lo : AXIS_MIN[ax], max: live ? hi : AXIS_MAX[ax], live };
  }
  return out;
}

/** True when `axis` appears in toolhead.homed_axes (Klipper reports lowercase, e.g. "xyz"). */
export function isHomed(raw, axis) {
  const ax = normalizeAxis(axis);
  const th = (raw && raw.toolhead) || {};
  return !!ax && String(th.homed_axes || "").toLowerCase().indexOf(ax.toLowerCase()) >= 0;
}

/** True when X, Y and Z are all homed. */
export function allHomed(raw) { return isHomed(raw, "X") && isHomed(raw, "Y") && isHomed(raw, "Z"); }

/** Current commanded position of an axis (toolhead.position) or null. */
export function axisPosition(raw, axis) {
  const ax = normalizeAxis(axis);
  const th = (raw && raw.toolhead) || {};
  return ax && Array.isArray(th.position) ? num(th.position[AXIS_INDEX[ax]]) : null;
}

/** Live Z gcode offset (gcode_move.homing_origin[2]) or null. */
export function zOffsetOf(raw) {
  const gm = (raw && raw.gcode_move) || {};
  return Array.isArray(gm.homing_origin) ? num(gm.homing_origin[2]) : null;
}

/**
 * Pure: build the relative jog script for one axis from the current store state.
 * Returns { axis, cmd, shown, delta, requested, target, clamped, limit } or { axis, error }.
 * `cmd` is exactly `G91\nG1 <axis><delta> F<feed>\nG90`; the trailing mode restore becomes G91 when the printer is
 * currently in relative mode (gcode_move.absolute_coordinates === false) so a jog never silently switches modes.
 */
export function jogCommand(raw, axis, d) {
  const ax = normalizeAxis(axis);
  if (!ax) return { axis, error: "Unknown axis '" + axis + "'" };
  const requested = typeof d === "string" ? parseFloat(d) : Number(d);
  if (!isFinite(requested) || requested === 0) return { axis: ax, error: "Jog ignored — distance must be a non-zero number" };
  const th = (raw && raw.toolhead) || null;
  if (!th || th.homed_axes === undefined) return { axis: ax, error: "Toolhead state unknown — refusing to move" };
  if (!isHomed(raw, ax)) return { axis: ax, error: "Must home axis first (G28)" };
  const limit = axisLimits(raw)[ax];
  const pos = axisPosition(raw, ax);
  let delta = requested, target = null, clamped = false;
  if (pos !== null) {
    target = pos + requested;
    if (target < limit.min) { target = limit.min; clamped = true; }
    if (target > limit.max) { target = limit.max; clamped = true; }
    delta = +(target - pos).toFixed(3);
    if (clamped && Math.abs(delta) < 0.0005) {
      return { axis: ax, error: "Move out of range: " + ax + " limit " + fmtNum(limit.min) + "–" + fmtNum(limit.max) + " mm", outOfRange: true, limit };
    }
    target = +target.toFixed(3);
  }
  const feed = JOG_FEED[ax];
  const gm = (raw && raw.gcode_move) || {};
  const restore = gm.absolute_coordinates === false ? "G91" : "G90";
  const cmd = "G91\nG1 " + ax + fmtNum(delta) + " F" + feed + "\n" + restore;
  const shown = "G91 · G1 " + ax + (delta > 0 ? "+" : "") + fmtNum(delta) + " F" + feed + " · " + restore;
  return { axis: ax, cmd, shown, delta, requested, target, clamped, limit };
}

/** Pure: Z_ADJUST script. { cmd, shown, delta, move } or { error }. `move` false drops MOVE=1 (Z not homed). */
export function zAdjustCommand(d, move = true) {
  const n = typeof d === "string" ? parseFloat(d) : Number(d);
  if (!isFinite(n) || n === 0) return { error: "Z nudge ignored — distance must be a non-zero number" };
  if (Math.abs(n) > Z_STEP_LIMIT) return { error: "Z nudge ignored — " + fmtNum(Math.abs(n)) + " mm exceeds the " + Z_STEP_LIMIT + " mm single-step limit" };
  const delta = +n.toFixed(3);
  if (delta === 0) return { error: "Z nudge ignored — below 0.001 mm resolution" };
  const tail = move ? " MOVE=1" : "";
  return {
    cmd: "SET_GCODE_OFFSET Z_ADJUST=" + fmtNum(delta) + tail,
    shown: "SET_GCODE_OFFSET Z_ADJUST=" + (delta > 0 ? "+" : "") + fmtNum(delta) + tail,   // design logs the sign
    delta, move: !!move
  };
}

/** Pure: absolute Z offset script. { cmd, value, clamped, move } or { error }. */
export function zSetCommand(v, move = true) {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  if (!isFinite(n)) return { error: "Z offset ignored — not a number" };
  const value = +Math.max(-Z_OFFSET_LIMIT, Math.min(Z_OFFSET_LIMIT, n)).toFixed(3);
  return {
    cmd: "SET_GCODE_OFFSET Z=" + value.toFixed(3) + (move ? " MOVE=1" : ""),
    value, clamped: Math.abs(value - n) > 0.0005, move: !!move
  };
}

export function makeToolheadActions({ api, store, log } = {}) {
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

  /** True while a job is actively printing (a paused print does not count — jogging/homing is how a paused print gets rescued). */
  function printingNow() {
    const ps = raw().print_stats || {};
    const paused = !!((raw().pause_resume || {}).is_paused);
    return ps.state === "printing" && !paused;
  }

  /**
   * printer.cfg has a [gcode_macro <name>] wrapper for a Klipper command (e.g. a KAMP
   * BED_MESH_CALIBRATE that homes/QGLs itself).
   *
   * Case-insensitive: Klipper upper-cases a macro's alias while objects.list preserves the config's
   * casing, so this printer carries both `last_scrub`/`LAST_SCRUB` and `_KAMP_Settings`/`_KAMP_SETTINGS`.
   * An exact-case indexOf returned false misses on exactly those.
   */
  function hasMacro(name) {
    const objs = state().objects;
    if (!Array.isArray(objs)) return false;
    const want = "gcode_macro " + String(name || "").toUpperCase();
    return objs.some(o => o.toUpperCase() === want);
  }
  function hasObject(name) {
    const objs = state().objects;
    return Array.isArray(objs) && objs.indexOf(name) >= 0;
  }

  /**
   * Send a script. `long` marks commands that may legitimately outlive the 30 s rpc timeout (G28, QGL, mesh) — for those a
   * timeout means "still running", not failure. Resolves true when Klipper accepted the script (or it is still running).
   */
  async function run(script, okMsg, long) {
    try {
      await api.gcode(script);
      if (okMsg) say(okMsg, "ok");
      return true;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (long && /^timeout/i.test(msg)) {
        say(script.split("\n")[0] + " still running — no reply within 30 s, the result will show in the console");
        return true;
      }
      say(msg, "err");
      return false;
    }
  }

  /**
   * Relative jog of one axis by d mm (design steps: X/Y ±100/50/1, Z ±50/10/1).
   * Refused when the axis is not homed, the toolhead state is unknown, or a print is running. Clamped to the travel limits;
   * a move that would not leave the current position is refused as "Move out of range" like the design.
   */
  async function jog(axis, d) {
    if (blocked()) return false;
    const ax = normalizeAxis(axis);
    if (!ax) { say("Unknown axis '" + axis + "'", "warn"); return false; }
    if (printingNow()) { say("Refused — jog while printing (pause it first)", "warn"); return false; }
    const c = jogCommand(raw(), ax, d);
    if (c.error) { say(c.error, "warn"); return false; }
    if (c.clamped) say(ax + " move clamped to " + fmtNum(c.target) + " mm (limit " + fmtNum(c.limit.min) + "–" + fmtNum(c.limit.max) + " mm)", "warn");
    say(c.shown);
    return run(c.cmd);
  }

  /**
   * kind: 'HOME' | 'XY' | 'QGL' | 'MESH' (design buttons) — also 'X' | 'Y' | 'Z' and the Klipper command names.
   * Homing is refused while a print is running. QGL / MESH require a homed toolhead unless a same-named macro wraps them.
   */
  async function home(kind) {
    if (blocked()) return false;
    const k = normalizeHomeKind(kind);
    if (!k) { say("Unknown home action '" + kind + "'", "warn"); return false; }
    const cmd = HOME_CMDS[k];
    if (printingNow()) { say("Refused — " + cmd + " while printing (pause it first)", "warn"); return false; }
    const r = raw();
    const objsKnown = Array.isArray(state().objects) && state().objects.length > 0;
    if (k === "QGL" || k === "MESH") {
      const wrapped = hasMacro(cmd);
      const section = k === "QGL" ? "quad_gantry_level" : "bed_mesh";
      if (objsKnown && !wrapped && !hasObject(section)) { say(cmd + " unavailable — no [" + section + "] section in printer.cfg", "warn"); return false; }
      if (!wrapped && !allHomed(r)) { say("Must home axis first (G28)", "warn"); return false; }
      if (k === "MESH" && !wrapped && r.quad_gantry_level && r.quad_gantry_level.applied === false) {
        say("QGL not applied — the mesh will be probed on an unleveled gantry", "warn");
      }
    }
    const intent = { HOME: " — homing all axes", XY: " — homing X/Y", X: " — homing X", Y: " — homing Y", Z: " — homing Z", QGL: " — leveling gantry", MESH: " — probing bed mesh" }[k];
    say(cmd + intent);
    const done = { HOME: "G28 — all axes homed", XY: "G28 X Y — X/Y homed", X: "G28 X — X homed", Y: "G28 Y — Y homed", Z: "G28 Z — Z homed", QGL: "QUAD_GANTRY_LEVEL complete", MESH: "BED_MESH_CALIBRATE complete" }[k];
    return run(cmd, done, true);
  }

  /** Baby-step the Z gcode offset by d mm (panel: ±0.005 / ±0.025). Allowed while printing. */
  /** Optimistic: Moonraker's confirming status push is ~270 ms behind the 6 ms ack. */
  function predict(patch) { if (store && typeof store.predict === "function") store.predict(patch); }

  async function nudgeZ(d) {
    if (blocked()) return false;
    const r = raw();
    const move = isHomed(r, "Z");
    const c = zAdjustCommand(d, move);
    if (c.error) { say(c.error, "warn"); return false; }
    const cur = zOffsetOf(r);
    const next = cur === null ? null : +(cur + c.delta).toFixed(3);
    if (next !== null && Math.abs(next) > Z_OFFSET_LIMIT) {
      say("Refused — Z offset would reach " + next.toFixed(3) + " mm (limit ±" + Z_OFFSET_LIMIT + " mm)", "warn");
      return false;
    }
    if (next !== null) {
      const ho = ((r.gcode_move || {}).homing_origin || [0, 0, 0, 0]).slice();
      ho[2] = next;
      predict({ gcode_move: { homing_origin: ho } });
    }
    say(c.shown + (move ? "" : "  (Z not homed — offset applies on the next move)"));
    return run(c.cmd, next === null ? undefined : "Z offset → " + next.toFixed(3) + " mm");
  }

  /** Set the absolute Z gcode offset (mm, clamped ±5). Unchanged values are not re-sent. */
  async function setZ(v) {
    if (blocked()) return false;
    const r = raw();
    const move = isHomed(r, "Z");
    const c = zSetCommand(v, move);
    if (c.error) { say(c.error, "warn"); return false; }
    if (c.clamped) say("Z offset clamped to ±" + Z_OFFSET_LIMIT + " mm", "warn");
    const cur = zOffsetOf(r);
    if (cur !== null && Math.abs(cur - c.value) < 0.0005) { say("Z offset already " + c.value.toFixed(3) + " mm"); return false; }
    say(c.cmd + (move ? "" : "  (Z not homed — offset applies on the next move)"));
    return run(c.cmd, "Z offset → " + c.value.toFixed(3) + " mm");
  }

  /**
   * Z_OFFSET_APPLY_PROBE: fold the live Z gcode offset into the probe's saved z_offset (Cartographer touch mode).
   * Klipper only stages the change — the UI reports "SAVE_CONFIG pending" and configfile.save_config_pending turns on;
   * the shell's SAVE CONFIG button issues the restart. A zero offset is refused (Klipper would answer "Nothing to do").
   */
  async function saveZ() {
    if (blocked()) return false;
    const off = zOffsetOf(raw());
    if (off === null) { say("Z offset unknown — nothing to save", "warn"); return false; }
    if (Math.abs(off) < 0.0005) { say("Nothing to do: Z offset is 0.000 mm — nudge it first, then SAVE", "warn"); return false; }
    say("Z_OFFSET_APPLY_PROBE");
    const ok = await run("Z_OFFSET_APPLY_PROBE");
    if (ok) say("Z_OFFSET_APPLY_PROBE — saved " + off.toFixed(3) + " mm, SAVE_CONFIG pending", "ok");
    return ok;
  }

  return { jog, home, nudgeZ, setZ, saveZ };
}

export default makeToolheadActions;
