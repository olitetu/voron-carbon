// Dashboard "CONSOLE" panel adapter — view-model keys derived from live store data.
//
// Source of lines: st.log — Moonraker's gcode_store hydrated at boot + live notify_gcode_response (src/lib/boot.js),
// newest first, entries { time (epoch s), message, type: 'command'|'response'|'error' } — plus the UI lines the host
// appends through ctx.log(msg, kind) (same shape with type = 'info'|'ok'|'warn'|'err', or the design's { t, m, kind }).
// Style strings are copied VERBATIM from src/pages/dashboard/logic.jsx renderVals(); only the data source changed.
//
// Keys returned (CONSOLE section of tools/panel-keys.json minus the macro-picker keys, which the macros adapter owns):
//   logLines, sendConsole, toggleConsole, consoleArrow, consoleArrowStyle, consoleBodyStyle, clock
//
// Line rules (CONTRACT "Console"): kind 'err' when type==='error' or the message starts with `!!`; 'info' when it starts
// with `//`; commands plain; 'ok' for lines containing complete|success|ready; time HH:MM from `time`; the `// ` / `!! `
// markers and HTML tags (Happy Hare wraps its output in <span>/<b>) are stripped. 12 lines collapsed, 40 expanded.

// ---- design constants (verbatim) -------------------------------------------------------------------------------
export const KIND_COLOR = { ok: "#3ddcc4", warn: "#f0b429", err: "#ff5a33" };
const LINE_STYLE = "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:";
const COLLAPSED_LINES = 12;
const EXPANDED_LINES = 40;
// One row is 10.5px mono at line-height 1.5 (15.75 px) plus the list's 3 px gap. The collapsed box used to be
// a flat 112 px, which is SIX rows: half of the twelve lines collected here were rendered into the DOM and then
// clipped away by overflow:hidden. The height follows the line count so the panel shows what it collects.
const ROW_PX = 19;
const COLLAPSED_PX = COLLAPSED_LINES * ROW_PX;   // 228
const EXPANDED_PX = 1100;

/** The design's per-line style: `{ok,warn,err}[kind] || "#8b98aa"` (info and plain lines share the grey). */
export function lineStyle(kind) { return LINE_STYLE + (KIND_COLOR[kind] || "#8b98aa"); }

// ---- classification --------------------------------------------------------------------------------------------
// How far into st.log (capped at 2000 by boot.appendLog) we look for displayable lines when noise is skipped.
const SCAN_MAX = 600;
const OK_RE = /complete|success|ready/i;
// Never paint a failure report teal just because it mentions "complete"/"ready" ("Unable to complete…", "Printer is not ready").
const NOT_OK_RE = /not ready|isn'?t ready|is not ready|fail|error|abort|cancel|unable|cannot|can'?t|timed? ?out|incomplete|unsuccess/i;
const WARN_RE = /\bwarn(ing)?\b/i;
// M105 answers / temperature auto-reports ("ok B:60.0 /60.0 T0:245.1 /245.0 …", "B:59.9 /60.0") — pure noise in a 12-line panel.
const TEMP_NOISE_RE = /^(ok\s+)?(B|C|T\d*):\s*-?\d+(\.\d+)?\s*\/\s*-?\d+/i;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Strip HTML tags (Happy Hare emits <span style=…>/<b>) and decode the common entities. */
export function stripHtml(s) {
  return String(s == null ? "" : s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?p\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k[0] === "#") {
        const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[k] !== undefined ? ENTITIES[k] : m;
    });
}

/**
 * Klipper/Moonraker message → one clean display line. Every physical line of a multi-line response (MMU_STATUS tables,
 * the Happy Hare banner) carries its own `// ` marker: strip the marker, `echo:` noise and HTML per line, collapse
 * whitespace, then join the lines with the design's " · " separator so the entry stays a single ellipsised row.
 */
