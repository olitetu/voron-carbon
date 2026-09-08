// Shared derived values for the dashboard adapters (owned by the MMU agent).
// Everything here is computed from live store state (st) + UI-only state (ui) — never from fake data.
// Other adapters read it via `ctx.common`; the MMU panel adapter (./mmu.js) is its main consumer.
//
// Field list (see CONTRACT.md "adapters/common.js"):
//   A, press, spoolDefs, gateInfo, loaded, loadedColor, pathGate, gate (loaded gate or null), selector, servo ('up'|'down'),
//   phase, travel, moving, reversing, flowing, extruding, printing, activeFeed, dashPeriod, dashCycle, flowSuffix, reverseSuffix,
//   feed, pxPerSec  — plus a few extras documented at the bottom (mmu, action, selectorMoving, travelTarget, liveFeed, swaps…).
import { travelFromPos, phaseFromAction, isMoving, gateHex, gateFill } from "../../../lib/hh.js";
import { geometry, travelForMm, cutTravel, trackMotion, parkRelativeMm } from "../../../lib/geometry.js";

/** Finite number or null — Moonraker sends nulls/strings for absent readings. */
function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export const NUM_GATES = 8;       // the design draws 8 spool cards + Bypass
export const BYPASS = 8;          // card index of the Bypass card (Happy Hare reports gate/tool -2 for bypass)
const EMPTY_COLOR = "#2a3340";    // design colour for an empty gate
const DESIGN_BLACK = "#3f4650";   // the design's "Black" swatch — pure #000 vanishes on the panel background

/** Lift colours that would be invisible on the dark panel (pure black filament) to the design's black swatch. */
export function visibleHex(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return EMPTY_COLOR;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 24 ? DESIGN_BLACK : hex.toLowerCase();
}

// ---- travel easing (source of truth is filament_pos; we ease the displayed 0..1 toward it, ~600–800 ms)
const _tv = { shown: null, target: null, t: 0, timer: null };
function easeTravel(target, ctx, tau) {
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (_tv.shown === null || !isFinite(_tv.shown)) { _tv.shown = target; _tv.t = now; _tv.target = target; return target; }
  const dt = Math.max(0, Math.min(200, now - _tv.t));
  _tv.t = now; _tv.target = target;
  const d = target - _tv.shown;
  if (Math.abs(d) < 0.004) _tv.shown = target;
  else _tv.shown += d * Math.min(1, dt / (tau || 160));
  // keep re-rendering while we are still in flight (a UI-only state bump; harmless if the host ignores it)
  if (_tv.shown !== target && !_tv.timer && ctx && typeof ctx.set === "function" && typeof setTimeout === "function") {
    _tv.timer = setTimeout(() => { _tv.timer = null; try { ctx.set({ travelTick: Date.now() }); } catch {} }, 33);
  }
  return _tv.shown;
}

// ---- live filament feed (mm/s) smoothing: motion_report.live_extruder_velocity drops to 0 on every travel move,
//      so an EMA (~2 s) keeps the label + dash speed steady while a print is actually extruding.
const _feed = { v: 0, t: 0 };
function smoothFeed(sample) {
  const now = Date.now();
  const dt = _feed.t ? Math.min(5000, now - _feed.t) : 1000;
  _feed.t = now;
  const k = 1 - Math.exp(-dt / 2000);
  _feed.v += (sample - _feed.v) * k;
  if (_feed.v < 0.005) _feed.v = 0;
  return _feed.v;
}

