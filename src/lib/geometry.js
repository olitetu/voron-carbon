// The machine's REAL filament-path geometry, read from Happy Hare's own configuration.
//
// Nothing here is hardcoded to this printer: every distance comes from live config, with fallbacks
// only for the moment before that config has arrived.
//
//   configfile.settings.mmu          gate_parking_distance, toolhead_extruder_to_nozzle,
//                                    toolhead_sensor_to_nozzle, toolhead_entry_to_extruder,
//                                    toolhead_residual_filament, toolhead_unload_safety_margin
//   save_variables.variables         mmu_calibration_bowden_lengths (PER GATE — the calibrated value is
//                                    the only true bowden length; the config holds only maxima)
//   gcode_macro _EREC_VARS           feed_length / cut_length -> where the gate cutter's blade sits
//   gcode_macro _MMU_FORM_TIP_VARS   cooling_tube_position, parking_distance -> toolhead tip geometry
//
// Positions are millimetres along the gate->nozzle path, matching Happy Hare's own
// `mmu.filament_position` convention: <= 0 is parked at/behind the gate, `bowden` is the end of the
// bowden run, and `bowden + extruderToNozzle` is the nozzle.

import { POS_ANCHOR } from "./hh.js";

const FALLBACK = {
  bowden: 1040, extruderToNozzle: 100, sensorToNozzle: 80,
  entryToExtruder: 10, gateParking: 18, cutFeed: 48,
};

function num(v, dflt) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Resolve the path geometry for a gate from live state. */
export function geometry(state, gate) {
  const st = state || {};
  const raw = st.raw || {};
  const mmuCfg = (st.config && st.config.mmu) || {};
  const vars = (raw.save_variables && raw.save_variables.variables) || {};
  const erec = raw["gcode_macro _EREC_VARS"] || {};
  const tip = raw["gcode_macro _MMU_FORM_TIP_VARS"] || {};

  // Bowden is calibrated PER GATE. The config only has bowden_homing_max (a 2000 mm ceiling here),
  // so save_variables is authoritative.
  const list = vars.mmu_calibration_bowden_lengths;
  let bowden = null;
  if (Array.isArray(list)) {
    const g = Number.isInteger(gate) && gate >= 0 && gate < list.length ? gate : 0;
    bowden = num(list[g], num(list[0], null));
  } else bowden = num(list, null);
  if (bowden === null || bowden <= 0) bowden = FALLBACK.bowden;

  const extruderToNozzle = num(mmuCfg.toolhead_extruder_to_nozzle, FALLBACK.extruderToNozzle);
  const gateParking = num(mmuCfg.gate_parking_distance, FALLBACK.gateParking);

  // The EREC cutter is at the MMU: feed_length is how far the filament advances from its parked
  // position to present the tip to the blade, so that IS the blade's position on the path.
  const cutFeed = num(erec.feed_length, FALLBACK.cutFeed);
  const cutAt = Math.max(0, cutFeed - gateParking);

  return {
    bowden,
    extruderToNozzle,
    sensorToNozzle: num(mmuCfg.toolhead_sensor_to_nozzle, FALLBACK.sensorToNozzle),
    entryToExtruder: num(mmuCfg.toolhead_entry_to_extruder, FALLBACK.entryToExtruder),
    gateParking,
    residual: num(mmuCfg.toolhead_residual_filament, 0),
    unloadSafety: num(mmuCfg.toolhead_unload_safety_margin, 0),
    cutFeed,
    cutLength: num(erec.cut_length, null),
    cutAt,
    cutAttempts: num(erec.cut_attempts, null),
    servoDuration: num(erec.servo_duration, null),
    coolingTube: num(tip.cooling_tube_position, null),
    tipPark: num(tip.parking_distance, null),
    total: bowden + extruderToNozzle,
    fromConfig: !!(st.config && st.config.mmu) && Array.isArray(list),
  };
}

/**
 * Millimetres along the path -> 0..1 on the design's drawn route.
 * Piecewise, so the drawing's proportions hold: the bowden run occupies START_BOWDEN..END_BOWDEN and
 * the extruder->nozzle stretch the last 30 %, exactly as the mockup was composed. (A linear map over
 * the full length would squeeze the extruder run into the last 9 %.)
 */
