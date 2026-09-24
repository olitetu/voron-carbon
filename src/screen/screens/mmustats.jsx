// ---------------------------------------------------------------------------
// MMU STATS — Happy Hare's own statistics: per-gate encoder slippage, failures and quality grades, clog
// detection, lifetime toolchanges and the wear counters. Standalone from MORE, and embedded as the MMU
// screen's STATS tab (see `embedded` below).
//
// WHERE THE NUMBERS LIVE. Verified against the live printer (HH v3.4.2, ERCF v2.0, 8 gates) and the source:
//
//   · The `mmu` object carries NO statistics. Its 60-odd fields hold num_toolchanges (per print: reset by
//     _on_print_start and at Klipper start), clog_detection (a DEPRECATED alias of the FlowGuard encoder mode),
//     flowguard{} and encoder{} -- nothing per gate.
//   · Happy Hare persists everything in save_variables, which boot.js already subscribes to:
//       mmu_statistics_gate_<n>   {loads, unloads, load_distance, load_delta, unload_distance, unload_delta,
//                                  load_failures, unload_failures, pauses, quality}
//       mmu_statistics_swaps      {total_swaps, total, pause, total_pauses, swaps_since_pause(_record), and the
//                                  per-phase timers pre_unload / form_tip / unload / ... / post_load}
//       mmu_statistics_counters   {servo_down, cutter_blade, mmu_restarts: {count, limit, warning, pause}}
//     _persist_gate_statistics() runs after every load, unload and toolchange. HH's save_variable() stores its
//     OWN dicts into allVariables by reference and write_variables() issues SAVE_VARIABLE mmu__revision, which
//     makes Klipper swap in a NEW top-level dict, so the subscription pushes the lot -- serialised from memory at
//     that moment, for every gate at once. The screen therefore shows real data WITHOUT sending anything.
//   · The published copy can still run BEHIND memory: a failed load bumps load_failures in the MmuError handler and
//     the pause counters at pause start, and nothing is published until Happy Hare next writes ANY variable (a
//     load, unload, toolchange, filament-position change, gate-map edit...). After a Klipper restart the loaded
//     copies are separate dicts until the first persist, so the lag lasts until then. REFRESH exists for that: it
//     sends MMU_STATS DETAIL=1, a report and nothing else (cmd_MMU_STATS without RESET or COUNTER only calls
//     _dump_statistics; its log_to_file writes mmu.log, not state). Never RESET, never COUNTER/INCR. Its one side
//     effect is every MMU command's: check_if_disabled() -> _wakeup() moves HH's print_state from "standby" (idle
//     timeout) to "idle", which runs _MMU_PRINT_STATE_CHANGED (LED effect; this printer's user extension is '').
//     No motion, no heat: allowed while printing, refused while the MMU is mid-operation (see STATS_GUARDS).
//
// THE REPORT. MMU_STATS DETAIL=1 -> _dump_statistics(force_log, total, job, gate, detail) -> ONE log_always ->
// Klipper's respond_info strips every line and prefixes "// ", so it lands as ONE st.log entry. Per-gate lines are
// printed only when _can_use_encoder() (encoder_move_validation = 1 on this printer), in the exact format
//     Gate 5: Load: (monitored: 192198.4mm slippage: 6.0%); Unload: (...); Failures: (load: 45 unload: 8
//     pauses: 71); Quality: 90.3%
// The summary line above them is emoji here (console_gate_stat = emoticon), so the numbers are what is parsed.
// Happy Hare also dumps a summary after every toolchange (log_statistics = 1) -- without the per-gate lines.
// A report replaces the saved numbers only when it is AHEAD of them: every counter the two share only grows
// between resets, so "all >= and one >" means newer -- judged over ALL gates, because both sides are all-gate
// snapshots (see the render). A report from before a reset is history and is ignored: an explicit reset line
// (`MMU_STATS RESET=1` without COUNTER=, `MMU_RESET CONFIRM=1`, "MMU state reset"), a newer dump with a lower
// lifetime swap record, or a record above the saved one all mean that.
//
// WHAT QUALITY IS -- and why the slip columns lead. Per monitored gear move Happy Hare computes
// abs(1 - delta/dist), with delta = moved - measured, and keeps a 1-in-10 rolling average. An unload move has
// NEGATIVE dist, so unload slippage pushes quality ABOVE 1. Gate 0 here slips 13.1 % on unload and reads
// quality 102.8 %: Happy Hare grades it PERFECT (its percentage view caps at 100). The grade thresholds below are
// _gate_statistics_to_string's, verbatim; the ▴ marks a quality that unload slip has inflated.
// `loads` / `unloads` count ATTEMPTS (tracked in a finally:). Gate 0's saved 10 load failures on 3 loads (and gate
// 1's failures on 0 loads) do not fit that rule -- shown as stored, not "fixed". The report carries no attempts, so
// a row it updates shows failures without the "/attempts".
// Statistics belong to the GATE (gear, servo, encoder), not the spool: a new spool inherits the gate's history.
//
// CLOG DETECTION reads the encoder object: detection_mode 2 = Automatic, 1 = On, 0 = Off (_get_encoder_summary);
// enabled = FlowGuard/runout armed, which only happens during a print; headroom = mm left before a trigger, and
// desired_headroom is Happy Hare's own target. detection_length (12.9 mm) is what automatic mode calibrated and
// saved as mmu_calibration_clog_length.
//
// EMBEDDED CONTRACT (same as GATE MAP). `embedded` only changes the root box: standalone it owns the whole
// 1024x548 content area with L.pad; embedded it is a flex:1 child of the MMU screen, which already provides the
// padding, the unit title and the tab strip. Either way the bottom row reserves the nav FAB's corner.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { mmu as mmuVm } from "../vm.js";
import { Panel, PanelBtn, Bar, Empty, ink } from "../parts.jsx";
import { num } from "../../lib/spools.js";
import { fmtLen, fmtSpan } from "../../lib/history.js";
import { fmtDur } from "../../lib/design.jsx";
import { cleanPhysical, fmtLogTime } from "../../pages/dashboard/adapters/console.js";

