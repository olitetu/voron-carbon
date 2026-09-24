// ---------------------------------------------------------------------------
// CONSOLE — what Klipper said, and a line to answer it on.
//
// WHERE THE LINES COME FROM. Two sources, interleaved by time:
//   st.log       Moonraker's gcode_store (boot.js hydrates the newest 300 on every klippy-ready) plus live
//                notify_gcode_response, newest first, capped at 2000. Read from this printer: entries are
//                { message, time, type } with type "response" | "command". Commands ARE in the backlog
//                (G28, SMART_HOME, "MMU_CHECK_GATE GATE=5 QUIET=1", Spoolman's 850-char
//                `MMU_GATE_MAP MAP="{…}"` push) but the live socket carries RESPONSES ONLY, so a command sent
//                after hydration never reaches st.log until the next klippy-ready. Hydration only runs once
//                Klipper is ready, so a panel that boots into a shutdown has no backlog at all (said so).
//   st.screenLog The action layer's own record (actions.js run/guarded/refuse, from EVERY screen): the script
//                as "info" the moment it is sent, then "<CMD> ok", the error, or the refusal. act.run ALSO logs
//                "<CMD> is still running" as "info" for a long command past the 30 s rpc window — that one is
//                a status line, not an echo, and must not render as "› G28 is still running". After a
//                rehydrate gcode_store holds the same command again, so a panel echo within 5 s of an
//                identical gcode_store command is dropped. Both clocks are the Pi's (the kiosk runs on it).
//
// LINE RULES are the dashboard console's, imported, not re-written (adapters/console.js toLine/lineStyle):
// `// ` and `!! ` markers and Happy Hare's per-letter <span> HTML stripped, multi-line responses joined with
// " · ", M105 temperature reports dropped, kinds err / warn / ok / info, HH:MM stamps, the same colours.
// One change: rows WRAP instead of ellipsising — this panel has the width, and a cut-off error is useless.
// The HH banner and the Spoolman MAP push are 760-850 chars, so rows past 360 collapse behind "+N MORE".
//
// VIEW: ALL, QUIET and ERRORS (err + warn). QUIET hides the chatter the web console's HIDE NOISE toggle hides
// (adapters/console.js isChatter: Happy Hare sync-feedback and gear-current lines, probe reports, pressure_advance
// echoes — about half of what a print prints). CONTRACT's "hide // responses" hid far more: on this printer every
// Happy Hare answer is a // response ("Checking gate 5...", "Gate 5 marked EMPTY", "Tool T5 enabled" in the live
// gcode_store), so QUIET hid the very reply the console was opened for. Commands and errors are never hidden.
// FIND is a plain substring.
//
// SENDING. Nothing is sent on render or mount; every command comes from SEND or the keyboard's OK.
//   · Everything goes through act.guarded(line, {}). No whilePrinting guard: a console has to work mid-print
//     (M220, SET_PRESSURE_ADVANCE, MMU_STATUS). guarded still refuses — before Klipper sees it — when
//     Moonraker or Klipper is down, or when the command is not in the 371-command catalogue.
//   · WHICH COMMAND A LINE IS comes from Klipper's own parse (klippy/gcode.py _process_commands): drop the `;`
//     comment, upper-case, split on ([A-Z_]+|[A-Z*]), skip an N line number. A regex on the raw text is not
//     the same thing: `FIRMWARE_RESTART ;now` and `RESTART X` restart Klipper, and `M112S1` is an M112.
//   · M112, FIRMWARE_RESTART and RESTART (a single line) go to their Moonraker endpoints through the shared
//     makeConsoleActions (lib/actions/console.js), because printer.gcode.script is what a long macro or a
//     shutdown blocks, and FIRMWARE_RESTART is needed exactly while act.guarded refuses everything. None of
//     the three reads a parameter, so the bare name is what is handed over — then the lib's own patterns
//     route it, and none of them is copied here.
//   · Always confirmed: M112, FIRMWARE_RESTART, RESTART, SAVE_CONFIG (printer.cfg here has a SAVE_CONFIG
//     block, so configfile.py rewrites it and restarts even with nothing pending), SDCARD_RESET_FILE,
//     CANCEL_PRINT (and BASE_CANCEL_PRINT, the renamed original this printer also has), SDCARD_PRINT_FILE and
//     M24 (a print starts; M24 on a paused print bypasses the RESUME macro), and MMU_RESET (HH v3.4.2 wipes the
//     gate map, TTG map, endless-spool groups and stats with CONFIRM=1). Confirmed only while a print is
//     active: TURN_OFF_HEATERS, M84, M18 (the web console's rule) and the homing/levelling/stepper commands
//     that would wreck it (G28, G32, SMART_HOME, QUAD_GANTRY_LEVEL, BED_MESH_CALIBRATE, FORCE_MOVE,
//     SET_KINEMATIC_POSITION, SET_STEPPER_ENABLE). "Active" is isPrintActive() from actions/machine.js, which
//     releases the lock once Klipper is down.
//   · The loaded line is React state, NOT persisted: a line left loaded must never come back hours later
//     (or after a reboot) one stray tap on SEND away from running mid-print.
//   · RECENT is the shared `carbon.console.history` (loadHistory/pushHistory). The kiosk's Chromium profile
//     persists (~/.carbon-kiosk), so it survives reboots. A tap LOADS a line; SEND sends it. One tap never
//     resends an arbitrary G-code — it may be a G28. Only lines that were actually sent are added.
//   · The keyboard's first key REPLACES a seeded value (Keyboard.jsx `touched`); ⌫ first keeps it. The hint
//     says so, because editing a recalled line is the common case here. If the screen goes away while the
//     keyboard is open (HH's pause auto-opens RECOVER), OK sends nothing.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { help, klipperCommand } from "../../lib/caps.js";
import { makeConsoleActions } from "../../lib/actions/console.js";
import { isPrintActive } from "../../lib/actions/machine.js";
import { toLine, lineStyle, isChatter, loadHistory, pushHistory } from "../../pages/dashboard/adapters/console.js";
import { C, F, L, TAP, mono } from "../tokens.js";
import { job as jobVm, badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Chip, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";

const MAX_ROWS = 400;     // rows rendered; the view and FIND still run over everything the store holds
const DEDUPE_S = 5;       // a panel echo this close to an identical gcode_store command is the same send
const LONG = 360;         // characters shown before a row collapses behind "+N MORE"

// Sub-labels stay at 22 characters or fewer: the column body is 224px, and at the XL type scale F.micro is
// 15px, 9.9px per character with the .06em spacing, so 22 fit (217px). 25 and 26 were cut off from LARGE up.
const VIEWS = [
  ["all", "ALL", "ALL · NO TEMP REPORTS"],
  ["quiet", "QUIET", "NO SYNC/PROBE CHATTER"],
  ["errors", "ERRORS", "ERRORS + WARNINGS ONLY"],
];

const lost = c => (c.active ? ` A print is running (${c.file} · ${c.pct}) — it will be lost.` : "");
const running = c => `A print is running (${c.file} · ${c.pct})`;

/**
 * Lines worth one more tap, matched on Klipper's parsed command name. `endpoint` entries are handed to
 * makeConsoleActions (bare name, single line only), which sends them to that Moonraker endpoint.
 */
const DANGER = [
  { names: ["M112"], title: "EMERGENCY STOP", endpoint: "printer.emergency_stop",
    text: c => "Halt now: heaters and motors cut out and Klipper shuts down until a FIRMWARE_RESTART." + lost(c) },
  { names: ["FIRMWARE_RESTART"], title: "FIRMWARE RESTART", endpoint: "printer.firmware_restart",
    text: c => "Reset the MCUs and restart Klipper — the way out of a shutdown. It reconnects in a few seconds." + lost(c) },
  { names: ["RESTART"], title: "RESTART KLIPPER", endpoint: "printer.restart",
    text: c => "Restart the Klipper host and re-read every config file. It reconnects in a few seconds." + lost(c) },
  { names: ["SAVE_CONFIG"], title: "SAVE CONFIG",
    text: c => (c.pending
      ? "Write the pending calibration into printer.cfg, then restart Klipper."
      : "Nothing is pending (save_config_pending is false), but SAVE_CONFIG still rewrites printer.cfg's saved block and restarts Klipper.") + lost(c) },
  { names: ["SDCARD_RESET_FILE"], title: "RESET PRINT FILE",
    text: c => "Unload the loaded print file. Klipper stops the print if one is running." + lost(c) },
  { names: ["CANCEL_PRINT", "BASE_CANCEL_PRINT"], title: "CANCEL PRINT",
    text: c => (c.active ? `Cancel ${c.file} at ${c.pct}? This cannot be undone.` : `No print is running — ${c.head} will still run.`) },
  { names: ["SDCARD_PRINT_FILE"], title: "START PRINT",
    text: c => (c.active ? `${running(c)} — Klipper will answer "SD busy".` : "Load the file this line names and start printing it.") },
  { names: ["M24"], title: "START / RESUME SD FILE",
    text: c => (c.paused ? "The print is paused. M24 restarts reading the file directly, not through the RESUME macro."
      : c.active ? `${running(c)} — Klipper will answer "SD busy".`
      : c.loaded ? `Start printing ${c.loaded}, the file Klipper has loaded.`
      : "No SD file is loaded (virtual_sdcard.file_path is empty), so there is nothing to start.") },
  { names: ["MMU_RESET"], title: "RESET HAPPY HARE",
    text: c => (/(?:^|\s)CONFIRM=0*1(?:\s|;|$)/i.test(c.line)
      ? "Happy Hare forgets its persisted state: the gate map (spool, material, colour, temperature per gate), the tool-to-gate map, endless-spool groups and statistics go back to defaults."
      : "Without CONFIRM=1 Happy Hare only prints how to reset; nothing changes.") },
  { names: ["TURN_OFF_HEATERS", "M84", "M18"], whenActive: true, title: head => `${head} · PRINT RUNNING`,
    text: c => `${running(c)} — ${c.head === "TURN_OFF_HEATERS" ? "turning the heaters off" : "disabling the steppers"} ends it.` },
  { names: ["G28", "G32", "SMART_HOME", "QUAD_GANTRY_LEVEL", "BED_MESH_CALIBRATE", "FORCE_MOVE", "SET_KINEMATIC_POSITION", "SET_STEPPER_ENABLE"],
    whenActive: true, title: head => `${head} · PRINT RUNNING`,
    text: c => `${running(c)} — ${c.head} moves or re-references the toolhead in the middle of it.` },
];

const headOf = line => (String(line || "").trim().split(/\s+/)[0] || "").toUpperCase();
const physical = line => String(line || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);

/** The DANGER entry a script trips, testing every physical line, or null. */
function dangerOf(line, active) {
  const lines = physical(line);
  const cmds = lines.map(klipperCommand);
  for (const d of DANGER) {
    if (d.whenActive && !active) continue;
    const i = cmds.findIndex(n => d.names.includes(n));
    if (i >= 0) return { d, head: cmds[i], line: lines[i], endpoint: d.endpoint && lines.length === 1 ? d.endpoint : null };
  }
  return null;
}

// toLine is pure and st.log entries are stable objects (the store prepends, never rewrites), so each one is
// classified once. The panel's entries are mapped once per screenLog object for the same reason.
const lineCache = new WeakMap();
const panelCache = new WeakMap();
function lineOf(e) {
  if (!e || typeof e !== "object") return null;
  if (lineCache.has(e)) return lineCache.get(e);
  let l = null;
  try { l = toLine(e); } catch (err) { l = null; }
  lineCache.set(e, l);
  return l;
}
/** act.run's other 'info' line (actions.js): a long command outliving the 30 s rpc window. */
const STILL_RE = /^\S+ is still running$/;
/** screenLog { t (ms), message, kind } → the store's { time (s), message, type }. The script echo is 'info'. */
function fromPanel(p) {
  let e = panelCache.get(p);
  if (!e) {
    const message = String(p.message == null ? "" : p.message);
    const echo = p.kind === "info" && !STILL_RE.test(message);
    e = { time: Number(p.t) / 1000, message, type: echo ? "command" : p.kind || "info", panel: true };
    panelCache.set(p, e);
  }
  return e;
}

/** Two newest-first lists → one, dropping panel echoes that gcode_store already recorded. */
function mergeSources(log, panelLog) {
  const kl = Array.isArray(log) ? log : [];
  const pl = Array.isArray(panelLog) ? panelLog.filter(Boolean) : [];
  if (!pl.length) return kl;
  const sent = new Map();
  for (const e of kl) {
    if (!e || e.type !== "command") continue;
    const k = String(e.message == null ? "" : e.message).trim();
    if (!sent.has(k)) sent.set(k, []);
    sent.get(k).push(Number(e.time));
  }
  const mine = [];
  for (const p of pl) {
    const e = fromPanel(p);
    if (e.type === "command" && (sent.get(e.message.trim()) || []).some(t => Math.abs(t - e.time) < DEDUPE_S)) continue;
    mine.push(e);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < kl.length || j < mine.length) {
    if (j >= mine.length || (i < kl.length && Number((kl[i] || {}).time) >= mine[j].time)) out.push(kl[i++]);
    else out.push(mine[j++]);
  }
  return out;
}

/** Display rows, oldest first, plus how many lines exist and how many match. */
function buildRows(log, panelLog, view, find) {
  const src = mergeSources(log, panelLog);
  const f = find.trim().toLowerCase();
  const picked = [];
  let total = 0, matched = 0;
  for (const e of src) {
    const l = lineOf(e);
    if (!l) continue;
    total++;
    if (view === "errors" && l.kind !== "err" && l.kind !== "warn") continue;
    if (view === "quiet" && e.type !== "command" && l.kind !== "err" && isChatter(l.m)) continue;
    if (f && l.m.toLowerCase().indexOf(f) < 0) continue;
    matched++;
    if (picked.length < MAX_ROWS) picked.push([e, l]);
  }
  // Keys are numbered oldest-first: new lines arrive at the tail, so an existing row's key (and its
  // expanded state) does not shift when an identical line lands after it.
  const keys = new Map();
  const rows = picked.reverse().map(([e, l]) => {
    let key = `${e.time}|${l.m.length}|${l.m.slice(0, 24)}`;
    const n = keys.get(key) || 0;
    keys.set(key, n + 1);
    if (n) key += "#" + n;
    return { key, t: l.t, m: l.m, kind: l.kind, cmd: e.type === "command" };
  });
  return { rows, total, matched };
}

/** Memoised so the ~4 Hz status pushes that re-render the screen do not reconcile 400 rows. */
const LogRows = React.memo(function LogRows({ rows, open, onToggle }) {
  return rows.map(r => {
    const long = r.m.length > LONG;
    const isOpen = long && open.has(r.key);
    return (
      <div key={r.key} onClick={long ? () => onToggle(r.key) : undefined}
        style={S(`flex:none; display:flex; gap:10px; ${mono(F.label, "line-height:1.45")}; cursor:${long ? "pointer" : "default"}`)}>
        <span style={S(`flex:none; color:${C.mute}`)}>{r.t}</span>
        <span style={S(`${lineStyle(r.kind)}; white-space:normal; overflow-wrap:anywhere; text-overflow:clip${r.cmd ? `; color:${C.text}` : ""}`)}>
          {long && !isOpen ? r.m.slice(0, LONG) : r.m}
          {long ? <span style={S(`color:${C.faint}`)}>{isOpen ? "  ▴ LESS" : `  … +${r.m.length - LONG} MORE`}</span> : null}
        </span>
      </div>
    );
  });
});

export default function Console({ st, meta, api, act, say, askInput }) {
  // The loaded line lives in React state only (see the header): it dies with the screen, and a pending
  // confirm does too, so nothing can come back later already half-way to M112.
  const [draft, setDraft] = React.useState("");
  const [view, setView] = React.useState("all");
  const [find, setFind] = React.useState("");
  const [hist, setHist] = React.useState(loadHistory);
  const [confirm, setConfirm] = React.useState(null);
  const [open, setOpen] = React.useState(() => new Set());
  const [pinned, setPinned] = React.useState(true);
  const scrollRef = React.useRef(null);
  const pinRef = React.useRef(true);
  // The keyboard is awaited for seconds; the send decision must use the state at OK, not at the tap that opened it.
  const stRef = React.useRef(st);
  stRef.current = st;
  const metaRef = React.useRef(meta);
  metaRef.current = meta;
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // makeConsoleActions logs its intent and outcome through act.log (screen/actions.js), so the "› FIRMWARE_RESTART"
  // echo and the "restart requested" / estop lines land in st.screenLog, which this screen shows; main.jsx's log
  // also toasts the warnings and errors. The store is a live view for its error wording ("— Klipper is shutdown
  // (FIRMWARE_RESTART required)").
  const consoleAct = React.useMemo(
    () => makeConsoleActions({ api, log: act.log, store: { get state() { return stRef.current; } } }), [api, act]);

  // ---- scrollback -----------------------------------------------------------------------------------
  const { rows, total, matched } = React.useMemo(
    () => buildRows(st.log, st.screenLog, view, find), [st.log, st.screenLog, view, find]);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinRef.current) { el.scrollTop = el.scrollHeight; return; }
    // A narrower view can shrink the log until nothing scrolls; no scroll event fires for that.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) { pinRef.current = true; setPinned(true); }
  }, [rows]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atEnd === pinRef.current) return;
    pinRef.current = atEnd;
    setPinned(atEnd);
  };
  const follow = React.useCallback(() => {
    pinRef.current = true; setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const toggle = React.useCallback(key => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);

  // ---- quick-send history: newest first, one row per command -----------------------------------------
  const recent = React.useMemo(() => {
    const seen = new Set(), out = [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const k = hist[i].trim().toUpperCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(hist[i]);
    }
    return out;
  }, [hist]);

  // ---- sending --------------------------------------------------------------------------------------
  /** Why this line cannot go right now, or null. Endpoint lines only need Moonraker. */
  const whyNot = (line, hit, s) => (hit && hit.endpoint ? (s.connected ? null : "Moonraker is not connected") : act.blocked({}, line));

  const dispatch = (line, hit) => {
    if (!alive.current) return;
    // Re-checked here: the state can change under an open confirm. A refused line stays loaded and is not
    // added to RECENT.
    const why = whyNot(line, hit, stRef.current);
    if (why) { setDraft(line); act.refuse(hit ? hit.head : headOf(line), why); return; }
    pushHistory(line);                       // the shared writer: trims, collapses repeats, caps at HISTORY_MAX
    setHist(loadHistory());
    setDraft("");
    follow();                                // the answer lands at the tail
    if (hit && hit.endpoint) { consoleAct.sendConsole(hit.head); return; }
    // guarded checks once more at send time; if it still refuses, give the line back.
    Promise.resolve(act.guarded(line, {})).then(r => { if (r && r.refused && alive.current) setDraft(line); }).catch(() => {});
  };

  const trySend = raw => {
    const line = String(raw || "").trim();
    if (!line || !alive.current) return;
    const s = stRef.current;
    const active = isPrintActive(s);
    const hit = dangerOf(line, active);
    const why = whyNot(line, hit, s);
    // Refused lines stay loaded so a typo can be fixed; they are not added to RECENT.
    if (why) { setDraft(line); act.refuse(hit ? hit.head : headOf(line), why); return; }
    if (!hit) { dispatch(line, null); return; }
    const j = jobVm(s, metaRef.current);
    const vs = (s.raw || {}).virtual_sdcard || {};
    const c = { active, paused: active && j.paused, file: j.file || "the current job", pct: j.pctLabel, head: hit.head, line: hit.line,
      pending: !!((s.raw || {}).configfile || {}).save_config_pending,
      loaded: String(vs.file_path || "").replace(/^.*\//, "") };
    setConfirm({
      label: typeof hit.d.title === "function" ? hit.d.title(hit.head) : hit.d.title,
      confirm: hit.d.text(c),
      cmd: hit.endpoint ? `${hit.head}  →  ${hit.endpoint}` : line,
      line, hit,
    });
  };

  const type = async () => {
    const v = await askInput({ mode: "text", label: "G-CODE", value: draft, hint: draft ? "⌫ EDITS · OK SENDS" : "OK SENDS" });
    if (v === null) return;                  // CANCEL keeps whatever was loaded
    if (!alive.current) { say("Not sent — the console closed while the keyboard was open"); return; }
    const line = String(v).trim();
    setDraft(line);
    trySend(line);
  };

  const askFind = async () => {
    const v = await askInput({ mode: "text", label: "FIND", value: find, hint: "ANY PART OF A LINE" });
    if (v !== null && alive.current) setFind(String(v).trim());
  };

  // ---- the line's own status --------------------------------------------------------------------------
  const active = isPrintActive(st);
  const hit = draft.trim() ? dangerOf(draft, active) : null;
  const sendWhy = draft.trim() ? whyNot(draft, hit, st) : null;
  const stateWhy = act.blocked({});
  let metaText = "", metaCol = C.mute;
  if (sendWhy) { metaText = sendWhy; metaCol = C.bed; }
  else if (hit) { metaText = hit.endpoint ? `CONFIRMS · VIA ${hit.endpoint}` : "CONFIRMS FIRST"; metaCol = C.accent; }
  else if (draft.trim()) { metaText = help(st, klipperCommand(physical(draft)[0])) || ""; }
  else if (stateWhy) {
    metaText = st.connected ? `${stateWhy} — FIRMWARE_RESTART and RESTART work` : stateWhy;
    metaCol = C.bed;
  }

  const busy = Array.isArray(st.busy) ? st.busy : [];
  const viewDesc = (VIEWS.find(v => v[0] === view) || VIEWS[0])[2];

  let empty = null;
  if (!rows.length && !total) {
    empty = !st.connected
      ? { title: "NOT CONNECTED", hint: "The backlog comes from Moonraker's gcode_store once the socket is up." }
      : st.klippy !== "ready"
        ? { title: "NO BACKLOG YET", hint: `Klipper is ${st.klippy || "not ready"}. The gcode_store backlog is loaded when it reports ready.` }
        : { title: "NO OUTPUT YET", hint: "Klipper has said nothing since Moonraker started, and this panel has sent nothing." };
  } else if (!rows.length) {
    const narrowed = [view !== "all" ? `in ${view.toUpperCase()}` : "", find ? `containing “${find}”` : ""].filter(Boolean).join(" and ");
    const widen = [view !== "all" ? "ALL" : "", find ? "✕" : ""].filter(Boolean).join(" or ");
    empty = { title: "NOTHING MATCHES", hint: `${total} line${total === 1 ? "" : "s"}, none ${narrowed}. Tap ${widen} to widen.` };
  }

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 250px; gap:${L.gap}px`)}>

        <Panel title="CONSOLE" style="min-height:0" bodyStyle="position:relative"
          right={<>
            {busy.length ? <span style={S(badgeStyle("warn"))}>RUNNING {busy[0]}{busy.length > 1 ? ` +${busy.length - 1}` : ""}</span> : null}
            <span style={S(mono(F.micro, `letter-spacing:.12em; color:${C.faint}; white-space:nowrap`))}>
              {matched === total ? `${total} LINES` : `${matched} / ${total} LINES`}
            </span>
          </>}>
          <div ref={scrollRef} onScroll={onScroll} className="scroll"
            style={S("position:absolute; top:0; left:0; right:0; bottom:0; overflow-y:auto; padding:10px 14px")}>
            {/* A terminal fills from the bottom: free space goes above the rows, never below them. */}
            <div style={S("min-height:100%; display:flex; flex-direction:column; justify-content:flex-end; gap:3px")}>
              {matched > rows.length ? (
                <div style={S(`flex:none; padding-bottom:6px; ${mono(F.micro, `letter-spacing:.12em; color:${C.faint}`)}`)}>
                  ⋮ {matched - rows.length} EARLIER LINE{matched - rows.length === 1 ? "" : "S"} NOT SHOWN — FIND REACHES THEM
                </div>
              ) : null}
              {empty ? <Empty title={empty.title} hint={empty.hint} /> : <LogRows rows={rows} open={open} onToggle={toggle} />}
            </div>
          </div>
          {!pinned ? (
            <div style={S("position:absolute; right:14px; bottom:12px; width:170px; z-index:2")}>
              <PanelBtn label="↓ LATEST" sub="FOLLOWING PAUSED" tone="accent" h={TAP.primary} onTap={follow} />
            </div>
          ) : null}
        </Panel>

        <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
          <Panel style="flex:none; padding:11px 12px" bodyStyle="gap:8px">
            <span style={S(microLabel(C.faint))}>VIEW</span>
            <div style={S("display:flex; gap:7px")}>
              {VIEWS.map(([k, label]) => <Chip key={k} label={label} on={view === k} onTap={() => setView(k)} fs={F.label} />)}
            </div>
            <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{viewDesc}</span>
            {find ? (
              <div style={S(`display:grid; grid-template-columns:minmax(0,1fr) ${TAP.min}px; gap:7px`)}>
                <Chip label={`FIND “${find.length > 12 ? find.slice(0, 11) + "…" : find}”`} on onTap={askFind} fs={F.label} />
                <Chip label="✕" onTap={() => setFind("")} fs={F.label} />
              </div>
            ) : (
              // A row wrapper: Chip is `flex:1`, which in this column body would collapse its 48px height.
              <div style={S("display:flex")}><Chip label="FIND…" onTap={askFind} fs={F.label} /></div>
            )}
          </Panel>

          <Panel title="RECENT" style="flex:1; min-height:0"
            right={<span style={S(mono(F.micro, `color:${C.faint}`))}>{recent.length ? String(recent.length) : ""}</span>}>
            {recent.length ? (
              <div className="scroll" style={S("flex:1; min-height:0; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px")}>
                {recent.map(cmd => {
                  const on = cmd === draft;
                  return (
                    <Hv as="div" key={cmd} onClick={() => setDraft(cmd)} active={`background:${C.line1}`}
                      style={`flex:none; display:flex; align-items:center; height:${TAP.min}px; padding:0 12px; border-radius:${L.radiusSm}px; cursor:pointer; ${on
                        ? `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent};`
                        : `background:${C.panelHead}; border:1px solid ${C.line3}; color:${C.body};`}`}>
                      <span style={S(mono(F.label, "min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis"))}>
                        {cmd.replace(/\r?\n/g, " ⏎ ")}
                      </span>
                    </Hv>
                  );
                })}
              </div>
            ) : (
              <Empty title="NONE YET" hint="Lines sent from this panel collect here. A tap loads one; SEND sends it." />
            )}
          </Panel>
        </div>
      </div>

      {/* First column is the nav FAB's corner. */}
      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px minmax(0,1fr) 110px 170px; gap:${L.gap}px`)}>
        <span />
        <Hv as="div" onClick={type} active={`background:${C.line1}`}
          style={`display:flex; align-items:center; gap:12px; min-width:0; height:${TAP.primary}px; padding:0 16px; border-radius:${L.radiusSm}px; background:${C.panelSunk}; border:1px solid ${draft ? C.accentLine : C.line3}; cursor:pointer`}>
          <span style={S(mono(F.num2, `flex:none; line-height:1; color:${C.accent}`))}>›</span>
          {draft ? (
            <span style={S(mono(F.val, `flex:0 1 auto; min-width:0; color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
              {draft.replace(/\r?\n/g, " ⏎ ")}
            </span>
          ) : (
            <span style={S(mono(F.val, `flex:none; color:${C.faint}`))}>TAP TO TYPE G-CODE</span>
          )}
          <span style={S(mono(F.micro, `flex:1 1 0; min-width:60px; text-align:right; color:${metaCol}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
            {metaText}
          </span>
        </Hv>
        <PanelBtn label="CLEAR" sub={draft ? undefined : "EMPTY"} h={TAP.primary} disabled={!draft} why={draft ? undefined : "nothing is loaded"}
          onTap={() => setDraft("")} />
        <PanelBtn label={draft ? "SEND" : "TYPE…"} tone="accent" h={TAP.primary}
          sub={sendWhy ? "BLOCKED" : hit ? "CONFIRMS" : undefined}
          disabled={!!sendWhy} why={sendWhy || undefined}
          onTap={() => (draft ? trySend(draft) : type())} />
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); dispatch(c.line, c.hit); }} />
      ) : null}
    </div>
  );
}
