// TEMPERATURES panel adapter — live view-model for the template keys
//   tempSeries, graphHover, graphLeave, gridLines, hoverLineStyle, tipStyle, tipRows, tipTime,
//   temps, clock, cooldownClick, toggleSoakMenu, soakMenuStyle, soakOptions
// Style strings are copied verbatim from the design's renderVals() (src/pages/dashboard/logic.jsx);
// only the data sources changed (st.tempHistory / st.raw.* / st.procStats / ctx.ui).
import { SOAK_PROFILES, MAX_EXTRUDER, MAX_BED } from "../../../lib/actions/temps.js";

const N = 61;             // the design draws 61 samples: −60 s … now, one per second
const MIN_SPAN = 0.5;     // °C — floor for the window's min..max so idle ADC noise is not blown up to a full-amplitude wave

/**
 * The four charted sensors. The design drew these as separate stylized sparklines, each on its own
 * invisible baseline with its own amplitude — pretty, but the lines were not comparable to each other.
 * They now share ONE temperature axis (see sharedDomain/seriesPoints), so a line that sits above
 * another really is hotter.
 */
export const SERIES = [
  { key: "extruder",                        color: "#ff5a33", name: "Extruder" },
  { key: "temperature_sensor Cartographer", color: "#3ddcc4", name: "Cartographer" },
  { key: "heater_bed",                      color: "#f0b429", name: "Heater Bed" },
  { key: "temperature_sensor CHAMBER",      color: "#5b7fd8", name: "Chamber" }
];

// Graph geometry (the template's svg is viewBox 0 0 620 132, rendered 112px tall).
export const VB_W = 620, VB_H = 132, SVG_PX_H = 112, PAD_T = 9, PAD_B = 9;
const STEP = 25;          // °C — axis snaps to 25° so it does not jitter every second
const TICKS = 4;          // 5 gridlines including both bounds

/** Shared y-domain across every charted series, rounded out to whole STEPs. */
export function sharedDomain(seriesVals) {
  let min = Infinity, max = -Infinity;
  for (const vals of seriesVals) {
    for (const v of vals) {
      if (v === null || v === undefined) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) return { lo: 0, hi: 100 };
  const lo = Math.max(0, Math.floor((min - 4) / STEP) * STEP);
  let hi = Math.ceil((max + 4) / STEP) * STEP;
  if (hi - lo < STEP) hi = lo + STEP;
  return { lo, hi };
}

/** °C -> y in viewBox units on the shared axis. */
export function yFor(v, lo, hi) {
  const t = (v - lo) / (hi - lo);
  return PAD_T + (1 - Math.max(0, Math.min(1, t))) * (VB_H - PAD_T - PAD_B);
}

/** Table rows (name, device, max) per the build contract; mcu = Klipper mcu object whose last_stats.mcu_awake is the load. */
export const ROWS = [
  { name: "Extruder",     obj: "extruder",                              device: "Rapido HF",       max: MAX_EXTRUDER, color: "#ff5a33", heater: "Extruder",   key: "t_ext" },
  { name: "Heater Bed",   obj: "heater_bed",                            device: "Keenovo",         max: MAX_BED,      color: "#f0b429", heater: "Heater Bed", key: "t_bed" },
  { name: "Cartographer", obj: "temperature_sensor Cartographer",       device: "Cartographer 3D", max: 105, color: "#3ddcc4" },
  { name: "Carto Coil",   obj: "temperature_sensor cartographer_coil",  device: "probe coil",      max: 100, color: "#3ddcc4" },
  { name: "Chamber",      obj: "temperature_sensor CHAMBER",            device: "enclosure",       max: 60,  color: "#5b7fd8" },
  { name: "EBB",          obj: "temperature_sensor EBB 2209",           device: "EBB36 toolhead",  max: 85,  color: "#8b98aa", mcu: "mcu can0" },
  { name: "MMU",          obj: "temperature_sensor MMU",                device: "MMB",             max: 85,  color: "#8b98aa", mcu: "mcu mmu" },
  { name: "Octopus",      obj: "temperature_sensor OCTOPUS",            device: "Octopus board",   max: 85,  color: "#8b98aa", mcu: "mcu" },
  { name: "Raspberry",    obj: "temperature_sensor RASPBERRY PI",       device: "Raspberry Pi",    max: 80,  color: "#8b98aa", host: true }
];

/** Finite number or null (Moonraker fields can be null/undefined before the first status update). */
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

/** Target for the edit field: "260" / "104.5" / "—". */
function fmtTarget(t) {
  if (t === null) return "—";
  return Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : t.toFixed(1);
}

/** Load / memory percentage for the CPU · MEM columns: "12%" / "0.4%" / "—". */
function pct(v) {
  if (v === null) return "—";
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + "%";
}

/** HH:MM:SS — same format as the logic's clock tick (fallback when ctx.ui.clock is empty). */
function nowClock() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}