/** The only command this screen sends. A report: no RESET, no COUNTER. */
export const STATS_CMD = "MMU_STATS DETAIL=1";
// Allowed while printing: it moves nothing and changes nothing. NOT while the MMU is mid-operation: the command then
// queues behind it on Klipper's gcode mutex (a swap averages 88 s here), rpc() gives up at 30 s and the action layer
// reports a failure for a report that is still coming -- and it could only report the state after that operation.
const STATS_GUARDS = { needsMmu: true, needsMmuIdle: true };
const SCAN = 600;                          // st.log entries searched for the newest report
const EPS = 0.051;                         // the report prints distances with %.1f
const GATE_KEY = "mmu_statistics_gate_";

// When REFRESH was last tapped. Module scope so switching MMU tabs (which remounts this) keeps the waiting state.
let askedAt = 0;

/** Happy Hare v3.4.2 _gate_statistics_to_string grading, verbatim thresholds. quality < 0 = never measured. */
const GRADES = [
  [0.985, "PERFECT", "ok"], [0.965, "GREAT", "ok"], [0.95, "GOOD", "ok"],
  [0.925, "MARGINAL", "warn"], [0.90, "DEGRADED", "warn"], [0.85, "POOR", "err"],
];
export function grade(q) {
  if (typeof q !== "number" || !(q >= 0)) return { label: "N/A", kind: "off" };
  for (const [min, label, kind] of GRADES) if (q >= min) return { label, kind };
  return { label: "TERRIBLE", kind: "err" };
}
const TONE = { ok: C.cool, warn: C.bed, err: C.accent, off: C.faint };
const n0 = v => num(v) ?? 0;

/** One gate's persisted entry -> the row model. slip is null when nothing was monitored (HH prints 0.0 then). */
function fromSaved(g) {
  if (!g || typeof g !== "object") return null;
  const loadDist = n0(g.load_distance), unloadDist = n0(g.unload_distance);
  return {
    loads: n0(g.loads), unloads: n0(g.unloads), loadDist, unloadDist,
    loadSlip: loadDist > 0 ? n0(g.load_delta) / loadDist * 100 : null,
    unloadSlip: unloadDist > 0 ? n0(g.unload_delta) / unloadDist * 100 : null,
    loadFail: n0(g.load_failures), unloadFail: n0(g.unload_failures), pauses: n0(g.pauses),
    quality: typeof g.quality === "number" ? g.quality : -1,
  };
}