export function travelForMm(mm, geo) {
  const g = geo || {};
  const B = g.bowden > 0 ? g.bowden : FALLBACK.bowden;
  const E = g.extruderToNozzle > 0 ? g.extruderToNozzle : FALLBACK.extruderToNozzle;
  const P = g.gateParking > 0 ? g.gateParking : FALLBACK.gateParking;
  const a = POS_ANCHOR[2], b = POS_ANCHOR[4];   // 0.12 .. 0.70
  if (!Number.isFinite(mm)) return 0;
  // Behind the gate: the filament parks `gate_parking_distance` back from it, and the design's route
  // gives that stretch its first 12 %. Ramping it (rather than returning 0 for everything <= 0) is what
  // keeps a short gate-local move readable — without it the head jumped a eighth of the route on the
  // first millimetre and snapped back at the end of every retract.
  if (mm <= -P) return 0;
  if (mm < 0) return a * (1 + mm / P);
  if (mm <= B) return a + (b - a) * (mm / B);
  return Math.min(1, b + (1 - b) * ((mm - B) / E));
}

/** Where the gate cutter's blade sits on the drawn route — derived, not the design's hardcoded 0.13. */
export function cutTravel(geo) {
  return travelForMm((geo && geo.cutAt) || 0, geo);
}

// ---------------------------------------------------------------------------
// Direction tracking.
//
// The ERCF encoder is a pulse counter with no sense of direction — it counts UP whichever way the
// filament travels — so it can never distinguish a load from an unload on its own.
// `mmu.filament_direction` is set only inside Happy Hare's own sequences and goes stale (it reads -1
// even while parked). But `mmu.filament_position` IS signed and is updated on every traced move, so
// the sign of its CHANGE is the honest answer to "which way is the filament moving right now".
// ---------------------------------------------------------------------------
const MOVE_EPS = 0.2;       // mm — smaller than this is noise, not a move
const MOVE_IDLE_MS = 600;   // no change for this long => not moving

let track = { pos: null, dir: 1, at: 0 };

/** Feed the latest signed position; returns { dir: +1|-1, moving, delta }. */
export function trackMotion(filamentPosition, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const p = num(filamentPosition, null);
  if (p === null) return { dir: track.dir, moving: false, delta: 0 };
  if (track.pos === null) { track.pos = p; return { dir: track.dir, moving: false, delta: 0 }; }
  const delta = p - track.pos;
  if (Math.abs(delta) >= MOVE_EPS) {
    track.dir = delta > 0 ? 1 : -1;
    track.pos = p;
    track.at = now;
    return { dir: track.dir, moving: true, delta };
  }
  return { dir: track.dir, moving: now - track.at < MOVE_IDLE_MS, delta: 0 };
}

/**
 * Path position measured from where the filament last came to REST at the gate.
 *
 * Happy Hare's `filament_position` is absolute ONLY inside a real load/unload, where HH zeroes it at
 * the gate. For gate-local operations it is a free-running counter with an arbitrary offset (observed
 * at 306 mm with the filament sitting in gate 5), so it cannot be read as a path position there.
 * MMU_CHECK_GATE feeds to the sensor and retracts, EREC_CUTTER_ACTION feeds feed_length+cut_length and
 * backs off, MMU_PRELOAD nudges it in — all without a real load. Reading the raw counter for those put
 * the head a third of the way down the bowden and left it there.
 *
 * This applies across the whole GATE REGION (filament_pos 0..2: UNLOADED, HOMED_GATE, START_BOWDEN),
 * not just the parked state — check-gate flips to START_BOWDEN the instant it begins retracting, and
 * that was enough to fall through to the absolute reading and lose the whole back-out. Past
 * START_BOWDEN the filament is committed to the bowden run, HH has zeroed the counter, and absolute is
 * both correct and necessary.
 *
 * Re-baselining is gated on the MMU being IDLE, not merely on motion stopping: Happy Hare only writes
 * `filament_position` at move boundaries, so during MMU_CHECK_GATE it sits unchanged at the far end for
 * a second or more. A motion-timeout rebase there collapsed the animation back to the gate while the
 * filament was still out at the sensor. Waiting for the operation to finish keeps the advance on screen
 * for as long as it is real, then settles to 0 wherever it comes to rest.
 */
let park = { base: null };
export const GATE_REGION_MAX_POS = 2;   // FILAMENT_POS_START_BOWDEN

export function parkRelativeMm(filamentPosition, filamentPos, moving, idle) {
  const p = num(filamentPosition, null);
  const pos = num(filamentPos, null);
  // Past the gate region the counter is absolute and authoritative.
  if (p === null || pos === null || pos > GATE_REGION_MAX_POS) return null;
  if (park.base === null || (idle && !moving)) park.base = p;
  return p - park.base;
}
export function resetParkBaseline() { park = { base: null }; }

export function resetMotionTracking() { track = { pos: null, dir: 1, at: 0 }; }
