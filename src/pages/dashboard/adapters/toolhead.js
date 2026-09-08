// TOOLHEAD panel adapter — live view-model for the template keys
//   axes, homeBtns, jogRows, zSteps, zField, zFieldStyle, saveZ
// Style strings (bar(), jogCell(), zFieldStyle) are copied VERBATIM from the design's renderVals() (src/pages/dashboard/logic.jsx);
// only the data sources changed:
//   axes      ← raw.toolhead.position[0..2] + raw.toolhead.homed_axes ("xyz"); v shows "?" for an unhomed axis (design) and "—"
//               when Klipper has not reported a position yet. `max` / the bar's 100 % = the printer's travel from
//               raw.toolhead.axis_maximum (335 / 355 / 320 on this Voron), falling back to the contract's 350 / 350 / 310.
//   homeBtns  → act.home('HOME' | 'XY' | 'QGL' | 'MESH')                   (G28 · G28 X Y · QUAD_GANTRY_LEVEL · BED_MESH_CALIBRATE)
//   jogRows   → act.jog(axis, ±step)  X/Y 100·50·1, Z 50·10·1; the centre axis cell homes THAT axis only (X → G28 X, …).
//               Was (Z → HOME, X/Y → XY) to match the design mockup, but a per-axis button that homes all three is a
//               surprise on a printer mid-setup — and act.home already supports the X / Y / Z kinds (see actions/toolhead.js).
//   zSteps    → act.nudgeZ(±0.005 | ±0.025)                                 (SET_GCODE_OFFSET Z_ADJUST=… MOVE=1)
//   zField    ← raw.gcode_move.homing_origin[2].toFixed(3) via ctx.field('zoff', shown, commit) → act.setZ(n)
//   saveZ     → act.saveZ()                                                 (Z_OFFSET_APPLY_PROBE → "SAVE_CONFIG pending")
// Never throws: every input may be missing before the first status update — values fall back to "—" / grey bars.
import { axisLimits, isHomed, axisPosition, zOffsetOf, HOME_CMDS, JOG_FEED, fmtNum } from "../../../lib/actions/toolhead.js";

/** Design jog rows: [axis, [coarse, medium, fine]] — rendered as −c −m −f [axis] +f +m +c. */
export const JOG_STEPS = [["X", [100, 50, 1]], ["Y", [100, 50, 1]], ["Z", [50, 10, 1]]];
/** Design Z-offset nudge buttons. */
export const Z_STEPS = [-0.025, -0.005, 0.005, 0.025];
/** Design home buttons (left → right). */
export const HOME_BTNS = ["HOME", "XY", "QGL", "MESH"];
export const AXES = ["X", "Y", "Z"];

/** Fallback for ctx.field when the logic host does not provide one — same code as the design's field(); edits live in ui.edits via ctx.set. */
function localField(ui, set, key, shown, commit) {
  const edits = (ui && ui.edits) || {};
  const val = edits[key] !== undefined ? edits[key] : shown;
  const dirty = edits[key] !== undefined && edits[key] !== shown;
  const write = t => set(s => ({ edits: Object.assign({}, (s && s.edits) || {}, { [key]: t }) }));
  const clear = () => set(s => {
    const e = Object.assign({}, (s && s.edits) || {});
    delete e[key];
    return { edits: e };
  });
  const apply = () => { const n = parseFloat(val); clear(); if (!isNaN(n)) commit(n); };
  return {
    value: val, dirty,
    onChange: e => write(e.target.value),
    onBlur: () => apply(),
    onKeyDown: e => {
      if (e.key === "Enter") { e.target.blur(); apply(); }
      else if (e.key === "Escape") { clear(); e.target.blur(); }
    }
  };
}

// The design's Enter handler blurs (→ onBlur → apply) and then calls apply() again, so one edit commits twice.
// Harmless for the fake state, but it would send SET_GCODE_OFFSET twice — dedupe identical commits within a short window.
const lastCommit = { n: null, t: 0 };
const DEDUPE_MS = 500;

/** "335" / "310" / "12.5" — the axis card's tiny max label (design: String(cfg[n])). */
function fmtMax(v) { return fmtNum(v, 1); }

