// Shared Spoolman helpers.
//
// Spoolman is the source of truth for filament identity (name, material, colour, weights, usage). Both the
// SPOOLMAN page and the gate editor render the same spool facts, so the formatting lives here once — the
// two surfaces disagreeing about what "low" means or how a black filament is drawn would be a bug.
import React from "react";
import { useAsync } from "./useStore.js";

/** Finite number or null (Spoolman omits weights it does not know). */
export const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const EMPTY_COLOR = "#2a3340";
export const DESIGN_BLACK = "#3f4650";   // pure #000 filament would vanish on the panel background
export const LOW = 0.15;                 // one threshold, so the card chip, gate tiles and picker agree

/** Spoolman/Happy Hare colours are bare hex ("FFC72C"); returns a css colour, or null when unset. */
export function swatch(hex) {
  const h = String(hex || "").replace(/^#/, "").replace(/^0x/i, "").slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 24 ? DESIGN_BLACK : "#" + h.toLowerCase();
}

export const grams = w => (w === null ? "—" : w >= 1000 ? (w / 1000).toFixed(2) + " kg" : w >= 100 ? Math.round(w) + " g" : w.toFixed(1) + " g");
export const metres = mm => (mm === null ? "—" : (mm / 1000).toFixed(1) + " m");

/** Spoolman timestamps are ISO strings; the design's fmtDate wants unix seconds. */
export const whenSeconds = iso => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t / 1000 : null; };

export const spoolName = sp => ((sp && sp.filament && sp.filament.name) || (sp && sp.filament && sp.filament.material) || "—");

/** remaining / initial, 0..1, or null when Spoolman has no weights for this spool. */
export function fillOf(sp) {
  const total = num(sp && sp.initial_weight) ?? num(sp && sp.filament && sp.filament.weight);
  const left = num(sp && sp.remaining_weight);
  return total && left !== null ? Math.max(0, Math.min(1, left / total)) : null;
}

/**
 * Search + rank a spool list the way the picker does: the active spool first, then spools already sitting
 * in a gate, then everything else; ties broken by id. `needle` matches id, name, material and vendor.
 */
export function filterSpools(all, needle, { activeId = null, gateIds = [], material = null } = {}) {
  const n = String(needle || "").trim().toLowerCase();
  const mat = material ? String(material).trim().toUpperCase() : null;
  const rank = sp => (sp.id === activeId ? 0 : gateIds.indexOf(sp.id) >= 0 ? 1 : 2);
  return (Array.isArray(all) ? all : [])
    .filter(sp => {
      const f = sp.filament || {};
      if (mat && String(f.material || "").toUpperCase() !== mat) return false;
      if (!n) return true;
      return `${sp.id} ${f.name || ""} ${f.material || ""} ${(f.vendor || {}).name || ""}`.toLowerCase().includes(n);
    })
    .sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

/** The material facets present in a spool list, with counts, most common first ("ABS", "PLA", ...). */
export function materialsOf(all) {
  const counts = new Map();
  for (const sp of (Array.isArray(all) ? all : [])) {
    const m = String(((sp.filament || {}).material) || "").trim().toUpperCase();
    if (m) counts.set(m, (counts.get(m) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([material, count]) => ({ material, count }));
}

/**
 * The spool list plus an id index, shared by the SPOOLMAN page and the gate editor.
 *
 * STORE WINS in `byId`. `all` is the snapshot taken when the caller mounted and is never re-fetched on
 * its own, while boot.js re-reads the gate + active spools every 60 s — so for exactly the spools these
 * surfaces show big, the store copy is the fresher one. Merging the list last would pin remaining_weight
 * to the mount-time value for as long as the view stayed open, which during a print is the number moving.
 */
export function useSpoolList(api, st, { enabled = true } = {}) {
  const list = useAsync(() => (enabled && api ? api.spoolman("/spool") : Promise.resolve(null)), [enabled, st && st.connected]);
  const all = Array.isArray(list.data) ? list.data : [];
  const byId = React.useMemo(() => {
    const m = {};
    for (const sp of all) if (sp && sp.id) m[sp.id] = sp;
    return Object.assign(m, (st && st.spools) || {});
  }, [st && st.spools, list.data]);
  return { all, byId, loading: list.loading, error: list.error, reload: list.reload };
}
