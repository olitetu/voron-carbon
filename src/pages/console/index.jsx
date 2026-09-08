// CONSOLE page — the full-height terminal the dashboard's 12-line panel cannot be.
//
// Everything that matters is SHARED with that panel: the same scrollback (store.log, newest first —
// see boot.js), the same send path (src/lib/actions/console.js, which routes M112 / FIRMWARE_RESTART /
// RESTART to their dedicated Moonraker endpoints so they still work when the gcode queue is wedged),
// the same message cleaning (dashboard/adapters/console.js) and the same ↑/↓ history — recall goes
// through the adapter's own loadHistory/pushHistory (`carbon.console.history`) on every keypress
// rather than a snapshot, so a line sent from the dashboard panel is recallable here immediately.
//
// What is page-only: multi-line entries stay multi-line (the panel joins them with " · " to fit one
// row), a search box, a noise toggle, completion over the whole 367-command catalogue via caps.js
// (st.macros is a subset that drops `_`-prefixed macros, every native and every Happy Hare command),
// and a confirm strip in front of the handful of commands that end a running print.
import React from "react";
import { Panel, Btn, Chip, Label, Row, Input, Toggle, Confirm, T, mono } from "../../lib/design.jsx";
import { S, Hv } from "../../lib/ui.js";
import { useStore, usePersisted } from "../../lib/useStore.js";
import { allCommands, help } from "../../lib/caps.js";
import { makeConsoleActions } from "../../lib/actions/console.js";
import { stripHtml, classify, KIND_COLOR, loadHistory, pushHistory } from "../dashboard/adapters/console.js";

const MAX_ROWS = 500;      // rows actually rendered; the filter still runs over all 2000 the store keeps
const MAX_SUGGEST = 10;
const PLACEHOLDER = "send code… (try G28, PREHEAT, MMU_LOAD)";   // the design's, verbatim

// What the noise toggle hides. Measured on 1000 consecutive gcode_store entries from this printer
// while it printed:  231 `// MmuSyncFeedbackManager: …` · 124 gear-current lines that follow it ·
// 59 M105 answers (`B:105.1 /105.0 T0:251.2 /250.0`) · 43 `// probe at …` — 46% of everything Klipper
// said. Commands and errors are never hidden, whatever they look like.
const NOISE_RE = new RegExp([
  "^(?:ok\\s+)?[BCT]\\d*:\\s*-?\\d",                              // M105 answer / temperature auto-report
  "^MmuSyncFeedbackManager:",                                     // Happy Hare sync-feedback chatter
  "^(?:Modifying|Restoring) MMU stepper_mmu_gear run current",     // …and the current changes it makes
  "^Run Current:",
  "^probe at ",                                                   // QGL + bed mesh probe reports
  "^pressure_advance:",
].join("|"), "i");

// Nothing typed here is ever refused — a console that argues is useless — but two shapes of command
// are worth one extra keystroke. M112 always: Klipper halts mid-motion and only FIRMWARE_RESTART
// brings it back. The job-killers only while a print is actually running, which is exactly when a
// fat-fingered line costs eight hours. Every physical line is tested, so a pasted script cannot
// smuggle one past the gate.
const ESTOP_RE = /^M112\b/i;
const KILL_RE = /^(?:CANCEL_PRINT|RESTART|FIRMWARE_RESTART|TURN_OFF_HEATERS|SDCARD_RESET_FILE|M84|M18)\b/i;
/** First line of `s` that matches `re`, or null — the strip names the offending line, not line one. */
const hit = (re, s) => s.split(/\r?\n/).map(l => l.trim()).find(l => re.test(l)) || null;
/** Its command word, so the button reads SEND CANCEL_PRINT rather than a bare SEND. */
const head = line => (String(line).split(/\s+/)[0] || "").toUpperCase().slice(0, 24);