export function toolheadVals(ctx) {
  const c = ctx || {};
  const st = c.st || (c.store && c.store.state) || {};
  const ui = c.ui || {};
  const act = c.act || {};
  const raw = st.raw || {};
  const A = c.A || (c.common && c.common.A) || "#ff5a33";
  const set = typeof c.set === "function" ? c.set : () => {};
  const log = typeof c.log === "function" ? c.log : () => {};
  const field = typeof c.field === "function" ? c.field : (key, shown, commit) => localField(ui, set, key, shown, commit);
  const edits = ui.edits || {};

  // ---- verbatim design style helpers (logic.jsx renderVals)
  const bar = (pct, color) => `width:${pct}%; height:100%; background:${color}; border-radius:2px`;
  const jogCell = (t, kind, go) => ({
    t, go,
    style: "background:" + (kind === "axis" ? "#141b25" : "#0d121a") + "; border:1px solid " + (kind === "axis" ? "#2c3746" : "#1c2430") +
      "; border-radius:3px; padding:6px 0; text-align:center; font-family:'JetBrains Mono',monospace; font-size:10px; cursor:pointer; transition:border-color .12s; color:" +
      (kind === "axis" ? A : "#8b98aa")
  });

  // ---- action bridges (log the intended gcode when the integrator has not merged the toolhead actions yet)
  const jog = (ax, d) => {
    if (typeof act.jog === "function") act.jog(ax, d);
    else log("G91 · G1 " + ax + (d > 0 ? "+" : "") + d + " F" + JOG_FEED[ax] + " · G90 — toolhead actions not wired", "warn");
  };
  const home = kind => {
    if (typeof act.home === "function") act.home(kind);
    else log((HOME_CMDS[kind] || kind) + " — toolhead actions not wired", "warn");
  };
  const nudge = d => {
    if (typeof act.nudgeZ === "function") act.nudgeZ(d);
    else log("SET_GCODE_OFFSET Z_ADJUST=" + (d > 0 ? "+" : "") + d + " MOVE=1 — toolhead actions not wired", "warn");
  };

  // ---- axis cards: live position, homed state and travel limits
  const limits = axisLimits(raw);
  const axes = AXES.map(n => {
    const pos = axisPosition(raw, n);
    const homed = isHomed(raw, n);
    const max = limits[n].max;
    // design: bar(Math.round(pos / cfg[n] * 100), homed ? A : "#3d4859") — clamped so a −2 mm Z or an unknown position never yields an invalid width
    const pct = pos === null ? 0 : Math.max(0, Math.min(100, Math.round(pos / max * 100)));
    return {
      n,
      v: pos === null ? "—" : homed ? pos.toFixed(n === "Z" ? 3 : 2) : "?",
      max: fmtMax(max),
      barStyle: bar(pct, homed ? A : "#3d4859")
    };
  });

  const homeBtns = HOME_BTNS.map(t => ({ t, go: () => home(t) }));

  const jogRows = JOG_STEPS.map(row => {
    const ax = row[0], st = row[1];
    return { cells: [
      jogCell("−" + st[0], null, () => jog(ax, -st[0])),
      jogCell("−" + st[1], null, () => jog(ax, -st[1])),
      jogCell("−" + st[2], null, () => jog(ax, -st[2])),
      jogCell(ax, "axis", () => home(ax)),
      jogCell("+" + st[2], null, () => jog(ax, st[2])),
      jogCell("+" + st[1], null, () => jog(ax, st[1])),
      jogCell("+" + st[0], null, () => jog(ax, st[0]))
    ] };
  });

  const zSteps = Z_STEPS.map(d => ({
    t: (d > 0 ? "+" : "−") + Math.abs(d), go: () => nudge(d)
  }));

  // ---- Z-offset field: design's field('zoff', zOffset.toFixed(3), v => setZ(v)) fed by gcode_move.homing_origin[2]
  const zOff = zOffsetOf(raw);
  const shown = zOff === null ? "—" : zOff.toFixed(3);
  const commit = n => {
    if (typeof n !== "number" || !isFinite(n)) return;
    // no-op guard: clicking in and out of the field re-applies the shown value — do not send gcode for an unchanged offset
    if (zOff !== null && n.toFixed(3) === shown) return;
    const now = Date.now();
    if (lastCommit.n === n && now - lastCommit.t < DEDUPE_MS) return;
    lastCommit.n = n; lastCommit.t = now;
    if (typeof act.setZ === "function") act.setZ(n);
    else log("SET_GCODE_OFFSET Z=" + n.toFixed(3) + " MOVE=1 — toolhead actions not wired", "warn");
  };
  const zField = field("zoff", shown, commit);
  const zFieldStyle = "width:62px; background:#0d121a; border:1px solid " +
    (edits.zoff !== undefined ? "#3ddcc4" : "#1c2430") +
    "; border-radius:3px; padding:3px 6px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:12px; color:#3ddcc4";

  const saveZ = () => {
    if (typeof act.saveZ === "function") act.saveZ();
    else log("Z_OFFSET_APPLY_PROBE — toolhead actions not wired", "warn");
  };

  return { axes, homeBtns, jogRows, zSteps, zField, zFieldStyle, saveZ };
}

export default toolheadVals;
