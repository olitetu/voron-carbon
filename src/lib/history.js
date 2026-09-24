// Moonraker job history: row normalisation, thumbnails, status buckets and formatting, shared by the desktop
// HISTORY page, the touchscreen HISTORY screen and the dashboard's LATEST PRINTS view (the CURRENT JOB card
// once nothing is running), so all three render the same job the same way. The per-tool slicer-list readers
// (listOf, usedTools) also serve the desktop FILES page, whose file metadata has the same shape.
import { T } from "./design.jsx";

const DAY = 86400;
const DASH = "—";
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
/** Slicer metadata fields can arrive as strings ("48.3"): a number either way, or null. */
export const numish = v => num(typeof v === "string" && v.trim() !== "" ? +v : v);

export const baseName = f => String(f || "").split("/").pop();

// 1.75 mm filament at PLA density — the only way to turn Moonraker's millimetres into a mass when nothing
// better is known (lifetime totals carry only mm). Callers print the assumption (FIL_NOTE) instead of
// pretending it was weighed.
export const MM3_PER_MM = Math.PI * Math.pow(1.75 / 2, 2);
export const G_PER_MM3 = 0.00124;
export const FIL_NOTE = "Mass is estimated from length: 1.75 mm filament at PLA density (1.24 g/cm³)";
export const SLICED_MASS_NOTE = "Mass is this length at the file's own slicer weight per mm (filament_weight_total / filament_total)";

// ---- formatting -------------------------------------------------------------------------------------
/** Long spans read as "46d 2h" — fmtDur's h:mm:ss becomes unreadable ("1104:12:07") at lifetime scale. */
export function fmtSpan(sec) {
  const t = num(sec);
  if (t === null || t < 0) return DASH;
  const d = Math.floor(t / DAY), h = Math.floor((t % DAY) / 3600), m = Math.floor((t % 3600) / 60);
  return d ? d + "d " + h + "h" : h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
}
export function fmtLen(mm) {
  const v = num(mm);
  if (v === null) return DASH;
  const m = v / 1000;
  return m >= 1000 ? (m / 1000).toFixed(2) + " km" : m >= 10 ? m.toFixed(1) + " m" : m.toFixed(2) + " m";
}
const fmtGrams = g => (g >= 1000 ? (g / 1000).toFixed(2) + " kg" : Math.round(g) + " g");
/** Mass of `mm` of filament at the PLA estimate (FIL_NOTE). */
export function fmtMass(mm) {
  const v = num(mm);
  return v === null ? DASH : fmtGrams(v * MM3_PER_MM * G_PER_MM3);
}
/** This file's own slicer grams per mm, or null when the slicer wrote no usable totals. */
function slicedGPerMm(meta) {
  const ft = numish(meta && meta.filament_total), wt = numish(meta && meta.filament_weight_total);
  return ft === null || wt === null || ft <= 0 || wt <= 0 ? null : wt / ft;
}
/**
 * Mass of `mm` of ONE job's filament. Its slicer wrote filament_total (mm) and filament_weight_total (g) for
 * that very file (238 of 280 rows here), median 2.50 g/m for this printer's ABS against the PLA constant's
 * 2.98 g/m — so the PLA estimate read 19% heavy and contradicted the slicer grams shown beside it
 * (claude_ABS_2h33m: "≈ 57 g" vs 48 g). Still an estimate ("≈"): a multi-material job's ratio is an average
 * over its tools. Falls back to fmtMass when the slicer gave none; jobMassNote says which one was used.
 */