export function commonVals(ctx) {
  const st = (ctx && (ctx.st || (ctx.store && ctx.store.state))) || {};
  const ui = (ctx && ctx.ui) || {};
  const A = (ctx && ctx.A) || "#ff5a33";
  const press = "; transition:transform .07s ease, border-color .12s";
  const raw = st.raw || {};
  const mmu = raw.mmu || {};
  const spoolsById = st.spools || {};
  const ps = raw.print_stats || {};
  const mr = raw.motion_report || {};
  const gm = raw.gcode_move || {};
  const ext = raw.extruder || {};
  const arr = k => (Array.isArray(mmu[k]) ? mmu[k] : []);

  // ---- printer-level state
  const estop = ["shutdown", "disconnected", "error", "startup"].indexOf(st.klippy) >= 0;
  const printState = ps.state || "standby";
  const printing = printState === "printing" && !estop;

  // ---- gates → gateInfo (8 gates + Bypass) and the design's spoolDefs
  const status = arr("gate_status"), names = arr("gate_filament_name"), mats = arr("gate_material"),
    spoolIds = arr("gate_spool_id"), colors = arr("gate_color"), temps = arr("gate_temperature");
  const gateInfo = [];
  for (let g = 0; g < NUM_GATES; g++) {
    const stt = typeof status[g] === "number" ? status[g] : 0;      // 0 empty, 1 available, 2 from buffer, -1 unknown
    const empty = stt === 0;
    const id = spoolIds[g];
    const sp = id > 0 ? spoolsById[id] : null;
    const fil = (sp && sp.filament) || null;
    const name = (fil && fil.name) || names[g] || mats[g] || "—";
    const mat = mats[g] || (fil && fil.material) || "—";
    const fill = empty ? 0 : gateFill(st, g);
    const known = !!sp;                                             // Spoolman knows the remaining weight
    const color = (!colors[g] && empty) ? EMPTY_COLOR : visibleHex(gateHex(st, g));
    gateInfo.push({
      name, mat, color, fill, empty, known, status: stt,
      spoolId: id > 0 ? id : null, spool: sp,
      vendor: (fil && fil.vendor && fil.vendor.name) || "",
      temp: typeof temps[g] === "number" ? temps[g] : null,
      pct: !empty && known ? Math.round(fill * 100) + "%" : "",
      low: !empty && known && fill < 0.15,
    });
  }
  gateInfo.push({ name: "Bypass", mat: "—", color: EMPTY_COLOR, fill: 0, empty: true, known: false, status: 0, spoolId: null, spool: null, vendor: "", temp: null, pct: "", low: false });

  const spoolDefs = gateInfo.slice(0, NUM_GATES).map((gi, g) => ({
    g: String(g), name: gi.name, mat: gi.mat, pct: gi.pct, color: gi.color, op: gi.empty ? .5 : 1, fill: gi.fill, low: gi.low,
  }));
  spoolDefs.push({ g: "BP", name: "Bypass", mat: "—", pct: "", color: EMPTY_COLOR, op: .5, fill: 0 });

  // ---- selector / loaded gate (HH: gate -1 unknown, -2 bypass)
  const rawGate = typeof mmu.gate === "number" ? mmu.gate : -1;
  const selector = rawGate >= 0 && rawGate < NUM_GATES ? rawGate : rawGate === -2 ? BYPASS : null;
  const selectorKnown = selector !== null;
  const filament = mmu.filament || "Unknown";
  const gate = filament === "Loaded" && selectorKnown ? selector : null;
  spoolDefs.forEach((s, i) => { s.active = gate === i; s.selected = selector === i; });
  const tool = typeof mmu.tool === "number" ? mmu.tool : -1;

  // ---- servo / selector motion / phase
  const rawServo = String(mmu.servo || "");
  const servo = /down/i.test(rawServo) ? "down" : "up";
  const action = String(mmu.action || "Idle");
  const selectorMoving = /select|hom/i.test(action) || /move/i.test(rawServo);
  // Happy Hare's own action wins whenever it reports one; a manual cut/retract shows up only in the
  // transient hint an action left behind (store.signalMotion).
  const hint = st.uiPhase && st.uiPhase.endsAt > Date.now() ? st.uiPhase : null;
  const hhPhase = phaseFromAction(action);
  let phase = hhPhase !== "idle" ? hhPhase : (hint ? hint.phase : "idle");
  // Backing the filament out after the last cut is its own leg of the sequence.
  if (st.cutter && st.cutter.parking) phase = "storing";
  const liveE = typeof mr.live_extruder_velocity === "number" ? mr.live_extruder_velocity : 0;
  // a manual extrude/retract from the extruder panel shows up as real extruder motion outside a print
  if (phase === "idle" && !printing && gate !== null && Math.abs(liveE) > 0.05) phase = liveE > 0 ? "extruding" : "retracting";

  // ---- travel along the gate→nozzle route (0..1), eased toward filament_pos
  // ---- where the filament really is
  // Preferred source is the ERCF encoder: it MEASURES travel, so it stays honest on a printer that
  // slips a few percent, where the commanded position drifts. The discrete filament_pos still pins
  // the endpoints (a slipping encoder can read ~1100 instead of ~1140 at the nozzle), and the
  // encoder only interpolates between them. Falls back to HH's commanded position, then to the
  // state-machine anchors + bowden_progress.
  const encObj = raw["mmu_encoder mmu_encoder"] || (mmu.encoder && typeof mmu.encoder === "object" ? mmu.encoder : {});
  // Every distance comes from Happy Hare's own config (see lib/geometry.js) — nothing hardcoded.
  const geo = geometry(st, selector);
  const bowdenLen = geo.bowden;
  const extruderToNozzle = geo.extruderToNozzle;

  const measuredMm = num(encObj.encoder_pos);
  // HH's signed, absolute position. The encoder cannot supply this: it is a direction-blind odometer
  // that counts UP on both loads and unloads, which is why it always looked like it moved forward.
  const signedMm = num(mmu.filament_position);
  const motion = trackMotion(signedMm, Date.now());
  // idle = no MMU operation in flight (HH action Idle and no UI-driven sequence)
  const mmuIdle = hhPhase === "idle" && !hint && !st.cutter;
  const parkRel = parkRelativeMm(signedMm, mmu.filament_pos, motion.moving, mmuIdle);

  let travelTarget;
  if (hint && hint.travel !== null && hint.travel !== undefined) {
    travelTarget = hint.travel;                                  // UI sequence (cut choreography)
  } else if (st.cutter && Number.isFinite(st.cutter.baseMm) && signedMm !== null) {
    // During a cut the macro feeds feed_length+cut_length forward while filament_pos is STILL 0, so
    // the advance only shows as a delta from where the filament sat when the cut began (HH's
    // filament_position is a running value that is not zeroed at the gate).
    travelTarget = travelForMm(signedMm - st.cutter.baseMm - geo.gateParking, geo);
  } else if (mmu.filament_pos === 10) travelTarget = 1;          // at the nozzle
  else if (parkRel !== null) {
    // Still in the gate region (filament_pos 0..2). Check-gate / preload / cut move the filament out
    // and back here without a real load, and HH's position counter carries an arbitrary offset while
    // it does — so measure from where the filament last came to rest instead.
    travelTarget = travelForMm(parkRel - geo.gateParking, geo);
  }
  else if (signedMm !== null) travelTarget = travelForMm(signedMm, geo); // signed => direction is inherent
  else travelTarget = travelFromPos(mmu.filament_pos, mmu.bowden_progress);

  // A scripted stage eases at the design's pace (animateTravel used ~700 ms); live printer
  // motion stays snappy so the head tracks the real filament without lag.
  const travel = easeTravel(travelTarget, ctx, (hint && hint.travel !== null && hint.travel !== undefined) ? 340 : 160);

  const pathGate = gate !== null ? gate : (selector !== null ? selector : 0);
  const loaded = spoolDefs.find(s => s.active) || {};
  const loadedColor = loaded.color || (phase === "checking" ? (gateInfo[pathGate] || gateInfo[0]).color : A);

  // filament linear speed from volumetric flow: 6.2 mm³/s over a 1.75 mm filament (design nominal)
  const flow = 6.2, feed = flow / (Math.PI * Math.pow(1.75 / 2, 2));   // ≈ 2.58 mm/s
  const PX_PER_MM = 6, pxPerSec = feed * PX_PER_MM;                    // ≈ 15.5 px/s
  // the gate→nozzle route stands for ~120 mm of filament path
  const ROUTE_MM = 120, routeSec = ROUTE_MM / feed;                    // ≈ 46 s end to end
  // print flow drives the line while printing (real, smoothed extruder feed); otherwise the extruder panel's feedrate does
  const extrudeFactor = typeof gm.extrude_factor === "number" ? gm.extrude_factor : 1;
  const liveFeed = smoothFeed(Math.max(0, liveE));
  const extrudeRate = +ui.extrudeRate > 0 ? +ui.extrudeRate : 10;
  const activeFeed = printing ? (liveFeed > 0.05 ? liveFeed : feed * extrudeFactor) : extrudeRate;
  // quantise the animation speed so a jittery live feed does not re-time the dash animation on every status update
  const animFeed = printing ? Math.max(0.5, Math.round(activeFeed * 2) / 2) : Math.max(0.1, activeFeed);
  const periodSec = 0.034 * (ROUTE_MM / animFeed);
  const dashPeriod = periodSec.toFixed(2) + "s";
  // vFlow travels 240 units per cycle over an 18-unit dash pattern
  const dashCycle = (periodSec * 240 / 18).toFixed(2) + "s";
  const VB = 0.73;                                                     // viewBox unit → px in the rail svg
  const uiExtruding = ui.extruding !== false;                          // the chip toggle (design: S.extruding, default on)
  const extruding = uiExtruding && gate !== null && travel === 1 && printing;
  const dur = pxRun => (pxRun / pxPerSec).toFixed(2) + "s";
  const pausedSuffix = extruding ? "" : "; animation-play-state:paused";
  const moving = isMoving(phase) || motion.moving;
  // Happy Hare tells us the direction outright (+1 load / -1 unload) — more reliable than inferring it from the phase.
  // Direction: the hint is authoritative while it is live (HH leaves filament_direction at its last
  // value — it reads -1 even while parked, which would make a manual EXTRUDE animate backwards).
  const reversing = hint && hint.dir ? hint.dir < 0 : motion.dir < 0;
  const reverseSuffix = reversing ? "; animation-direction:reverse" : "";
  const flowing = extruding || moving;
  const flowSuffix = (flowing ? "" : "; animation-play-state:paused") + reverseSuffix;

  return {
    // contract fields
    A, press, spoolDefs, gateInfo, loaded, loadedColor, pathGate, gate, selector, servo, phase, travel,
    moving, reversing, flowing, extruding, printing, activeFeed, dashPeriod, dashCycle, flowSuffix, reverseSuffix, feed, pxPerSec,
    // extras (safe to ignore)
    mmu, action, rawServo, selectorMoving, selectorKnown, rawGate, tool, filament, estop, printState,
    encObj, measuredMm, signedMm, motion, parkRel, geo, cutTravelPos: cutTravel(geo), bowdenLen, extruderToNozzle, hint,
    travelTarget, liveFeed, liveExtruderVelocity: liveE, extrudeFactor, extrudeRate, uiExtruding, pausedSuffix, dur, routeSec, VB,
    swaps: typeof mmu.num_toolchanges === "number" ? mmu.num_toolchanges : null,
    extruderTemp: typeof ext.temperature === "number" ? ext.temperature : null,
    extruderTarget: typeof ext.target === "number" ? ext.target : null,
    spoolsById, NUM_GATES, BYPASS,
  };
}
