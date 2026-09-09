// FANS & LEDS panel adapter — returns ONLY { fans, leds } for Template.jsx.
// Style strings are copied VERBATIM from logic.jsx renderVals(); only the data source changed:
//   fans  ← raw.fan / raw["fan_generic Chamber"|"Exhaust"] / raw["heater_fan hotend_fan"] / raw["controller_fan Controller"]
//   leds  ← raw["neopixel sb_leds"|"caselight"|"mmu_leds"|"logo"].color_data[0]  (via ledModel in lib/actions/fansLeds.js)
// ctx: { st, ui, set, field, barPick, act, log, A } — see CONTRACT.md "Dashboard adapters".
import { FAN_OBJECTS, LED_ORDER, ledModel } from "../../../lib/actions/fansLeds.js";

// Verbatim from the design (DashboardLogic.hsl2hex) — hue wheel click → hex.
function hsl2hex(h, s) {
  const l = 0.55, c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  const seg = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(hp) % 6];
  const m = l - c / 2;
  return "#" + seg.map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

// Fallback for barPick (verbatim from the design) if the integrator's ctx lacks it.
const localBarPick = cb => e => {
  const r = e.currentTarget.getBoundingClientRect();
  cb(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100));
};
const noField = shown => ({ value: shown, dirty: false, onChange: () => {}, onBlur: () => {}, onKeyDown: () => {} });

const isNum = v => typeof v === "number" && isFinite(v);