/**
 * Last 61 samples of a temperature_store series, oldest → newest, right-aligned so index 60 is "now".
 * Missing samples are null (short history after a restart); with no history at all the live reading fills "now".
 */
export function window61(tempHistory, key, liveNow) {
  const out = new Array(N).fill(null);
  const s = tempHistory && tempHistory[key];
  const arr = s && Array.isArray(s.temperatures) ? s.temperatures : null;
  if (arr && arr.length) {
    const tail = arr.slice(-N);
    const off = N - tail.length;
    for (let i = 0; i < tail.length; i++) out[off + i] = num(tail[i]);
  } else if (liveNow !== null && liveNow !== undefined) {
    out[N - 1] = num(liveNow);
  }
  return out;
}

/** Real °C window -> polyline points on the SHARED axis. Empty string when there is no data. */
export function seriesPoints(vals, lo, hi) {
  const pts = [];
  for (let k = 0; k < N; k++) {
    const v = vals[k];
    if (v === null || v === undefined) continue;
    pts.push(`${(k * VB_W / (N - 1)).toFixed(1)},${yFor(v, lo, hi).toFixed(1)}`);
  }
  return pts.join(" ");
}

/** Gridlines for the svg (viewBox units) plus HTML labels positioned in real px over the chart. */
export function axisTicks(lo, hi) {
  const lines = [], labels = [];
  for (let i = 0; i <= TICKS; i++) {
    const v = hi - (hi - lo) * (i / TICKS);
    const y = PAD_T + (i / TICKS) * (VB_H - PAD_T - PAD_B);
    lines.push({ y: +y.toFixed(1) });
    labels.push({
      label: Math.round(v) + "\u00b0",
      // The svg is drawn with preserveAspectRatio="none", so text inside it would be stretched;
      // the labels are HTML overlaid on the chart instead.
      style: "position:absolute; left:3px; top:" + (y * SVG_PX_H / VB_H).toFixed(1) +
        "px; transform:translateY(-50%); font-family:'JetBrains Mono',monospace; font-size:8px; " +
        "letter-spacing:.06em; color:#8b98aa; pointer-events:none; background:#0d121a; padding:0 2px"
    });
  }
  return { lines, labels };
}

/** Fallback for ctx.field when the logic host does not provide one — same semantics as the design's field() (edits live in ui.edits). */
function localField(ui, set) {
  return (key, shown, commit) => {
    const edits = (ui && ui.edits) || {};
    const val = edits[key] !== undefined ? edits[key] : shown;
    const dirty = edits[key] !== undefined && edits[key] !== shown;
    const write = t => set(s => ({ edits: Object.assign({}, s.edits, { [key]: t }) }));
    const clear = () => set(s => { const e = Object.assign({}, s.edits); delete e[key]; return { edits: e }; });
    const apply = () => { const n = parseFloat(val); clear(); if (!isNaN(n) && commit) commit(n); };
    return {
      value: val, dirty,
      onChange: e => write(e.target.value),
      onBlur: () => apply(),
      onKeyDown: e => {
        if (e.key === "Enter") e.target.blur();                 // blur → onBlur → apply (once)
        else if (e.key === "Escape") { clear(); e.target.blur(); }
      }
    };
  };
}

