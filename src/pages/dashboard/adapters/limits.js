// MACHINE LIMITS panel adapter — live view-model for the template key `limits` (+ `limitsEditable`).
// Row labels/units and the field style are copied verbatim from the design's renderVals() (src/pages/dashboard/logic.jsx);
// only the data sources changed: raw.toolhead.{max_velocity,max_accel,square_corner_velocity,minimum_cruise_ratio}
// and raw.gcode_move.homing_origin[2]. Each row carries a design-style edit field (ctx.field('lim_'+key, shown, commit))
// whose commit calls act.setLimit(key, n) → SET_VELOCITY_LIMIT … / SET_GCODE_OFFSET Z=… MOVE=1 (src/lib/actions/limits.js).
//
// The generated Template renders {l.v} as plain text today; `limitsEditable: true` + the per-row `field`/`fieldStyle`
// let the integrator swap that span for an <input> (exact JSX in the build report). Until then the rows still show live values.

/** Finite number or null (Moonraker fields can be null/undefined before the first status update). */
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

/** Design shows `String(cfg.velocity)` → "1000"; live floats keep at most `dec` decimals, integers stay bare ("7000", "9", "60", "9.5"). */
function fmtNum(v, dec) {
  if (v === null) return "—";
  const s = String(+v.toFixed(dec));
  return s.indexOf("e") >= 0 ? v.toFixed(dec) : s;
}

/** Row definitions in the design's order. `read(th, gm)` → number|null in panel units; `fmt` → the shown string. */
export const LIMIT_ROWS = [
  { key: "velocity", k: "Velocity",          u: "mm/s",  read: th => num(th.max_velocity),           fmt: v => fmtNum(v, 1) },
  { key: "accel",    k: "Acceleration",      u: "mm/s²", read: th => num(th.max_accel),              fmt: v => fmtNum(v, 0) },
  { key: "scv",      k: "Square Corner Vel", u: "mm/s",  read: th => num(th.square_corner_velocity), fmt: v => fmtNum(v, 2) },
  { key: "cruise",   k: "Min Cruise Ratio",  u: "%",     read: th => { const r = num(th.minimum_cruise_ratio); return r === null ? null : r * 100; }, fmt: v => fmtNum(v, 1) },
  { key: "zoffset",  k: "Z Offset",          u: "mm",    read: (th, gm) => { const o = gm.homing_origin; return Array.isArray(o) ? num(o[2]) : null; }, fmt: v => v.toFixed(3) }
];

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
// Harmless for the fake state, but it would send two gcode lines — dedupe identical commits within a short window.
const lastCommit = { key: null, n: null, t: 0 };
const DEDUPE_MS = 500;

export function limitsVals(ctx) {
  const st = (ctx && ctx.st) || {};
  const ui = (ctx && ctx.ui) || {};
  const act = (ctx && ctx.act) || {};
  const raw = st.raw || {};
  const th = raw.toolhead || {};
  const gm = raw.gcode_move || {};
  const set = (ctx && typeof ctx.set === "function") ? ctx.set : () => {};
  const log = (ctx && typeof ctx.log === "function") ? ctx.log : () => {};
  const field = (ctx && typeof ctx.field === "function") ? ctx.field : (key, shown, commit) => localField(ui, set, key, shown, commit);
  const edits = ui.edits || {};

  const limits = LIMIT_ROWS.map(def => {
    const rawV = def.read(th, gm);
    const shown = rawV === null ? "—" : def.fmt(rawV);
    const editKey = "lim_" + def.key;
    const commit = n => {
      if (typeof n !== "number" || !isFinite(n)) return;
      // no-op guard: clicking in and out of a field re-applies the shown value — do not send gcode for an unchanged limit
      if (rawV !== null && def.fmt(n) === shown) return;
      const now = Date.now();
      if (lastCommit.key === def.key && lastCommit.n === n && now - lastCommit.t < DEDUPE_MS) return;
      lastCommit.key = def.key; lastCommit.n = n; lastCommit.t = now;
      if (act.setLimit) act.setLimit(def.key, n);
      else log((def.key === "zoffset" ? "SET_GCODE_OFFSET Z=" + n.toFixed(3) + " MOVE=1" : "SET_VELOCITY_LIMIT " + def.k.toUpperCase().replace(/ /g, "_") + "=" + n) + " — actions not wired", "warn");
    };
    return {
      k: def.k, v: shown, u: def.u,
      key: def.key, raw: rawV, editable: true,
      field: field(editKey, shown, commit),
      // verbatim design zFieldStyle (the Z-OFFSET input): teal border while an edit is in progress, hairline otherwise
      fieldStyle: "width:62px; background:#0d121a; border:1px solid " +
        (edits[editKey] !== undefined ? "#3ddcc4" : "#1c2430") +
        "; border-radius:3px; padding:3px 6px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:12px; color:#3ddcc4"
    };
  });

  return { limits, limitsEditable: true };
}

export default limitsVals;
