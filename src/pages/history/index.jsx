// HISTORY page — Moonraker's job history: lifetime totals, a 14-day activity chart, and a filtered, sorted,
// paginated job table with a per-job detail view (reprint / delete). Contract: CONTRACT.md "Pages → history".
//
// Fetch strategy: the first paint costs ONE page of jobs (PAGE = 50, ~95 KB) instead of the whole database
// (254 jobs = 394 KB, ~8 s on this printer's WiFi). NEXT past the last loaded page fetches the next chunk and
// LOAD ALL pulls the rest in one request, so the filters and the success rate can still cover every job when
// the user asks for it — the footer always says how many jobs are actually loaded and whether more exist.
//
// Moonraker can only filter history by time, so the RANGE tabs are pushed to the server (`since`) and are
// therefore exact no matter how little is loaded; status, filename search, sort and paging happen in the
// browser over the loaded rows. The 14-day chart has its OWN cheap query (`since` = the first bucket, ~18 KB
// for this printer) — deriving it from the loaded page would silently lose days as soon as 50 jobs span less
// than two weeks.
//
// Every control the user touches is persisted (usePersisted → localStorage): Orca tears the Device tab down and
// reloads the base URL on nearly every preset change, so a filter kept only in React state is lost constantly.
// Two deliberate exceptions: a pending confirm strip must NOT survive a reload ("delete everything" least of
// all), and neither must LOAD MORE / LOAD ALL — persisting how many rows were fetched would hand Orca a 394 KB
// request on every preset change, which is the exact cost this page exists to avoid. The first page comes back
// in ~113 KB and the footer says what is loaded, so re-loading more is one click away.
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Input, Table, Confirm, T, mono, fmtDur, fmtBytes, fmtDate } from "../../lib/design.jsx";
import { S } from "../../lib/ui.js";
import { useStore, useAsync, usePersisted } from "../../lib/useStore.js";
import { makeHistoryActions } from "../../lib/actions/history.js";

const PAGE = 50;          // rows per fetch — one page of the table, ~95 KB with metadata on this printer
const ALL_LIMIT = 5000;   // LOAD ALL is still bounded: a runaway database must not be pulled in one request
const CHART_LIMIT = 400;  // the 14-day query is tiny here (9 jobs), but bound it too
const CHART_DAYS = 14;
const DAY = 86400;
const DASH = "—";
// 1.75 mm filament at PLA density — the only way to turn Moonraker's millimetres into a mass. The tile prints the
// assumption in its tooltip instead of pretending it was weighed.
const MM3_PER_MM = Math.PI * Math.pow(1.75 / 2, 2);
const G_PER_MM3 = 0.00124;
const FIL_NOTE = "Mass is estimated from length: 1.75 mm filament at PLA density (1.24 g/cm³)";

// Nothing to fetch yet (the websocket is still connecting): a promise that never settles keeps useAsync in its
// loading state, so the table says "LOADING HISTORY…" instead of flashing "not connected" on every cold boot.
const PENDING = new Promise(() => {});

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const numish = v => num(typeof v === "string" && v.trim() !== "" ? +v : v);   // metadata fields can arrive as strings
const baseName = f => String(f || "").split("/").pop();
const errText = e => (e && e.message ? e.message : String(e || "error"));

