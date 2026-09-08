// TOOL & EXTRUDER panel adapter — live view-model for the template keys
//   tools, factors, extruderVals, lenSteps, rateSteps, retract, extrude
// Style strings are copied VERBATIM from the design's renderVals() (src/pages/dashboard/logic.jsx); only the data
// sources changed:
//   tools        ← raw.mmu (Happy Hare): tool i feeds gate ttg_map[i]; empty = gate_status[gate] === 0; on = loaded tool;
//                  dot colour = the shared gateInfo colour (ctx.common, same swatch as the MMU spool cards) or hh.gateHex
//   factors      ← raw.gcode_move.speed_factor / extrude_factor × 100 (bar click → act.setFactor → M220 / M221)
//   extruderVals ← raw.extruder.pressure_advance / smooth_time, ctx.ui.extrudeLen / extrudeRate
//   lenSteps / rateSteps → ctx.set({ extrudeLen | extrudeRate })      (UI-only state, lives in the logic's state)
//   retract / extrude   → act.extrudeMove(dir, len, rate)             (src/lib/actions/extruder.js, can_extrude guard)
// Never throws: every input may be missing before the first status update — values fall back to "—" / design defaults.
import { gateHex } from "../../../lib/hh.js";

const DEFAULT_LEN = 100;   // mm   (design default, logic.jsx state.extrudeLen)
const DEFAULT_RATE = 10;   // mm/s (design default, logic.jsx state.extrudeRate)
export const LEN_STEPS = [100, 50, 25, 10];
export const RATE_STEPS = [20, 15, 10, 5];
export const NUM_TOOLS = 8;              // the design's 4×2 tool grid: T0..T7
const EMPTY_COLOR = "#2a3340";           // design colour for an empty gate (hh.gateHex fallback)
const DESIGN_BLACK = "#3f4650";          // the design's "Black" swatch — pure #000 vanishes on the panel background

/** Fallback for ctx.barPick when the logic host does not provide one (same code as the design's barPick). */
function localBarPick(cb) {
  return e => {
    const r = e.currentTarget.getBoundingClientRect();
    cb(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100));
  };
}

/** Finite number or null (Moonraker fields can be null/undefined before the first status update). */
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

/** Positive finite number (numeric strings accepted) or the default — for the UI pickers' len / rate. */
function posNum(v, dflt) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Klipper time constants (pressure_advance, smooth_time) → text like the design's "0.02 s" / "0.04 s":
 * up to 4 decimals (Klipper accepts 0.0325), trailing zeros trimmed, never fewer than 2 decimals; null → "—".
 */
export function fmtSeconds(v) {
  if (v === null || v === undefined || typeof v !== "number" || !isFinite(v)) return "—";
  let s = v.toFixed(4).replace(/0+$/, "");
  const dec = s.split(".")[1] || "";
  if (dec.length < 2) s = v.toFixed(2);
  return s;
}

/** Lift colours that would be invisible on the dark panel (pure black filament) to the design's black swatch. */
export function visibleHex(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return EMPTY_COLOR;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 24 ? DESIGN_BLACK : hex.toLowerCase();
}

/**
 * Per-tool info from Happy Hare. Tool i feeds from gate ttg_map[i] (identity when the map is absent).
 *   empty  = gate_status[gate] === 0 (GATE.EMPTY) — unknown (-1) / available (1) / from buffer (2) stay selectable
 *   on     = this tool is loaded to the nozzle: filament === 'Loaded' and mmu.tool === i
 *            (when HH reports tool -1 while loaded, the tools mapped to the loaded gate light up instead)
 *   color  = shared gateInfo colour when the host passes ctx.common (identical to the MMU spool cards), else hh.gateHex
 */
