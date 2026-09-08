// FANS & LEDS actions — real gcode per CONTRACT.md ("Exact gcode per action").
// Owned by the fans/leds builder. Also exports the pure helpers the dashboard adapter
// (src/pages/dashboard/adapters/fansLeds.js) uses to read LED state, so both sides agree.
//
//   const act = makeFansLedsActions({ api, store, log });
//   act.setFan("Part Fan", 35)                     → M106 S89
//   act.setFan("Chamber", 40)                      → SET_FAN_SPEED FAN=Chamber SPEED=0.40
//   act.setLed("SB Leds", { color:"#ff5a33", pct:80, on:true })
//                                                  → SET_LED LED=sb_leds RED=0.800 GREEN=0.282 BLUE=0.160 WHITE=0 TRANSMIT=1
//   act.setLed("Logo", { on:false })               → SET_LED LED=logo RED=0 GREEN=0 BLUE=0 WHITE=0 TRANSMIT=1

// ---- catalog --------------------------------------------------------------------------------
/** Design row label → Klipper object. heater_fan / controller_fan are driven by Klipper: read-only. */
export const FAN_OBJECTS = {
  "Part Fan":   { obj: "fan",                       settable: true  },
  "Chamber":    { obj: "fan_generic Chamber",       settable: true  },
  "Exhaust":    { obj: "fan_generic Exhaust",       settable: true  },
  "Hotend Fan": { obj: "heater_fan hotend_fan",     settable: false },
  "Controller": { obj: "controller_fan Controller", settable: false },
};
export const FAN_ORDER = ["Part Fan", "Chamber", "Exhaust", "Hotend Fan", "Controller"];

/** Design LED label → neopixel name (SET_LED LED=<name>, raw["neopixel <name>"]). */
export const LED_OBJECTS = { "SB Leds": "sb_leds", "Caselight": "caselight", "MMU Leds": "mmu_leds", "Logo": "logo" };
export const LED_ORDER = ["SB Leds", "Caselight", "MMU Leds", "Logo"];
const LED_DEFAULT = { hex: "#ffffff", pct: 100 };
const LS_PREFIX = "carbon.led.";

// ---- colour helpers -------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
export const clampPct = v => clamp(Math.round(num(Number(v))), 0, 100);

/** "#f0a"|"#ff00aa"|"ff00aa" → "#ff00aa" (lowercase) or null when not a colour. */
export function normalizeHex(h) {
  if (typeof h !== "string") return null;
  let s = h.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split("").map(c => c + c).join("");
  return /^[0-9a-f]{6}$/.test(s) ? "#" + s : null;
}
/** "#rrggbb" → [r,g,b] each 0..1 */
export function hexToRgb(hex) {
  const s = normalizeHex(hex) || "#000000";
  return [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16) / 255);
}
/** r,g,b 0..1 → "#rrggbb" */
export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(v => Math.round(clamp(num(v), 0, 1) * 255).toString(16).padStart(2, "0")).join("");
}

// ---- LED state --------------------------------------------------------------------------------
/**
 * Live neopixel → { present, on, pct, hex }. Per contract: read color_data[0]; hex normalized by the max channel,
 * pct = max channel × 100, on = pct > 0. hex is null while the strip is dark (nothing to normalize).
 */
export function readLed(raw, k) {
  const name = LED_OBJECTS[k];
  const obj = name && raw ? raw["neopixel " + name] : null;
  const cd = obj && Array.isArray(obj.color_data) ? obj.color_data[0] : null;
  if (!Array.isArray(cd)) return { present: false, on: false, pct: 0, hex: null };
  const r = clamp(num(cd[0]), 0, 1), g = clamp(num(cd[1]), 0, 1), b = clamp(num(cd[2]), 0, 1), w = clamp(num(cd[3]), 0, 1);
  const mx = Math.max(r, g, b);
  if (mx > 0) return { present: true, on: true, pct: Math.round(mx * 100), hex: rgbToHex(r / mx, g / mx, b / mx) };
  if (w > 0) return { present: true, on: true, pct: Math.round(w * 100), hex: "#ffffff" }; // white-only channel
  return { present: true, on: false, pct: 0, hex: null };
}

function loadLocal(k) {
  try {
    const j = JSON.parse(localStorage.getItem(LS_PREFIX + LED_OBJECTS[k]) || "null");
    if (j && normalizeHex(j.hex)) return { hex: normalizeHex(j.hex), pct: clampPct(j.pct) || LED_DEFAULT.pct };
  } catch {}
  return null;
}
function saveLocal(k, mem) { try { localStorage.setItem(LS_PREFIX + LED_OBJECTS[k], JSON.stringify(mem)); } catch {} }

/** Last colour/brightness the LED had while ON (so OFF → ON restores it, like the design's ledOverrides). */
export function recallLed(st, k) {
  const m = st && st.ledMemory && st.ledMemory[k];
  if (m && normalizeHex(m.hex)) return { hex: normalizeHex(m.hex), pct: clampPct(m.pct) || LED_DEFAULT.pct };
  return loadLocal(k) || LED_DEFAULT;
}

/**
 * The design's ledList() row shape from live data: { k, color, pct, on, present }.
 * ON → live colour/brightness. OFF → remembered colour/brightness rendered dimmed (design semantics).
 */
