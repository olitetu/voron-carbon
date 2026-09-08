// TEMPERATURES actions — real gcode behind the dashboard panel.
//   setTarget(name, v)     Extruder → M104 S<n> (0..300) · Heater Bed → M140 S<n> (0..120)
//   bumpTarget(name, d)    current target (raw.extruder / raw.heater_bed .target) ± d → setTarget
//   heatSoak(p)            M140 S<bed> \n SET_FAN_SPEED FAN=Chamber SPEED=0.40 \n SET_FAN_SPEED FAN=Exhaust SPEED=<exhaust/100>
//   cooldown()             TURN_OFF_HEATERS
// Every action logs the command (or a short intent line), awaits api.gcode and logs errors; nothing throws.
// Usage: const act = makeTempsActions({ api, store, log });   (merged with the other panels' actions by the integrator)

export const MAX_EXTRUDER = 300;   // °C — the design's cfg.maxExtruder (Rapido HF)
export const MAX_BED = 120;        // °C — the design's cfg.maxBed (Keenovo)

/** Heat-soak recipes — verbatim from the design's soakProfiles (chamber fan is always 40 %). */
export const SOAK_PROFILES = [
  { mat: "ABS",  bed: 105, exhaust: 0 },
  { mat: "ASA",  bed: 105, exhaust: 0 },
  { mat: "PC",   bed: 110, exhaust: 0 },
  { mat: "PETG", bed: 85,  exhaust: 40 },
  { mat: "PLA",  bed: 60,  exhaust: 100 },
  { mat: "TPU",  bed: 50,  exhaust: 60 }
];
export const SOAK_CHAMBER_FAN = 0.40;   // SET_FAN_SPEED FAN=Chamber SPEED=0.40

/** Design heater name → Klipper object / gcode / limit. */
export const HEATERS = {
  "Extruder":   { label: "Extruder",   obj: "extruder",   cmd: "M104 S", max: MAX_EXTRUDER },
  "Heater Bed": { label: "Heater Bed", obj: "heater_bed", cmd: "M140 S", max: MAX_BED }
};

/** Accepts the design names plus the Klipper object names / common aliases. */
export function heaterOf(name) {
  const k = String(name || "").trim().toLowerCase();
  if (k === "extruder" || k === "hotend" || k === "tool" || k === "t_ext") return HEATERS["Extruder"];
  if (k === "heater bed" || k === "heater_bed" || k === "bed" || k === "t_bed") return HEATERS["Heater Bed"];
  return null;
}

function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

export function makeTempsActions({ api, store, log } = {}) {
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

  /** True while a job is actively printing (paused does not count). */
  function printingNow() {
    const ps = raw().print_stats || {};
    const paused = !!((raw().pause_resume || {}).is_paused);
    return ps.state === "printing" && !paused;
  }

  async function run(script, okMsg) {
    try {
      await api.gcode(script);
      if (okMsg) say(okMsg, "ok");
      return true;
    } catch (e) {
      say((e && e.message) || String(e), "err");
      return false;
    }
  }

  /** name: 'Extruder' | 'Heater Bed' (design names; 'extruder' / 'heater_bed' / 'bed' also accepted). v in °C; 0 turns the heater off. */
  /** Optimistic: Moonraker's confirming status push is ~270 ms behind the 6 ms ack. */
  function predict(patch) { if (store && typeof store.predict === "function") store.predict(patch); }

  async function setTarget(name, v) {
    if (blocked()) return false;
    const h = heaterOf(name);
    if (!h) { say("Unknown heater '" + name + "'", "warn"); return false; }
    const x = Number(v);
    if (!isFinite(x)) { say(h.label + " target ignored — not a number", "warn"); return false; }
    const n = Math.max(0, Math.min(h.max, Math.round(x)));
    if (n !== Math.round(x)) say(h.label + " target clamped to 0–" + h.max + " °C", "warn");
    const cmd = h.cmd + n;
    predict({ [h.obj]: { target: n } });
    say(cmd);
    return run(cmd);
  }

  /** Nudge the live target by d °C (the design's bumpTarget); the current target comes from the printer, not local state. */
  async function bumpTarget(name, d) {
    if (blocked()) return false;
    const h = heaterOf(name);
    if (!h) { say("Unknown heater '" + name + "'", "warn"); return false; }
    const step = Number(d);
    if (!isFinite(step) || step === 0) { say(h.label + " bump ignored — not a number", "warn"); return false; }
    const cur = num((raw()[h.obj] || {}).target) ?? 0;
    return setTarget(h.label, Math.min(h.max, Math.max(0, cur + step)));
  }

  /**
   * p = { mat, bed, exhaust } (one of SOAK_PROFILES) or a material string ('ABS').
   * Bed to <bed> °C, chamber fan to 40 %, exhaust to <exhaust> %. Refused while a print is running.
   */
  async function heatSoak(p) {
    if (blocked()) return false;
    let prof = p;
    if (typeof p === "string") prof = SOAK_PROFILES.find(x => x.mat.toUpperCase() === p.trim().toUpperCase()) || null;
    if (!prof || typeof prof !== "object") { say("Heat soak ignored — unknown profile", "warn"); return false; }
    const bedN = Number(prof.bed), exN = Number(prof.exhaust ?? 0);
    if (!isFinite(bedN)) { say("Heat soak ignored — bed temperature missing", "warn"); return false; }
    const bed = Math.max(0, Math.min(MAX_BED, Math.round(bedN)));
    const exhaust = Math.max(0, Math.min(100, Math.round(isFinite(exN) ? exN : 0)));
    if (bed !== Math.round(bedN)) say("Heat soak bed clamped to 0–" + MAX_BED + " °C", "warn");
    if (printingNow()) { say("Refused — heat soak while printing (pause first)", "warn"); return false; }
    // only address fans this printer actually has (objects list is empty until hydrate → assume both exist, per the build contract)
    const objects = Array.isArray(state().objects) ? state().objects : [];
    const has = o => objects.length === 0 || objects.indexOf(o) >= 0;
    const lines = ["M140 S" + bed];
    if (has("fan_generic Chamber")) lines.push("SET_FAN_SPEED FAN=Chamber SPEED=" + SOAK_CHAMBER_FAN.toFixed(2));
    else say("No 'fan_generic Chamber' on this printer — skipping chamber fan", "warn");
    if (has("fan_generic Exhaust")) lines.push("SET_FAN_SPEED FAN=Exhaust SPEED=" + (exhaust / 100).toFixed(2));
    else say("No 'fan_generic Exhaust' on this printer — skipping exhaust fan", "warn");
    const mat = prof.mat ? String(prof.mat).toUpperCase() : "CUSTOM";
    say("HEATSOAK MATERIAL=" + mat + " — M140 S" + bed + " · chamber fan " + Math.round(SOAK_CHAMBER_FAN * 100) + "% · exhaust " + exhaust + "%");
    return run(lines.join("\n"), "Heat soak " + mat + " started — bed " + bed + " °C");
  }

  /** TURN_OFF_HEATERS. Refused while actively printing (it would ruin the job); allowed when paused/idle. */
  async function cooldown() {
    if (blocked()) return false;
    if (printingNow()) { say("Refused — print in progress (pause first, or set a target to 0 in the table)", "warn"); return false; }
    const cmd = "TURN_OFF_HEATERS";
    say(cmd);
    return run(cmd, "Heaters off");
  }

  return { setTarget, bumpTarget, heatSoak, cooldown };
}

export default makeTempsActions;