export function fansLedsVals(ctx) {
  const st = (ctx && ctx.st) || {};
  const ui = (ctx && ctx.ui) || {};
  const act = (ctx && ctx.act) || {};
  const raw = st.raw || {};
  const A = (ctx && ctx.A) || "#ff5a33";
  const set = (ctx && typeof ctx.set === "function") ? ctx.set : () => {};
  const barPick = (ctx && typeof ctx.barPick === "function") ? ctx.barPick : localBarPick;
  const field = (ctx && typeof ctx.field === "function") ? ctx.field : (key, shown) => noField(shown);
  const warn = m => { try { ctx && ctx.log && ctx.log(m, "warn"); } catch {} };
  const setFan = (k, v) => (act.setFan ? act.setFan(k, v) : warn("setFan action unavailable"));
  const setLed = (k, patch) => (act.setLed ? act.setLed(k, patch) : warn("setLed action unavailable"));
  const edits = ui.edits || {};

  // verbatim helper from renderVals()
  const bar = (pct, color) => `width:${pct}%; height:100%; background:${color}; border-radius:2px`;

  // ---- fans: speed 0..1 → %; exhaust also reports rpm. heater/controller fans are read-only (no click handler).
  const fans = [["Part Fan", A],["Chamber","#5b7fd8"],["Exhaust","#3ddcc4"],["Hotend Fan", A],["Controller","#3ddcc4"]].map(row => {
    const def = FAN_OBJECTS[row[0]];
    const o = raw[def.obj] || {};
    const pct = isNum(o.speed) ? Math.round(Math.min(1, Math.max(0, o.speed)) * 100) : null;
    const rpm = isNum(o.rpm) ? Math.round(o.rpm) : null;
    // A settable fan gets a typed field, like the LED rows already had: dragging a 3 px bar cannot
    // express "37 %", and heater/controller fans stay read-only text because Klipper owns their speed.
    const editable = !!(def.settable && act.setFan);
    return {
      k: row[0],
      // `v` still carries the whole readout for read-only fans (and for a settable fan with no reading yet).
      v: pct === null ? "—" : pct + " %" + (rpm !== null ? " · " + rpm + " rpm" : ""),
      bar: bar(pct === null ? 0 : pct, pct === null ? "#3d4859" : row[1]),
      set: editable ? barPick(p => setFan(row[0], p)) : undefined,
      // setFan takes 0..100 (same units barPick produces), so the field commits a plain percent.
      pctField: editable && pct !== null
        ? field("fan_" + row[0], String(pct), v => setFan(row[0], Math.max(0, Math.min(100, Math.round(v)))))
        : null,
      pctInputStyle: "width:34px; text-align:right; background:#0d121a; border:1px solid #1c2430; border-radius:3px; padding:1px 4px; outline:none; font-family:'JetBrains Mono',monospace; font-size:10.5px; color:#e8eef6",
      pctSuffixStyle: "font-family:'JetBrains Mono',monospace; font-size:10.5px; color:#6b7789",
      // rpm is a measurement, not an input — kept beside the field when the fan reports one.
      rpmLabel: rpm !== null ? rpm + " rpm" : "",
      rpmStyle: "font-family:'JetBrains Mono',monospace; font-size:9.5px; color:#6b7789"
    };
  });

  // ---- leds: verbatim view-model over ledModel() rows { k, color, pct, on, present }
  const leds = (presetStyle => LED_ORDER.map(k => {
    const l = ledModel(st, k);
    const open = ui.ledPicker === l.k;
    return Object.assign({
      k: l.k, hex: l.color.toUpperCase(), pctLabel: !l.present ? "—" : l.on ? l.pct + " %" : "off",
      openPicker: () => set({ ledPicker: open ? null : l.k }),
      closePicker: () => set({ ledPicker: null }),
      toggle: () => setLed(l.k, { on: !l.on }),
      pickHue: e => {
        const r = e.currentTarget.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        let h = Math.atan2(dy, dx) * 180 / Math.PI + 90; if (h < 0) h += 360;
        const sat = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
        setLed(l.k, { color: hsl2hex(h, sat), on: true });
      },
      swatchStyle: `width:16px; height:16px; border-radius:3px; flex:none; cursor:pointer; transition:border-color .12s; border:1px solid ${open ? "#8b98aa" : "#2c3746"}; background:${l.color}; opacity:${l.on ? 1 : .3}` +
        (l.on ? `; box-shadow:0 0 8px ${l.color}66` : ""),
      sliderSet: barPick(p => setLed(l.k, { pct: p })),
      onStyle: presetStyle(l.on),
      offStyle: presetStyle(!l.on),
      setOn: () => setLed(l.k, { on: true }),
      setOff: () => setLed(l.k, { on: false }),
      sliderStyle: "position:relative; width:52px; height:3px; flex:none; border-radius:2px; background:#161d27; cursor:pointer",
      sliderFill: `width:${l.pct}%; height:100%; border-radius:2px; background:${l.on ? l.color : "#2c3746"}`,
      sliderKnob: `position:absolute; left:${l.pct}%; top:50%; width:8px; height:8px; margin:-4px 0 0 -4px; border-radius:50%; background:${l.on ? "#e8eef6" : "#8b98aa"}; border:2px solid ${l.on ? l.color : "#3d4859"}`,
      pctField: field("led_" + l.k, String(l.pct), v => setLed(l.k, { pct: Math.max(0, Math.min(100, Math.round(v))) })),
      pctSuffixStyle: `font-family:'JetBrains Mono',monospace; font-size:10px; flex:none; color:${l.on ? "#6b7789" : "#3d4859"}`,
      pctInputStyle: "width:26px; flex:none; background:transparent; border:1px solid " +
        (edits["led_" + l.k] !== undefined ? "#8b98aa" : "transparent") +
        "; border-radius:3px; padding:1px 3px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:10px; color:" +
        (l.on ? "#e8eef6" : "#4d5a6b"),
      pickerStyle: open
        ? "display:flex; gap:10px; margin-top:9px; padding:10px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; animation:vRise .18s ease both"
        : "display:none",
      wheelStyle: "position:relative; width:74px; height:74px; flex:none; border-radius:50%; cursor:crosshair; border:1px solid #2c3746; background:conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
      markerStyle: `position:absolute; left:50%; top:50%; width:11px; height:11px; margin:-5.5px 0 0 -5.5px; border-radius:50%; background:${l.color}; border:2px solid #e8eef6; box-shadow:0 0 6px rgba(0,0,0,.6)`,
      hexStyle: `font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:.06em; color:${l.color}`,
      levels: [0, 25, 50, 80, 100].map(v => ({
        t: v, set: () => setLed(l.k, { pct: v, on: v > 0 }),
        style: "padding:4px 0; text-align:center; border-radius:3px; cursor:pointer; transition:.12s; font-family:'JetBrains Mono',monospace; font-size:9px; border:1px solid " +
          (l.on && l.pct === v ? "#8b98aa" : "#1c2430") + "; background:#0b0f15; color:" + (l.on && l.pct === v ? "#e8eef6" : "#6b7789")
      }))
    });
  }))(on => "padding:2px 5px; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:8px; letter-spacing:.06em; border:1px solid " +
    (on ? "#2c3746" : "transparent") + "; background:" + (on ? "#141b25" : "transparent") + "; color:" + (on ? "#e8eef6" : "#4d5a6b"));

  return { fans, leds };
}

export default fansLedsVals;
