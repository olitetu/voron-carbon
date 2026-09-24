// TOOLHEAD actions — real gcode behind the dashboard panel (CONTRACT.md "Exact gcode per action").
//   jog(axis, d)    G91 \n G1 <axis><d> F<Z: 600 | X/Y: 6000> \n G90
//                   refused when <axis> is not in toolhead.homed_axes ("Must home axis first (G28)") or while a print is
//                   running (a paused print is fine). The target is clamped to the printer's travel: Klipper's live
//                   toolhead.axis_minimum / axis_maximum (0..335 / 0..355 / −2..320 on this Voron) with the contract's
//                   0..350 / 0..350 / 0..310 as the fallback before the first status update.
//   home(kind)      HOME → G28 · XY → G28 X Y · QGL → QUAD_GANTRY_LEVEL · MESH → BED_MESH_CALIBRATE   (+ X / Y / Z → G28 <axis>)
//                   refused while printing. QGL / MESH are pre-checked for homing ("Must home axis first (G28)"), also when
//                   printer.cfg wraps the command in a same-named gcode_macro: this printer's BED_MESH_CALIBRATE is KAMP's
//                   wrapper, and it neither homes nor levels (see home()).
//   nudgeZ(d)       SET_GCODE_OFFSET Z_ADJUST=<d> MOVE=1     baby-stepping — allowed while printing (that is what it is for)
//   setZ(v)         SET_GCODE_OFFSET Z=<v> MOVE=1            absolute offset, clamped to ±5 mm like the design's setZ
//                   Both are planned by zNudgePlan / zSetPlan (below), the rules every Z control shares: ±5 mm on the
//                   running total, never below the bed with MOVE=1, no mid-print jump over 1 mm, taps in flight counted.
//   saveZ()         Z_OFFSET_APPLY_PROBE → "… SAVE_CONFIG pending"  (Cartographer touch mode; SAVE_CONFIG is the shell's own button)
//   MOVE=1 is dropped (the offset applies on the next move) when Z is not homed — Klipper would otherwise raise "Must home axis first".
// Long-running scripts (G28 / QUAD_GANTRY_LEVEL / BED_MESH_CALIBRATE) can outlive Moonraker.rpc's 30 s timeout while Klipper is
// still busy: that timeout is reported as "still running" (info), not as an error — the real result arrives via gcode_response.
// Every action logs the command (or a short intent line), awaits api.gcode and logs errors; nothing throws.
// Usage: const act = makeToolheadActions({ api, store, log });   (merged with the other panels' actions by the integrator)

import { jogFeed } from "../prefs.js";
// The one signed-mm formatter ("+0.062" / "−0.041", never "−0.000"); the screens' Z messages already use it.
import { fmtSignedMm } from "../../pages/dashboard/adapters/heightmap.js";

/** Contract travel limits — used only until Klipper reports toolhead.axis_minimum / axis_maximum. */
export const AXIS_MAX = { X: 350, Y: 350, Z: 310 };
export const AXIS_MIN = { X: 0, Y: 0, Z: 0 };
/** Shipped jog feeds in mm/min (100 mm/s X/Y, 10 mm/s Z). The live value comes from lib/prefs.js jogFeed(). */
export const JOG_FEED = { X: 6000, Y: 6000, Z: 600 };
/** Absolute Z offset accepted by setZ (design: Math.max(-5, Math.min(5, v))). */
export const Z_OFFSET_LIMIT = 5;
/** Largest single Z_ADJUST nudge accepted (the panel offers ±0.005 / ±0.025), and the largest absolute jump mid-print. */
export const Z_STEP_LIMIT = 1;
/** How long an ANSWERED Z change is still trusted over the status push (it lands ~270 ms after the ack, p90 ~480 ms). */
export const Z_PENDING_MS = 1500;

