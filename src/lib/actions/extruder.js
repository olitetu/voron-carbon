// TOOL & EXTRUDER actions — real gcode behind the dashboard panel (CONTRACT.md "Exact gcode per action").
//   setFactor(kind, pct)            speed → M220 S<pct>, extrusion → M221 S<pct>
//   extrudeMove(dir, len, rate)     M83 \n G1 E±<len> F<rate*60>     refused when !raw.extruder.can_extrude ("Extrude below minimum temp"),
//                                   while a print is running (not paused), or when <len> exceeds Klipper's max_extrude_only_distance
//   selectTool(i)                   T<i>                              refused for an empty gate (gate_status 0), an unknown tool index,
//                                   a disabled MMU, or while a print is running (not paused)
// Every action logs the command (or a short intent line), awaits api.gcode and logs errors; nothing throws.
// Usage: const act = makeExtruderActions({ api, store, log });   (merged with the other panels' actions by the integrator)

export const DEFAULT_LEN = 100;   // mm   (used only when the caller passes no length)
export const DEFAULT_RATE = 10;   // mm/s (used only when the caller passes no feedrate)
export const FACTOR_MIN = 10, FACTOR_MAX = 300;   // % — the panel's bar itself spans 20..200

const FACTOR_KINDS = {
  speed: "speed", speedfactor: "speed", m220: "speed",
  extrusion: "extrusion", extrusionfactor: "extrusion", extrude: "extrusion", extrudefactor: "extrusion", flow: "extrusion", flowrate: "extrusion", m221: "extrusion"
};

/** 'SPEED FACTOR' / 'speed' / 'flow' / 'extrusion' → 'speed' | 'extrusion'; unknown → null. */
export function normalizeFactorKind(kind) {
  if (kind === null || kind === undefined) return null;
  return FACTOR_KINDS[String(kind).toLowerCase().replace(/[\s_\-.]+/g, "")] || null;
}

/** Pure: build the M220/M221 command. Returns { kind, cmd, value, clamped } or { kind, error }. */
export function factorCommand(kind, pct) {
  const k = normalizeFactorKind(kind);
  if (!k) return { kind, error: "Unknown factor '" + kind + "'" };
  const n = typeof pct === "string" ? parseFloat(pct) : Number(pct);
  if (!isFinite(n)) return { kind: k, error: (k === "speed" ? "Speed" : "Extrusion") + " factor ignored — not a number" };
  const value = Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, Math.round(n)));
  return { kind: k, cmd: (k === "speed" ? "M220 S" : "M221 S") + value, value, clamped: value !== Math.round(n) };
}

/** Pure: build the manual extrude script. dir > 0 extrude, else retract (design: ±1). */
export function extrudeCommand(dir, len, rate) {
  const L = Math.abs(typeof len === "string" ? parseFloat(len) : Number(len));
  const R = typeof rate === "string" ? parseFloat(rate) : Number(rate);
  const length = isFinite(L) && L > 0 ? +L.toFixed(3) : DEFAULT_LEN;
  const feed = isFinite(R) && R > 0 ? R : DEFAULT_RATE;
  const sign = dir > 0 ? "" : "-";
  const f = Math.round(feed * 60);
  return { length, feed, sign, cmd: "M83\nG1 E" + sign + length + " F" + f, shown: "M83 · G1 E" + sign + length + " F" + f };
}

