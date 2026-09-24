// ---------------------------------------------------------------------------
// Carbon Screen — shell view-model.
//
// Turns the live store into the handful of values the persistent status bar and the
// home screen need. Everything here is derived from REAL Moonraker state; the design
// export's 120 ms fake tick and its ~60 demo state fields are gone.
// ---------------------------------------------------------------------------
import { C, F, mono } from "./tokens.js";

const pad2 = n => String(n).padStart(2, "0");

export function fmtHM(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}
export function fmtClock(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

/** Klippy / Moonraker health, and what the bar should say about it. */
export function health(st) {
  if (!st.connected) return { level: "down", label: "MOONRAKER OFFLINE", detail: "reconnecting…" };
  const k = st.klippy;
  if (k === "shutdown") return { level: "down", label: "KLIPPER SHUTDOWN", detail: (st.raw.webhooks || {}).state_message || "" };
  if (k === "disconnected") return { level: "down", label: "KLIPPER DISCONNECTED", detail: "" };
  if (k === "startup") return { level: "wait", label: "KLIPPER STARTING", detail: (st.raw.webhooks || {}).state_message || "" };
  if (k !== "ready") return { level: "wait", label: String(k || "UNKNOWN").toUpperCase(), detail: "" };
  return { level: "ok", label: "READY", detail: "" };
}

/** The job, as far as the bar and the home screen care. */
export function job(st, meta) {
  const ps = st.raw.print_stats || {};
  const vs = st.raw.virtual_sdcard || {};
  const paused = !!(st.raw.pause_resume || {}).is_paused;
  const state = ps.state || "standby";
  const active = state === "printing" || state === "paused" || paused;
  const progress = Number(vs.progress || (st.raw.display_status || {}).progress || 0);
  const elapsed = Number(ps.print_duration || 0);
  const remaining = progress > 0.001 ? elapsed / progress - elapsed : NaN;
  const layerCount = (ps.info && ps.info.total_layer) || (meta && meta.layer_count) || 0;
  let layer = (ps.info && ps.info.current_layer) || 0;
  if (!layer && layerCount && progress) layer = Math.max(1, Math.round(layerCount * progress));
  return {
    active, paused, state,
    file: String(ps.filename || "").replace(/\.gcode$/i, "").replace(/^.*\//, ""),
    rawFile: ps.filename || "",
    pct: progress * 100,
    pctLabel: (progress * 100).toFixed(1) + "%",
    layer, layerCount,
    layerLabel: layerCount ? `LAYER ${layer} / ${layerCount}` : "LAYER —",
    elapsed, remaining,
    etaLabel: fmtHM(remaining),
    filamentUsed: Number(ps.filament_used || 0) / 1000,
  };
}

/** Nozzle / bed / chamber. Chamber is a SENSOR on this printer — no target, no heater.
 *  heaters.available_heaters == ["heater_bed","extruder"], and temperature_store has no
 *  targets/powers series for CHAMBER. Anything that offers a chamber setpoint is fiction. */
export function temps(st) {
  const e = st.raw.extruder || {};
  const b = st.raw.heater_bed || {};
  const ch = st.raw["temperature_sensor CHAMBER"] || {};
  return {
    nozzle: { cur: Number(e.temperature || 0), tgt: Number(e.target || 0), power: Number(e.power || 0), max: 300, col: C.hot, label: "NOZZLE", settable: true },
    bed: { cur: Number(b.temperature || 0), tgt: Number(b.target || 0), power: Number(b.power || 0), max: 120, col: C.bed, label: "BED", settable: true },
    chamber: { cur: Number(ch.temperature || 0), tgt: 0, power: 0, max: 70, col: C.cool, label: "CHAMBER", settable: false },
  };
}

/** Happy Hare. Reads the real 60-field mmu object; tolerates no-MMU printers. */
export function mmu(st) {
  const m = st.raw.mmu;
  if (!m) return { present: false, gates: [], n: 0 };
  const unit = ((st.raw.mmu_machine || {}).unit_0) || {};
  const n = Number(m.num_gates || unit.num_gates || 0);
  const enc = m.encoder || st.raw["mmu_encoder mmu_encoder"] || {};
  const spools = st.spools || {};
  const gates = Array.from({ length: n }, (_, i) => {
    const status = (m.gate_status || [])[i];
    const hex = (m.gate_color || [])[i] || "";
    const spoolId = (m.gate_spool_id || [])[i];
    const sp = spoolId > 0 ? spools[spoolId] : null;
    const initial = sp && Number(sp.initial_weight || 0);
    const remain = sp && Number(sp.remaining_weight || 0);
    const fill = initial > 0 ? Math.max(0, Math.min(1, remain / initial)) : null;
    return {
      i, status,
      empty: status === 0,
      unknown: status === -1,
      color: hex ? "#" + hex.replace(/^#/, "") : C.line4,
      hasColor: !!hex,
      material: (m.gate_material || [])[i] || "—",
      name: (m.gate_filament_name || [])[i] || (sp && sp.filament && sp.filament.name) || "",
      temp: (m.gate_temperature || [])[i],
      spoolId: spoolId > 0 ? spoolId : null,
      fill, remainG: remain != null ? Math.round(remain) : null,
      group: (m.endless_spool_groups || [])[i],
      selected: Number(m.gate) === i,
      loaded: Number(m.gate) === i && m.filament === "Loaded",
    };
  });
  return {
    present: true, n, gates,
    unitName: unit.name || "MMU", unitVendor: unit.vendor || "", unitVersion: unit.version || "",
    // "ERCF v2.0 · 8 GATE" when mmu_machine has been read; a plain "MMU" before that.
    title: unit.vendor
      ? `${unit.vendor}${unit.version ? " v" + unit.version : ""} · ${n} GATE`
      : `MMU · ${n} GATE`,
    hasBypass: !!(m.has_bypass ?? unit.has_bypass),
    gate: Number(m.gate), tool: Number(m.tool),
    filament: m.filament || "Unknown",
    filamentPos: Number(m.filament_pos || 0),
    action: m.action || "Idle",
    busy: (m.action || "Idle") !== "Idle",
    servo: m.servo || "",
    isHomed: !!m.is_homed,
    isPaused: !!m.is_paused,
    reason: m.reason_for_pause || "",
    // The encoder is DISABLED on this machine (encoder.enabled === false, encoder_pos 0).
    // Report that honestly instead of animating a number that never moves.
    encoderEnabled: enc.enabled !== false,
    encoderPos: Number(enc.encoder_pos || 0),
    clogDetection: Number(m.clog_detection ?? 0),
    syncDrive: !!m.sync_drive,
    syncState: m.sync_feedback_state || "",
    toolchanges: Number(m.num_toolchanges || 0),
    active: m.active_filament || null,
    endlessEnabled: !!m.endless_spool_enabled,
  };
}

/**
 * "T5 · G5" -- the active tool AND the gate feeding it. They are different numbers once MMU_TTG_MAP maps a
 * tool elsewhere (ttg_map), so a single "T5" under a GATE label, or a gate number called a tool, is wrong the
 * moment a remap exists. Happy Hare's sentinels are shared by both fields (mmu.py TOOL_GATE_UNKNOWN = -1,
 * TOOL_GATE_BYPASS = -2); bypass is one path, not a tool/gate pair, so it gets HH's own word.
 */
export function toolGateLabel(m) {
  if (!m || !m.present) return "—";
  if (m.tool === -2 || m.gate === -2) return "BYPASS";
  const known = n => Number.isFinite(n) && n >= 0;
  if (!known(m.tool) && !known(m.gate)) return "—";
  return `${known(m.tool) ? "T" + m.tool : "T?"} · ${known(m.gate) ? "G" + m.gate : "G?"}`;
}

/** Machine-wide warnings the bar should surface when there is no job to talk about. */
export function badges(st) {
  const out = [];
  if ((st.raw.configfile || {}).save_config_pending) out.push({ kind: "warn", text: "SAVE CONFIG PENDING" });
  const homed = String((st.raw.toolhead || {}).homed_axes || "");
  if (homed !== "xyz") out.push({ kind: "warn", text: homed ? `HOMED ${homed.toUpperCase()}` : "NOT HOMED" });
  const m = st.raw.mmu;
  if (m && m.is_paused) out.push({ kind: "err", text: "MMU PAUSED" });
  // An announcement's priority is its feed item's <category> (announcements.py), "normal" or "high". A high one
  // is surfaced here, where it is seen, rather than only on NOTIFICATIONS. main.jsx counts the undismissed
  // ones (include_dismissed: false) into the store.
  const hi = Number(st.announcementsHigh) || 0;
  if (hi > 0) out.push({ kind: "err", text: hi > 1 ? `${hi} PRIORITY NOTICES` : "PRIORITY NOTICE" });
  return out;
}

// --- small shared style helpers, in the export's exact idiom ------------------
export const badgeStyle = kind => {
  const k = { ok: [C.okBg, C.cool, C.okLine], warn: [C.warnBg, C.bed, C.warnLine], err: [C.accentBg2, C.accent, C.accentLine], off: [C.offBg, C.faint, C.line3] }[kind] || [C.offBg, C.faint, C.line3];
  return `padding:4px 10px; border-radius:${4}px; background:${k[0]}; color:${k[1]}; border:1px solid ${k[2]}; ${mono(F.micro, "letter-spacing:.14em")}; white-space:nowrap`;
};
export const microLabel = (color = C.dim) => mono(F.micro, `letter-spacing:.18em; color:${color}`);