const DETAIL_RE = /Gate\s+(\d+):\s*Load:\s*\(monitored:\s*(-?[\d.]+)\s*mm\s+slippage:\s*(-?[\d.]+)\s*%\)\s*;\s*Unload:\s*\(monitored:\s*(-?[\d.]+)\s*mm\s+slippage:\s*(-?[\d.]+)\s*%\)\s*;\s*Failures:\s*\(load:\s*(\d+)\s+unload:\s*(\d+)\s+pauses:\s*(\d+)\)\s*;\s*Quality:\s*(-?[\d.]+)\s*%/i;
const PAUSED_RE = /(\S+)\s+spent paused over\s+(\d+)\s+pauses\s+\(All time\)/i;
const INCIDENT_RE = /swaps since last incident:\s*(\d+)\s*\(Record:\s*(\d+)\)/i;
// What wipes the per-gate statistics (cmd_MMU_STATS / cmd_MMU_RESET): `MMU_STATS RESET=1` WITHOUT COUNTER= (with it,
// only that wear counter is zeroed -- this printer's macros send MMU_STATS COUNTER=... all day), and `MMU_RESET
// CONFIRM=1` (without CONFIRM it only prints a warning). Command lines reach st.log only from the gcode_store backlog;
// the live stream carries responses, so MMU_RESET's own "MMU state reset" reply is matched as well.
const RESET_CMD_RE = /^\s*MMU_STATS\b(?![^\n]*\bCOUNTER\s*=)[^\n]*\bRESET\s*=\s*1\b|^\s*MMU_RESET\b[^\n]*\bCONFIRM\s*=\s*1\b/im;
const RESET_MSG_RE = /^\s*\/\/\s*MMU state reset\s*$/im;
/** HH's _seconds_to_short_string ("57:22:51", "1:28", "44.2") back to seconds. */
const hhSecs = t => String(t).split(":").reduce((a, p) => a * 60 + (parseFloat(p) || 0), 0);

/**
 * Newest MMU_STATS report with per-gate lines in st.log (newest first), plus when the newest statistics dump of
 * any kind arrived -- so a REFRESH that came back without gate lines can say so instead of looking ignored.
 *
 * `stale` = the report predates a statistics reset. Besides an explicit reset line, every dump (the per-toolchange
 * summary included) ends "Number of swaps since last incident: n (Record: r)", and the lifetime record only grows
 * between resets -- so a NEWER dump with a LOWER record means a reset came in between, even when the reset command
 * itself never reached this log.
 */
export function parseStatsReport(log) {
  const list = log || [];
  let dumpAt = 0, resetSeen = false, newerRecord = Infinity, m;
  for (let i = 0; i < Math.min(list.length, SCAN); i++) {
    const e = list[i] || {};
    const msg = String(e.message || "");
    if (RESET_CMD_RE.test(msg) || RESET_MSG_RE.test(msg)) { resetSeen = true; continue; }
    if (msg.indexOf("MMU Statistics") < 0 && msg.indexOf("Gate Statistics") < 0) continue;
    const time = Number(e.time) || 0;
    if (!dumpAt) dumpAt = time;
    const rec = (m = msg.match(INCIDENT_RE)) ? +m[2] : null;
    const note = () => { if (rec !== null) newerRecord = Math.min(newerRecord, rec); };
    if (msg.indexOf("monitored:") < 0) { note(); continue; }
    const gates = {};
    let paused = null, incident = null;
    for (const line of msg.split(/\r?\n/)) {
      const l = cleanPhysical(line).trim();
      if ((m = l.match(DETAIL_RE))) {
        const ld = +m[2], ud = +m[4];
        gates[+m[1]] = {
          loadDist: ld, unloadDist: ud,
          loadSlip: ld > 0 ? +m[3] : null, unloadSlip: ud > 0 ? +m[5] : null,
          loadFail: +m[6], unloadFail: +m[7], pauses: +m[8],
          // "Quality: 0.0%" is also what HH prints for a never-measured gate (quality -1).
          quality: ld + ud > 0 ? +m[9] / 100 : -1,
        };
      } else if ((m = l.match(PAUSED_RE))) paused = { secs: hhSecs(m[1]), count: +m[2] };
      else if ((m = l.match(INCIDENT_RE))) incident = { since: +m[1], record: +m[2] };
    }
    if (!Object.keys(gates).length) { note(); continue; }
    const dropped = !!(incident && incident.record > newerRecord);
    return { report: { time, gates, paused, incident, stale: resetSeen || dropped }, dumpAt };
  }
  return { report: null, dumpAt };
}