export function makeExtruderActions({ api, store, log } = {}) {
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

  /** True while a job is actively printing (a paused print does not count — manual moves / tool changes are how runouts get fixed). */
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

  // ---- [extruder] config limits (max_extrude_only_distance, min_extrude_temp): read once per Klipper session via the
  //      read-only printer.objects.query (boot only subscribes configfile.save_config_pending). Unknown → no pre-check.
  const cfg = { extruder: null, at: 0, klippy: null, pending: null };
  function extruderConfig() {
    const k = state().klippy;
    if (cfg.extruder && cfg.klippy === k && Date.now() - cfg.at < 10 * 60 * 1000) return Promise.resolve(cfg.extruder);
    if (cfg.pending) return cfg.pending;
    if (!api || typeof api.query !== "function") return Promise.resolve(null);
    cfg.pending = Promise.resolve()
      .then(() => api.query({ configfile: ["settings"] }))
      .then(r => {
        const s = r && r.status && r.status.configfile && r.status.configfile.settings;
        cfg.extruder = (s && s.extruder) || null; cfg.at = Date.now(); cfg.klippy = k;
        return cfg.extruder;
      })
      .catch(() => null)
      .then(v => { cfg.pending = null; return v; });
    return cfg.pending;
  }

  /** kind: 'speed' | 'extrusion' (design keys; 'flow' and the panel labels are accepted too). Resolves true when Klipper accepted it. */
  /** Optimistic: Moonraker's confirming status push is ~270 ms behind the 6 ms ack. */
  function predict(patch) { if (store && typeof store.predict === "function") store.predict(patch); }

  async function setFactor(kind, pct) {
    if (blocked()) return false;
    const c = factorCommand(kind, pct);
    if (c.error) { say(c.error, "warn"); return false; }
    if (c.clamped) say((c.kind === "speed" ? "Speed" : "Extrusion") + " factor clamped to " + FACTOR_MIN + "–" + FACTOR_MAX + " %", "warn");
    predict({ gcode_move: c.kind === "speed" ? { speed_factor: c.value / 100 } : { extrude_factor: c.value / 100 } });
    say(c.cmd);
    return run(c.cmd);
  }

  /**
   * dir > 0 extrude, dir < 0 retract. len (mm) / rate (mm/s) come from the panel's pickers (ctx.ui.extrudeLen / extrudeRate);
   * an options object { len, rate } is accepted in place of the two numbers. Resolves true when Klipper accepted the move.
   */
  async function extrudeMove(dir, len, rate) {
    if (blocked()) return false;
    if (len && typeof len === "object") { rate = len.rate; len = len.len; }
    const c = extrudeCommand(dir, len, rate);
    if (printingNow()) { say("Refused — print in progress (pause it first)", "warn"); return false; }
    const ext = raw().extruder || {};
    const conf = await extruderConfig();
    if (ext.can_extrude === false) {
      const t = typeof ext.temperature === "number" ? ext.temperature.toFixed(1) + " °C" : null;
      const min = conf && typeof conf.min_extrude_temp === "number" ? conf.min_extrude_temp + " °C" : null;
      say("Extrude below minimum temp" + (t ? " (" + t + (min ? " < " + min : "") + ")" : ""), "warn");
      return false;
    }
    if (ext.can_extrude !== true && typeof ext.temperature !== "number") { say("Extruder state unknown — refusing to move", "warn"); return false; }
    const maxDist = conf && typeof conf.max_extrude_only_distance === "number" ? conf.max_extrude_only_distance : null;
    if (maxDist !== null && c.length > maxDist) {
      say("Refused — " + c.length + " mm exceeds max_extrude_only_distance (" + maxDist + " mm); pick a shorter length or raise it in printer.cfg", "warn");
      return false;
    }
    const mmu = raw().mmu;
    if (mmu && String(mmu.filament || "").toLowerCase() === "unloaded") say("MMU reports filament Unloaded — the extruder will run dry", "warn");
    say(c.shown);
    // A manual E move is invisible to HH (mmu.action stays "Idle"), so the animation has to be told:
    // the dashes must run backwards while retracting. Duration = length / feedrate.
    if (store && store.signalMotion) {
      const ms = Math.min(20000, Math.max(400, (c.length / Math.max(1, c.feed)) * 1000));
      store.signalMotion(dir > 0 ? "extruding" : "retracting", dir > 0 ? 1 : -1, ms);
    }
    return run(c.cmd, (dir > 0 ? "Extruded " : "Retracted ") + c.length + " mm");
  }

  /** Happy Hare tool change: T<i>. Tool i feeds from gate ttg_map[i]. Resolves true when Klipper accepted the command. */
  async function selectTool(i) {
    if (blocked()) return false;
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0) { say("Tool ignored — invalid index '" + i + "'", "warn"); return false; }
    const mmu = raw().mmu;
    if (!mmu) { say("T" + n + " unavailable — no MMU detected (Happy Hare not loaded)", "warn"); return false; }
    if (mmu.enabled === false) { say("T" + n + " unavailable — MMU is disabled (MMU ENABLE=1 to re-enable)", "warn"); return false; }
    const ttg = Array.isArray(mmu.ttg_map) ? mmu.ttg_map : [];
    const numTools = typeof mmu.num_gates === "number" && mmu.num_gates > 0 ? mmu.num_gates : (ttg.length || null);
    if (numTools !== null && n >= numTools) { say("T" + n + " unavailable — this MMU has " + numTools + " tools (T0…T" + (numTools - 1) + ")", "warn"); return false; }
    const gate = typeof ttg[n] === "number" && ttg[n] >= 0 ? ttg[n] : n;
    const status = Array.isArray(mmu.gate_status) ? mmu.gate_status[gate] : undefined;
    if (status === 0) { say("T" + n + " unavailable — no filament detected in gate " + gate, "warn"); return false; }
    const loaded = String(mmu.filament || "").toLowerCase() === "loaded";
    if (loaded && mmu.tool === n) { say("T" + n + " already loaded from gate " + gate); return false; }
    if (printingNow()) { say("Refused — tool change while printing (pause it first)", "warn"); return false; }
    if (mmu.is_paused) say("MMU is paused (" + (mmu.reason_for_pause || "see console") + ") — Happy Hare may refuse until MMU_UNLOCK / MMU_RECOVER", "warn");
    else if (mmu.is_locked) say("MMU is locked — Happy Hare may refuse until MMU_UNLOCK / MMU_RECOVER", "warn");
    const cmd = "T" + n;
    if (loaded && typeof mmu.gate === "number" && mmu.gate >= 0) say(cmd + " — unloading gate " + mmu.gate + ", loading gate " + gate, "warn");
    else say(cmd + " — loading gate " + gate, "ok");
    return run(cmd);
  }

  return { setFactor, extrudeMove, selectTool };
}

export default makeExtruderActions;