export function tempsVals(ctx) {
  const st = (ctx && ctx.st) || {};
  const ui = (ctx && ctx.ui) || {};
  const act = (ctx && ctx.act) || {};
  const raw = st.raw || {};
  const th = st.tempHistory || null;
  const ps = st.procStats || null;
  const set = (ctx && typeof ctx.set === "function") ? ctx.set : () => {};
  const log = (ctx && typeof ctx.log === "function") ? ctx.log : () => {};
  const field = (ctx && typeof ctx.field === "function") ? ctx.field : localField(ui, set);
  const hoverIdx = Number.isInteger(ui.hoverIdx) ? Math.max(0, Math.min(60, ui.hoverIdx)) : null;

  // ---- graph: oldest sample on the left, newest on the right (real samples from the temperature store)
  const windows = SERIES.map(s => window61(th, s.key, num((raw[s.key] || {}).temperature)));
  const { lo, hi } = sharedDomain(windows);
  const ticks = axisTicks(lo, hi);
  const tempSeries = SERIES.map((s, i) => ({
    points: seriesPoints(windows[i], lo, hi), color: s.color, name: s.name, vals: windows[i]
  }));

  // ---- actions (fall back to a console line when the actions object is not wired yet)
  const setTarget = (name, v) => {
    if (act.setTarget) return act.setTarget(name, v);
    log((name === "Extruder" ? "M104 S" : "M140 S") + Math.round(v) + " — actions not wired", "warn");
  };
  const bumpTarget = (name, d) => {
    if (act.bumpTarget) return act.bumpTarget(name, d);
    log(name + " " + (d > 0 ? "+" : "") + d + " °C — actions not wired", "warn");
  };
  const heatSoak = p => {
    set({ soakMenuOpen: false });
    if (act.heatSoak) return act.heatSoak(p);
    log("HEATSOAK MATERIAL=" + p.mat + " — M140 S" + p.bed + " · chamber fan 40% · exhaust " + p.exhaust + "% — actions not wired", "warn");
  };
  const cooldown = () => {
    if (act.cooldown) return act.cooldown();
    log("TURN_OFF_HEATERS — actions not wired", "warn");
  };

  /** Editable target field (design's field helper) + ↑/↓ nudges the live target by 1 °C (⇧ = 10 °C). */
  const targetField = (row, target) => {
    const f = field(row.key, fmtTarget(target), v => setTarget(row.heater, v));
    const base = f && f.onKeyDown;
    return Object.assign({}, f, {
      onKeyDown: e => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          bumpTarget(row.heater, (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
          return;
        }
        if (typeof base === "function") base(e);
      }
    });
  };

  // each sensor scaled against the recommended maximum for its device
  const mkTemp = (name, state, curN, target, color, max, bump, device, mcu) => {
    const frac = Math.max(0, Math.min(1, (curN === null ? 0 : curN) / max));
    const hot = frac >= 0.9, warm = frac >= 0.75;
    const load = mcu ? mcu[0] : null, mem = mcu ? mcu[1] : null;
    const busy = v => v >= 85 ? "#ff5a33" : v >= 65 ? "#f0b429" : "#6b7789";
    return {
      name, state, target, device,
      cpu: mcu ? pct(load) : "",
      mem: mcu ? pct(mem) : "",
      cpuStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; text-align:right; color:" + (mcu ? busy(load) : "#1c2430"),
      memStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; text-align:right; color:" + (mcu ? busy(mem) : "#1c2430"),
      cur: curN === null ? "—" : curN.toFixed(1) + "°C",
      max: max + "°",
      maxStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; text-align:right; color:" +
        (hot ? "#ff5a33" : warm ? "#f0b429" : "#3d4859"),
      dot: `width:6px; height:6px; border-radius:50%; background:${color}; flex:none`,
      editable: !!bump,
      readonly: !bump,
      field: bump || { value: "", onChange: null, onBlur: null, onKeyDown: null },
      inputStyle: "width:100%; min-width:0; background:#0d121a; border:1px solid " +
        (bump && bump.dirty ? color : "#1c2430") +
        "; border-radius:3px; padding:2px 4px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:10.5px; color:#c9d3e0",
      targetStyle: "font-family:'JetBrains Mono',monospace; font-size:10.5px; text-align:right; color:#6b7789",
      rowStyle: "display:grid; grid-template-columns:6px minmax(56px,1fr) 50px 40px 28px 28px 26px 26px; align-items:center; gap:4px; padding:4px 3px; border-radius:3px",
      curStyle: `font-family:'JetBrains Mono',monospace; font-size:12px; text-align:right; color:${frac > .8 ? "#e8eef6" : "#8b98aa"}`,
      barStyle: `width:${Math.round(frac * 100)}%; height:100%; border-radius:2px; background:${hot ? "#ff5a33" : warm ? "#f0b429" : color}`
    };
  };

  // ---- per-row live data
  const mcuLoad = objName => {
    const ls = (raw[objName] || {}).last_stats || {};
    const awake = num(ls.mcu_awake);
    return awake === null ? null : Math.max(0, Math.min(100, awake * 100));
  };
  const hostCpu = () => num(((ps || {}).system_cpu_usage || {}).cpu);
  const hostMem = () => {
    const m = (ps || {}).system_memory || {};
    const total = num(m.total), used = num(m.used);
    if (total === null || total <= 0) return null;
    if (used !== null) return Math.max(0, Math.min(100, used / total * 100));
    const avail = num(m.available);
    return avail === null ? null : Math.max(0, Math.min(100, (total - avail) / total * 100));
  };

  const temps = ROWS.map(row => {
    const obj = raw[row.obj] || {};
    const cur = num(obj.temperature);
    if (row.heater) {
      const target = num(obj.target);
      const power = num(obj.power);
      return mkTemp(row.name, power === null ? "—" : Math.round(power * 100) + " %", cur,
        target === null ? "—" : fmtTarget(target) + " °C", row.color, row.max, targetField(row, target), row.device);
    }
    const mcu = row.mcu ? [mcuLoad(row.mcu), null] : row.host ? [hostCpu(), hostMem()] : null;
    return mkTemp(row.name, "—", cur, "—", row.color, row.max, null, row.device, mcu);
  });

  return {
    tempSeries,
    graphHover: e => {
      const r = e.currentTarget.getBoundingClientRect();
      const i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 60);
      if (i !== hoverIdx) set({ hoverIdx: i });
    },
    graphLeave: () => set({ hoverIdx: null }),
    gridLines: ticks.lines,
    gridLabels: ticks.labels,
    axisLo: lo,
    axisHi: hi,
    hoverLineStyle: hoverIdx === null
      ? "display:none"
      : `position:absolute; top:0; bottom:0; left:${(hoverIdx / 60 * 100).toFixed(2)}%; width:1px; background:#8b98aa; opacity:.55; pointer-events:none`,
    tipStyle: hoverIdx === null
      ? "display:none"
      : "position:absolute; top:2px; " + (hoverIdx > 30 ? "right:" + ((60 - hoverIdx) / 60 * 100).toFixed(2) + "%; margin-right:8px" : "left:" + (hoverIdx / 60 * 100).toFixed(2) + "%; margin-left:8px") +
        "; z-index:5; pointer-events:none; padding:6px 8px; border:1px solid #2c3746; border-radius:4px; background:#0d121a; box-shadow:0 8px 20px rgba(0,0,0,.6); display:flex; flex-direction:column; gap:3px; animation:vRise .12s ease both",
    tipRows: hoverIdx === null ? [] : tempSeries.map(s => {
      const v = s.vals[hoverIdx];
      return {
        name: s.name,
        val: v === null || v === undefined ? "—" : v.toFixed(1) + " °C",
        dot: `width:6px; height:6px; border-radius:50%; flex:none; background:${s.color}`
      };
    }),
    temps,
    tipTime: hoverIdx === null ? "" : (hoverIdx === 60 ? "now" : "−" + (60 - hoverIdx) + " s"),
    clock: ui.clock || nowClock(),
    cooldownClick: () => cooldown(),
    toggleSoakMenu: () => set(s => ({ soakMenuOpen: !s.soakMenuOpen })),
    soakMenuStyle: ui.soakMenuOpen
      ? "position:absolute; right:0; top:24px; z-index:40; min-width:186px; padding:5px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 12px 26px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both"
      : "display:none",
    soakOptions: SOAK_PROFILES.map(p => ({
      mat: p.mat,
      detail: "bed " + p.bed + "°C · exhaust " + p.exhaust + "%",
      go: () => heatSoak(p),
      style: "display:flex; align-items:baseline; gap:8px; padding:5px 8px; border-radius:3px; cursor:pointer; white-space:nowrap; color:#8b98aa"
    }))
  };
}

export default tempsVals;