/** Is the report newer than the saved copy? Shared counters only grow between resets. */
function compare(r, s) {
  if (!r) return null;
  if (!s) return "ahead";
  const d = [r.loadDist - s.loadDist, r.unloadDist - s.unloadDist].map(x => (Math.abs(x) <= EPS ? 0 : x))
    .concat([r.loadFail - s.loadFail, r.unloadFail - s.unloadFail, r.pauses - s.pauses]);
  const up = d.some(x => x > 0), down = d.some(x => x < 0);
  return up && !down ? "ahead" : !up && !down ? "same" : "behind";
}
const FIELDS = ["loadDist", "unloadDist", "loadSlip", "unloadSlip", "loadFail", "unloadFail", "pauses", "quality"];
function changed(r, s) {
  const out = new Set();
  for (const k of FIELDS) {
    const a = r[k], b = s ? s[k] : null;
    const tol = k === "quality" ? 0.00051 : /Slip$/.test(k) ? 0.051 : /Dist$/.test(k) ? EPS : 0;
    if (b == null || a == null ? a !== b : Math.abs(a - b) > tol) out.add(k);
  }
  return out;
}
/**
 * The row for a gate the report is ahead on. Only fields that really moved come from the report: the rest keep the
 * saved copy's full precision (the report prints %.1f, so a 98.49 % quality would read 98.5 % and grade one step
 * too high). Attempts (loads / unloads) are not in the report and the saved ones lag it, so they are dropped rather
 * than shown under a failure count that may already exceed them.
 */
function merge(s, r, diff) {
  const out = Object.assign({}, s || {});
  for (const k of FIELDS) if (!s || diff.has(k)) out[k] = r[k];
  out.loads = null; out.unloads = null;
  return out;
}
const NONE = new Set();