// ---- formatting -------------------------------------------------------------------------------------
/** Long spans read as "46d 2h" — fmtDur's h:mm:ss becomes unreadable ("1104:12:07") at lifetime scale. */
function fmtSpan(sec) {
  const t = num(sec);
  if (t === null || t < 0) return DASH;
  const d = Math.floor(t / DAY), h = Math.floor((t % DAY) / 3600), m = Math.floor((t % 3600) / 60);
  return d ? d + "d " + h + "h" : h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
}
function fmtLen(mm) {
  const v = num(mm);
  if (v === null) return DASH;
  const m = v / 1000;
  return m >= 1000 ? (m / 1000).toFixed(2) + " km" : m >= 10 ? m.toFixed(1) + " m" : m.toFixed(2) + " m";
}
function fmtMass(mm) {
  const v = num(mm);
  if (v === null) return DASH;
  const g = v * MM3_PER_MM * G_PER_MM3;
  return g >= 1000 ? (g / 1000).toFixed(2) + " kg" : Math.round(g) + " g";
}
/** fmtDate has no year; a job from 2024 must not read like one from last week. */
function fmtStamp(t) {
  const d = new Date(t * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
const fmtMm = v => (num(v) === null ? DASH : num(v).toFixed(2) + " mm");
/**
 * Slicer material fields are per-extruder, and this printer's history holds two shapes: Orca 2.x writes a
 * JSON array STRING (`["ABS", "ABS", "PLA", …]`), older exports a quote-semicolon list (`ABS";"PC`). Printed
 * raw, eight MMU gates fill the cell with `["ABS", "ABS", "P…` — so parse both and keep the distinct ones.
 */
function fmtMaterials(v) {
  if (v === null || v === undefined) return null;
  let parts = v;
  if (!Array.isArray(parts)) {
    const s = String(parts).trim();
    if (!s) return null;
    if (s.startsWith("[")) { try { parts = JSON.parse(s); } catch (e) { parts = [s]; } }
    else parts = s.split(";");
  }
  const seen = [];
  for (const p of Array.isArray(parts) ? parts : [parts]) {
    const t = String(p === null || p === undefined ? "" : p).trim().replace(/^["']+|["']+$/g, "").toUpperCase();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.length ? seen.join(" + ") : null;
}

// ---- status ------------------------------------------------------------------------------------------
// Moonraker writes these into job.status: in_progress, completed, cancelled, error, klippy_shutdown,
// klippy_disconnect, server_exit, interrupted. Anything unknown is treated as a failure (red) on purpose.
const STATUS_COLOR = { completed: T.ok, in_progress: T.accent, cancelled: T.warn, interrupted: T.warn };
const statusColor = s => STATUS_COLOR[s] || T.err;
const statusText = s => String(s || "unknown").replace(/_/g, " ").toUpperCase();
const isDone = s => s === "completed";
const isRunning = s => s === "in_progress";
const GROUPS = {
  all: null,
  completed: ["completed"],
  cancelled: ["cancelled", "interrupted"],
  failed: ["error", "klippy_shutdown", "klippy_disconnect", "server_exit"],
  in_progress: ["in_progress"],
};
const STATUS_TABS = [["all", "ALL"], ["completed", "DONE"], ["cancelled", "CANCELLED"], ["failed", "FAILED"], ["in_progress", "RUNNING"]];
const RANGE_TABS = [[0, "ALL"], [7, "7D"], [30, "30D"], [90, "90D"], [365, "1Y"]];
const SORT_TABS = [["start", "DATE"], ["dur", "TIME"], ["fil", "FILAMENT"], ["base", "NAME"]];
const SIZES = [25, 50, 100];

// ---- job rows ----------------------------------------------------------------------------------------
function normalize(data) {
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
function thumbUrl(api, job, minPx) {
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

function deriveTotals(jobs) {
  const t = { n: 0, time: 0, fil: 0, longest: 0, done: 0, bad: 0 };
  for (const j of jobs) {
    if (isRunning(j.status)) continue;              // an unfinished job has no final numbers yet
    t.n++;
    const d = num(j.dur) || 0;
    t.time += d;
    t.fil += num(j.fil) || 0;
    if (d > t.longest) t.longest = d;
    if (isDone(j.status)) t.done++; else t.bad++;
  }
  return t;
}

const dayKey = d => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
/** Local midnight `back` days ago — also the exact lower bound the chart query asks Moonraker for. */
function midnightBack(back) {
  const m = new Date();
  m.setHours(0, 0, 0, 0);
  return new Date(m.getTime() - back * DAY * 1000);
}
/** One bucket per local day, oldest first. Failures are counted separately so a bar can show them. */
function buildDays(jobs, n) {
  const buckets = [], byDay = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const at = midnightBack(i);
    const b = { at, jobs: 0, fails: 0, time: 0, failTime: 0 };
    buckets.push(b);
    byDay.set(dayKey(at), b);
  }
  for (const j of jobs) {
    if (j.start === null) continue;
    const b = byDay.get(dayKey(new Date(j.start * 1000)));
    if (!b) continue;
    const t = Math.max(0, num(j.dur) || 0);
    b.jobs++; b.time += t;
    if (!isDone(j.status) && !isRunning(j.status)) { b.fails++; b.failTime += t; }
  }
  return buckets;
}

// ---- small pieces ------------------------------------------------------------------------------------
/** Mono uppercase micro-label over a large mono value — the design's stat vocabulary. */
function Tile({ label, value, sub, color, title }) {
  return <div style={S(`flex:1 1 130px; min-width:0; padding:8px 10px; border:1px solid ${T.line}; border-radius:4px; background:${T.panel2}`)}>
    <Label>{label}</Label>
    <div style={S("margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")} title={title || undefined}><Val size={17} color={color || T.text}>{value}</Val></div>
    {/* the sub is ellipsised at ~120 px: always give the full string as a tooltip */}
    <div title={title || (sub || undefined)} style={S(`margin-top:3px; ${mono(8.5, `letter-spacing:.1em; color:${T.mute}`)}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{sub || " "}</div>
  </div>;
}

/** Segmented control: the design has no such primitive, so it is a row of Btns with the active one accented. */
function Seg({ items, value, onPick }) {
  return <Row gap={3}>{items.map(([v, t]) => (
    <Btn key={String(v)} small kind={value === v ? "accent" : "default"} onClick={() => onPick(v)}>{t}</Btn>
  ))}</Row>;
}

function Thumb({ url, size }) {
  const box = `width:${size}px; height:${size}px; flex:none; border:1px solid ${T.line}; border-radius:3px; background:${T.panel2}`;
  if (!url) return <div style={S(box)} />;
  // A 404 is still possible (a thumbnail deleted on its own): hide the broken image and keep the empty box.
  // Keyed by url so a row whose file changed under it gets a fresh <img> rather than inheriting that hiding.
  return <img key={url} src={url} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = "hidden"; }}
    style={S(`${box}; object-fit:contain; display:block`)} />;
}

function Dot({ color }) { return <span style={S(`width:5px; height:5px; border-radius:50%; background:${color}; flex:none`)} />; }

/**
 * 14-day activity, hand-drawn SVG (no chart library — Carbon has zero runtime dependencies).
 * One bar per local day: print time or job count, with the part that did not complete stacked on top in warn,
 * so a bad week is visible without reading a single number.
 */
function Activity({ days, metric, loading, error }) {
  const W = 400, H = 108, TOP = 12, BASE = 82, LABEL_Y = 96;
  const val = d => (metric === "time" ? d.time : d.jobs);
  const bad = d => (metric === "time" ? d.failTime : d.fails);
  const peak = Math.max(1, ...days.map(val));
  const slot = W / days.length;
  const bw = Math.min(21, slot - 7);
  const scale = v => (v <= 0 ? 0 : Math.max(1.5, (v / peak) * (BASE - TOP)));
  const any = days.some(d => val(d) > 0);
  const today = dayKey(new Date());
  const span = days.length
    ? days[0].at.toLocaleDateString(undefined, { month: "short", day: "2-digit" }).toUpperCase() + " → " +
      days[days.length - 1].at.toLocaleDateString(undefined, { month: "short", day: "2-digit" }).toUpperCase()
    : "";
  return <div style={S("display:flex; flex-direction:column; gap:7px")}>
    <svg viewBox={`0 0 ${W} ${H}`} style={S(`width:100%; height:auto; display:block; opacity:${loading || error ? .45 : 1}`)}>
      <g shapeRendering="crispEdges">
        <line x1="0" x2={W} y1={TOP} y2={TOP} stroke={T.line} strokeDasharray="2 4" />
        <line x1="0" x2={W} y1={(TOP + BASE) / 2} y2={(TOP + BASE) / 2} stroke={T.line} strokeDasharray="2 4" />
        <line x1="0" x2={W} y1={BASE} y2={BASE} stroke={T.line2} />
        {days.map((d, i) => {
          const x = i * slot + (slot - bw) / 2;
          const h = scale(val(d));
          const f = Math.min(h, scale(bad(d)));
          return <g key={i}>
            <title>{d.at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "2-digit" }) +
              " — " + d.jobs + (d.jobs === 1 ? " job" : " jobs") + (d.fails ? " (" + d.fails + " failed)" : "") + " · " + fmtSpan(d.time)}</title>
            <rect x={x} y={TOP} width={bw} height={BASE - TOP} fill="transparent" />
            {h - f > 0 && <rect x={x} y={BASE - (h - f)} width={bw} height={h - f} fill={T.accent} fillOpacity=".75" />}
            {f > 0 && <rect x={x} y={BASE - h} width={bw} height={f} fill={T.warn} fillOpacity=".8" />}
            {h === 0 && <rect x={x} y={BASE - 1} width={bw} height="1" fill={T.line2} />}
          </g>;
        })}
      </g>
      {/* axis text sits on T.panel: T.faint is 2.7:1 there, T.mute is 4.1:1 */}
      <text x="1" y={TOP - 3} fill={T.mute} style={S(mono(8, "letter-spacing:.1em"))}>{metric === "time" ? fmtSpan(peak) : peak + (peak === 1 ? " JOB" : " JOBS")}</text>
      {days.map((d, i) => (
        <text key={i} x={i * slot + slot / 2} y={LABEL_Y} textAnchor="middle" fill={dayKey(d.at) === today ? T.dim : T.mute}
          style={S(mono(8, "letter-spacing:.06em"))}>{d.at.getDate()}</text>
      ))}
      {!any && !loading && !error && <text x={W / 2} y={(TOP + BASE) / 2 + 3} textAnchor="middle" fill={T.mute} style={S(mono(9.5, "letter-spacing:.22em"))}>NO ACTIVITY</text>}
      {error && <text x={W / 2} y={(TOP + BASE) / 2 + 3} textAnchor="middle" fill={T.err} style={S(mono(9, "letter-spacing:.14em"))}>CHART UNAVAILABLE</text>}
    </svg>
    <Row gap={10}>
      <Row gap={5}><Dot color={T.accent} /><Label>{metric === "time" ? "PRINT TIME" : "JOBS"}</Label></Row>
      <Row gap={5}><Dot color={T.warn} /><Label>NOT COMPLETED</Label></Row>
      <div style={S("margin-left:auto")} />
      <Val size={9} color={T.mute}>{error ? String(error).slice(0, 34).toUpperCase() : span}</Val>
    </Row>
  </div>;
}

/** Expanded row: full metadata + the per-job actions. */
function JobDetail({ job, api, canPrint, printBlocked, locked, onReprint, onDelete, onView, onClose }) {
  const m = job.meta || {};
  const est = numish(m.estimated_time);
  const done = isDone(job.status);
  // A job that was cancelled or died stopped early BY DEFINITION, so "1h26m under the estimate" would read as
  // a win it never was. The comparison is only meaningful for a job that actually ran to the end.
  const delta = done && est !== null && job.dur !== null ? job.dur - est : null;
  const lh = numish(m.layer_height), first = numish(m.first_layer_height), objH = numish(m.object_height);
  let layers = numish(m.layer_count);
  if (layers === null && lh !== null && lh > 0 && objH !== null && first !== null) layers = Math.max(1, Math.round((objH - first) / lh) + 1);
  const weight = numish(m.filament_weight_total);
  const eTemp = numish(m.first_layer_extr_temp), bTemp = numish(m.first_layer_bed_temp);
  const fields = [
    ["STARTED", job.start === null ? DASH : fmtStamp(job.start)],
    ["ENDED", job.end === null ? DASH : fmtStamp(job.end)],
    ["PRINT TIME", job.dur === null ? DASH : fmtDur(job.dur)],
    ["TOTAL TIME", job.total === null ? DASH : fmtDur(job.total)],
    ["SLICER EST", est === null ? DASH : fmtDur(est)],
    ["VS ESTIMATE", delta === null ? DASH : (delta >= 0 ? "+" : "−") + fmtDur(Math.abs(delta)), delta === null ? T.body : delta > 0 ? T.warn : T.ok,
      done ? "Actual print time minus the slicer's estimate" : "Only compared for a job that ran to the end"],
    ["FILAMENT USED", fmtLen(job.fil)],
    ["SLICED LENGTH", fmtLen(numish(m.filament_total))],
    // Two different numbers, and for a cancelled job they are far apart: what this job actually pulled
    // (estimated from length) versus what the slicer said the whole print would weigh.
    ["WEIGHT USED", job.fil === null ? DASH : "≈ " + fmtMass(job.fil), null, FIL_NOTE],
    ["SLICED WEIGHT", weight === null ? DASH : weight.toFixed(1) + " g", null, "The slicer's figure for the complete print"],
    ["MATERIAL", fmtMaterials(m.filament_type) || fmtMaterials(m.filament_name) || DASH],
    ["FIRST LAYER", fmtMm(first)],
    ["LAYER HEIGHT", fmtMm(lh)],
    // layer_count is what the SLICER sliced, not the layer this job reached — Moonraker keeps no such number.
    ["LAYERS", layers === null ? DASH : String(layers), null, "Layers in the sliced file"],
    ["OBJECT HEIGHT", fmtMm(objH)],
    ["NOZZLE", fmtMm(numish(m.nozzle_diameter))],
    ["FIRST TEMPS", eTemp === null && bTemp === null ? DASH : `${eTemp === null ? DASH : Math.round(eTemp)} / ${bTemp === null ? DASH : Math.round(bTemp)} °C`],
    ["FILE SIZE", num(m.size) === null ? DASH : fmtBytes(m.size)],
    ["SLICER", m.slicer ? String(m.slicer) + (m.slicer_version ? " " + m.slicer_version : "") : DASH],
    ["USER", job.user || DASH],
    ["JOB ID", job.uid || DASH],
    ["G-CODE", job.exists ? "ON DISK" : "DELETED", job.exists ? T.body : T.mute],
  ];
  // Whatever the server's providers attached — on this printer that is Spoolman's spool_ids, the only record
  // of which spools a job actually charged. Rendered by shape, so a new provider needs no code here.
  for (const a of job.aux || []) {
    if (!a || !a.name || a.value === null || a.value === undefined) continue;
    // Spoolman writes one entry per tool and null for a tool that had no spool — join those out rather than
    // printing "43, 25, 24, 35, " with a dangling separator.
    const v = (Array.isArray(a.value) ? a.value.filter(x => x !== null && x !== undefined && x !== "").join(", ") : String(a.value)).trim();
    if (v) fields.push([String(a.name).replace(/_/g, " ").toUpperCase(), v + (a.units ? " " + a.units : ""), null, a.description ? String(a.description) : ""]);
  }
  return <div style={S(`flex:none; max-height:44%; overflow:auto; border-top:1px solid ${T.line}; background:${T.panel3}; padding:10px 12px; animation:vRise .16s ease both`)}>
    <Row gap={12} align="flex-start">
      <Thumb url={thumbUrl(api, job)} size={112} />
      <div style={S("flex:1; min-width:0")}>
        <Row gap={8}>
          <Chip color={statusColor(job.status)} bg={T.panel2} border={statusColor(job.status) + "44"} pulse={isRunning(job.status)}>{statusText(job.status)}</Chip>
          <div style={S(`flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${mono(12, `color:${T.text}`)}`)} title={job.name}>{job.base}</div>
          {/* `locked` while a confirm strip is already open: a second action must not quietly swap the
              question the user is in the middle of answering. */}
          <Btn small kind="ok" disabled={!canPrint || !job.exists || locked}
            title={!job.exists ? "The g-code file is no longer on the printer" : locked ? "Answer the confirmation first" : printBlocked || "Start this file again"}
            onClick={() => onReprint(job)}>REPRINT</Btn>
          <Btn small disabled={!job.exists} title="Open in the g-code viewer" onClick={() => onView(job)}>VIEWER</Btn>
          <Btn small kind="danger" disabled={!job.uid || isRunning(job.status) || locked}
            title={isRunning(job.status) ? "This job is still running" : locked ? "Answer the confirmation first" : "Delete this history record"}
            onClick={() => onDelete(job)}>DELETE</Btn>
          <Btn small kind="ghost" onClick={onClose} title="Collapse">✕</Btn>
        </Row>
        <div style={S(`margin-top:4px; ${mono(9.5, `color:${T.mute}`)}; overflow-wrap:anywhere`)}>{job.name || DASH}</div>
        <div style={S("margin-top:10px; display:grid; gap:9px 14px; grid-template-columns:repeat(auto-fill,minmax(122px,1fr))")}>
          {/* keyed by index, not label: the auxiliary names above are server-supplied and could collide */}
          {fields.map(([label, value, color, note], i) => <div key={i} style={S("min-width:0")}>
            <Label>{label}</Label>
            <div style={S("margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")} title={note ? String(value) + " — " + note : String(value)}>
              <Val size={11} color={color || T.body}>{value}</Val>
            </div>
          </div>)}
        </div>
      </div>
    </Row>
  </div>;
}

// ---- page --------------------------------------------------------------------------------------------
export default function Page({ store, api, navigate }) {
  const st = useStore(store);   // pages are rendered as a prop element — subscribe or the page never re-renders

  const [statusPref, setStatus] = usePersisted("history.status", "all");
  const [rangePref, setRange] = usePersisted("history.range", 0);
  const [q, setQ] = usePersisted("history.q", "");
  const [sortK, setSortK] = usePersisted("history.sortKey", "start");
  const [sortDirPref, setSortDir] = usePersisted("history.sortDir", "desc");
  const [sizePref, setSize] = usePersisted("history.size", 25);
  const [page, setPage] = usePersisted("history.page", 0);
  const [openKey, setOpenKey] = usePersisted("history.open", "");
  const [metricPref, setMetric] = usePersisted("history.metric", "time");
  const [confirm, setConfirm] = React.useState(null);   // NOT persisted: a reload must cancel a pending delete
  const [busy, setBusy] = React.useState(false);
  // Persisted values come back from localStorage, which holds whatever an older build of this page left there.
  // A stale `size` of 0 is a trap with no way out — rows/0 pages into a permanently empty table, and clearing
  // localStorage is not something the user can do from inside Orca's Device tab. Clamp every enumeration: a
  // value that is not on a tab would also leave the whole segmented control looking unselected.
  const size = SIZES.includes(sizePref) ? sizePref : SIZES[0];
  const sortKey = SORT_TABS.some(t => t[0] === sortK) ? sortK : "start";
  const status = GROUPS[statusPref] !== undefined ? statusPref : "all";
  const range = RANGE_TABS.some(t => t[0] === rangePref) ? rangePref : 0;
  const sortDir = sortDirPref === "asc" ? "asc" : "desc";
  const metric = metricPref === "jobs" ? "jobs" : "time";

  const log = React.useCallback((message, kind) => {
    if (!store) return;
    const entry = { time: Date.now() / 1000, message: String(message), type: kind || "info", local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }, [store]);
  const act = React.useMemo(() => makeHistoryActions({ api, store, log }), [api, store, log]);

  // `gen` bumps every time Moonraker comes up, which both delays the first fetch until the socket is open and
  // re-fetches after a reconnect — an RPC issued while disconnected just rejects with "not connected".
  const [gen, setGen] = React.useState(0);
  React.useEffect(() => { if (st.connected) setGen(g => g + 1); }, [st.connected]);
  const ready = !!api && gen > 0;

  // ---- the paged feed --------------------------------------------------------------------------------
  // `feed.jobs` is what has been fetched for the current window; `done` means the server has nothing older
  // left to give (the last response came back short), so the counts and filters below cover everything.
  const [feed, setFeed] = React.useState({ jobs: [], done: false, loading: true, adding: false, error: null });
  const feedRef = React.useRef(feed); feedRef.current = feed;
  const runRef = React.useRef(0);      // every fetch takes a ticket; only the newest one may write state
  const wantRef = React.useRef(0);     // rows asked for in this window so far (-1 = "all") — survives a refresh
  const winRef = React.useRef("");

  const request = React.useCallback((start, limit) => {
    const p = { start, limit, order: "desc" };
    // Moonraker's only server-side filter. `since` compares against start_time with a strict >, so step one
    // second back to keep a job that started exactly on the boundary.
    if (range) p.since = Math.floor(Date.now() / 1000 - range * DAY) - 1;
    return api.historyList(p);
  }, [api, range]);

  /** Fetch the newest `limit` rows of the window and replace what is held (0 = every row, capped). */
  const replace = React.useCallback(limit => {
    if (!api) return;
    const run = ++runRef.current;
    const ask = limit === 0 ? ALL_LIMIT : limit;
    setFeed(f => ({ ...f, loading: true, adding: false, error: null }));
    request(0, ask)
      .then(d => {
        if (run !== runRef.current) return;
        const js = normalize(d);
        setFeed({ jobs: js, done: js.length < ask, loading: false, adding: false, error: null });
      })
      .catch(e => {
        // Keep whatever was already on screen: a failed REFRESH should say "unavailable" over the last
        // known rows, not throw the user's page away. A failed FIRST load has nothing to keep anyway.
        if (run !== runRef.current) return;
        setFeed(f => ({ ...f, loading: false, adding: false, error: errText(e) }));
      });
  }, [api, request]);

  /** Fetch the next chunk and append it. */
  const loadMore = React.useCallback(() => {
    const cur = feedRef.current;
    if (!api || cur.loading || cur.adding || cur.done) return;
    const run = ++runRef.current;
    const start = cur.jobs.length;
    setFeed(f => ({ ...f, adding: true, error: null }));
    request(start, PAGE)
      .then(d => {
        if (run !== runRef.current) return;
        const js = normalize(d);
        // A job finishing between two requests shifts every offset by one; drop anything already held
        // rather than showing the same row twice (React would also warn about the duplicate key).
        const prev = feedRef.current.jobs;
        const seen = new Set(prev.map(j => j.key));
        const jobs = prev.concat(js.filter(j => !seen.has(j.key)));
        wantRef.current = wantRef.current < 0 ? -1 : jobs.length;
        setFeed({ jobs, done: js.length < PAGE, loading: false, adding: false, error: null });
      })
      .catch(e => {
        if (run !== runRef.current) return;
        setFeed(f => ({ ...f, adding: false, error: errText(e) }));
      });
  }, [api, request]);

  const loadAll = React.useCallback(() => {
    wantRef.current = -1;
    replace(0);
  }, [replace]);

  // First load, and a reload whenever the socket comes back or the time window changes. `wantRef` keeps a
  // LOAD ALL (or a few LOAD MOREs) in force across a rows-per-page change so the user does not silently
  // lose the rows they waited for.
  const win = gen + "|" + range;
  React.useEffect(() => {
    if (!ready) return;
    if (winRef.current !== win) { winRef.current = win; wantRef.current = 0; }
    const want = wantRef.current;
    const limit = want < 0 ? 0 : Math.max(want, PAGE, size);
    wantRef.current = want < 0 ? -1 : limit;
    replace(limit);
  }, [ready, win, size, replace]);

  const totalsQ = useAsync(() => (ready ? api.historyTotals() : PENDING), [api, gen]);
  // The chart's own query: exactly the 14 buckets it draws, ~18 KB here. Deriving it from the loaded page
  // would drop days as soon as the newest 50 jobs span less than two weeks.
  const chartQ = useAsync(() => (ready
    ? api.historyList({ start: 0, limit: CHART_LIMIT, order: "desc", since: Math.floor(midnightBack(CHART_DAYS - 1).getTime() / 1000) - 1 })
    : PENDING), [api, gen]);

  const reload = React.useCallback(() => {
    const want = wantRef.current;
    replace(want < 0 ? 0 : Math.max(want, PAGE, size));
    totalsQ.reload();
    chartQ.reload();
  }, [replace, size, totalsQ.reload, chartQ.reload]);

  // Moonraker pushes notify_history_changed when a job starts AND when it finishes; the two can land
  // together, so coalesce them into one refetch.
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    let t = 0;
    const off = api.on("history", () => { clearTimeout(t); t = setTimeout(reload, 400); });
    return () => { clearTimeout(t); if (off) off(); };
  }, [api, reload]);

  const jobs = feed.jobs;
  const chartJobs = React.useMemo(() => normalize(chartQ.data), [chartQ.data]);
  const days = React.useMemo(() => buildDays(chartJobs, CHART_DAYS), [chartJobs]);
  const totals = React.useMemo(() => deriveTotals(jobs), [jobs]);
  const loadingRows = feed.loading && !jobs.length;

  const rows = React.useMemo(() => {
    const group = GROUPS[status] || null;
    const needle = String(q || "").trim().toLowerCase();
    const dir = sortDir === "asc" ? 1 : -1;
    // No date filter here: `range` is applied by the server, and re-applying it against a slightly later
    // `now` would hide the oldest row of the window every time this recomputed.
    return jobs
      .filter(j => (!group || group.includes(j.status)) && (!needle || j.name.toLowerCase().includes(needle)))
      .sort((a, b) => dir * (sortKey === "base" ? a.base.localeCompare(b.base) : (num(a[sortKey]) || 0) - (num(b[sortKey]) || 0)));
  }, [jobs, status, q, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const cur = Math.min(Math.max(0, page | 0), pageCount - 1);
  const view = rows.slice(cur * size, cur * size + size);
  // Scoped to the rows on screen: an expanded detail card whose row has been filtered or paged away is a
  // panel of REPRINT/DELETE buttons pointing at a job the user can no longer see.
  const open = openKey ? view.find(j => j.key === openKey) || null : null;

  const filtered = status !== "all" || !!String(q || "").trim();
  // Sorting matters as much as filtering here: "longest print" sorted over half a database is a wrong answer,
  // while the default (newest first) is exactly the order the server paged in, so a partial set is honest.
  const reordered = sortKey !== "start" || sortDir !== "desc";
  const partial = !feed.done && (filtered || reordered);
  const canLoadMore = !feed.done && !feed.loading && !feed.adding;
  const scope = feed.done
    ? (range ? "LAST " + range + "D · " + jobs.length + " JOBS" : "")
    : "NEWEST " + jobs.length + (range ? " OF LAST " + range + "D" : " LOADED");

  // ---- print guard: the printer must be idle and Klipper ready before anything can be re-printed
  const raw = st.raw || {};
  const ps = raw.print_stats || {};
  const pstate = String(ps.state || "standby").toLowerCase();
  const paused = pstate === "paused" || !!(raw.pause_resume || {}).is_paused;
  const active = paused || pstate === "printing";
  const klippy = String(st.klippy || "unknown");
  const printBlocked = active ? (paused ? "A print is paused on the bed" : "A print is running") : klippy !== "ready" ? "Klipper is " + klippy : "";
  const canPrint = !printBlocked && !busy;

  // ---- lifetime totals: Moonraker's own numbers, falling back to the loaded rows if the RPC failed
  const jt = (totalsQ.data && totalsQ.data.job_totals) || null;
  // No server totals AND no rows (both requests failed) is not "zero prints ever" — it is "unknown".
  const fb = jobs.length ? totals : null;
  const totalJobs = jt ? num(jt.total_jobs) : fb && fb.n;
  const totalTime = jt ? num(jt.total_print_time) : fb && fb.time;
  const totalFil = jt ? num(jt.total_filament_used) : fb && fb.fil;
  const longest = jt ? num(jt.longest_print) : fb && fb.longest;
  const avg = totalJobs ? (totalTime || 0) / totalJobs : null;
  const rated = totals.done + totals.bad;
  const rate = rated ? Math.round((totals.done / rated) * 100) : null;
  // job_totals counts the jobs Moonraker itself tallied (250 here) while the list holds every stored row
  // (254): never present one as the breakdown of the other.
  const loadedNote = (feed.done ? jobs.length + " ROWS LOADED" : jobs.length + " NEWEST ROWS LOADED") + (range ? " · LAST " + range + " DAYS" : "");

  const pick = (setter, v) => { setter(v); setPage(0); };
  const askReprint = job => setConfirm({ kind: "reprint", job });
  const askDelete = job => setConfirm({ kind: "delete", job });
  const view3d = job => { if (navigate) navigate("/viewer", { file: job.name }); };

  function runConfirm() {
    const c = confirm;
    if (!c) return;
    if (c.kind === "deleteAll") { setConfirm({ kind: "deleteAll2" }); return; }   // second half of the double confirm
    setConfirm(null);
    setBusy(true);
    const p = c.kind === "reprint" ? act.reprint(c.job.name)
      : c.kind === "delete" ? act.deleteJob(c.job.uid, c.job.base)
        // Only pass a count when it is the real one: with a page loaded, or a range in force, jobs.length is
        // a fraction of what delete_job(all) actually erases.
        : act.deleteAll(feed.done && !range ? jobs.length : null);
    Promise.resolve(p)
      .then(ok => {
        if (!ok) return;
        if (c.kind === "delete" && openKey === c.job.key) setOpenKey("");
        if (c.kind === "deleteAll2") setOpenKey("");
        reload();
      })
      .catch(() => { /* the action already logged it */ })
      .then(() => setBusy(false));
  }

  const allCount = feed.done && !range ? String(jobs.length) + " " : "";
  const confirmText = !confirm ? "" :
    confirm.kind === "reprint" ? `Print "${confirm.job.base}" again? The printer starts immediately.` :
      confirm.kind === "delete" ? `Delete the history record for "${confirm.job.base}"? The g-code file itself is not touched.` :
        // The RPC is delete_job(all:true) — it ignores the filters and the time window entirely.
        confirm.kind === "deleteAll" ? `Delete ALL ${allCount}history records — every job Moonraker has stored, not just the ones listed here? The g-code files are not touched.` :
          "Last chance — this erases every job, total and statistic Moonraker has stored.";

  const cols = [
    { k: "thumb", label: "", w: "26px", render: r => <Thumb url={thumbUrl(api, r, 32)} size={22} /> },
    { k: "base", label: "FILE", w: "minmax(0,3fr)", render: r => <span title={r.name}>{r.base || DASH}</span> },
    { k: "status", label: "STATUS", w: "minmax(0,1.2fr)", render: r => <Row gap={5}><Dot color={statusColor(r.status)} /><span style={S(`color:${statusColor(r.status)}`)}>{statusText(r.status)}</span></Row> },
    { k: "start", label: "STARTED", w: "minmax(0,1.2fr)", render: r => (r.start === null ? DASH : <span title={fmtStamp(r.start)}>{fmtDate(r.start)}</span>) },
    { k: "dur", label: "DURATION", w: "minmax(0,1fr)", align: "right", render: r => (r.dur === null ? DASH : fmtDur(r.dur)) },
    { k: "fil", label: "FILAMENT", w: "minmax(0,1fr)", align: "right", render: r => fmtLen(r.fil) },
  ];

  const emptyMsg = loadingRows ? (st.connected ? "LOADING HISTORY…" : "WAITING FOR MOONRAKER…")
    : feed.error ? "—"
      : jobs.length ? "NO JOBS MATCH THESE FILTERS"
        : range ? "NO PRINTS IN THE LAST " + range + " DAYS" : "NO PRINTS RECORDED YET";

  return <div style={S("flex:1; display:grid; gap:10px; padding:10px; min-height:0; grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr)")}>

    <div style={S("display:grid; gap:10px; grid-template-columns:minmax(0,1fr) minmax(300px,430px)")}>
      <Panel title="TOTALS" right={<Row gap={8}>
        {/* Chip takes no title, so the tooltip lives on a wrapper */}
        {totalsQ.error && <span title={"server.history.totals failed: " + totalsQ.error}>
          <Chip color={T.warn} border="#3a2f14">TOTALS FROM LOADED ROWS</Chip></span>}
        {!!scope && <span title={loadedNote}><Chip color={T.dim}>{scope}</Chip></span>}
        <Btn small onClick={reload} disabled={feed.loading || feed.adding || totalsQ.loading}>{feed.loading || feed.adding || totalsQ.loading ? "LOADING…" : "REFRESH"}</Btn>
      </Row>}>
        <Row gap={8} style="flex-wrap:wrap" align="stretch">
          <Tile label="JOBS" value={totalJobs === null ? DASH : String(totalJobs)}
            sub={jobs.length ? totals.bad + " FAILED / " + totals.n : ""}
            title={(jt ? "Moonraker's lifetime job count. " : "No lifetime total from the server — this is the loaded rows. ") + loadedNote} />
          <Tile label="PRINT TIME" value={fmtSpan(totalTime)} sub={totalTime === null ? "" : fmtDur(totalTime)} />
          <Tile label="FILAMENT" value={fmtLen(totalFil)} sub={totalFil === null ? "" : "≈ " + fmtMass(totalFil)} title={FIL_NOTE} />
          <Tile label="LONGEST" value={fmtSpan(longest)} sub={longest === null ? "" : fmtDur(longest)} />
          <Tile label="AVERAGE" value={fmtSpan(avg)} sub="PER JOB" />
          <Tile label="SUCCESS" value={rate === null ? DASH : rate + "%"} sub={rated ? `${totals.done} / ${rated} DONE` : ""}
            title={"Completed jobs among the rows loaded here — " + loadedNote}
            color={rate === null ? T.text : rate >= 90 ? T.ok : rate >= 70 ? T.warn : T.err} />
        </Row>
      </Panel>

      <Panel title={CHART_DAYS + "-DAY ACTIVITY"} right={<Seg items={[["time", "TIME"], ["jobs", "JOBS"]]} value={metric} onPick={setMetric} />}>
        <Activity days={days} metric={metric} loading={chartQ.loading && !chartQ.data} error={chartQ.error} />
      </Panel>
    </div>

    <Panel title="JOBS" flat bodyStyle="display:flex; flex-direction:column; min-height:0"
      right={<Row gap={8} style="flex-wrap:wrap; justify-content:flex-end">
        <Input value={q} placeholder="SEARCH FILENAME" onChange={e => pick(setQ, e.target.value)} style="width:170px" />
        <Seg items={STATUS_TABS} value={status} onPick={v => pick(setStatus, v)} />
        <Seg items={RANGE_TABS} value={range} onPick={v => pick(setRange, v)} />
        <Btn small kind="danger" disabled={!jobs.length || busy || active || !!confirm}
          title={active ? "The running print is still writing its history row" : confirm ? "Answer the confirmation first" : "Erase every history record Moonraker has stored"}
          onClick={() => setConfirm({ kind: "deleteAll" })}>DELETE ALL</Btn>
      </Row>}>

      {feed.error && <div style={S(`flex:none; margin:8px 10px 0; padding:8px 10px; border:1px solid #4a1d13; border-radius:4px; background:#1a0c08; display:flex; align-items:center; gap:10px; ${mono(10, `color:${T.err}`)}`)}>
        <span style={S("flex:1; min-width:0")}>HISTORY UNAVAILABLE — {feed.error}</span>
        <Btn small onClick={reload}>RETRY</Btn>
      </div>}

      {/* The client-side filters only see what has been fetched — say so rather than letting a filter look
          like it searched the whole database. */}
      {partial && !feed.error && <div style={S(`flex:none; margin:8px 10px 0; padding:6px 10px; border:1px solid ${T.line}; border-radius:4px; background:${T.panel2}; display:flex; align-items:center; gap:10px; ${mono(9.5, `letter-spacing:.08em; color:${T.dim}`)}`)}>
        <span style={S("flex:1; min-width:0")}>{filtered ? "FILTERING" : "SORTING"} THE {jobs.length} LOADED JOBS — OLDER ONES ARE STILL IN THE DATABASE</span>
        <Btn small disabled={!canLoadMore} onClick={loadAll}>LOAD ALL</Btn>
      </div>}

      <div style={S("flex:1; min-height:0; overflow:auto; padding:2px 10px 8px")}>
        <Table cols={cols} rows={view} rowKey={r => r.key}
          onRow={r => setOpenKey(k => (k === r.key ? "" : r.key))}
          rowStyle={r => (r.key === openKey ? `background:${T.panel2}` : "")}
          empty={<span style={S(`color:${T.mute}`)}>{emptyMsg}</span>} />
      </div>

      {open && <JobDetail job={open} api={api} canPrint={canPrint} printBlocked={printBlocked} locked={!!confirm || busy}
        onReprint={askReprint} onDelete={askDelete} onView={view3d} onClose={() => setOpenKey("")} />}

      <Row gap={8} style={`flex:none; flex-wrap:wrap; padding:7px 10px; border-top:1px solid ${T.line}`}>
        <Label>SORT</Label>
        <Seg items={SORT_TABS} value={sortKey} onPick={v => pick(setSortK, v)} />
        <Btn small title="Reverse the sort order" onClick={() => pick(setSortDir, sortDir === "desc" ? "asc" : "desc")}>{sortDir === "desc" ? "↓ DESC" : "↑ ASC"}</Btn>
        <div style={S("margin-left:auto")} />
        <Label>ROWS</Label>
        <Seg items={SIZES.map(n => [n, String(n)])} value={size} onPick={v => pick(setSize, v)} />
        <Val size={10} color={T.mute} style={`white-space:nowrap`}>
          {rows.length ? `${cur * size + 1}–${Math.min(rows.length, (cur + 1) * size)} OF ${rows.length}${feed.done ? "" : "+"}` : "0 OF 0"}
        </Val>
        {!feed.done && <Btn small disabled={!canLoadMore} onClick={loadAll}
          title="Fetch every remaining job in one request — slower, but the filters and the success rate then cover the whole history">LOAD ALL</Btn>}
        <Btn small disabled={cur <= 0} onClick={() => setPage(cur - 1)}>PREV</Btn>
        {/* Past the last loaded page this button fetches instead of paging, and says which it is doing. */}
        <Btn small disabled={cur >= pageCount - 1 ? !canLoadMore : false}
          title={cur >= pageCount - 1 ? "Fetch the next " + PAGE + " jobs from Moonraker" : "Next page"}
          onClick={() => (cur < pageCount - 1 ? setPage(cur + 1) : loadMore())}>
          {feed.adding ? "LOADING…" : cur < pageCount - 1 ? "NEXT" : "LOAD MORE"}
        </Btn>
      </Row>

      {confirm && <Confirm text={confirmText} onYes={runConfirm} onNo={() => setConfirm(null)}
        yes={confirm.kind === "reprint" ? "PRINT" : confirm.kind === "deleteAll2" ? "ERASE ALL" : "DELETE"} />}
    </Panel>
  </div>;
}