export function ledModel(st, k) {
  const live = readLed(st && st.raw, k);
  if (live.on) return { k, color: live.hex, pct: live.pct, on: true, present: true };
  const mem = recallLed(st, k);
  return { k, color: mem.hex, pct: mem.pct, on: false, present: live.present };
}

// ---- actions ---------------------------------------------------------------------------------
export function makeFansLedsActions({ api, store, log }) {
  const say = (m, kind) => { try { log && log(m, kind || "info"); } catch {} };
  const state = () => (store && store.state) || {};

  /** Klipper unavailable → reject like the design's blocked(). ("unknown" before server_info is let through; the RPC error is logged.) */
  function blocked() {
    const k = state().klippy;
    if (k === "shutdown" || k === "disconnected" || k === "startup" || k === "error") {
      say("Command rejected — Klipper is " + k + (k === "shutdown" ? " (FIRMWARE_RESTART required)" : ""), "err");
      return true;
    }
    if (!api || typeof api.gcode !== "function") { say("Command rejected — no Moonraker connection", "err"); return true; }
    return false;
  }
  async function run(cmd, kind) {
    say(cmd, kind || "info");
    try { await api.gcode(cmd); }
    catch (e) { say((e && e.message) || String(e), "err"); }
  }
  function remember(k, hex, pct) {
    const prev = recallLed(state(), k);
    const mem = { hex: normalizeHex(hex) || prev.hex, pct: pct > 0 ? clampPct(pct) : prev.pct }; // keep last non-zero brightness
    saveLocal(k, mem);
    if (store && typeof store.update === "function") store.update(s => ({ ledMemory: Object.assign({}, s.ledMemory, { [k]: mem }) }));
    return mem;
  }

  /** Apply an expected value to the store now; the real status push confirms or corrects it. */
  function predict(patch) { if (store && typeof store.predict === "function") store.predict(patch); }
  /** neopixel status is color_data:[[r,g,b,w] 0..1]; mirror what SET_LED will produce. */
  function predictLed(name, hex, pct) {
    const [r, g, b] = hexToRgb(hex).map(c => +(c * pct / 100).toFixed(3));
    const obj = "neopixel " + name;
    const cur = ((state().raw || {})[obj] || {}).color_data;
    const n = Array.isArray(cur) && cur.length ? cur.length : 1;
    predict({ [obj]: { color_data: new Array(n).fill([r, g, b, 0]) } });
  }

  return {
    /** v = 0..100 %. Part Fan → M106 S0..255; Chamber/Exhaust → SET_FAN_SPEED; heater/controller fans refuse. */
    async setFan(k, v) {
      const def = FAN_OBJECTS[k];
      if (!def) { say('Unknown fan "' + k + '"', "warn"); return; }
      if (!def.settable) { say(k + " is a " + def.obj.split(" ")[0] + " — speed is managed by Klipper, not settable", "warn"); return; }
      if (blocked()) return;
      const p = clampPct(v);
      // Optimistic: Moonraker confirms ~270 ms later; without this the bar does not move on click.
      predict({ [def.obj]: { speed: p / 100 } });
      await run(k === "Part Fan" ? "M106 S" + Math.round(p * 2.55) : "SET_FAN_SPEED FAN=" + k + " SPEED=" + (p / 100).toFixed(2));
    },

    /** patch = { color?: "#rrggbb", pct?: 0..100, on?: bool } merged over the current (live or remembered) state. */
    async setLed(k, patch) {
      const name = LED_OBJECTS[k];
      if (!name) { say('Unknown LED "' + k + '"', "warn"); return; }
      const p = patch || {};
      const cur = ledModel(state(), k);
      const next = {
        color: normalizeHex(p.color) || cur.color,
        pct: p.pct !== undefined ? clampPct(p.pct) : cur.pct,
        on: p.on !== undefined ? !!p.on : cur.on,
      };
      const mem = remember(k, next.color, next.pct);
      if (!next.on) {
        // Design semantics: brightness/colour edits while OFF only update the stored value — no light change.
        if (!cur.on && p.on === undefined) { say(k + " · " + next.color.toUpperCase() + " @ " + next.pct + " % stored (LED is off)", "info"); return; }
        if (blocked()) return;
        predictLed(name, "#000000", 0);
        await run("SET_LED LED=" + name + " RED=0 GREEN=0 BLUE=0 WHITE=0 TRANSMIT=1");
        return;
      }
      // Explicit OFF → ON with nothing remembered above 0 % → restore the last brightness (design: ON re-lights the stored level).
      // Any other path to 0 % (slider, % field, the "0" level) while ON darkens the strip: it reads back as off, memory keeps the colour.
      const pct = (next.pct === 0 && p.on === true && !cur.on) ? (mem.pct || LED_DEFAULT.pct) : next.pct;
      if (blocked()) return;
      if (pct === 0) { predictLed(name, "#000000", 0); await run("SET_LED LED=" + name + " RED=0 GREEN=0 BLUE=0 WHITE=0 TRANSMIT=1"); return; }
      const [r, g, b] = hexToRgb(next.color).map(c => (c * pct / 100).toFixed(3));
      predictLed(name, next.color, pct);
      await run("SET_LED LED=" + name + " RED=" + r + " GREEN=" + g + " BLUE=" + b + " WHITE=0 TRANSMIT=1");
    },
  };
}
