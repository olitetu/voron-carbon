// ---------------------------------------------------------------------------
// HISTORY — Moonraker's job history on the panel: lifetime totals, a status filter, a scrollable job list with
// the real thumbnails, and one job's detail with REPRINT.
//
// ONE IMPLEMENTATION. Row normalisation, thumbnails, formatting, status colour/text, the status buckets
// (STATUS_TABS / statusGroup), a job's own materials (jobMaterials) and mass (jobMass) are src/lib/history.js,
// shared with the desktop HISTORY page; REPRINT is makeHistoryActions().reprint from
// src/lib/actions/history.js, which refuses while a print is active or Klipper is not ready.
//
// What the live printer returned when this was built (2026-09-23, read-only GETs, printer idle):
//   server.history.list limit=50  ~98 KB WITH metadata; the whole table (280 rows) is ~450 KB. So one page of
//                                 50 on mount/refresh, and LOAD OLDER fetches the next 50 on a tap. The reply's
//                                 `count` is the number of rows RETURNED, not stored, so "no more" is only
//                                 knowable from a short page.
//   server.history.totals         job_totals.total_jobs = 276 while 280 rows are stored: Moonraker's tally and
//                                 its table disagree, so JOBS is labelled as the tally and never presented as
//                                 the count of the list. There is no success count at all in job_totals, so
//                                 SUCCESS is computed over the LOADED rows and says how many that is.
//   job.status                    completed 216, cancelled 53, klippy_shutdown 8, interrupted 3 across all
//                                 rows. The chips are lib/history.js STATUS_TABS, bucketed by statusGroup as on
//                                 the desktop: DONE / CANCELLED (+ interrupted) / FAILED (error, klippy_shutdown,
//                                 klippy_disconnect, server_exit) / RUNNING (in_progress, only ever the current
//                                 job). A status Moonraker does not document is listed only under ALL.
//   job.exists                    false on 62 rows, and 33 of those share their filename with a file uploaded
//                                 AGAIN since (same name, different metadata uuid). A by-name reprint of such a
//                                 row would print a DIFFERENT file than the one this row records, so REPRINT
//                                 is refused for every exists:false row, not only the ones whose name is gone.
//   thumbnails                    .thumbs/<name>-32x32 / 48x48 / 300x300.png; 42 of 280 rows have none, and
//                                 thumbUrl() asks for nothing when the g-code is gone. The list takes the 48,
//                                 the detail the 300. They are RGBA with a transparent ground (vfa_ABS 48x48:
//                                 1713 of 2304 pixels alpha 0), so a placeholder label may only be mounted when
//                                 there is no image or it failed — "behind the image" shows straight through it.
//   filament_type                 both a JSON-array string and a semicolon list, 8 entries = one per TOOL of
//                                 the slicer profile, NOT per job: 20 of the newest 50 rows list "ABS + PC" or
//                                 "ABS + PLA" for a print whose referenced_tools is a single ABS tool. So the
//                                 material shown is jobMaterials(): the referenced_tools entries only.
//   auxiliary_data                only Spoolman's spool_ids, one entry per tool.
//   filenames                     contain spaces (even double spaces). REPRINT goes through api.startPrint =
//                                 printer.print.start with a JSON `filename`, never a g-code line, so
//                                 Klipper's whitespace splitting cannot touch it.
// Mass. Lifetime totals only have millimetres, so the FILAMENT tile is lib/history.js's PLA-density estimate
// (FIL_NOTE), marked "≈ … BY LENGTH". A JOB's FILAMENT is jobMass(): filament_used at that file's own slicer
// g/mm, which the PLA constant overstated by 19% here and which then contradicted the slicer grams the REPRINT
// confirm quotes. The PLA estimate only when the slicer gave none.
//
// Nothing is sent on render or mount: the only requests are the two read-only history reads above (on mount,
// on REFRESH, on LOAD OLDER, and on Moonraker's notify_history_changed, coalesced). The one command, REPRINT,
// goes through a confirm and is re-checked against the live state at the moment CONFIRM is tapped.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { microLabel } from "../vm.js";
import { Chip, Panel, PanelBtn, Empty, Thumb } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { useAsync } from "../../lib/useStore.js";
import { makeHistoryActions } from "../../lib/actions/history.js";
import {
  normalize, thumbUrl, fmtSpan, fmtLen, fmtMass, fmtAgo, fmtStamp, jobMass, jobMaterials, usedTools, numish,
  statusText, statusColor, isRunning, STATUS_TABS, statusGroup,
} from "../../lib/history.js";