export const HOME_CMDS = {
  // HOME is SMART_HOME, not G28: "Home + QGL when needed, otherwise just re-home Z" (its own help text).
  // A bare G28 on a Voron 2.4 leaves the gantry unleveled, and G32 re-levels every single time even when
  // nothing moved. SMART_HOME is this printer's own macro and does the right one of the two.
  HOME: "SMART_HOME", XY: "G28 X Y", X: "G28 X", Y: "G28 Y", Z: "G28 Z",
  QGL: "QUAD_GANTRY_LEVEL", MESH: "BED_MESH_CALIBRATE",
  // PARK is the Blobifier's park position — where this printer stows the toolhead.
  PARK: "BLOBIFIER_PARK",
  CARTO: "CARTOGRAPHER_CALIBRATE",
  // M84 is a NATIVE Klipper command, so it does NOT appear in printer.gcode.commands (that catalogue
  // lists only extended/named commands — 316 entries here, of which the only M-code is M486). Never
  // capability-gate it against the catalogue: has() would say "missing" for a command that works.
  MOTORS: "M84"
};
const HOME_ALIASES = {
  home: "HOME", all: "HOME", xyz: "HOME", g28: "HOME",
  xy: "XY", g28xy: "XY", x: "X", y: "Y", z: "Z",
  qgl: "QGL", quadgantrylevel: "QGL", mesh: "MESH", bedmesh: "MESH", bedmeshcalibrate: "MESH",
  smarthome: "HOME", g32: "HOME",
  park: "PARK", blobifierpark: "PARK",
  carto: "CARTO", cartocal: "CARTO", cartographercalibrate: "CARTO",
  motors: "MOTORS", motorsoff: "MOTORS", m84: "MOTORS", m18: "MOTORS"
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
export function jogCommand(raw, axis, d, feedMmMin) {
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
  const feed = feedMmMin > 0 ? Math.round(feedMmMin) : JOG_FEED[ax];
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

// ---- Z offset changes: the rules every Z control applies (the dashboard's nudgeZ / setZ below, and Carbon Screen's
// Z OFFSET and FINE TUNE screens), so a babystep is judged the same way wherever it is tapped.
//
//   LIMIT. The running total stays within ±Z_OFFSET_LIMIT: a nudge past it is refused, an absolute value is clamped.
//   FLOOR. MOVE=1 moves the nozzle at once, and Klipper lets it go down to position_min (−2 mm on this Voron), i.e.
//          2 mm into the bed. A change that lowers the nozzle is refused when gcode_move.position[2] + delta < 0.
//          gcode_move.position is gcode_move's last_position: g-code Z plus the offset, before the bed-mesh transform
//          (Klipper gcode_move.py; SET_GCODE_OFFSET ... MOVE=1 adds the delta to it). So 0 is the bed model's zero, as
//          far as the Cartographer's touch calibration is right, and the real gap at a point differs by the mesh
//          (about ±0.02 mm here).
//   HAPPY HARE. A toolchange is ONE command (T<n> -> MMU_CHANGE_TOOL), and Klipper's gcode mutex runs one command at
//          a time, so a change sent mid-sequence is deferred until it ends: it runs after _restore_toolhead_position
//          (RESTORE_GCODE_STATE NAME=MMU_state MOVE=1) has put the nozzle back at the print height, while position[2]
//          now is the PARKED height (HH v3.4.2). The floor cannot be checked then, so a lowering MOVE=1 change is
//          refused while mmu.action is not Idle, or while mmu.operation (HH's saved_toolhead_operation) is set
//          outside a pause. During a pause the parked position is real, and RESUME discards the change anyway.
//   JUMP.  While printing, an absolute value that moves the offset by more than Z_STEP_LIMIT is refused: a typed value
//          mid-print is a jump, not a step ("2" typed for ".2").
//   IN FLIGHT. The status push lags the ack by ~270 ms, and the ack itself waits for the gcode mutex. makeZFlight()
//          keeps what the sent changes should produce, from the send until Z_PENDING_MS after the answer, so taps
//          quicker than the status build on each other instead of each passing the checks against the same value.

/** True while a job is paused. Both flags: print_stats says "paused" for a virtual_sdcard job, and
 *  pause_resume.is_paused is set by PAUSE itself (also for a pause taken with no virtual_sdcard job). */
export function isPaused(raw) {
  const r = raw || {};
  return (r.print_stats || {}).state === "paused" || !!(r.pause_resume || {}).is_paused;
}

/** True while a job is actively printing (a paused one does not count). */
export function isPrinting(raw) { return ((raw || {}).print_stats || {}).state === "printing" && !isPaused(raw); }

/** gcode_move.position[2]: the nozzle's height above the bed model, offset included (see FLOOR), or null. */
export function modelZOf(raw) {
  const gm = (raw && raw.gcode_move) || {};
  return Array.isArray(gm.position) ? num(gm.position[2]) : null;
}

/** What Happy Hare is in the middle of (see HAPPY HARE), or null. */
function hhSequence(raw) {
  const m = raw && raw.mmu;
  if (!m) return null;
  if (m.action && m.action !== "Idle") return String(m.action).toLowerCase();
  if (m.operation && !isPaused(raw)) return String(m.operation);
  return null;
}

/** The offset and the nozzle height once every change in flight has landed. `pending` is makeZFlight().pending(). */
function zBase(raw, pending) {
  const live = zOffsetOf(raw), gz = modelZOf(raw);
  if (!pending) return { off: live, gz };
  const off = pending.off !== null ? pending.off : live;
  // A MOVE=1 change moves position[2] with the offset, so position[2] − offset (the g-code Z) is the same before and
  // after it, and the height after the pending changes is that plus the expected offset. The dashboard's
  // Store.predict writes the expected offset into raw ahead of the position, which would hide the pending move from
  // that sum, so the height the change itself expected is kept too and the lower of the two wins. A layer change
  // in between only makes this stricter, for at most Z_PENDING_MS.
  let h = gz !== null && live !== null ? gz - live + off : gz;
  if (pending.gz !== null && (h === null || pending.gz < h)) h = pending.gz;
  return { off, gz: h === null ? null : +h.toFixed(3) };
}

/** Why moving the offset by `delta` must not go: HAPPY HARE and FLOOR. null = allowed. */
function zFloorWhy(raw, base, delta, move) {
  if (!move || !(delta < 0)) return null;
  const hh = hhSequence(raw);
  if (hh) return "Happy Hare is busy (" + hh + ") — the change would wait for it, then lower the nozzle at a height that cannot be checked now";
  if (base.gz === null) return null;
  const to = +(base.gz + delta).toFixed(3);
  return to < 0 ? "the nozzle would end " + Math.abs(to).toFixed(3) + " mm below the bed (Z " + base.gz.toFixed(3) + " now)" : null;
}

/**
 * Pure: plan one SET_GCODE_OFFSET Z_ADJUST nudge against the printer as it is, plus what is in flight.
 * → { cmd, shown, delta, move, from, value, gz, to } or { error, rule? }. `from` / `value` are the offset before and
 * after (null while gcode_move has not reported one), `gz` / `to` the nozzle height before and after (null when
 * unknown or when MOVE=1 is dropped). `rule` names the rule that refused ("limit" | "floor"); a builder error has none.
 */
export function zNudgePlan(raw, d, { pending = null } = {}) {
  const move = isHomed(raw, "Z");
  const c = zAdjustCommand(d, move);
  if (c.error) return c;
  const b = zBase(raw, pending);
  const value = b.off === null ? null : +(b.off + c.delta).toFixed(3);
  if (value !== null && Math.abs(value) > Z_OFFSET_LIMIT) {
    return { error: "the Z offset would reach " + fmtSignedMm(value) + " mm (limit ±" + Z_OFFSET_LIMIT + " mm)", rule: "limit" };
  }
  const low = zFloorWhy(raw, b, c.delta, move);
  if (low) return { error: low, rule: "floor" };
  return { cmd: c.cmd, shown: c.shown, delta: c.delta, move, from: b.off, value, gz: b.gz,
    to: move && b.gz !== null ? +(b.gz + c.delta).toFixed(3) : null };
}

/**
 * Pure: plan an absolute SET_GCODE_OFFSET Z=<v>. → { cmd, delta, move, from, value, clamped, gz, to } or
 * { error, rule? }, fields as zNudgePlan. rule: "same" (nothing to do) | "jump" | "unknown" | "floor".
 */
export function zSetPlan(raw, v, { pending = null } = {}) {
  const move = isHomed(raw, "Z");
  const c = zSetCommand(v, move);
  if (c.error) return c;
  const b = zBase(raw, pending);
  if (b.off !== null && Math.abs(c.value - b.off) < 0.0005) return { error: "Z offset already " + fmtSignedMm(c.value) + " mm", rule: "same" };
  const delta = b.off === null ? null : +(c.value - b.off).toFixed(3);
  if (isPrinting(raw) && (delta === null || Math.abs(delta) > Z_STEP_LIMIT)) {
    return { error: (delta === null ? "an unknown" : "a " + Math.abs(delta).toFixed(3) + " mm") + " jump while printing — babystep instead (at most " + Z_STEP_LIMIT + " mm at once)", rule: "jump" };
  }
  if (delta === null && move) return { error: "the live Z offset has not been reported, so the nozzle move cannot be checked", rule: "unknown" };
  const low = delta === null ? null : zFloorWhy(raw, b, delta, move);
  if (low) return { error: low, rule: "floor" };
  return { cmd: c.cmd, delta, move, from: b.off, value: c.value, clamped: c.clamped, gz: b.gz,
    to: move && b.gz !== null && delta !== null ? +(b.gz + delta).toFixed(3) : null };
}

/**
 * The Z changes one surface has sent that the status does not show yet (see IN FLIGHT). One per surface:
 *   const flight = makeZFlight();
 *   const p = zNudgePlan(raw, d, { pending: flight.pending() });   // …or zSetPlan
 *   const settle = flight.begin(p);   … send p.cmd …   settle(result);
 * settle() takes true / false, or the screen act's { ok, error, refused }. A refused or failed change is taken back
 * out. An rpc timeout counts as sent: the script is still waiting for the gcode mutex and will run.
 */
export function makeZFlight(now = () => Date.now()) {
  let off = null, gz = null, open = 0, at = 0;
  const live = () => open > 0 || now() - at < Z_PENDING_MS;
  return {
    /** { off, gz } expected once the changes in flight land, or null (trust the status). */
    pending() { return live() && (off !== null || gz !== null) ? { off, gz } : null; },
    begin(p) {
      off = p.value === undefined ? null : p.value;
      gz = p.to === undefined ? null : p.to;
      open += 1;
      let done = false;
      return r => {
        if (done) return;
        done = true;
        open = Math.max(0, open - 1);
        at = now();
        const sent = r === true || !!(r && typeof r === "object" && (r.ok || /^timeout/i.test(String(r.error || ""))));
        if (!sent && typeof p.delta === "number") {
          if (off !== null) off = +(off - p.delta).toFixed(3);
          if (gz !== null && p.move) gz = +(gz - p.delta).toFixed(3);
        }
      };
    }
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
  function printingNow() { return isPrinting(raw()); }

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
   * `settle`, when given, hears whether the script was sent: true on the ack and on an rpc timeout (the script is then
   * still queued behind Klipper's gcode mutex and will run), false on an error. makeZFlight() uses it.
   */
  async function run(script, okMsg, long, settle) {
    try {
      await api.gcode(script);
      if (settle) settle(true);
      if (okMsg) say(okMsg, "ok");
      return true;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (settle) settle(/^timeout/i.test(msg));
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
    const c = jogCommand(raw(), ax, d, jogFeed(state(), ax));
    if (c.error) { say(c.error, "warn"); return false; }
    if (c.clamped) say(ax + " move clamped to " + fmtNum(c.target) + " mm (limit " + fmtNum(c.limit.min) + "–" + fmtNum(c.limit.max) + " mm)", "warn");
    say(c.shown);
    return run(c.cmd);
  }

  /**
   * kind: 'HOME' | 'XY' | 'QGL' | 'MESH' (design buttons) — also 'X' | 'Y' | 'Z' and the Klipper command names.
   * Homing is refused while a print is running. QGL / MESH require a homed toolhead, wrapped in a macro or not.
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
      // A same-named macro is NOT assumed to home. This printer's BED_MESH_CALIBRATE is KAMP's (rename_existing:
      // _BED_MESH_CALIBRATE): it computes the adaptive area, waits G4 P5000 when no objects are defined, and calls
      // _BED_MESH_CALIBRATE, with no G28 and no QGL anywhere in it (live configfile gcode, 2026-09-23). There is no
      // QUAD_GANTRY_LEVEL macro. Skipping the check sent an unhomed mesh into a 5 s wait and Klipper's own error; a
      // wrapper that did home would only be refused one tap early, with the reason.
      if (!allHomed(r)) { say("Must home axis first (G28)", "warn"); return false; }
      if (k === "MESH" && r.quad_gantry_level && r.quad_gantry_level.applied === false) {
        say("QGL not applied — the mesh will be probed on an unleveled gantry", "warn");
      }
    }
    const intent = { HOME: " — smart home (homes, and levels the gantry only if needed)", XY: " — homing X/Y",
      X: " — homing X", Y: " — homing Y", Z: " — homing Z", QGL: " — leveling gantry", MESH: " — probing bed mesh",
      PARK: " — parking the toolhead at the Blobifier", CARTO: " — calibrating the Cartographer response curve",
      MOTORS: " — releasing all steppers" }[k];
    say(cmd + intent);
    const done = { HOME: "SMART_HOME complete", XY: "G28 X Y — X/Y homed", X: "G28 X — X homed",
      Y: "G28 Y — Y homed", Z: "G28 Z — Z homed", QGL: "QUAD_GANTRY_LEVEL complete", MESH: "BED_MESH_CALIBRATE complete",
      PARK: "Toolhead parked", CARTO: "CARTOGRAPHER_CALIBRATE complete", MOTORS: "M84 — steppers released" }[k];
    return run(cmd, done, true);
  }

  /** Optimistic: Moonraker's confirming status push is ~270 ms behind the 6 ms ack. */
  function predict(patch) { if (store && typeof store.predict === "function") store.predict(patch); }

  /** The Z changes this panel has sent that the status does not show yet (makeZFlight, IN FLIGHT above). */
  const zFlight = makeZFlight();
  /** The Z offset nudgeZ last wrote into the store ahead of Klipper (null = the store holds a real value). */
  let zPredicted = null;
  /** A refusal from zNudgePlan / zSetPlan, in this panel's log voice. "same" is information, not a refusal. */
  function sayPlanError(p) {
    say((p.rule && p.rule !== "same" ? "Refused — " : "") + p.error, p.rule === "same" ? "info" : "warn");
  }
  function predictZ(v) {
    const ho = ((raw().gcode_move || {}).homing_origin || [0, 0, 0, 0]).slice();
    ho[2] = v;
    zPredicted = v;
    predict({ gcode_move: { homing_origin: ho } });
  }

  /**
   * Baby-step the Z gcode offset by d mm (panel: ±0.005 / ±0.025). Allowed while printing. Refused past ±5 mm, and a
   * MOVE=1 lowering below the bed or while Happy Hare is mid-sequence (zNudgePlan). Taps still in flight are counted.
   */
  async function nudgeZ(d) {
    if (blocked()) return false;
    const p = zNudgePlan(raw(), d, { pending: zFlight.pending() });
    if (p.error) { sayPlanError(p); return false; }
    if (p.value !== null) predictZ(p.value);
    say(p.shown + (p.move ? "" : "  (Z not homed — offset applies on the next move)"));
    const settle = zFlight.begin(p);
    let sent = true;
    const ok = await run(p.cmd, p.value === null ? undefined : "Z offset → " + p.value.toFixed(3) + " mm", false,
      s => { sent = s; settle(s); });
    // A failed change moves nothing, so Klipper reports nothing, and Moonraker pushes only fields that changed: the
    // prediction would stay in the store (the field, saveZ()'s "nothing to do" check, the limit) until something
    // else moved homing_origin. Put back what the changes still in flight add up to, unless a real push has
    // already replaced the prediction.
    if (!sent && p.value !== null && zPredicted !== null && zOffsetOf(raw()) === zPredicted) {
      const q = zFlight.pending();
      if (q && q.off !== null) predictZ(q.off);
    }
    return ok;
  }

  /**
   * Set the absolute Z gcode offset (mm, clamped ±5). Unchanged values are not re-sent. Refused for a MOVE=1 lowering
   * below the bed or while Happy Hare is mid-sequence, and mid-print for a jump over Z_STEP_LIMIT (zSetPlan).
   */
  async function setZ(v) {
    if (blocked()) return false;
    const p = zSetPlan(raw(), v, { pending: zFlight.pending() });
    if (p.error) { sayPlanError(p); return false; }
    if (p.clamped) say("Z offset clamped to ±" + Z_OFFSET_LIMIT + " mm", "warn");
    say(p.cmd + (p.move ? "" : "  (Z not homed — offset applies on the next move)"));
    return run(p.cmd, "Z offset → " + p.value.toFixed(3) + " mm", false, zFlight.begin(p));
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