export function toolInfo(st, i, common) {
  const raw = (st && st.raw) || {};
  const hasMmu = !!raw.mmu;
  const mmu = raw.mmu || {};
  const ttg = Array.isArray(mmu.ttg_map) ? mmu.ttg_map : [];
  const gate = typeof ttg[i] === "number" && ttg[i] >= 0 ? ttg[i] : i;
  const status = Array.isArray(mmu.gate_status) ? mmu.gate_status[gate] : undefined;
  const empty = !hasMmu || status === 0 || status === undefined || status === null;
  const loaded = String(mmu.filament || "").toLowerCase() === "loaded";
  const tool = typeof mmu.tool === "number" ? mmu.tool : -1;
  const on = !empty && loaded && (tool === i || (tool < 0 && typeof mmu.gate === "number" && mmu.gate === gate));
  const gi = common && Array.isArray(common.gateInfo) ? common.gateInfo[gate] : null;
  const color = !hasMmu ? EMPTY_COLOR : (gi && gi.color) ? gi.color : visibleHex(gateHex(st, gate));
  return { gate, status, empty, on, loaded, color };
}

export function extruderVals(ctx) {
  const c = ctx || {};
  const st = c.st || (c.store && c.store.state) || {};
  const ui = c.ui || {};
  const act = c.act || {};
  const common = c.common || null;
  const raw = st.raw || {};
  const mmu = raw.mmu || {};
  const ext = raw.extruder || {};
  const gm = raw.gcode_move || {};
  const A = c.A || (common && common.A) || "#ff5a33";
  const press = (common && common.press) || "; transition:transform .07s ease, border-color .12s";
  const set = typeof c.set === "function" ? c.set : () => {};
  const log = typeof c.log === "function" ? c.log : () => {};
  const barPick = typeof c.barPick === "function" ? c.barPick : localBarPick;

  const extrudeLen = posNum(ui.extrudeLen, DEFAULT_LEN);
  const extrudeRate = posNum(ui.extrudeRate, DEFAULT_RATE);

  // ---- verbatim design style helper (logic.jsx renderVals)
  const stepStyle = on => "background:" + (on ? "#150f10" : "#0d121a") + "; border:1px solid " + (on ? A : "#1c2430") +
    "; border-radius:3px; padding:5px 0; text-align:center; font-family:'JetBrains Mono',monospace; font-size:9.5px; cursor:pointer; color:" +
    (on ? "#e8eef6" : "#6b7789") + "; transition:transform .07s ease, border-color .12s";

  // ---- tools T0..T(n-1): n = mmu.num_gates (8 on this printer), capped at the design's 8-tile grid
  const nGates = num(mmu.num_gates);
  const nTools = nGates !== null && nGates > 0 ? Math.min(NUM_TOOLS, Math.round(nGates)) : NUM_TOOLS;
  const tools = Array.from({ length: nTools }, (_, i) => i).map(i => {
    const t = toolInfo(st, i, common);
    const empty = t.empty;
    const on = t.on;
    return {
      n: "T" + i,
      go: () => {
        if (typeof act.selectTool === "function") act.selectTool(i);
        else log("T" + i + " — tool actions not wired", "warn");
      },
      style: "display:flex; align-items:center; justify-content:center; gap:5px; padding:6px 0; border-radius:4px; background:" +
        (on ? "#150f10" : empty ? "#0a0e13" : "#0d121a") + "; border:1px " + (empty ? "dashed" : "solid") + " " +
        (on ? A : empty ? "#1a222c" : "#1c2430") + "; color:" +
        (on ? "#e8eef6" : empty ? "#33404f" : "#6b7789") +
        (empty ? "; cursor:not-allowed; opacity:.6" : "; cursor:pointer") + press,
      dot: "width:9px; height:9px; border-radius:50%; border:1px solid " + (empty ? "#1f2833" : "#2c3746") + "; background:" +
        (empty ? "#11161f" : t.color)
    };
  });

  // ---- speed / extrusion factors from gcode_move (fractions → %)
  const speedFactor = num(gm.speed_factor), extrudeFactor = num(gm.extrude_factor);
  const factors = [
    { k: "SPEED FACTOR", key: "speed", v: speedFactor === null ? null : Math.round(speedFactor * 100) },
    { k: "EXTRUSION FACTOR", key: "extrusion", v: extrudeFactor === null ? null : Math.round(extrudeFactor * 100) }
  ].map(f => {
    const v = f.v === null ? 100 : f.v;      // bar geometry falls back to the 100 % mark while unknown; the label shows "—"
    return {
      k: f.k, v: f.v === null ? "—" : f.v + " %",
      set: barPick(p => {
        const pct = Math.max(20, p * 2);
        if (typeof act.setFactor === "function") act.setFactor(f.key, pct);
        else log((f.key === "speed" ? "M220 S" : "M221 S") + pct + " — factor actions not wired", "warn");
      }),
      fill: `width:${Math.min(100, v / 2)}%; height:100%; background:${A}; border-radius:2px`,
      knob: `position:absolute; left:${Math.min(100, v / 2)}%; top:50%; width:9px; height:9px; margin:-4.5px 0 0 -4.5px; border-radius:50%; background:#e8eef6; border:2px solid ${A}`
    };
  });

  // ---- extruder tiles (design: "0.02 s" / "0.04 s" / "100 mm" / "10 mm/s")
  const pa = num(ext.pressure_advance), smooth = num(ext.smooth_time);
  const extruderVals = [
    { k: "PRESSURE ADV", v: pa === null ? "—" : fmtSeconds(pa) + " s" }, { k: "SMOOTH TIME", v: smooth === null ? "—" : fmtSeconds(smooth) + " s" },
    { k: "LENGTH", v: extrudeLen + " mm" }, { k: "FEEDRATE", v: extrudeRate + " mm/s" }
  ];

  // ---- step pickers (UI-only state in ctx.ui, written through ctx.set)
  const lenSteps = LEN_STEPS.map(v => ({
    t: String(v),
    style: stepStyle(extrudeLen === v),
    go: () => { set({ extrudeLen: v }); log("Extrude length " + v + " mm"); }
  }));
  const rateSteps = RATE_STEPS.map(v => ({
    t: String(v),
    style: stepStyle(extrudeRate === v),
    go: () => { set({ extrudeRate: v }); log("Extrude feedrate " + v + " mm/s"); }
  }));

  // ---- manual extrude / retract: the picked length + feedrate travel with the call (the action has no access to ui state)
  const move = dir => {
    if (typeof act.extrudeMove === "function") return act.extrudeMove(dir, extrudeLen, extrudeRate);
    log("M83 · G1 E" + (dir > 0 ? "" : "-") + extrudeLen + " F" + extrudeRate * 60 + " — extruder actions not wired", "warn");
    return undefined;
  };

  // ---- the line under RETRACT / EXTRUDE. The design baked it in as the literal
  //      "~1914 mm @ 24.1 mm³/s · ⌀ 0.4 mm", so the panel described a move nobody had asked for and never
  //      changed when the length / feedrate pickers did. Same shape, real numbers: the picked length, the
  //      volumetric rate that feedrate works out to on 1.75 mm filament, and the configured nozzle
  //      (boot.js parks configfile.settings on st.config; "—" until it lands).
  const volFlow = extrudeRate * Math.PI * Math.pow(1.75 / 2, 2);
  const nozzle = num(((st.config || {}).extruder || {}).nozzle_diameter);
  const extrudeSummary = "~" + extrudeLen + " mm @ " + volFlow.toFixed(1) + " mm³/s · ⌀ " +
    (nozzle === null ? "—" : nozzle) + " mm";

  return {
    tools,
    factors,
    extruderVals,
    lenSteps,
    rateSteps,
    extrudeSummary,
    retract: () => move(-1),
    extrude: () => move(1)
  };
}

export default extruderVals;