const PAGE = 50;          // rows per fetch: ~98 KB with metadata on this printer
const ROW_H = 64;
const DASH = "—";
const PENDING = new Promise(() => {});   // not connected yet: keep useAsync loading instead of erroring

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const errText = e => (e && e.message ? e.message : String(e || "error"));

/** The dot + word the desktop table uses, in the panel's idiom. `bare` drops the box, for a panel header. */
function StatusTag({ status, bare }) {
  const col = statusColor(status);
  const box = bare ? "" : `padding:4px 9px; border-radius:${L.radiusXs}px; border:1px solid ${C.line3}; background:${C.panelSunk};`;
  return (
    <span style={S(`flex:none; display:inline-flex; align-items:center; gap:7px; ${box} ${mono(F.micro, `letter-spacing:.12em; line-height:1.2; color:${col}`)}; white-space:nowrap`)}>
      <span style={S(`width:7px; height:7px; border-radius:50%; background:${col}${isRunning(status) ? "; animation:ksPulse 1.6s ease-in-out infinite" : ""}`)} />
      {statusText(status)}
    </span>
  );
}

function Tile({ label, value, sub, color = C.text }) {
  return (
    <div style={S(panel("padding:7px 14px; gap:3px; justify-content:center"))}>
      <span style={S(`${microLabel(C.faint)}; line-height:1.15`)}>{label}</span>
      <span style={S(mono(F.num2, `line-height:1.15; color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{value}</span>
      <span style={S(mono(F.micro, `line-height:1.15; color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{sub || " "}</span>
    </div>
  );
}

export default function History({ st, api, act, go, say }) {
  const [tab, setTab] = React.useState("all");
  const [selKey, setSelKey] = React.useState("");
  const [confirm, setConfirm] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  // busyRef: the CONFIRM re-check must see a start already in flight, not the value captured when the dialog
  // rendered. alive: a reply (or reprint's settle after go("job")) must not land on an unmounted screen.
  const busyRef = React.useRef(false);
  const alive = React.useRef(true);

  // makeHistoryActions reads `store.state` at CALL time; a view over the latest render is all it needs. Its
  // log narrates intent as "info" and failures as warn/err, straight into the screen command log (act.log:
  // st.screenLog, and warn/err also toast), the same arrangement as the console screen.
  const stRef = React.useRef(st); stRef.current = st;
  const hist = React.useMemo(() => makeHistoryActions({
    api, store: { get state() { return stRef.current; } }, log: act.log,
  }), [api, act]);

  // ---- the feed: newest PAGE rows, extended by LOAD OLDER. A ticket drops any reply a newer request superseded.
  const [feed, setFeed] = React.useState({ jobs: [], done: false, loading: true, error: null, loaded: false });
  const feedRef = React.useRef(feed); feedRef.current = feed;
  const seq = React.useRef(0);
  // Bumping seq on unmount makes every in-flight history reply a stale one, so nothing lands after we are gone.
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; seq.current++; }; }, []);

  const fetchNewest = React.useCallback(() => {
    // Keep what the user already paged in: a refresh re-reads the same extent, not just the first page.
    const want = Math.max(PAGE, feedRef.current.jobs.length);
    const run = ++seq.current;
    setFeed(f => ({ ...f, loading: true, error: null }));
    api.historyList({ limit: want, start: 0, order: "desc" })
      .then(d => {
        if (run !== seq.current) return;
        const js = normalize(d);
        setFeed({ jobs: js, done: js.length < want, loading: false, error: null, loaded: true });
      })
      // A failed refresh keeps the rows already on screen and says so; it does not blank the list.
      .catch(e => { if (run === seq.current) setFeed(f => ({ ...f, loading: false, error: errText(e) })); });
  }, [api]);

  const loadOlder = React.useCallback(() => {
    const cur = feedRef.current;
    if (cur.loading || cur.done) return;
    const run = ++seq.current;
    setFeed(f => ({ ...f, loading: true, error: null }));
    api.historyList({ limit: PAGE, start: cur.jobs.length, order: "desc" })
      .then(d => {
        if (run !== seq.current) return;
        const js = normalize(d);
        // A job starting between two requests shifts every offset by one: drop rows already held.
        const prev = feedRef.current.jobs;
        const seen = new Set(prev.map(j => j.key));
        setFeed({ jobs: prev.concat(js.filter(j => !seen.has(j.key))), done: js.length < PAGE, loading: false, error: null, loaded: true });
      })
      .catch(e => { if (run === seq.current) setFeed(f => ({ ...f, loading: false, error: errText(e) })); });
  }, [api]);

  // Lifetime totals. main.jsx already fetched them once into st.historyTotals; that is the fallback while this
  // screen's own read is in flight or if it fails.
  const totalsQ = useAsync(() => (st.connected ? api.historyTotals() : PENDING), [st.connected]);

  // First load, and again whenever the socket comes back (an RPC issued while disconnected just rejects).
  React.useEffect(() => { if (st.connected) fetchNewest(); }, [st.connected, fetchNewest]);

  // Moonraker pushes notify_history_changed when a job starts AND when it finishes; coalesce into one re-read.
  const reloadTotals = totalsQ.reload;
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    let t = 0;
    const off = api.on("history", () => { clearTimeout(t); t = setTimeout(() => { fetchNewest(); reloadTotals(); }, 400); });
    return () => { clearTimeout(t); if (typeof off === "function") off(); };
  }, [api, fetchNewest, reloadTotals]);

  const refresh = () => { fetchNewest(); reloadTotals(); };

  // ---- derived -----------------------------------------------------------------------------------------
  const jobs = feed.jobs;
  const counts = React.useMemo(() => {
    const c = { all: jobs.length, completed: 0, cancelled: 0, failed: 0, in_progress: 0 };
    for (const j of jobs) { const g = statusGroup(j.status); if (g) c[g]++; }
    return c;
  }, [jobs]);
  const rows = React.useMemo(() => (tab === "all" ? jobs : jobs.filter(j => statusGroup(j.status) === tab)), [jobs, tab]);
  const sel = rows.find(j => j.key === selKey) || rows[0] || null;

  const jt = (totalsQ.data && totalsQ.data.job_totals) || st.historyTotals || null;
  const totalJobs = jt ? num(jt.total_jobs) : null;
  const printTime = jt ? num(jt.total_print_time) : null;
  const wallTime = jt ? num(jt.total_time) : null;
  const filament = jt ? num(jt.total_filament_used) : null;
  const longest = jt ? num(jt.longest_print) : null;
  // With no totals at all say why; when this screen's own read failed and the tiles show main.jsx's earlier
  // copy, say that too rather than presenting it as fresh.
  const totalsNote = jt ? "" : totalsQ.error ? "TOTALS UNAVAILABLE" : "READING TOTALS…";
  const jobsSub = !jt ? totalsNote : totalsQ.error && !totalsQ.data ? "CACHED · READ FAILED" : "LIFETIME TALLY";

  // An unfinished job has no outcome yet, so it is neither a success nor a failure.
  const rated = jobs.length - counts.in_progress;
  const rate = rated ? Math.round((counts.completed / rated) * 100) : null;
  const rateCol = rate === null ? C.text : rate >= 90 ? C.cool : rate >= 70 ? C.bed : C.accent;
  const scope = feed.done ? `ALL ${jobs.length} ROWS` : `NEWEST ${jobs.length}`;
  // The tile's sub has ~22 characters; "216 / 280 · ALL 280 ROWS" was cut, so the tile says ALL and the count
  // is already on its left.
  const rateScope = feed.done ? "ALL ROWS" : `NEWEST ${jobs.length}`;

  // ---- REPRINT guard: say why, in words, before the user taps -----------------------------------------------
  const why = job => {
    if (!job) return "no job selected";
    if (!job.name) return "no filename in this record";
    if (!job.exists) return "g-code no longer on disk";
    const b = act.blocked({ whilePrinting: false });
    if (b) return b;
    const s = stRef.current.raw || {};
    if (String((s.print_stats || {}).state || "") === "paused" || (s.pause_resume || {}).is_paused) return "a print is paused";
    if (busy || busyRef.current) return "starting…";
    return null;
  };
  const selWhy = why(sel);

  const askReprint = job => {
    const m = job.meta || {};
    const est = numish(m.estimated_time);
    const g = numish(m.filament_weight_total);
    const tools = usedTools(m);
    const mat = jobMaterials(m);
    setConfirm({
      label: "REPRINT", job,
      confirm: `Print ${job.base} again? The printer heats and starts immediately` +
        (est !== null || g !== null ? ` — slicer estimate ${est !== null ? fmtSpan(est) : DASH}, ${g !== null ? Math.round(g) + " g" : "weight unknown"}.` : ".") +
        // An MMU reprint pulls from whatever those tools map to NOW, not what this job used then.
        (tools.length ? ` Uses ${tools.map(t => "T" + t).join(" ")}${mat ? " (" + mat + ")" : ""} — check what is loaded for them.` : ""),
      cmd: `printer.print.start filename=${job.name}`,
    });
  };
  const runReprint = c => {
    const w = why(c.job);   // re-decided NOW: the printer may have started something while the dialog was up
    if (w) { act.refuse("REPRINT", w); return; }
    busyRef.current = true; setBusy(true);
    Promise.resolve(hist.reprint(c.job.name))
      // say is the shell's toast (safe after unmount); go only if the user is still here, never yank them back.
      .then(ok => { if (ok) { say("PRINTING " + c.job.base); if (alive.current) go("job"); } })
      .catch(() => { /* the action already logged it */ })
      .then(() => { busyRef.current = false; if (alive.current) setBusy(false); });
  };

  // ---- list body ------------------------------------------------------------------------------------------
  const fab = L.fab + L.fabInset;
  const tabLabel = (STATUS_TABS.find(t => t[0] === tab) || STATUS_TABS[0])[1];
  let body;
  if (!feed.loaded && feed.error) body = <Empty title="HISTORY UNAVAILABLE" hint={feed.error} />;
  else if (!feed.loaded) body = <Empty title={st.connected ? "LOADING HISTORY" : "WAITING FOR MOONRAKER"} hint="Reading server.history — the newest 50 jobs." />;
  else if (!jobs.length) body = <Empty title="NO PRINTS RECORDED" hint="Moonraker's job history is empty. Jobs appear here the moment a print starts." />;
  else {
    body = (
      <div className="scroll" style={S("flex:1; min-height:0; overflow-y:auto")}>
        {!rows.length ? (
          <div style={S("height:220px; display:flex")}>
            <Empty title={`NO ${tabLabel} JOBS`}
              hint={feed.done ? `None in all ${jobs.length} stored rows.` : `None among the newest ${jobs.length}. LOAD OLDER reads further back.`} />
          </div>
        ) : rows.map(j => {
          const on = sel && j.key === sel.key;
          const mat = jobMaterials(j.meta);
          return (
            <Hv as="div" key={j.key} onClick={() => setSelKey(j.key)} active={`background:${C.line1}`}
              style={`position:relative; height:${ROW_H}px; display:flex; align-items:center; gap:12px; padding:0 14px; border-bottom:1px solid ${C.line0}; cursor:pointer; content-visibility:auto; contain-intrinsic-size:auto ${ROW_H}px; background:${on ? C.rowOn : "transparent"}`}>
              <span style={S(`position:absolute; left:0; top:8px; bottom:8px; width:3px; border-radius:1px; background:${on ? C.accent : "transparent"}`)} />
              <Thumb url={thumbUrl(api, j, 46)} size={46} label={j.exists ? "GC" : "GONE"} />
              <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:3px")}>
                <span style={S(mono(F.body, `color:${on ? C.accent : j.exists ? C.text : C.dim}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{j.base || DASH}</span>
                <span style={S(mono(F.micro, `letter-spacing:.04em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                  {[fmtAgo(j.start), fmtSpan(j.dur), fmtLen(j.fil), mat, j.exists ? null : "G-CODE GONE"].filter(Boolean).join(" · ")}
                </span>
              </div>
              <StatusTag status={j.status} />
            </Hv>
          );
        })}
        <div style={S("padding:10px 14px 12px")}>
          {feed.done ? (
            <div style={S(`text-align:center; ${mono(F.micro, `letter-spacing:.16em; color:${C.ghost}`)}`)}>END OF HISTORY · {jobs.length} ROWS</div>
          ) : (
            <PanelBtn label={feed.loading ? "LOADING…" : `LOAD ${PAGE} OLDER`} h={TAP.min} disabled={feed.loading}
              why={feed.loading ? "a history read is already in flight" : undefined} onTap={loadOlder} />
          )}
        </div>
      </div>
    );
  }

  // ---- detail ---------------------------------------------------------------------------------------------
  const detail = sel ? (() => {
    const m = sel.meta || {};
    const est = numish(m.estimated_time);
    const tl = usedTools(m);
    const tools = tl.length ? tl.map(t => "T" + t).join(" ") : DASH;
    const spoolAux = (sel.aux || []).find(a => a && a.name === "spool_ids");
    const spools = spoolAux && Array.isArray(spoolAux.value)
      ? spoolAux.value.filter(v => v !== null && v !== undefined && v !== "").map(v => "#" + v).join(" ") : "";
    const fields = [
      ["PRINT TIME", fmtSpan(sel.dur)],
      ["WALL TIME", fmtSpan(sel.total)],
      ["SLICER EST", est === null ? DASH : fmtSpan(est)],
      ["FILAMENT", sel.fil === null ? DASH : `${fmtLen(sel.fil)} ≈ ${jobMass(sel.fil, m)}`],
      ["MATERIAL", jobMaterials(m) || DASH],
      ["TOOLS", tools],
      ["SPOOLS", spools || DASH],
      ["G-CODE", sel.exists ? "ON DISK" : "GONE", sel.exists ? C.body : C.bed],
    ];
    return (
      <Panel title="JOB" right={<StatusTag status={sel.status} bare />} style="min-height:0" bodyStyle="padding:10px 12px; gap:9px">
        <div style={S("flex:none; display:flex; gap:12px; min-width:0")}>
          <Thumb url={thumbUrl(api, sel, 88)} size={88} label={sel.exists ? "GC" : "GONE"} />
          <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:5px")}>
            <span style={S(`${mono(F.label, `color:${C.text}; line-height:1.3; word-break:break-word`)}; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden`)}>{sel.base || DASH}</span>
            <span style={S(mono(F.micro, `line-height:1.2; color:${C.dim}`))}>{fmtAgo(sel.start)}</span>
            <span style={S(mono(F.micro, `line-height:1.2; color:${C.faint}`))}>{sel.start === null ? DASH : fmtStamp(sel.start)}</span>
          </div>
        </div>
        <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:7px 12px")}>
          {fields.map(([k, v, col]) => (
            <div key={k} style={S("min-width:0; display:flex; flex-direction:column; gap:1px")}>
              <span style={S(mono(F.micro, `letter-spacing:.14em; line-height:1.2; color:${C.faint}`))}>{k}</span>
              <span style={S(mono(F.label, `line-height:1.2; color:${col || C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
            </div>
          ))}
        </div>
        <div style={S("margin-top:auto; flex:none")}>
          <PanelBtn label="REPRINT" tone="accent" h={TAP.primary} disabled={!!selWhy} why={selWhy || undefined}
            sub={selWhy ? String(selWhy).toUpperCase() : "START THIS FILE AGAIN"} onTap={() => askReprint(sel)} />
        </div>
      </Panel>
    );
  })() : (
    <div style={S(panel("min-height:0"))}>
      <Empty title="NO JOB" hint={!feed.loaded ? "Waiting for the history list." : jobs.length ? "Nothing to show for this filter." : "No job has been recorded yet."} />
    </div>
  );

  // ---- layout: totals / list + detail / FAB spacer + filter chips + refresh --------------------------------
  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      <div style={S(`flex:none; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:${L.gap}px`)}>
        <Tile label="JOBS" value={totalJobs === null ? DASH : String(Math.round(totalJobs))}
          sub={jobsSub} />
        <Tile label="PRINT TIME" value={fmtSpan(printTime)}
          sub={wallTime === null ? totalsNote : `${fmtSpan(wallTime)} WALL CLOCK`} />
        <Tile label="FILAMENT" value={fmtLen(filament)}
          sub={filament === null ? totalsNote : `≈ ${fmtMass(filament)} BY LENGTH`} />
        <Tile label="LONGEST" value={fmtSpan(longest)} sub={longest === null ? totalsNote : "SINGLE PRINT"} />
        <Tile label="SUCCESS" value={rate === null ? DASH : rate + "%"} color={rateCol}
          sub={rated ? `${counts.completed} / ${rated} · ${rateScope}` : feed.loaded ? "NO FINISHED JOBS" : ""} />
      </div>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 340px; grid-template-rows:minmax(0,1fr); gap:${L.gap}px`)}>
        <div style={S(panel("min-height:0; overflow:hidden"))}>{body}</div>
        {detail}
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:${fab}px repeat(5,minmax(0,1fr)) 150px 128px; gap:8px; align-items:center`)}>
        <span />
        {STATUS_TABS.map(([k, label]) => (
          <Chip key={k} label={label} sub={feed.loaded ? String(counts[k]) : DASH} on={tab === k} h={L.fab} fs={F.label}
            onTap={() => setTab(k)} />
        ))}
        <div style={S("min-width:0; display:flex; flex-direction:column; align-items:flex-end; gap:3px")}>
          <span style={S(mono(F.micro, `max-width:100%; letter-spacing:.12em; color:${feed.error ? C.accent : C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
            {feed.error ? (feed.loaded ? "REFRESH FAILED" : "READ FAILED") : feed.loading ? "LOADING…" : feed.loaded ? scope : DASH}
          </span>
          {/* A failed refresh keeps the old rows; the reason goes where "LOADED" sits, a panel has no tooltip. */}
          <span style={S(mono(F.micro, `max-width:100%; letter-spacing:.06em; color:${feed.error ? C.dim : C.ghost}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
            {feed.error ? feed.error : feed.loaded ? "LOADED" : ""}
          </span>
        </div>
        <PanelBtn label="REFRESH" h={L.fab} disabled={feed.loading || !st.connected}
          why={!st.connected ? "Moonraker is not connected" : feed.loading ? "a history read is already in flight" : undefined}
          sub={!st.connected ? "NOT CONNECTED" : undefined}
          onTap={refresh} />
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); runReprint(c); }} />
      ) : null}
    </div>
  );
}