/** Label over value -- the top panels' idiom. */
function Cell({ k, v, color = C.body, big = false }) {
  return (
    <div style={S("display:flex; flex-direction:column; gap:2px; min-width:0")}>
      <span style={S(mono(F.micro, `letter-spacing:.02em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{k}</span>
      <span style={S(mono(big ? F.num2 : F.body, `color:${color}; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
    </div>
  );
}
const CELLS = "flex:1; min-height:0; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); grid-auto-rows:auto; gap:4px 10px; align-content:center; padding:5px 13px";

// GATE | FILAMENT | GRADE | QUALITY | LOAD slip dist fails | UNLOAD slip dist fails | PAUSES
const COLS = "34px minmax(0,1fr) 96px 64px 60px 72px 76px 60px 72px 76px 60px";
const HEAD = ["GATE", "FILAMENT", "GRADE", "QUALITY", "SLIP", "DIST", "FAILS", "SLIP", "DIST", "FAILS", "PAUSES"];
const cellTxt = (color, right = true) =>
  mono(F.label, `color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:${right ? "right" : "left"}`);

export default function MmuStats({ st, act, embedded = false }) {
  const [, bump] = React.useState(0);
  const { report, dumpAt } = React.useMemo(() => parseStatsReport(st.log), [st.log]);
  const m = mmuVm(st);
  const raw = st.raw || {};
  const hm = raw.mmu || {};
  const vars = (raw.save_variables || {}).variables || {};

  const root = embedded
    ? `flex:1; min-height:0; display:flex; flex-direction:column; gap:${L.gap}px`
    : `height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`;

  if (!m.present) {
    return (
      <div style={S(embedded ? root : `height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px`)}>
        <div style={S(panel("height:100%; flex:1"))}>
          <Empty title="NO MMU CONFIGURED" hint="There is no Happy Hare mmu object on this printer, so there are no MMU statistics." />
        </div>
      </div>
    );
  }

  // ---- swap statistics. HH reads every key with .get(key, 0) and a reset saves {}, so a missing key IS zero.
  const sw = vars.mmu_statistics_swaps && typeof vars.mmu_statistics_swaps === "object" ? vars.mmu_statistics_swaps : null;
  const sv = k => (sw ? n0(sw[k]) : null);

  // ---- per gate: the saved copy, overridden by a report that is ahead of it.
  // Both are snapshots of ALL gates at one moment (_persist_gate_statistics writes every gate; MMU_STATS prints every
  // gate), and every compared counter only grows between resets. So within one epoch the report is ahead of the saved
  // copy on no gate or ahead-or-equal on all of them. A report ahead on some gates and behind on others is from before
  // a reset, and so is one whose lifetime swap record exceeds the saved record (persisted on every swap).
  const epochGone = !!(report && report.incident && sw && report.incident.record > sv("swaps_since_pause_record"));
  const usable = report && !report.stale && !epochGone ? report : null;
  const base = m.gates.map(g => {
    const s = fromSaved(vars[GATE_KEY + g.i]);
    const r = usable ? usable.gates[g.i] || null : null;
    return { g, s, r, cmp: compare(r, s) };
  });
  const cmps = base.map(x => x.cmp).filter(Boolean);
  const anyBehind = cmps.includes("behind"), anyAhead = cmps.includes("ahead");
  const live = usable && anyAhead && !anyBehind ? usable : null;
  const rows = base.map(({ g, s, r, cmp }) => {
    const ahead = !!live && cmp === "ahead";
    const diff = ahead ? changed(r, s) : NONE;
    return { g, ahead, diff, v: ahead ? merge(s, r, diff) : s };
  });
  const anyStats = rows.some(x => x.v);
  const aheadGates = rows.filter(x => x.ahead).map(x => x.g.i);
  const repState = !report ? "none" : !usable ? "reset" : anyAhead && anyBehind ? "mixed" : live ? "live"
    : cmps.length && cmps.every(c => c === "same") ? "same" : "older";
  const repTime = report ? fmtLogTime(report.time) : "";

  // ---- toolchanges (lifetime from the saved swap statistics, this print from the live mmu object)
  const swaps = sv("total_swaps");
  const avgSwap = swaps ? sv("total") / swaps : null;
  const saved = { pauses: sv("total_pauses"), pausedSecs: sv("pause"), since: sv("swaps_since_pause"), record: sv("swaps_since_pause_record") };
  let { pauses, pausedSecs, since, record } = saved;
  // A pause is counted in memory at pause start and saved at the next write -- take the report's if it is ahead. The
  // gates need not show it (a pause with no gate selected counts no gate), so this only needs a same-epoch report
  // that is not behind the saved copy.
  const swapSrc = usable && !anyBehind ? usable : null;
  const pausesLive = !!(swapSrc && swapSrc.paused && pauses !== null && swapSrc.paused.count > pauses);
  if (pausesLive) {
    pauses = swapSrc.paused.count; pausedSecs = swapSrc.paused.secs;
    if (swapSrc.incident) { since = swapSrc.incident.since; record = swapSrc.incident.record; }
  }
  const psState = (raw.print_stats || {}).state;
  const inPrint = psState === "printing" || psState === "paused";
  // num_toolchanges resets at print start AND at Klipper start, so outside a print it is one or the other.
  const jobLabel = inPrint ? "THIS PRINT" : ["complete", "cancelled", "error"].includes(psState) ? "LAST PRINT" : "SINCE BOOT";
  const tc = num(hm.num_toolchanges);
  const planned = num((hm.slicer_tool_map || {}).total_toolchanges);
  const dash = v => (v === null || v === undefined ? "—" : String(v));
  // Amber = taken from the report AND different from the saved copy, as in the gate table. The report prints the
  // paused time as h:mm:ss, so under a second of difference is the same value.
  const amber = (a, b, tol = 0) => (pausesLive && a !== null && b !== null && Math.abs(a - b) > tol ? C.bed : C.body);

  // ---- clog detection (encoder FlowGuard)
  const enc = hm.encoder || raw["mmu_encoder mmu_encoder"] || null;
  const fg = hm.flowguard && typeof hm.flowguard === "object" ? hm.flowguard : null;
  const modeNum = enc && typeof enc.detection_mode === "number" ? enc.detection_mode
    : typeof hm.clog_detection === "number" ? hm.clog_detection : null;
  const mode = { 0: "OFF", 1: "ON", 2: "AUTOMATIC" }[modeNum] || "—";
  const armed = !!(enc && enc.enabled);
  const mm = v => (num(v) === null ? "—" : `${num(v).toFixed(1)} mm`);
  const headroom = enc ? num(enc.headroom) : null, desired = enc ? num(enc.desired_headroom) : null;
  const savedClog = num(vars.mmu_calibration_clog_length);
  // _can_use_encoder() = encoder fitted AND [mmu] encoder_move_validation: without it no slippage is measured and
  // MMU_STATS prints no per-gate lines. configfile.settings (st.config) carries it as an int; 1 on this printer.
  const validation = num(((st.config || {}).mmu || {}).encoder_move_validation);
  const trigger = fg && fg.trigger ? String(fg.trigger).toUpperCase() : fg ? "NONE" : "—";

  // ---- wear counters (HH consumption counters; MMU_STATS COUNTER=... maintains them, never this screen)
  const counters = vars.mmu_statistics_counters && typeof vars.mmu_statistics_counters === "object"
    ? Object.entries(vars.mmu_statistics_counters).filter(([, c]) => c && typeof c === "object") : [];

  // ---- refresh
  const inFlight = (st.busy || []).includes("MMU_STATS");
  const why = act.blocked(STATS_GUARDS, STATS_CMD) || (hm.enabled === false ? "Happy Hare is disabled" : null);
  const fresh = askedAt && report && report.time * 1000 >= askedAt - 1000;
  const noDetail = askedAt && !inFlight && !fresh && dumpAt * 1000 >= askedAt - 1000;
  const refresh = () => {
    if (why) { act.refuse("MMU_STATS", why); return; }
    askedAt = Date.now();
    bump(x => x + 1);
    act.guarded(STATS_CMD, STATS_GUARDS);
  };

  const plural = n => (n.length === 1 ? `gate ${n[0]} is` : `gates ${n.join(", ")} are`);
  const [statusText, statusColor] = why ? [`REFRESH unavailable — ${why}`, C.bed]
    : inFlight ? ["Asking Happy Hare for its in-memory statistics…", C.dim]
    : noDetail ? [validation === 0
        ? "MMU_STATS answered without per-gate lines — encoder_move_validation is 0 in [mmu]"
        : "MMU_STATS answered without per-gate lines — Happy Hare prints them only with encoder move validation on", C.bed]
    : repState === "live" ? [`Live report ${repTime}: ${plural(aheadGates)} ahead of the saved copy — amber is not saved yet`, C.bed]
    : repState === "same" ? [`Report ${repTime} matches the saved copy — nothing is waiting to be saved`, C.cool]
    : repState === "older" ? [`Saved copy shown — the ${repTime} report is older than it`, C.dim]
    : repState === "mixed" ? [`Saved copy shown — the ${repTime} report is ahead on some gates, behind on others`, C.dim]
    : repState === "reset" ? [`Saved copy shown — the ${repTime} report predates a statistics reset`, C.dim]
    : ["Saved copy — Happy Hare writes it after every load and unload", C.dim];

  const srcLabel = repState === "live" ? `● LIVE ${repTime}` : anyStats ? "● SAVED" : "● NO DATA";
  const srcColor = repState === "live" ? C.bed : anyStats ? C.cool : C.faint;

  return (
    <div style={S(root)}>

      {/* lifetime / clog / wear */}
      <div style={S(`flex:none; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:${L.gap}px`)}>
        <Panel title="TOOLCHANGES"
          right={<span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.dim}; white-space:nowrap`))}>
            AVG {avgSwap === null ? "—" : fmtDur(avgSwap)} / SWAP</span>}>
          <div style={S(CELLS)}>
            <Cell k="LIFETIME" v={dash(swaps)} color={C.text} big />
            <Cell k={jobLabel} v={tc === null ? "—" : inPrint && planned !== null ? `${tc} / ${planned}` : String(tc)} />
            <Cell k="PAUSES" v={dash(pauses)} color={amber(pauses, saved.pauses)} />
            <Cell k="SINCE PAUSE" v={dash(since)} color={amber(since, saved.since)} />
            <Cell k="RECORD" v={dash(record)} color={amber(record, saved.record)} />
            <Cell k="TIME PAUSED" v={pausedSecs === null ? "—" : fmtSpan(pausedSecs)} color={amber(pausedSecs, saved.pausedSecs, 1)} />
          </div>
        </Panel>

        <Panel title="CLOG DETECTION"
          right={<span style={S(mono(F.micro, `letter-spacing:.12em; color:${modeNum > 0 ? C.cool : C.faint}; white-space:nowrap`))}>
            {enc ? mode : "NO ENCODER"}</span>}>
          <div style={S(CELLS)}>
            <Cell k="ENCODER" v={enc ? (armed ? "ARMED" : "IDLE") : "—"} color={armed ? C.cool : C.mute} />
            <Cell k="FLOWGUARD" v={fg ? (!fg.enabled ? "OFF" : fg.active ? "ARMED" : "IDLE") : "—"}
              color={fg && fg.active ? C.cool : C.mute} />
            <Cell k="TRIGGER" v={trigger} color={fg && fg.trigger ? C.accent : C.mute} />
            <Cell k="LENGTH" v={enc ? mm(enc.detection_length) : savedClog !== null ? mm(savedClog) : "—"} />
            {/* Headroom is only measured while armed (a print). Idle, the number is not a measurement. */}
            <Cell k="HEADROOM" v={armed ? mm(headroom) : "—"}
              color={armed && headroom !== null && desired !== null && headroom < desired ? C.bed : C.body} />
            <Cell k="MIN HEADROOM" v={enc ? mm(enc.min_headroom) : "—"} />
          </div>
        </Panel>

        <Panel title="WEAR COUNTERS"
          right={<span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}`))}>HAPPY HARE</span>}>
          <div style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; justify-content:center; gap:7px; padding:8px 13px")}>
            {counters.length ? counters.map(([name, c]) => {
              const count = n0(c.count), limit = num(c.limit);
              const over = limit !== null && limit >= 0 && count > limit;
              return (
                <div key={name} style={S("display:flex; flex-direction:column; gap:3px; min-width:0")}>
                  <div style={S("display:flex; align-items:baseline; gap:8px; min-width:0")}>
                    <span style={S(mono(F.micro, `letter-spacing:.08em; color:${over ? C.accent : C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>
                      {over && c.warning ? String(c.warning).toUpperCase() : name.replace(/_/g, " ").toUpperCase()}
                    </span>
                    <span style={S(`margin-left:auto; ${mono(F.label, `color:${over ? C.accent : C.body}; white-space:nowrap`)}`)}>
                      {count}{limit !== null && limit >= 0 ? <span style={S(`color:${C.faint}`)}> / {limit}</span> : null}
                    </span>
                  </div>
                  {limit !== null && limit > 0 ? <Bar pct={count / limit * 100} h={4} color={over ? C.accent : C.cool} /> : null}
                </div>
              );
            }) : (
              <span style={S(mono(F.label, `color:${C.faint}`))}>No counters saved</span>
            )}
          </div>
        </Panel>
      </div>

      {/* per-gate table */}
      <Panel title="PER-GATE ENCODER STATISTICS" style="flex:1; min-height:0"
        right={<span style={S(mono(F.micro, `letter-spacing:.14em; color:${srcColor}; white-space:nowrap`))}>{srcLabel}</span>}>
        {!anyStats ? (
          <Empty title="NO GATE STATISTICS"
            hint={!enc
              ? "This MMU reports no encoder. Happy Hare needs one to measure slippage, so it keeps no per-gate statistics."
              : validation === 0
                ? "encoder_move_validation is 0 in [mmu], so Happy Hare measures no slippage and keeps no per-gate statistics."
                : "Happy Hare saves per-gate statistics to save_variables after the first encoder-monitored load or unload. REFRESH asks it for the in-memory numbers."} />
        ) : (
          <>
            <div style={S(`flex:none; display:grid; grid-template-columns:${COLS}; column-gap:8px; row-gap:1px; padding:3px 12px 2px; border-bottom:1px solid ${C.line2}`)}>
              {[["LOAD", "5 / 8"], ["UNLOAD", "8 / 11"]].map(([t, col]) => (
                <span key={t} style={S(`grid-row:1; grid-column:${col}; text-align:center; border-bottom:1px solid ${C.line3}; ${mono(F.micro, `letter-spacing:.16em; color:${C.dim}; line-height:1.1`)}`)}>{t}</span>
              ))}
              {HEAD.map((h, i) => (
                <span key={i} style={S(`grid-row:2; grid-column:${i + 1}; text-align:${i >= 3 ? "right" : "left"}; ${mono(F.micro, `letter-spacing:.06em; color:${C.faint}; white-space:nowrap; overflow:hidden`)}`)}>{h}</span>
              ))}
            </div>
            <div style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column")}>
              {rows.map(({ g, v, ahead, diff }) => {
                const gr = grade(v ? v.quality : -1);
                const q = v ? v.quality : -1;
                const hot = k => (diff.has(k) ? C.bed : null);
                const fil = [g.material, g.name].filter(x => x && x !== "—").join(" · ");
                const pct = x => (x === null || x === undefined ? "—" : `${x.toFixed(1)}%`);
                const fails = (f, of, k) => (
                  <span style={S(cellTxt(hot(k) || (f ? C.body : C.faint)))}>
                    {f}{of !== null && of !== undefined ? <span style={S(`color:${C.faint}`)}> /{of}</span> : null}
                  </span>
                );
                return (
                  <div key={g.i} style={S(`flex:1 0 22px; display:grid; grid-template-columns:${COLS}; column-gap:8px; align-items:center; padding:0 12px; ${g.i ? `border-top:1px solid ${C.line1};` : ""} ${g.selected ? `background:${C.rowOn};` : ""}`)}>
                    <span style={S(mono(F.label, `color:${ahead ? C.bed : g.selected ? C.accent : C.dim}`))}>{g.i}</span>
                    <div style={S("display:flex; align-items:center; gap:8px; min-width:0")}>
                      <span style={S(`width:10px; height:10px; border-radius:50%; flex:none; background:${g.hasColor ? ink(g.color) : C.line4}; ${g.empty ? "opacity:.35" : ""}`)} />
                      <span style={S(cellTxt(g.empty ? C.ghost : C.dim, false))}>{g.empty ? "EMPTY" : fil || "—"}</span>
                    </div>
                    <span style={S(`display:flex; align-items:center; gap:6px; min-width:0; ${mono(F.micro, `letter-spacing:.1em; color:${hot("quality") || TONE[gr.kind]}; white-space:nowrap`)}`)}>
                      <span style={S(`width:7px; height:7px; border-radius:50%; flex:none; background:${TONE[gr.kind]}`)} />
                      {v ? gr.label : "—"}
                    </span>
                    <span style={S(cellTxt(hot("quality") || (q >= 0 ? C.body : C.faint)))}>
                      {q >= 0 ? `${Math.min(100, q * 100).toFixed(1)}%` : "—"}
                      {q > 1.0005 ? <span style={S(`color:${C.bed}`)}>{"▴"}</span> : null}
                    </span>
                    {v ? (
                      <>
                        <span style={S(cellTxt(hot("loadSlip") || C.body))}>{pct(v.loadSlip)}</span>
                        <span style={S(cellTxt(hot("loadDist") || C.mute))}>{v.loadDist > 0 ? fmtLen(v.loadDist) : "—"}</span>
                        {fails(v.loadFail, v.loads, "loadFail")}
                        <span style={S(cellTxt(hot("unloadSlip") || C.body))}>{pct(v.unloadSlip)}</span>
                        <span style={S(cellTxt(hot("unloadDist") || C.mute))}>{v.unloadDist > 0 ? fmtLen(v.unloadDist) : "—"}</span>
                        {fails(v.unloadFail, v.unloads, "unloadFail")}
                        <span style={S(cellTxt(hot("pauses") || (v.pauses ? C.body : C.faint)))}>{v.pauses}</span>
                      </>
                    ) : (
                      [5, 6, 7, 8, 9, 10, 11].map(c => <span key={c} style={S(cellTxt(C.faint))}>—</span>)
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Panel>

      {/* refresh + what the numbers mean. The first column is the nav FAB's corner. */}
      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 250px minmax(0,1fr); gap:${L.gap}px; align-items:center`)}>
        <span />
        <PanelBtn label={inFlight ? "ASKING…" : "REFRESH"} sub={STATS_CMD} h={TAP.min}
          disabled={!!why || inFlight} why={why || undefined} onTap={refresh} />
        <div style={S("display:flex; flex-direction:column; justify-content:center; gap:3px; min-width:0")}>
          <span style={S(mono(F.label, `color:${statusColor}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{statusText}</span>
          <span style={S(mono(F.micro, `color:${C.faint}; line-height:1.25; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical`))}>
            {"SLIP = encoder shortfall per mm moved · FAILS n /m = n failed of m attempts (live: n only) · ▴ over 100 % = unload slip counted as gain · stats follow the gate, not the spool"}
          </span>
        </div>
      </div>
    </div>
  );
}