export function cleanMessage(raw) {
  const parts = String(raw == null ? "" : raw).split(/\r?\n/).map(l =>
    stripHtml(l.replace(/^\s*(\/\/|!!)\s?/, "").replace(/^echo:\s*/i, "")).replace(/\s+/g, " ").trim()
  ).filter(Boolean);
  return parts.join(" · ");
}

/** Epoch seconds (or ms) → local HH:MM (zero-padded so the time column stays aligned in the mono grid). */
export function fmtLogTime(t) {
  let n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return "--:--";
  if (n > 1e12) n = n / 1000; // tolerate ms timestamps
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "--:--";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/**
 * Kind per CONTRACT: type==='error' || message.startsWith('!!') → 'err'; message.startsWith('//') → 'info';
 * commands → plain (undefined); 'ok' when a response mentions complete/success/ready (and is not a failure report);
 * 'warn' for Klipper "Warning" lines. UI lines appended with an explicit kind as `type` ('ok'|'warn'|'err'|'info') keep it.
 */
export function classify(entry, clean) {
  const raw = String((entry && entry.message) == null ? "" : entry.message).trimStart();
  const type = String((entry && entry.type) || "").toLowerCase();
  if (type === "error" || type === "err" || raw.startsWith("!!")) return "err";
  if (type === "ok" || type === "warn" || type === "info") return type;
  if (type === "command") return undefined;
  // Word tests run on the CLEANED text: Happy Hare splits words letter-by-letter across <span>s ("R</span><span>e</span>…ady"),
  // so the raw HTML never contains "Ready" contiguously (verified on the live v3.4.2 banner).
  const text = clean !== undefined ? clean : cleanMessage(raw);
  let kind = raw.startsWith("//") ? "info" : undefined;
  if (WARN_RE.test(text)) kind = "warn";
  else if (OK_RE.test(text) && !NOT_OK_RE.test(text)) kind = "ok";
  return kind;
}

/** True for entries the dashboard console should not spend one of its 12 rows on (temperature reports, blank lines). */
export function isNoise(entry) {
  if (!entry || typeof entry !== "object") return true;
  if (entry.message === undefined && entry.m !== undefined) return !String(entry.m == null ? "" : entry.m).trim();
  const msg = String(entry.message == null ? "" : entry.message);
  if (!msg.trim()) return true;
  const type = String(entry.type || "").toLowerCase();
  if (type === "command") return false;
  return TEMP_NOISE_RE.test(msg.trimStart());
}

/**
 * One store entry → { t, m, kind } or null when it is noise. Accepts the store shape { time, message, type } and the
 * design's { t, m, kind } (in case the host's ctx.log keeps that shape).
 */
export function toLine(entry) {
  if (isNoise(entry)) return null;
  if (entry.message === undefined && entry.m !== undefined) {
    const m = String(entry.m == null ? "" : entry.m).trim();
    return { t: entry.t || (entry.time !== undefined ? fmtLogTime(entry.time) : "--:--"), m: m || "—", kind: entry.kind === "info" ? undefined : entry.kind };
  }
  const type = String(entry.type || "").toLowerCase();
  let m = cleanMessage(entry.message);
  const kind = classify(entry, m);
  // Commands (ours echoed via ctx.log, or other clients' from gcode_store) render like the design's echo: "› G28".
  if (type === "command" && m && !m.startsWith("›")) m = "› " + m;
  if (!m) return null;
  return { t: fmtLogTime(entry.time), m, kind };
}

/** Newest-first display lines from st.log: skips noise, stops after `limit` lines (or SCAN_MAX entries). */
export function collectLines(log, limit) {
  const out = [];
  if (!Array.isArray(log)) return out;
  const n = Math.min(log.length, SCAN_MAX);
  for (let i = 0; i < n && out.length < limit; i++) {
    let l = null;
    try { l = toLine(log[i]); } catch { l = null; }
    if (l) out.push(l);
  }
  return out;
}

function nowClock() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}