export function jobMass(mm, meta) {
  const len = num(mm);
  if (len === null) return DASH;
  const r = slicedGPerMm(meta);
  return r === null ? fmtMass(len) : fmtGrams(len * r);
}
export const jobMassNote = meta => (slicedGPerMm(meta) === null ? FIL_NOTE : SLICED_MASS_NOTE);
/** fmtDate has no year; a job from 2024 must not read like one from last week. */
export function fmtStamp(t) {
  const d = new Date(t * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
/** "just now" / "12 min ago" / "3 h ago" / "2 d ago", then an absolute date past a week. */
export function fmtAgo(t, now = Date.now() / 1000) {
  const s = num(t);
  if (s === null) return DASH;
  const d = Math.max(0, now - s);
  if (d < 90) return "just now";
  if (d < 3600) return Math.round(d / 60) + " min ago";
  if (d < DAY) return Math.round(d / 3600) + " h ago";
  if (d < 7 * DAY) return Math.round(d / DAY) + " d ago";
  return new Date(s * 1000).toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}
/**
 * Per-extruder slicer metadata (filament_type, filament_name, filament_colors, filament_weights) arrives in
 * TWO shapes on this printer: the ';'-joined form ("ABS;ABS;PLA;…", or `ABS";"PC` in older exports) and a
 * JSON array string ('["ABS", "ABS", …]') — Orca writes whichever its post-processor produced. Reading only
 * one form left a quarter of the library blank, or printed the whole '["ABS", …]' blob as one value. A '['
 * string that is not valid JSON falls back to the ';' split. Entries are returned raw (quotes and all).
 */
export function listOf(v) {
  if (Array.isArray(v)) return v;
  const s = String(v == null ? "" : v).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch (e) { /* not JSON after all — fall through */ }
  }
  return s.split(";");
}

/** metadata.referenced_tools ([5], [2, 3, 4, 7] here) as non-negative integers; [] when absent. */
const toolList = v => (Array.isArray(v)
  ? v.map(t => (typeof t === "number" ? t : parseInt(t, 10))).filter(t => Number.isInteger(t) && t >= 0)
  : []);
export const usedTools = meta => toolList(meta && meta.referenced_tools);

const material = p => String(p == null ? "" : p).trim().replace(/^["']+|["']+$/g, "").toUpperCase();
/**
 * The distinct materials of a slicer per-tool list, joined "ABS + PC". With `tools` (referenced_tools, raw or
 * from usedTools), only those tools' entries: the list has one entry per TOOL of the slicer profile (8 on this
 * MMU), not per job, and 20 of the newest 50 rows listed "ABS + PC" or "ABS + PLA" for a print whose
 * referenced_tools is a single ABS tool. Falls back to the whole list when no tool indexes a non-empty entry
 * (a single-extruder profile has one entry however high the tool number).
 */
export function fmtMaterials(v, tools) {
  let parts = listOf(v).map(material);
  const idx = toolList(tools);
  if (idx.length) {
    const used = idx.map(t => parts[t]).filter(Boolean);
    if (used.length) parts = used;
  }
  const seen = [];
  for (const t of parts) if (t && !seen.includes(t)) seen.push(t);
  return seen.length ? seen.join(" + ") : null;
}
/** The materials ONE job used: filament_type, else filament_name, restricted to its referenced_tools. */
export const jobMaterials = meta => (meta
  ? fmtMaterials(meta.filament_type, meta.referenced_tools) || fmtMaterials(meta.filament_name, meta.referenced_tools)
  : null);

// ---- status ------------------------------------------------------------------------------------------
// Moonraker writes these into job.status: in_progress, completed, cancelled, error, klippy_shutdown,
// klippy_disconnect, server_exit, interrupted. Anything unknown is treated as a failure (red) on purpose.
const STATUS_COLOR = { completed: T.ok, in_progress: T.accent, cancelled: T.warn, interrupted: T.warn };
export const statusColor = s => STATUS_COLOR[s] || T.err;
export const statusText = s => String(s || "unknown").replace(/_/g, " ").toUpperCase();
export const isDone = s => s === "completed";
export const isRunning = s => s === "in_progress";

// The status filter both HISTORY views offer. The keys are the desktop page's persisted `history.status`
// values, so they must not be renamed. Seen on this printer across 280 rows: completed 216, cancelled 53,
// klippy_shutdown 8, interrupted 3; in_progress is only ever the current job.
export const STATUS_TABS = [["all", "ALL"], ["completed", "DONE"], ["cancelled", "CANCELLED"], ["failed", "FAILED"], ["in_progress", "RUNNING"]];
const STATUS_GROUP = {
  completed: "completed", in_progress: "in_progress", cancelled: "cancelled", interrupted: "cancelled",
  error: "failed", klippy_shutdown: "failed", klippy_disconnect: "failed", server_exit: "failed",
};
/**
 * The STATUS_TABS bucket of a job status, or null for a status Moonraker does not document: such a row is
 * listed only under ALL (it is still coloured red by statusColor), as the desktop page always did — FAILED
 * is the four documented failure statuses, not a catch-all.
 */
export const statusGroup = s => (Object.prototype.hasOwnProperty.call(STATUS_GROUP, s) ? STATUS_GROUP[s] : null);

// ---- job rows ----------------------------------------------------------------------------------------
export function normalize(data) {
  const list = data && Array.isArray(data.jobs) ? data.jobs : [];
  return list.map((j, i) => {
    const job = j || {};
    const name = String(job.filename || "");
    const start = num(job.start_time);
    return {
      // job_id is the uid server.history.delete_job wants; keep a fallback key so a row without one still renders.
      uid: String(job.job_id == null ? "" : job.job_id),
      key: String(job.job_id == null ? "" : job.job_id) || name + ":" + (start === null ? i : start),
      name, base: baseName(name).replace(/\.g(code|co)?$/i, ""),
      status: String(job.status || "unknown"),
      start, end: num(job.end_time),
      dur: num(job.print_duration), total: num(job.total_duration),
      fil: num(job.filament_used),
      exists: job.exists !== false,
      user: String(job.user || ""),
      meta: job.metadata || {},
      // Providers bolt extra columns onto a job (Spoolman writes the spool ids it charged); rendered generically.
      aux: Array.isArray(job.auxiliary_data) ? job.auxiliary_data : [],
    };
  });
}

/** Thumbnails live beside the g-code file: relative_path is relative to THAT file's directory. */
export function thumbUrl(api, job, minPx) {
  // A deleted g-code took its .thumbs folder with it, and 58 of this printer's 254 rows are in that state —
  // asking would be 58 guaranteed 404s while the user scrolls. The empty box is the answer either way.
  if (!job || !job.exists) return "";
  const list = job.meta && Array.isArray(job.meta.thumbnails) ? job.meta.thumbnails.filter(t => t && t.relative_path) : [];
  if (!list.length || !api || typeof api.fileUrl !== "function") return "";
  const sorted = list.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  const pick = minPx ? sorted.find(t => (t.width || 0) >= minPx) || sorted[sorted.length - 1] : sorted[sorted.length - 1];
  const dir = job.name.includes("/") ? job.name.slice(0, job.name.lastIndexOf("/") + 1) : "";
  return api.fileUrl("gcodes", dir + pick.relative_path);
}
