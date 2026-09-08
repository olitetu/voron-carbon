// Happy Hare (v3.x) helpers shared by dashboard + pages.
export const GATE = { EMPTY: 0, AVAILABLE: 1, BUFFER: 2, UNKNOWN: -1 };
/**
 * filament_pos (0..10) -> 0..1 along the design's gate->nozzle route.
 * Anchors follow Happy Hare's state machine (mmu.py FILAMENT_POS_*): the bowden is the long
 * stretch, so most of the route sits between START_BOWDEN and END_BOWDEN.
 */
export const POS_ANCHOR = {
  0: 0,      // UNLOADED — parked at the gate
  1: 0.05,   // HOMED_GATE
  2: 0.12,   // START_BOWDEN
  3: 0.40,   // IN_BOWDEN (unknown point — only used when there is no bowden_progress)
  4: 0.70,   // END_BOWDEN
  5: 0.75,   // HOMED_ENTRY
  6: 0.78,   // HOMED_EXTRUDER
  7: 0.82,   // EXTRUDER_ENTRY
  8: 0.90,   // HOMED_TS
  9: 0.95,   // IN_EXTRUDER
  10: 1,     // LOADED — at the nozzle
};

/**
 * Where the filament really is, 0..1.
 * `mmu.bowden_progress` is Happy Hare's own 0-100 % through the bowden move (-1 when not moving);
 * when it is live we interpolate START_BOWDEN..END_BOWDEN with it instead of sitting on the
 * discrete IN_BOWDEN anchor, which is what made the animation look out of step with reality.
 */
export function travelFromPos(pos, bowdenProgress) {
  if (pos == null || pos < 0) return 0;
  const p = POS_ANCHOR[pos];
  const base = p === undefined ? 0 : p;
  if (typeof bowdenProgress === "number" && bowdenProgress >= 0 && pos >= 2 && pos <= 4) {
    const a = POS_ANCHOR[2], b = POS_ANCHOR[4];
    return a + (b - a) * Math.max(0, Math.min(1, bowdenProgress / 100));
  }
  return base;
}

/**
 * Travel from a REAL measured distance in mm along the gate->nozzle path.
 * Mapped piecewise onto the design's visual anchors (not linearly over the whole length) so the
 * drawing's proportions hold: the bowden run occupies START_BOWDEN..END_BOWDEN and the
 * extruder->nozzle stretch the last 30 %.
 */
export function travelFromDistance(mm, bowdenLen, extruderToNozzle) {
  if (!Number.isFinite(mm) || mm <= 0) return 0;
  const B = Number.isFinite(bowdenLen) && bowdenLen > 0 ? bowdenLen : 1040;
  const E = Number.isFinite(extruderToNozzle) && extruderToNozzle > 0 ? extruderToNozzle : 100;
  const a = POS_ANCHOR[2], b = POS_ANCHOR[4];      // 0.12 .. 0.70
  if (mm <= B) return a + (b - a) * (mm / B);
  return Math.min(1, b + (1 - b) * ((mm - B) / E));
}

/**
 * Convert the ERCF encoder reading into a POSITION along the path.
 *
 * The encoder is a slotted-wheel pulse counter: `mmu_encoder.encoder_pos` is
 * `counts * resolution`, incremented in `_counter_callback` with NO direction information and NO
 * `enabled` check — so it is live outside prints (`enabled` only gates clog/runout logic), but it is
 * an ODOMETER, not a position. Happy Hare zeroes it (`_initialize_encoder`) at the start of each
 * load/unload sequence, so:
 *   loading   -> distance travelled from the gate      => position = encoder_pos
 *   unloading -> distance travelled back from the tip   => position = pathTotal - encoder_pos
 * Feeding it in raw would animate an unload as though it were loading.
 */
export function pathMmFromEncoder(encoderMm, direction, bowdenLen, extruderToNozzle) {
  if (!Number.isFinite(encoderMm) || encoderMm <= 0) return null;
  const total = (Number.isFinite(bowdenLen) && bowdenLen > 0 ? bowdenLen : 1040) +
                (Number.isFinite(extruderToNozzle) && extruderToNozzle > 0 ? extruderToNozzle : 100);
  return direction === -1 ? Math.max(0, total - encoderMm) : Math.min(total, encoderMm);
}

/** Happy Hare's 13 action strings (mmu.py _get_action_string) -> the design's animation phases. */
const PHASE_BY_ACTION = {
  "idle": "idle",
  "loading": "loading",
  "loading ext": "loading",
  "unloading": "unloading",
  "exiting ext": "unloading",
  "forming tip": "unloading",
  "cutting tip": "cutting",
  "cutting filament": "cutting",
  "purging": "extruding",
  "heating": "heating",
  "checking": "checking",
  "homing": "checking",
  "selecting": "checking",
  "unknown": "idle",
};

/**
 * Action -> phase. Exact table lookup on Happy Hare's own strings (a substring match got
 * "Cutting Tip" wrong: it contains "tip", so it read as tip-forming rather than a cut).
 */
export function phaseFromAction(action) {
  const a = String(action == null ? "" : action).trim().toLowerCase();
  return PHASE_BY_ACTION[a] || "idle";
}

/** True while the filament is physically moving (drives the flow dashes). */
export const MOVING_PHASES = ["loading", "unloading", "presenting", "storing", "checking", "extruding", "retracting"];
export function isMoving(phase) { return MOVING_PHASES.indexOf(phase) >= 0; }

/**
 * Is the filament moving backwards (toward the gate)? Prefer Happy Hare's own
 * `filament_direction` (+1 load / -1 unload) and fall back to the phase.
 */
export function isReversing(phase, filamentDirection) {
  if (filamentDirection === -1 && isMoving(phase)) return true;
  if (filamentDirection === 1) return false;
  return ["unloading", "storing", "retracting"].indexOf(phase) >= 0;
}

export function gateName(state, g) {
  const m = state.raw.mmu || {}; const name = (m.gate_filament_name || [])[g]; const mat = (m.gate_material || [])[g];
  return name || mat || (((m.gate_status || [])[g] || 0) ? "Gate " + g : "—");
}
export function gateHex(state, g) {
  const c = ((state.raw.mmu || {}).gate_color || [])[g];
  if (!c) return "#2a3340";
  return c.startsWith("#") ? c : "#" + c.replace(/^0x/i, "").slice(0, 6);
}
/** Spool fill fraction from Spoolman (remaining/initial weight), or null when unknown. */
export function gateFill(state, g) {
  const id = ((state.raw.mmu || {}).gate_spool_id || [])[g];
  const sp = id > 0 ? state.spools[id] : null;
  if (!sp) return ((((state.raw.mmu || {}).gate_status || [])[g]) || 0) ? 1 : 0;
  const init = sp.initial_weight || sp.filament?.weight || 1000;
  return Math.max(0, Math.min(1, (sp.remaining_weight ?? init) / init));
}