/** HH:MM:SS — the dashboard column is HH:MM to save width; a full-height terminal can afford seconds. */
function stamp(t) {
  let n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return "--:--:--";
  if (n > 1e12) n = n / 1000;                                     // tolerate ms timestamps
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = x => String(x).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/**
 * One store entry → { t, text, kind }, or null when there is nothing to show.
 *
 * Cleaning runs per PHYSICAL line (each line of a multi-line response carries its own `// ` / `!! `
 * marker, and Happy Hare wraps its words in <span>/<b>), but whitespace is deliberately NOT collapsed:
 * MMU_STATUS and the gate map are space-aligned tables and only survive in a pre-wrap mono column.
 */
function toRow(entry) {
  if (!entry || typeof entry !== "object") return null;
  const raw = String(entry.message == null ? "" : entry.message);
  const type = String(entry.type || "").toLowerCase();
  const text = raw.split(/\r?\n/)
    .map(l => stripHtml(l.replace(/^\s*(\/\/|!!)\s?/, "").replace(/^echo:\s?/i, "")).replace(/\s+$/, ""))
    .join("\n").replace(/^\n+|\n+$/g, "");
  if (!text.trim()) return null;
  const kind = type === "command" ? "command" : /^\s*echo:/i.test(raw) ? "echo" : classify(entry, text);
  return { t: stamp(entry.time), text, kind };
}

/** command → accent, err/warn/ok → the dashboard's palette, `echo:` → muted, `//` → dim, response → body. */
function lineColor(kind) {
  if (kind === "command") return T.accent;
  if (KIND_COLOR[kind]) return KIND_COLOR[kind];
  return kind === "echo" ? T.mute : kind === "info" ? T.dim : T.body;
}

// flex:none — the rows are flex items of the bottom-aligned column below and a tall MMU_STATUS table
// must never be squeezed to make the block fit.
const ROW_STYLE = `display:flex; flex:none; gap:10px; ${mono(10.5, "line-height:1.5")}`;
// T.ghost measured 2.0:1 against the panel — the stamp is data (when a line landed), not decoration,
// so it sits at T.mute (4.1:1) like the temps labels that were lifted for the same reason.
const TIME_STYLE = `color:${T.mute}; flex:none`;

export default function Page({ store, api }) {
  const st = useStore(store);

  // Orca reloads the Device tab under the user constantly — an unsent line, the filter and the toggle
  // all have to come back from localStorage rather than living in React state.
  const [draftV, setDraft] = usePersisted("console.draft", "");
  const [filterV, setFilter] = usePersisted("console.filter", "");
  const [hideNoise, setHideNoise] = usePersisted("console.hideNoise", true);
  // localStorage can hand back whatever an older build (or another client) wrote under these keys.
  const draft = typeof draftV === "string" ? draftV : "";
  const filter = typeof filterV === "string" ? filterV : "";

  const [histIdx, setHistIdx] = React.useState(null);   // index into the stored history while recalling; null = editing
  const [sel, setSel] = React.useState(-1);             // highlighted suggestion; -1 = the typed text
  const [dismissed, setDismissed] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [pinned, setPinned] = React.useState(true);     // tail-following; paused while scrolled up
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [pending, setPending] = React.useState(null);   // command awaiting a confirm strip; NOT persisted —
                                                        // a reload must drop it, never resurrect an M112

  const inputRef = React.useRef(null);
  const scrollRef = React.useRef(null);
  const pinRef = React.useRef(true);                    // read by the layout effect, which runs before state settles
  const draftRef = React.useRef("");                    // the unsent line, restored when recall walks past the newest

  /** Adds a UI line to the shared log — same shape and cap as DashboardLogic.log(). */
  const log = React.useCallback((message, kind) => {
    let msg = String(message), type = kind || "info";
    // actions/console.js echoes the sent line as the design's `› G28` info line. Store it as a real
    // 'command' entry instead — with the arrow stripped it is indistinguishable from the command
    // entries Moonraker's own gcode_store returns, so it colours right here and on the dashboard.
    if (type === "info" && msg.startsWith("›")) { msg = msg.replace(/^›\s*/, ""); type = "command"; }
    const entry = { time: Date.now() / 1000, message: msg, type, local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }, [store]);

  const act = React.useMemo(() => makeConsoleActions({ api, store, log }), [api, store, log]);

  // Same live-job test the machine page gates its destructive actions on (print_stats.state alone is
  // "paused" for a Happy Hare pause, but pause_resume is the one that survives a UI reconnect).
  const job = (st.raw && st.raw.print_stats) || {};
  const printing = job.state === "printing" || job.state === "paused" || !!((st.raw && st.raw.pause_resume) || {}).is_paused;

  // ---- scrollback ---------------------------------------------------------------------------------
  const { rows, shown, total } = React.useMemo(() => {
    const src = Array.isArray(st.log) ? st.log : [];
    const f = filter.trim().toLowerCase();
    const out = [];
    let seen = 0;
    for (let i = src.length - 1; i >= 0; i--) {          // store is newest first; a terminal reads bottom-up
      let r = null;
      try { r = toRow(src[i]); } catch { r = null; }
      if (!r) continue;
      seen++;
      if (hideNoise && r.kind !== "command" && r.kind !== "err" && NOISE_RE.test(r.text)) continue;
      if (f && r.text.toLowerCase().indexOf(f) < 0) continue;
      out.push(r);
    }
    return { rows: out.length > MAX_ROWS ? out.slice(-MAX_ROWS) : out, shown: out.length, total: seen };
  }, [st.log, filter, hideNoise]);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinRef.current) { el.scrollTop = el.scrollHeight; return; }
    // Turning the noise toggle on, or typing a filter, can shrink the content until there is nothing
    // left to scroll. No scroll event fires for that, so without this the page stays "paused" forever:
    // ↓ LATEST hangs in a pane that cannot scroll and new lines stop following the tail.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) { pinRef.current = true; setPinned(true); }
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atEnd === pinRef.current) return;
    pinRef.current = atEnd;
    setPinned(atEnd);
  };
  const jump = () => { pinRef.current = true; setPinned(true); const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; };

  // ---- completion ---------------------------------------------------------------------------------
  // Only the command NAME completes: arguments are not in the catalogue, so a line with whitespace
  // closes the list instead of offering nonsense.
  const token = draft.trim();
  // The TRAILING space matters and trim() used to eat it: after Tab completes "MMU_CHECK_GATE " the
  // user has moved on to arguments, but the list stayed open on the 45 catalogue names that are a
  // prefix of another (G28, MMU_LOAD, PROBE, CANCEL_PRINT…) and then swallowed the ↑/↓ keys.
  const naming = !!token && !/\s/.test(token) && !/\s$/.test(draft);
  const commands = React.useMemo(() => allCommands(st), [st.commands]);
  const suggestions = React.useMemo(() => {
    if (!naming) return [];
    const t = token.toUpperCase();
    const starts = [], contains = [];
    for (const n of commands) {
      if (n === t) continue;                             // nothing left to complete
      if (n.startsWith(t)) starts.push(n);
      else if (n.indexOf(t) >= 0) contains.push(n);
    }
    return starts.concat(contains).slice(0, MAX_SUGGEST);
  }, [commands, token, naming]);
  const open = focused && !dismissed && suggestions.length > 0;
  const exactHelp = token && !/\s/.test(token) ? help(st, token) : null;

  const caretToEnd = () => requestAnimationFrame(() => {
    const el = inputRef.current;
    if (el) { try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* not selectable */ } }
  });
  const complete = name => {
    if (!name) return;                                 // the list can shrink under a stale `sel` (catalogue reload)
    setDraft(name + " "); setSel(-1); setDismissed(false);
    const el = inputRef.current; if (el) el.focus();
    caretToEnd();
  };

  /** dir -1 = older (ArrowUp), +1 = newer; walking past the newest entry restores the unsent draft. */
  const recall = dir => {
    const items = loadHistory();                       // read through on every press: the dashboard's console
    if (!items.length) return;                         // panel writes this same key while this page is alive
    let idx = histIdx;
    if (idx === null) { if (dir > 0) return; draftRef.current = draft; idx = items.length; }
    const next = idx + dir;
    if (next < 0) return;
    if (next >= items.length) { setHistIdx(null); setDraft(draftRef.current || ""); }
    else { setHistIdx(next); setDraft(items[next]); }
    // A recalled line is a whole command, so the completion list must not re-open over it: leaving it
    // open handed the NEXT ↑ to the suggestion list, stranding recall one entry deep (and a following
    // Enter then sent the highlighted neighbour — MMU_CHECK_GATES for a recalled MMU_CHECK_GATE).
    // Typing anything clears `dismissed` again, so completion is only suspended while recalling.
    setDismissed(true); setSel(-1);
    caretToEnd();
  };

  const dispatch = v => {
    pushHistory(v);                                      // the adapter's own writer: loads, dedupes, caps, saves
    setPending(null); setDraft(""); setHistIdx(null); setSel(-1); setDismissed(false);
    jump();                                              // sending always takes you back to the tail
    Promise.resolve(act.sendConsole(v)).catch(() => {}); // sendConsole logs its own failures, never throws
  };

  const send = text => {
    const v = String(text || "").trim();
    if (!v) return;
    const stop = hit(ESTOP_RE, v), kill = printing ? hit(KILL_RE, v) : null;
    // The draft is deliberately left alone while the strip is up, so CANCEL gives the line back.
    if (stop || kill) { setConfirmClear(false); setPending({ v, estop: !!stop, name: head(stop || kill) }); return; }
    dispatch(v);
  };

  const onKeyDown = e => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (open) setDismissed(true);
      else { setDraft(""); setHistIdx(null); }
      return;
    }
    if (e.key === "Tab" && open) { e.preventDefault(); complete(suggestions[Math.max(0, sel)]); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      if (!open) { recall(dir); return; }
      const next = sel + dir;                            // wraps through -1, which restores the typed text
      setSel(next < -1 ? suggestions.length - 1 : next >= suggestions.length ? -1 : next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && sel >= 0) complete(suggestions[sel]); else send(draft);
    }
  };

  const clearLog = () => {
    setConfirmClear(false);
    store.set({ log: [] });
    log("Console cleared — Klipper's own log is untouched", "info");
  };

  React.useEffect(() => { const el = inputRef.current; if (el) el.focus(); }, []);

  // ---- connection banner --------------------------------------------------------------------------
  const klippy = st.klippy || "unknown";
  const offline = !st.connected;
  const bad = offline || klippy !== "ready";
  const severe = offline || klippy === "shutdown" || klippy === "error";
  const bannerC = severe ? T.err : T.warn;
  const webhooks = (st.raw && st.raw.webhooks) || {};
  const bannerMsg = offline
    ? "Reconnecting to Moonraker — commands cannot be sent."
    : (webhooks.state_message || "").trim() ||
      (klippy === "shutdown" ? "Klipper is shut down. FIRMWARE_RESTART below goes straight to the restart endpoint."
        : "Waiting for Klipper to report ready.");

  const banner = bad ? (
    <div style={S(`display:flex; align-items:center; gap:12px; padding:9px 12px; border:1px solid ${severe ? "#4a1d13" : "#3a2f14"}; border-radius:6px; background:${severe ? "#1a0c08" : "#14100a"}`)}>
      <Chip color={bannerC} border={severe ? "#4a1d13" : "#3a2f14"} bg="transparent" pulse>
        {offline ? "MOONRAKER OFFLINE" : "KLIPPY " + String(klippy).toUpperCase()}
      </Chip>
      <div style={S(`flex:1; min-width:0; font-size:12px; color:${T.body}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{bannerMsg}</div>
    </div>
  ) : null;

  const controls = <>
    {st.commandsStale &&
      <div title="Klipper dropped its command handlers; showing the last catalogue seen while it was ready">
        <Chip color={T.warn} border="#3a2f14" bg="#14100a">CATALOGUE STALE</Chip>
      </div>}
    <Chip color={T.mute}>{shown} / {total} LINES</Chip>
    <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter…"
      onKeyDown={e => { if (e.key === "Escape") setFilter(""); }} style="width:150px" />
    <div title="Hides temperature reports, Happy Hare sync-feedback chatter, gear-current lines and probe reports">
      <Row gap={6}><Label>HIDE NOISE</Label><Toggle on={hideNoise} onClick={() => setHideNoise(v => !v)} /></Row>
    </div>
    <Btn small disabled={!total} onClick={() => { setPending(null); setConfirmClear(true); }}>CLEAR</Btn>
  </>;

  return <div style={S(`flex:1; display:grid; gap:10px; padding:10px; min-height:0; grid-template-columns:1fr; grid-template-rows:${banner ? "auto minmax(0,1fr)" : "minmax(0,1fr)"}`)}>
    {banner}
    <Panel title="CONSOLE" accent={T.dim} right={controls} flat bodyStyle="display:flex; flex-direction:column" style="min-height:0">

      {/*
        The scroller is taken OUT OF FLOW on purpose. The shell is `min-height:100vh` and its <main>
        is a flex item with the default `min-height:auto` (adapters/shell.js mainStyle), so an in-flow
        scrollback taller than the viewport pushed the whole column open instead of scrolling inside
        it: measured at 714 lines the page grew to 11 649 px, the input row sat at y=11 586 in a 900 px
        viewport and ↓ LATEST could never appear. Absolute means the log contributes no height at all,
        so the panel is sized by the viewport whatever the shell does.
      */}
      <div style={S("position:relative; flex:1; min-height:0")}>
        <div ref={scrollRef} onScroll={onScroll} style={S("position:absolute; top:0; left:0; right:0; bottom:0; overflow-y:auto; padding:10px 12px")}>
          {/* A terminal fills from the bottom: a short log belongs above the prompt, not stranded at
              the top of an empty pane. Free space goes above the rows, never below them. */}
          <div style={S("min-height:100%; display:flex; flex-direction:column; justify-content:flex-end")}>
            {shown > rows.length &&
              <div style={S(`${mono(9, `color:${T.mute}; letter-spacing:.1em`)}; padding-bottom:6px; flex:none`)}>
                ⋮ {shown - rows.length} EARLIER LINE{shown - rows.length === 1 ? "" : "S"} NOT RENDERED
              </div>}
            {rows.length === 0 &&
              <div style={S(`margin:auto 0; padding:40px 0; text-align:center; ${mono(10, `color:${T.mute}; letter-spacing:.22em`)}`)}>
                {offline ? "NOT CONNECTED TO MOONRAKER" : filter.trim() ? "NO LINES MATCH THE FILTER" : total ? "EVERY LINE IS FILTERED OUT" : "NO OUTPUT YET"}
              </div>}
            {rows.map((r, i) =>
              <div key={i} style={S(ROW_STYLE)}>
                <span style={S(TIME_STYLE)}>{r.t}</span>
                <span style={S(`min-width:0; white-space:pre-wrap; word-break:break-word; color:${lineColor(r.kind)}`)}>
                  {r.kind === "command" ? "› " + r.text : r.text}
                </span>
              </div>)}
          </div>
        </div>
        {!pinned &&
          <div style={S("position:absolute; right:16px; bottom:10px; z-index:5")}>
            <Btn small kind="accent" onClick={jump} title="Auto-scroll is paused while you are scrolled up">↓ LATEST</Btn>
          </div>}
      </div>

      {pending
        ? <Confirm
          text={pending.estop
            ? "M112 — emergency stop. Klipper halts where it stands and only FIRMWARE_RESTART brings it back"
              + (printing ? "; the print is lost." : ".")
            : `A print is running${job.filename ? " (" + job.filename + ")" : ""} — ${pending.name} ends it. Send it anyway?`}
          yes={"SEND " + pending.name}
          onYes={() => { const p = pending; setPending(null); dispatch(p.v); }}
          onNo={() => setPending(null)} />
        : confirmClear && <Confirm text="Clear the console scrollback? Klipper's own log is not affected — a reload brings it back."
          onYes={clearLog} onNo={() => setConfirmClear(false)} yes="CLEAR CONSOLE" />}

      <div style={S(`flex:none; position:relative; padding:10px 12px; border-top:1px solid ${T.line}`)}>
        {open &&
          <div style={S(`position:absolute; left:12px; right:12px; bottom:100%; margin-bottom:6px; z-index:20; border:1px solid ${T.line}; border-radius:5px; background:${T.panel}; overflow:hidden`)}>
            {suggestions.map((n, i) =>
              // onMouseDown, not onClick: the input blurs first otherwise and the list is gone before the click lands.
              <Hv key={n} as="div" onMouseDown={e => { e.preventDefault(); complete(n); }} onMouseEnter={() => setSel(i)}
                style={`display:flex; align-items:baseline; gap:10px; padding:5px 9px; cursor:pointer; border-left:2px solid ${i === sel ? T.accent : "transparent"}; background:${i === sel ? T.panel3 : "transparent"}`}
                hover={`background:${T.panel3}`}>
                <span style={S(mono(11, `color:${i === sel ? T.text : T.body}; flex:none`))}>{n}</span>
                <span style={S(mono(9, `color:${T.mute}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`))}>{help(st, n) || ""}</span>
              </Hv>)}
          </div>}

        <div style={S(`display:flex; align-items:center; gap:8px; background:${T.panel}; border:1px solid ${open ? T.line2 : T.line}; border-radius:4px; padding:7px 10px`)}>
          <span style={S(mono(11, `color:${T.accent}`))}>›</span>
          <input ref={inputRef} type="text" value={draft} placeholder={PLACEHOLDER} spellCheck="false" autoComplete="off"
            onChange={e => {
              // Editing the line drops a pending confirm: the strip names the command as it was typed.
              setDraft(e.target.value); setPending(null); setHistIdx(null); setSel(-1); setDismissed(false);
            }}
            onKeyDown={onKeyDown} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            style={S(`flex:1; min-width:0; background:transparent; border:0; outline:none; ${mono(11, `color:${T.body}`)}`)} />
          <span style={S(`width:6px; height:13px; background:${T.accent}; animation:vBlink 1.1s steps(1) infinite`)} />
        </div>

        <Row gap={12} style="margin-top:6px">
          <Label>↑↓ HISTORY · TAB COMPLETE · ESC DISMISS</Label>
          <div style={S(`margin-left:auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${mono(9, `color:${exactHelp ? T.dim : T.faint}`)}`)}>
            {exactHelp || (commands.length ? commands.length + " COMMANDS" : "CATALOGUE NOT LOADED")}
          </div>
        </Row>
      </div>
    </Panel>
  </div>;
}
