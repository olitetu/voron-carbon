// ---------------------------------------------------------------------------
// MORE — the second tier.
//
// The export's rail has 9 destinations; parity with this printer's KlipperScreen
// needs ~17. Rather than a scrolling rail (the worst place to hide things on a
// 56px touch strip), the long tail lives here as a 4x4 grid in the home-tile
// idiom, mirroring the owner's own ks_menus.conf shape: a short home row plus a
// "More" submenu.
//
// Each tile's sub-line carries live state — that is what makes a menu screen
// worth its pixels.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, mono } from "../tokens.js";
import { mmu, badgeStyle } from "../vm.js";

/** [key, label, glyph, sub(st) -> string, built?] */
export const MORE_TILES = [
  ["fans", "FANS & LEDS", "✳", st => {
    const p = Math.round(((st.raw.fan || {}).speed || 0) * 100);
    const cl = ((st.raw["neopixel caselight"] || {}).color_data || [[0, 0, 0]])[0] || [0, 0, 0];
    return `PART ${p}% · CASELIGHT ${Math.max(...cl) > 0.01 ? "ON" : "OFF"}`;
  }],
  ["console", "CONSOLE", "›_", st => {
    const l = (st.log || [])[0];
    return l ? String(l.message).replace(/\s+/g, " ").slice(0, 26) : "no output";
  }],
  ["camera", "CAMERA", "◉", st => {
    // Name and service only. The old "streaming / idle" read st.visible, which is PAGE visibility: it said
    // "streaming" whenever the panel was on, with no stream open anywhere.
    const c = (st.webcams || [])[0];
    return c ? [c.name, c.service].filter(Boolean).join(" · ") : "no camera";
  }],
  ["spoolman", "SPOOLMAN", "◍", st => {
    const s = st.spools[st.activeSpool];
    return s ? `spool ${st.activeSpool} · ${Math.round(s.remaining_weight || 0)} g left` : "no active spool";
  }],
  ["bedmesh", "BED MESH", "▦", st => {
    const b = st.raw.bed_mesh || {};
    const rows = (b.probed_matrix || []).length;
    return b.profile_name ? `${b.profile_name} · ${rows}×${rows ? (b.probed_matrix[0] || []).length : 0}` : "no mesh loaded";
  }],
  ["zoffset", "Z OFFSET", "⇕", st => {
    const z = ((st.raw.gcode_move || {}).homing_origin || [0, 0, 0, 0])[2] || 0;
    return `${z >= 0 ? "+" : ""}${z.toFixed(3)} mm${(st.raw.configfile || {}).save_config_pending ? " · pending" : ""}`;
  }],
  ["finetune", "FINE TUNE", "⌾", st => {
    const g = st.raw.gcode_move || {};
    return `speed ${Math.round((g.speed_factor || 1) * 100)}% · flow ${Math.round((g.extrude_factor || 1) * 100)}%`;
  }],
  ["limits", "LIMITS", "⊞", st => {
    const t = st.raw.toolhead || {};
    return `${Math.round(t.max_velocity || 0)} mm/s · ${Math.round(t.max_accel || 0)} mm/s²`;
  }],
  ["gatemap", "GATE MAP", "⬡", st => {
    const m = mmu(st);
    if (!m.present) return "no MMU";
    return `${m.gates.filter(g => !g.empty).length} of ${m.n} loaded`;
  }],
  ["ttg", "TTG MAP", "⇄", st => {
    const t = (st.raw.mmu || {}).ttg_map || [];
    if (!t.length) return "no MMU";
    return t.every((v, i) => v === i) ? "identity" : t.join(",");
  }],
  ["mmustats", "MMU STATS", "▁▃▅", st => {
    const m = st.raw.mmu || {};
    return m.num_toolchanges != null ? `${m.num_toolchanges} toolchanges` : "no MMU";
  }],
  ["history", "HISTORY", "◷", st => st.historyTotals
    ? `${st.historyTotals.total_jobs} jobs · ${(st.historyTotals.total_filament_used / 1000).toFixed(0)} m`
    : "—"],
  ["updates", "UPDATES", "↻", st => {
    // Components and apt packages are different units: 5 repos behind is not "103 pending". main.jsx keeps
    // them apart, and counts a component only against a KNOWN remote version ('?' is unknown, not behind).
    const u = st.updateStatus;
    if (!u) return "—";
    return [`${u.pending} pending`, u.packages ? `${u.packages} pkg` : null, u.unknown ? `${u.unknown} unknown` : null]
      .filter(Boolean).join(" · ");
  }],
  ["notifications", "NOTIFICATIONS", "◔", st => {
    // Undismissed only (main.jsx reads include_dismissed: false); a snoozed entry counts again once it wakes.
    if (st.announcements == null) return "—";
    if (!st.announcements) return "none";
    return `${st.announcements} unread${st.announcementsHigh ? ` · ${st.announcementsHigh} high` : ""}`;
  }],
  ["network", "NETWORK", "⌁", st => {
    const n = ((st.systemInfo || {}).network) || {};
    const k = Object.keys(n)[0];
    if (!k) return "—";
    const ip = ((n[k].ip_addresses || []).find(a => a.family === "ipv4") || {}).address;
    // Say plainly whether this screen can change anything or only report.
    const mode = st.helper === true ? "" : st.helper === false ? " · read-only" : "";
    return `${k} · ${ip || "no address"}${mode}`;
  }],
  ["system", "SYSTEM", "⚙", st => {
    const p = st.procStats || {};
    const up = p.system_uptime ? `up ${Math.floor(p.system_uptime / 86400)}d` : "";
    const t = p.cpu_temp != null ? `${p.cpu_temp.toFixed(0)} °C` : "";
    return [t, up].filter(Boolean).join(" · ") || "—";
  }],
];

export default function More({ st, go, built }) {
  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px; animation:ksFade .18s ease both`)}>
      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:repeat(4,1fr); grid-template-rows:repeat(4,1fr); gap:${L.gap}px`)}>
        {MORE_TILES.map(([k, label, glyph, sub]) => {
          const ready = built.has(k);
          let subText = "—";
          try { subText = sub(st) || "—"; } catch (e) { subText = "—"; }
          return (
            <Hv as="div" key={k} onClick={() => go(k)} hover={`border-color:${C.line5}`} active="transform:translateY(2px)"
              style={`display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:6px; padding:0 14px; background:${C.panel}; border:1px solid ${C.line2}; border-radius:${L.radius}px; cursor:pointer; transition:border-color .16s; box-shadow:0 8px 20px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.02); opacity:${ready ? 1 : 0.62}`}>
              <div style={S("display:flex; align-items:center; gap:10px; width:100%")}>
                <span style={S(mono(19, `line-height:1; color:${ready ? C.accent : C.mute}; flex:none`))}>{glyph}</span>
                <span style={S(mono(F.label, `letter-spacing:.14em; color:${C.text}`))}>{label}</span>
                {!ready ? <span style={S(`margin-left:auto; ${badgeStyle("off")}`)}>TODO</span> : null}
              </div>
              <span style={S(mono(F.micro, `letter-spacing:.04em; color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%`))}>{subText}</span>
            </Hv>
          );
        })}
      </div>
    </div>
  );
}