// ---- ↑/↓ command recall -----------------------------------------------------------------------------------------
// Shared with the full /console page through localStorage `carbon.console.history`: a JSON array of strings in
// chronological order (oldest first, newest last), capped at HISTORY_MAX, consecutive duplicates collapsed.
export const HISTORY_KEY = "carbon.console.history";
export const HISTORY_MAX = 100;
const nav = { idx: null, draft: "" };   // idx: index into the history while browsing; null = editing the draft

export function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()) : [];
  } catch { return []; }
}
export function pushHistory(cmd) {
  const v = String(cmd == null ? "" : cmd).trim();
  nav.idx = null; nav.draft = "";
  if (!v) return;
  try {
    const items = loadHistory();
    if (items[items.length - 1] !== v) items.push(v);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(-HISTORY_MAX)));
  } catch {}
}
/** dir -1 = older (ArrowUp), +1 = newer (ArrowDown); walking past the newest entry restores the unsent draft. */
function recall(el, dir) {
  const items = loadHistory();
  if (!items.length) return;
  if (nav.idx === null) { if (dir > 0) return; nav.draft = el.value || ""; nav.idx = items.length; }
  const next = nav.idx + dir;
  if (next < 0) return;
  if (next >= items.length) { nav.idx = null; el.value = nav.draft; nav.draft = ""; }
  else { nav.idx = next; el.value = items[next]; }
  try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
}

/** Dispatch a console command through the merged actions (src/lib/actions/console.js) or straight to api.gcode as a fallback. */
function dispatch(ctx, text) {
  const act = ctx && ctx.act;
  if (act && typeof act.sendConsole === "function") { try { act.sendConsole(text); } catch (e) { safeLog(ctx, (e && e.message) || String(e), "err"); } return; }
  safeLog(ctx, "› " + text, "info");
  if (!ctx || !ctx.api || typeof ctx.api.gcode !== "function") { safeLog(ctx, "Not connected to Moonraker", "err"); return; }
  Promise.resolve().then(() => ctx.api.gcode(text)).catch(err => safeLog(ctx, (err && err.message) || String(err), "err"));
}
function safeLog(ctx, msg, kind) { try { if (ctx && typeof ctx.log === "function") ctx.log(msg, kind); } catch {} }

// ---- adapter -----------------------------------------------------------------------------------------------------
export function consoleVals(ctx) {
  const c = ctx || {};
  const st = c.st || {};
  const ui = c.ui || {};
  const expanded = !!ui.consoleExpanded;
  const set = typeof c.set === "function" ? c.set : () => {};

  const lines = collectLines(st.log, expanded ? EXPANDED_LINES : COLLAPSED_LINES);
  if (!lines.length) lines.push({ t: "--:--", m: st.connected === false ? "Not connected to Moonraker" : "—", kind: undefined });
  const logLines = lines.map(l => ({ t: l.t, m: l.m, style: lineStyle(l.kind) }));

  return {
    logLines,
    sendConsole: e => {
      if (!e || !e.target) return;
      const el = e.target;
      if (e.key === "ArrowUp") { e.preventDefault(); recall(el, -1); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); recall(el, +1); return; }
      if (e.key === "Escape") { el.value = ""; nav.idx = null; nav.draft = ""; return; }
      if (e.key !== "Enter") return;
      const v = String(el.value || "").trim();
      if (!v) return;
      el.value = "";
      pushHistory(v);
      dispatch(c, v);
    },
    toggleConsole: () => set(s => ({ consoleExpanded: !(s && s.consoleExpanded) })),
    consoleArrow: expanded ? "▼" : "◀",
    consoleArrowStyle: "width:20px; height:20px; margin-left:8px; border:1px solid #1c2430; border-radius:3px; display:flex; align-items:center; justify-content:center; font-family:'JetBrains Mono',monospace; font-size:9px; color:#8b98aa; cursor:pointer; transition:.12s",
    consoleBodyStyle: `display:flex; flex-direction:column; gap:3px; transition:max-height .28s ease; max-height:${expanded ? EXPANDED_PX : COLLAPSED_PX}px; overflow-y:${expanded ? "auto" : "hidden"}`,
    clock: ui.clock || nowClock(),
  };
}

export default consoleVals;
