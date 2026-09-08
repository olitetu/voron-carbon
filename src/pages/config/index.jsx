// CONFIG — every file under Moonraker's `config` root, grouped by what it is FOR, with a CodeMirror editor.
//
// The listing is api.dirInfo("config", true) walked recursively (326 files in 10 directories on this
// printer) and classified into three sections: the files Klipper actually runs from (with the whole
// `[include …]` graph resolved the way Klipper resolves it — transitively, globs included, each spec
// relative to the file that wrote it — so INCLUDED / ROOT / SERVICE badges are facts, not guesses),
// Happy Hare's tree, and the pile of timestamped backups that every Happy Hare upgrade and every
// SAVE_CONFIG leaves behind.
//
// The editor is CodeMirror 6 in a SEPARATE bundle (dist/editor.js, ~130 KB gzipped) injected on mount,
// exactly like the 3D viewer: app.js stays small and a clone that never built it still gets a working
// textarea, labelled as such. Saving goes through makeMachineActions().saveConfig — the one place that
// knows Moonraker has no "write file" RPC and that a restart is refused mid-print.
import React from "react";
import { Panel, Btn, Chip, Label, Row, Input, Confirm, T, mono, fmtBytes, fmtDate } from "../../lib/design.jsx";
import { S, Hv } from "../../lib/ui.js";
import { useStore, useAsync, usePersisted } from "../../lib/useStore.js";
import { makeMachineActions, isPrintActive } from "../../lib/actions/machine.js";

const EDITOR_SRC = "editor.js";
const MAX_EDIT = 1024 * 1024;     // past this a textarea helps nobody — the file is offered as a download
const MAX_DEPTH = 8;              // the tree is 3 deep; this is a loop guard, not a limit anyone should hit
const DASH = "—";
// Include-graph walk: KAMP_Settings.cfg → KAMP/*.cfg is two hops, so the depth is a cycle guard; the
// fetch budget is what stops `[include *.cfg]` turning one page load into three hundred requests.
const MAX_INCLUDE_DEPTH = 6;
const MAX_INCLUDE_FETCH = 80;
const MAX_INCLUDE_BYTES = 512 * 1024;
// boot() opens the websocket asynchronously; staying pending until st.connected keeps the first
// render's "not connected" rejection out of the error state (same idiom as FILES / MACHINE).
const PENDING = new Promise(() => {});

// ---------------------------------------------------------------------------------------------
// Classification. Priority order matters: a `.bak` under mmu/ is a backup, not a live MMU file.
// ---------------------------------------------------------------------------------------------
const BACKUP_RES = [
  /\.(bak[\w.\-]*|bkp|backup|old|orig)$/i,
  /(^|\/)printer-\d{8}_\d{6}\.cfg(-old)?$/,
  /(^|\/)mmu-\d{8}_\d{6}\//,
  /\.zip$/i,
  /\.(gcode|g|gco)$/i,
  /\.\d{4}-\d{2}-\d{2}(-\d{4})?$/,           // dated copies: crowsnest.conf.2025-01-31-1904
];
const OWN_PREFIXES = ["voron-ui/", ".theme/"];   // this app's own files, and Mainsail's theme
/** Files that configure a SERVICE (Moonraker, crowsnest, KlipperScreen…) — Klipper never reads them. */
const SERVICE = new Set(["moonraker.conf", "crowsnest.conf", "KlipperScreen.conf", "ks_menus.conf", "sonar.conf", "spoolman.cfg", "timelapse.cfg", "mmu_klipperscreen.conf"]);
const TEXT_RE = /\.(cfg|conf|ini|txt|md|json|py|sh|ya?ml|log|bak[\w.\-]*|bkp|backup|old|orig|template|css|js|html|cfg-old)$/i;
const PRINTER_SNAP = /^printer-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.cfg(-old)?$/;
const MMU_SNAP = /^(mmu-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2}))\//;

const GROUPS = [
  { id: "main", title: "MAIN PRINTER FILES", accent: T.accent, hint: "printer.cfg, what it includes, and the other root files" },
  { id: "mmu", title: "MMU (HAPPY HARE)", accent: T.info, hint: "mmu/ — base, addons, optional, and the live mmu_vars.cfg" },
  { id: "backups", title: "BACKUPS & OTHERS", accent: T.mute, hint: "timestamped copies, upgrade snapshots, archives, this app's own files" },
];
const SORTS = [["name", "NAME"], ["modified", "MODIFIED"], ["size", "SIZE"]];

// What a file IS, for the filter row. Exactly one kind per file, tested in this order.
// ROOT (printer.cfg) is deliberately absent: it is never filtered out — hiding Klipper's entry point
// behind a toggle is never what anyone wants.
const KINDS = [
  ["included", "INCLUDED", T.ok,     "Loaded by printer.cfg through an [include] line"],
  ["service",  "SERVICE",  T.info,   "Configures a service (Moonraker, crowsnest, KlipperScreen…)"],
  ["backups",  "BACKUPS",  T.mute,   "Timestamped copies, upgrade snapshots, archives"],
  ["others",   "OTHERS",   T.faint,  "Present but not reached by printer.cfg and not a service config"],
];
const ALL_KINDS = KINDS.map(k => k[0]);
function kindOf(f, included) {
  if (f.path === "printer.cfg") return "root";                    // always shown
  if (BACKUP_RES.some(r => r.test(f.path)) || OWN_PREFIXES.some(pre => f.path.startsWith(pre))) return "backups";
  if (included.has(f.path)) return "included";
  if (SERVICE.has(f.name)) return "service";
  return "others";
}

function classify(path) {
  if (OWN_PREFIXES.some(p => path.startsWith(p)) || BACKUP_RES.some(r => r.test(path))) return "backups";
  if (path.startsWith("mmu/") || path === "mmu_klipperscreen.conf") return "mmu";
  return "main";
}
const isTextName = name => TEXT_RE.test(name) || /\.\d{4}-\d{2}-\d{2}(-\d{4})?$/.test(name);
const baseOf = p => { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); };

/** `[include mmu/base/*.cfg] ; comment` → "mmu/base/*.cfg"; commented-out includes are skipped. */
function parseIncludes(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    const m = /^\[include\s+([^\]]+)\]/i.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}
/** Klipper resolves an include with glob.glob — same wildcard rules here, on a root-relative path. */
function globToRe(pattern) {
  const p = String(pattern == null ? "" : pattern);
  const src = p.split(/(\*\*|\*|\?)/).map(seg =>
    seg === "**" ? ".*" : seg === "*" ? "[^/]*" : seg === "?" ? "[^/]" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
  try { return new RegExp("^" + src + "$"); } catch (e) { return null; }
}
/**
 * Klipper joins an include spec against the directory of the file that WROTE it (configfile.py:
 * `os.path.join(os.path.dirname(source_filename), include_spec)`), so `[include blobifier_hw.cfg]`
 * inside mmu/addons/blobifier.cfg means mmu/addons/blobifier_hw.cfg. Normalise `.` and `..`; an
 * absolute spec, or one that climbs out of the config root, can never match a file in this listing.
 */
function joinCfg(dir, spec) {
  const s = String(spec == null ? "" : spec).trim();
  if (!s || s[0] === "/" || s[0] === "~") return null;
  const out = [];
  for (const seg of (dir ? dir + "/" + s : s).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.length ? out.join("/") : null;
}
const dirOf = p => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

/** One hop: the [include] lines of a single file. Used as the floor while the deep walk runs. */
function includedSet(files, text, dir = "") {
  const res = parseIncludes(text).map(s => { const j = joinCfg(dir, s); return j ? globToRe(j) : null; }).filter(Boolean);
  const set = new Set();
  if (res.length) for (const f of files) if (res.some(r => r.test(f.path))) set.add(f.path);
  return set;
}

// Re-reading every included file on every walk is pointless — config files change rarely and the walk
// fires on each filelist notification. Keyed by path AND mtime, so a real edit still busts the entry.
const textCache = new Map();
function cachedText(api, f) {
  const k = f.path + "@" + f.modified;
  let p = textCache.get(k);
  if (!p) {
    if (textCache.size > 200) textCache.clear();
    p = api.fileText("config", f.path).catch(e => { textCache.delete(k); throw e; });
    textCache.set(k, p);
  }
  return p;
}

/**
 * Every file Klipper actually loads — not just the ones printer.cfg names itself. Resolving only the
 * root's own lines told this printer that KAMP/Adaptive_Meshing.cfg, mmu/addons/blobifier_hw.cfg and
 * mmu/addons/mmu_erec_cutter_hw.cfg were "NOT INCLUDED BY PRINTER.CFG" and dimmed them, while Klipper
 * loads all three through KAMP_Settings.cfg / blobifier.cfg / mmu_erec_cutter.cfg. Breadth-first, one
 * level of fetches at a time, bounded by depth and a fetch budget; a file that cannot be read just
 * ends its own branch, so the answer is always a floor and never a false INCLUDED.
 */
async function resolveIncluded(api, files, rootText) {
  const included = new Set();
  const done = new Set(["printer.cfg"]);       // also breaks an [include printer.cfg] cycle
  let budget = MAX_INCLUDE_FETCH;
  let level = [["", rootText]];
  for (let depth = 0; depth < MAX_INCLUDE_DEPTH && level.length; depth++) {
    const next = [];
    for (const [dir, text] of level) {
      for (const spec of parseIncludes(text)) {
        const joined = joinCfg(dir, spec);
        const re = joined && globToRe(joined);
        if (!re) continue;
        for (const f of files) {
          if (done.has(f.path) || !re.test(f.path)) continue;
          done.add(f.path);
          included.add(f.path);
          if (budget > 0 && isTextName(f.name) && f.size <= MAX_INCLUDE_BYTES) { budget--; next.push(f); }
        }
      }
    }
    if (!next.length) break;
    const texts = await Promise.all(next.map(f => cachedText(api, f).catch(() => "")));
    level = next.map((f, i) => [dirOf(f.path), texts[i]]);
  }
  return included;
}

/**
 * Walk the whole root. Sub-directories are read in parallel; one that fails is named, not fatal.
 * `.git` is never entered: Moonraker refuses it outright ("Access to .git folders is forbidden" —
 * Mainsail's theme checkout under .theme/ has one), and nothing in it is config.
 */
async function walkConfig(api) {
  const files = [], skipped = [];
  let dirs = 0, disk = null;
  async function walk(rel, depth) {
    let d;
    try { d = await api.dirInfo(rel ? "config/" + rel : "config", true); }
    catch (e) { if (!rel) throw e; skipped.push(rel); return; }
    if (!rel) disk = d.disk_usage || null;
    for (const f of d.files || []) {
      if (!f || typeof f.filename !== "string") continue;
      files.push({ path: rel ? rel + "/" + f.filename : f.filename, name: f.filename, dir: rel,
        size: Number(f.size) || 0, modified: Number(f.modified) || 0, permissions: f.permissions || "rw" });
    }
    const subs = (d.dirs || []).filter(x => x && typeof x.dirname === "string" && x.dirname !== ".git");
    dirs += subs.length;
    if (depth >= MAX_DEPTH) { subs.forEach(x => skipped.push(rel + "/" + x.dirname)); return; }
    await Promise.all(subs.map(x => walk(rel ? rel + "/" + x.dirname : x.dirname, depth + 1)));
  }
  await walk("", 0);
  return { files, dirs, skipped, disk };
}

/**
 * Nest a flat file list into { dirs: Map<name, node>, files: [] } so the browser shows the real
 * directory structure. `base` is stripped from the front of every path first (the MMU group is all
 * under "mmu/", so repeating it on each row is noise).
 */
function buildTree(files, base) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const rel = base && f.path.startsWith(base) ? f.path.slice(base.length) : f.path;
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1 && i < MAX_DEPTH; i++) {
      const seg = parts[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [], path: (base || "") + parts.slice(0, i + 1).join("/") });
      node = node.dirs.get(seg);
    }
    node.files.push(f);
  }
  return root;
}
/** Deepest-first count so a folder header can say how much is inside it. */
function countTree(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countTree(d);
  return n;
}

function sorter(sort) {
  const byName = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" });
  return (a, b) => {
    let r = sort.k === "size" ? a.size - b.size : sort.k === "modified" ? a.modified - b.modified : byName(a, b);
    if (!r && sort.k !== "name") r = byName(a, b);
    return r * sort.dir;
  };
}

const stampOf = (m, i) => `${m[i]}-${m[i + 1]}-${m[i + 2]} ${m[i + 3]}:${m[i + 4]}`;
/** The same capture groups as an epoch. A snapshot SET has to sort by the stamp it displays: `cp -r`
 *  preserves the ORIGINAL mtimes, so ordering the sets by the newest file inside them listed
 *  2026-06-15, 2025-04-05, 2025-03-21, 2025-02-15 and then 2025-04-05 again. */
const stampTime = (m, i) => new Date(+m[i], +m[i + 1] - 1, +m[i + 2], +m[i + 3], +m[i + 4], +m[i + 5]).getTime() / 1000;
/** printer-YYYYMMDD backups, mmu-YYYYMMDD_HHMMSS upgrade snapshots (one bucket per directory), the rest. */
function bucketBackups(files) {
  const printer = [], other = [], sets = new Map();
  for (const f of files) {
    let m = PRINTER_SNAP.exec(f.path);
    if (m) { printer.push(Object.assign({}, f, { stamp: stampOf(m, 1) })); continue; }
    m = MMU_SNAP.exec(f.path);
    if (m) {
      const k = m[1];
      if (!sets.has(k)) sets.set(k, { dir: k, stamp: stampOf(m, 2), when: stampTime(m, 2), files: [], size: 0 });
      const s = sets.get(k); s.files.push(f); s.size += f.size;
      continue;
    }
    other.push(f);
  }
  return { printer, sets: [...sets.values()], other };
}

/** fmtDate drops the year, which is fine for this week and useless for a 2025 backup. */
function fmtWhen(t) {
  if (!Number.isFinite(t) || t <= 0) return DASH;
  const d = new Date(t * 1000);
  if (d.getFullYear() === new Date().getFullYear()) return fmtDate(t);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

// ---------------------------------------------------------------------------------------------
// Drafts — one localStorage key per file, written raw (no JSON) and throttled: Orca tears this page
// down on nearly every preset change, so an edit has to survive a reload the user never asked for.
// "Dirty" is "a draft exists", not a diff: after such a reload the on-disk copy is not fetched yet.
// ---------------------------------------------------------------------------------------------
const DRAFT_PREFIX = "carbon.config.draft:";
const readDraft = p => { try { return localStorage.getItem(DRAFT_PREFIX + p); } catch (e) { return null; } };
const writeDraft = (p, text) => { try { localStorage.setItem(DRAFT_PREFIX + p, text); return true; } catch (e) { return false; } };
const clearDraft = p => { try { localStorage.removeItem(DRAFT_PREFIX + p); } catch (e) { /* nothing to clear */ } };
function listDrafts() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(DRAFT_PREFIX)) out.push(k.slice(DRAFT_PREFIX.length)); } }
  catch (e) { /* storage unavailable */ }
  return out;
}

/**
 * The draft for `path`: [text|null, set(text|null), flush()].
 * `onFlush(ok, path, exists)` reports every storage write — `exists` is false when the draft was cleared.
 */
function useDraft(path, onFlush) {
  // Keyed by path so a NEW selection never renders the OLD file's draft for one frame.
  const initial = React.useMemo(() => (path ? readDraft(path) : null), [path]);
  const [d, setD] = React.useState({ path, text: initial });
  const pending = React.useRef(null);
  const timer = React.useRef(null);
  const cb = React.useRef(onFlush);
  cb.current = onFlush;
  const flush = React.useCallback(() => {
    clearTimeout(timer.current);
    const p = pending.current; pending.current = null;
    if (!p) return;
    const ok = p.text === null ? (clearDraft(p.path), true) : writeDraft(p.path, p.text);
    try { cb.current && cb.current(ok, p.path, p.text !== null); } catch (e) { /* listeners are best-effort */ }
  }, []);
  const set = React.useCallback(text => {
    setD({ path, text });
    pending.current = { path, text };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [path, flush]);
  // Leaving the file (or the page) must not lose the last 300 ms of typing.
  React.useEffect(() => () => flush(), [path, flush]);
  // React's cleanup does NOT run when the document is torn down, and Orca reloads this page at the
  // base URL on nearly every preset change — so the same flush is wired to the two events a WKWebView
  // does fire on the way out. Both are no-ops when nothing is pending.
  React.useEffect(() => {
    const go = () => flush();
    window.addEventListener("pagehide", go);
    document.addEventListener("visibilitychange", go);
    return () => { window.removeEventListener("pagehide", go); document.removeEventListener("visibilitychange", go); };
  }, [flush]);
  return [d.path === path ? d.text : initial, set, flush];
}

// ---------------------------------------------------------------------------------------------
// editor.js — injected once per page load, shared by every mount (the viewer's idiom).
// ---------------------------------------------------------------------------------------------
let bundle = null;
function loadEditor() {
  if (typeof window !== "undefined" && window.CarbonEditor) return Promise.resolve(window.CarbonEditor);
  if (bundle) return bundle;
  bundle = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = EDITOR_SRC; el.async = true; el.dataset.carbonEditor = "1";
    el.onload = () => (window.CarbonEditor ? resolve(window.CarbonEditor) : reject(new Error("editor.js loaded but window.CarbonEditor is missing")));
    el.onerror = () => reject(new Error("editor.js is not on the server"));
    document.head.appendChild(el);
  }).catch(e => {
    const el = document.querySelector("script[data-carbon-editor]");
    if (el) el.remove();
    bundle = null;                                    // a dead <script> never fires again — let a remount retry
    throw e;
  });
  return bundle;
}

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------
/** Anchor styled as a Btn — same-tab `download` href, never target=_blank (Orca ejects to Safari). */
function LinkBtn({ href, children, title }) {
  return <Hv as="a" href={href} download title={title}
    style={`padding:4px 8px; border:1px solid ${T.line}; background:${T.panel}; border-radius:4px; ${mono(9, `letter-spacing:.1em; color:${T.dim}`)}; text-decoration:none; white-space:nowrap; transition:.12s`}
    hover={`border-color:${T.line2}; color:${T.text}`} active="transform:translateY(1px)">{children}</Hv>;
}
/** Tiny in-row badge: ROOT / INCLUDED / SERVICE / VARS. */
function Tag({ children, color = T.dim, title }) {
  return <span title={title} style={S(`flex:none; padding:1px 5px; border-radius:3px; border:1px solid ${T.line}; background:${T.panel}; ${mono(8, `letter-spacing:.08em; color:${color}`)}; line-height:1.5`)}>{children}</span>;
}
const BADGE = {
  ROOT: [T.accent, "Klipper's entry point — everything else is reached from here"],
  INCLUDED: [T.ok, "Loaded by printer.cfg through an [include] line"],
  SERVICE: [T.info, "Configures a service (Moonraker, crowsnest, KlipperScreen…), not Klipper"],
  VARS: [T.warn, "Written by Klipper's save_variables — Happy Hare state; hand edits get overwritten"],
};
function badgesFor(f, group, included) {
  const out = [];
  if (f.path === "printer.cfg") out.push("ROOT");
  else if (included.has(f.path)) out.push("INCLUDED");
  if (group !== "backups" && SERVICE.has(f.name)) out.push("SERVICE");
  if (f.path === "mmu/mmu_vars.cfg") out.push("VARS");
  return out;
}

/**
 * "mmu-20250405_035132/addons/mmu_eject_buttons_hw.cfg" → "…/addons/mmu_eject_buttons_hw.cfg".
 * Panel's header is one flex row and its title track does not shrink (no min-width:0, no ellipsis),
 * so a 50-character path wrapped the title onto two lines and pushed SAVE & RESTART clean off the
 * panel at the shell's 980 px minimum. Elide from the FRONT: the file name is what identifies it.
 */
function shortPath(p, max = 36) {
  const s = String(p == null ? "" : p);
  if (s.length <= max) return s;
  const parts = s.split("/");
  let out = parts[parts.length - 1];
  if (out.length + 1 > max) return "…" + out.slice(out.length - (max - 1));   // one very long name
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts.slice(i).join("/");
    if (next.length + 2 > max) break;
    out = next;
  }
  return "…/" + out;
}

function GroupHead({ title, accent, open, onToggle, right, hint }) {
  return <Hv as="div" onClick={onToggle} title={hint}
    style={`display:flex; align-items:center; gap:8px; padding:7px 10px 6px; cursor:pointer; user-select:none; position:sticky; top:0; z-index:1; background:${T.panel}; border-bottom:1px solid ${T.line}`}
    hover="background:#0f151d">
    <span style={S(`flex:none; width:8px; ${mono(9, `color:${T.mute}`)}`)}>{open ? "▾" : "▸"}</span>
    <div style={S(`width:3px; height:11px; background:${accent}; border-radius:1px; flex:none`)} />
    <div style={S(`${mono(9.5, `letter-spacing:.16em; color:${T.dim}`)}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{title}</div>
    <div style={S("display:flex; align-items:center; gap:8px; flex:none")}>{right}</div>
  </Hv>;
}
function SubHead({ title, right, open, onToggle, indent = 0 }) {
  const click = typeof onToggle === "function";
  return <Hv as="div" onClick={onToggle}
    style={`display:flex; align-items:center; gap:6px; padding:6px 10px 3px ${10 + indent}px; ${click ? "cursor:pointer; user-select:none;" : ""} min-width:0`}
    hover={click ? "background:#0f151d" : ""}>
    {click && <span style={S(`flex:none; width:8px; ${mono(9, `color:${T.mute}`)}`)}>{open ? "▾" : "▸"}</span>}
    <div style={S(`${mono(8.5, `letter-spacing:.14em; color:${T.faint}`)}; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{title}</div>
    <div style={S(`flex:none; ${mono(9, `color:${T.faint}`)}`)}>{right}</div>
  </Hv>;
}

function FileRow({ f, label, prefix, active, dim, badges, right, draft, indent = 0, onClick }) {
  return <Hv as="div" onClick={onClick} title={f.path}
    style={`display:flex; align-items:center; gap:6px; padding:4px 10px 4px ${8 + indent}px; border-left:2px solid ${active ? T.accent : "transparent"}; cursor:pointer; min-width:0; ${active ? `background:${T.panel2};` : ""}`}
    hover={active ? "" : "background:#0f151d"}>
    {draft && <span title="Unsaved draft kept in this browser" style={S(`flex:none; width:5px; height:5px; border-radius:50%; background:${T.warn}`)} />}
    <span style={S(`flex:1; min-width:0; ${mono(10.5, `color:${active ? T.text : dim ? T.mute : T.body}`)}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>
      {prefix ? <span style={S(`color:${T.faint}`)}>{prefix}</span> : null}{label || f.name}
    </span>
    {(badges || []).map(b => <Tag key={b} color={BADGE[b][0]} title={BADGE[b][1]}>{b}</Tag>)}
    <span style={S(`flex:none; ${mono(9, `color:${T.faint}`)}`)}>{right}</span>
  </Hv>;
}

// ---------------------------------------------------------------------------------------------
// Editor surfaces: CodeMirror when dist/editor.js is there, a line-numbered textarea when it is not.
// ---------------------------------------------------------------------------------------------
function CodeMirrorHost({ lib, value, onChange, readOnly, filename, height }) {
  const host = React.useRef(null), inst = React.useRef(null), last = React.useRef(null), cb = React.useRef(onChange);
  cb.current = onChange;
  React.useEffect(() => {
    if (!host.current || !lib || typeof lib.create !== "function") return undefined;
    try {
      inst.current = lib.create(host.current, {
        doc: value, readOnly, filename,
        onChange: s => { last.current = s; try { cb.current && cb.current(s); } catch (e) { /* never throw into CM */ } },
      });
      last.current = value;
    } catch (e) { console.warn("[config] CodeMirror mount failed", e); }
    return () => { try { inst.current && inst.current.destroy(); } catch (e) { /* already gone */ } inst.current = null; };
    // Mounted once per file (the parent keys this component by path, so undo history never crosses files).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // External changes only (revert, reload, save): the editor already holds what the user typed.
  React.useEffect(() => { const i = inst.current; if (!i || value === last.current) return; last.current = value; try { i.setValue(value); } catch (e) { /* view destroyed */ } }, [value]);
  React.useEffect(() => { try { inst.current && inst.current.setReadOnly(!!readOnly); } catch (e) { /* view destroyed */ } }, [readOnly]);
  return <div ref={host} style={S(`height:${height}; min-height:0; border:1px solid ${T.line}; border-radius:4px; overflow:hidden; background:${T.panel}`)} />;
}

/** The fallback: a <textarea> with a scroll-synced gutter, Tab inserting two spaces. */
function PlainArea({ value, onChange, readOnly, height }) {
  const gutter = React.useRef(null);
  const text = value || "";
  const count = React.useMemo(() => text.split("\n").length, [text]);
  const nums = React.useMemo(() => { const a = new Array(count); for (let i = 0; i < count; i++) a[i] = i + 1; return a.join("\n"); }, [count]);
  const face = `font-family:${T.mono}; font-size:12px; line-height:18px`;
  const onKeyDown = e => {
    if (e.key !== "Tab" || readOnly) return;
    e.preventDefault();
    const el = e.target, a = el.selectionStart, b = el.selectionEnd;
    onChange(text.slice(0, a) + "  " + text.slice(b));
    requestAnimationFrame(() => { try { el.selectionStart = el.selectionEnd = a + 2; } catch (err) { /* element gone */ } });
  };
  return <div style={S(`display:flex; min-height:0; height:${height}; border:1px solid ${T.line}; border-radius:4px; background:${T.panel}; overflow:hidden`)}>
    <pre ref={gutter} style={S(`${face}; margin:0; flex:none; min-width:46px; padding:8px 6px 8px 12px; text-align:right; color:${T.faint}; background:${T.panel}; border-right:1px solid ${T.line}; overflow:hidden; user-select:none`)}>{nums}</pre>
    <textarea value={text} readOnly={!!readOnly} spellCheck={false} wrap="off"
      onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
      onScroll={e => { if (gutter.current) gutter.current.scrollTop = e.target.scrollTop; }}
      style={S(`${face}; flex:1; min-width:0; margin:0; padding:8px 12px; border:none; outline:none; resize:none; background:transparent; color:${T.body}; white-space:pre; overflow:auto; tab-size:2`)} />
  </div>;
}

// ---------------------------------------------------------------------------------------------
// The editor panel
// ---------------------------------------------------------------------------------------------
const EDITOR_H = "clamp(340px, calc(100vh - 262px), 1100px)";

function EditorPanel({ api, act, sel, file, group, badges, printing, connected, onDraftsChanged }) {
  const path = sel ? sel.path : null;
  const meta = file || sel;                                  // the fresh listing wins over the persisted snapshot
  const readOnly = !!(meta && meta.permissions === "r");
  const textName = !!path && isTextName(baseOf(path));
  // Two different reasons the editor stays shut, and they need two different headlines: the stray
  // 21 MB `Lightbox Draft_ABS_7h55m.gcode` in the config root was announced as "NOT A TEXT FILE" and
  // then explained as "21.0 MB is past the editor's 1.0 MB limit", and a big .log would have read
  // "NOT A TEXT FILE" while being nothing but text.
  const tooBig = textName && !!(meta && meta.size > MAX_EDIT);
  const editable = textName && (!meta || !(meta.size > MAX_EDIT));
  const [reloadN, reload] = React.useReducer(n => n + 1, 0);
  // `lib` is the resolved bundle object, not window.CarbonEditor read at mount time — the host must
  // never end up with an engine of "cm" and nothing to mount (that is a blank panel, the one thing
  // this page promises not to show).
  const [lib, setLib] = React.useState(() => (typeof window !== "undefined" && window.CarbonEditor) || null);
  const [engine, setEngine] = React.useState(() => (lib ? "cm" : "loading"));
  const [confirm, setConfirm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [storeFail, setStoreFail] = React.useState(false);
  const fileRef = React.useRef(file);
  fileRef.current = file;
  // A pending SAVE confirmation belongs to the file it was opened on: picking another one drops it,
  // so the strip can never name one file while the panel (and the save below) holds another.
  // `storeFail` goes with it — a quota failure on one file is not a fact about the next.
  React.useEffect(() => { setConfirm(null); setStoreFail(false); }, [path]);

  React.useEffect(() => {
    let alive = true;
    loadEditor()
      .then(l => { if (!alive) return; if (l && typeof l.create === "function") { setLib(l); setEngine("cm"); } else setEngine("plain"); })
      .catch(() => { if (alive) setEngine("plain"); });
    return () => { alive = false; };
  }, []);

  // Tagged with the path it belongs to: useAsync keeps the previous result while the next loads, and
  // showing printer.cfg's body under mmu_hardware.cfg's name for one frame is how a draft gets seeded
  // with the wrong file — and SAVE then writes it. `mod` is the listing's mtime at fetch time, so a
  // later listing can tell whether the file moved underneath the editor (Happy Hare rewrites
  // mmu_vars.cfg on every tool change).
  const disk = useAsync(() => (api && path && editable
    ? api.fileText("config", path).then(text => ({ path, text, mod: fileRef.current ? fileRef.current.modified : null }))
    : Promise.resolve(null)), [api, path, editable, reloadN]);
  const onDisk = disk.data && disk.data.path === path ? disk.data.text : null;

  // The mtime the file had when this copy was read. An Orca reload restores a selection and starts
  // the read BEFORE the directory walk lands, so `mod` is null on exactly the path that matters most
  // — in that case the first mtime the listing reports afterwards is adopted as the baseline. Without
  // it CHANGED ON DISK never fires after a reload, which is the one case Happy Hare rewriting
  // mmu_vars.cfg under the editor has to be caught in.
  const [modBase, setModBase] = React.useState(null);
  React.useEffect(() => { setModBase(null); }, [path, reloadN]);
  React.useEffect(() => {
    if (modBase !== null) return;
    const d = disk.data;
    if (!d || d.path !== path) return;                     // nothing read for this file yet
    if (d.mod !== null) setModBase(d.mod);
    else if (file) setModBase(file.modified);
  }, [modBase, disk.data, file, path]);
  // Our OWN save bumps the mtime too. The re-read that follows it captures the mtime from the listing
  // it can see — still the pre-save one, because the walk is debounced 1.5 s behind the filelist
  // notification — so the walk that lands next looks exactly like somebody else editing the file, and
  // CHANGED ON DISK fired on every single save. Absorb exactly one bump, and only for a short while,
  // so Happy Hare rewriting mmu_vars.cfg under the editor is still caught.
  const selfWriteUntil = React.useRef(0);
  React.useEffect(() => { selfWriteUntil.current = 0; }, [path]);
  React.useEffect(() => {
    if (!file || modBase === null) return;
    if (file.modified > modBase + 0.5 && Date.now() < selfWriteUntil.current) {
      selfWriteUntil.current = 0;
      setModBase(file.modified);
    }
  }, [file, modBase]);
  const diskStale = !!(file && modBase !== null && file.modified > modBase + 0.5);

  // A flush lands every 300 ms while someone types; the page behind this panel re-renders 300+ rows
  // when it hears one, so it is only told when a file actually gained or lost its draft.
  const draftSeen = React.useRef(new Map());
  const onFlushed = React.useCallback((ok, p, exists) => {
    setStoreFail(!ok);
    if (draftSeen.current.get(p) === exists) return;
    draftSeen.current.set(p, exists);
    if (onDraftsChanged) onDraftsChanged();
  }, [onDraftsChanged]);
  const [draft, setDraft, flush] = useDraft(path, onFlushed);
  const hasDraft = draft !== null;
  const text = hasDraft ? draft : (onDisk || "");
  const changed = hasDraft && (onDisk === null || draft !== onDisk);
  const liveRef = React.useRef({ path: null, text: "" });
  liveRef.current = { path, text };

  const onEdit = t => {
    if (readOnly) return;
    // Typing the file back to exactly what is on disk clears the draft — "UNSAVED" must mean it.
    if (onDisk !== null && t === onDisk) setDraft(null); else setDraft(t);
  };
  const revert = () => { setDraft(null); flush(); };
  // What SAVE writes is read at the moment the confirmation is answered, never captured when it was
  // opened: the editor stays live under the strip, and writing a body the user has since typed past
  // is how an edit silently disappears. The path cannot drift — a new selection clears the strip.
  const save = restart => {
    const now = liveRef.current;
    if (!now.path) return;
    flush();
    setSaving(true);
    Promise.resolve(act.saveConfig(now.path, now.text, { restart }))
      .then(ok => { if (ok) { selfWriteUntil.current = Date.now() + 30000; setDraft(null); flush(); reload(); } })
      .catch(() => {})
      .then(() => setSaving(false));
  };
  const askSave = restart => setConfirm({
    yes: restart ? "SAVE & RESTART" : "SAVE",
    text: restart
      ? `Overwrite config/${path} and restart Klipper to load it?`
      : `Overwrite config/${path} on the printer?` + (printing ? " A print is running — the file changes now, Klipper only picks it up on the next restart." : ""),
    run: () => save(restart),
  });

  // Cmd/Ctrl+S is what hands do in a config editor. Unbound it reached the browser and opened "Save
  // page as…" — useless here, and inside Orca's WKWebView it does nothing at all while the user
  // believes the file went to the printer. It opens exactly the Confirm the SAVE button opens; it
  // never writes anything by itself, and Shift+Cmd+S is deliberately NOT wired to SAVE & RESTART.
  React.useEffect(() => {
    if (!path || !editable) return undefined;
    const onKey = e => {
      if ((e.key !== "s" && e.key !== "S") || e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (changed && !readOnly && !saving) askSave(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, editable, changed, readOnly, saving, printing]);

  const lines = text ? text.split("\n").length : 0;
  // fmtBytes(text.length) counted CHARACTERS. mmu_parameters.cfg is 72 982 bytes on disk and 59 336
  // JS characters (Happy Hare's comments are full of box-drawing glyphs), so the panel showed
  // "71.3 KB" in the meta row and "57.9 KB" in the status row for the same file, 19 % apart.
  const bytes = React.useMemo(() => {
    try { return new TextEncoder().encode(text).length; } catch (e) { return text.length; }
  }, [text]);
  const live = badges.includes("ROOT") || badges.includes("INCLUDED");
  const status = !meta ? null
    : live ? ["LOADED BY KLIPPER", T.ok]
    : group === "backups" ? ["BACKUP — NOT LOADED", T.mute]
    : badges.includes("SERVICE") ? ["SERVICE CONFIG", T.info]
    : badges.includes("VARS") ? ["HAPPY HARE STATE", T.warn]
    : ["NOT INCLUDED BY PRINTER.CFG", T.faint];
  const ready = onDisk !== null || hasDraft;

  return <Panel title={path ? <span title={path}>{shortPath(path)}</span> : "CONFIG EDITOR"} accent={changed ? T.warn : T.info} flat
    right={<Row gap={5} style="flex-wrap:wrap; justify-content:flex-end; row-gap:4px">
      {engine === "plain" && <div title="dist/editor.js is not built — editing in a plain textarea"><Chip color={T.warn}>PLAIN TEXTAREA</Chip></div>}
      {engine === "loading" && <Chip color={T.mute}>LOADING EDITOR…</Chip>}
      {readOnly && <Chip color={T.mute}>READ ONLY</Chip>}
      {changed && <Chip color={T.warn} pulse>UNSAVED</Chip>}
      {diskStale && <div title="The listing shows a newer copy on the printer than the one loaded here"><Chip color={T.accent}>CHANGED ON DISK</Chip></div>}
      {diskStale && <Btn small onClick={reload} title="Re-read the file from the printer (a draft is kept)">RELOAD</Btn>}
      {path && <LinkBtn href={api ? api.fileUrl("config", path) : "#"} title={"Download " + path}>GET</LinkBtn>}
      <Btn small disabled={!hasDraft || saving} onClick={revert} title="Drop the local draft">REVERT</Btn>
      <Btn small kind="ok" disabled={!changed || saving || readOnly} onClick={() => askSave(false)}>{saving ? "…" : "SAVE"}</Btn>
      <Btn small kind="warn" disabled={!changed || saving || readOnly || printing} onClick={() => askSave(true)}
        title={printing ? "Refused while printing — a restart would kill the job" : "Save, then restart Klipper"}>SAVE &amp; RESTART</Btn>
    </Row>}>
    <div style={S("padding:10px 12px")}>
      {!path && <div style={S("padding:70px 0; text-align:center")}>
        <div style={S(`${mono(10.5, `color:${T.ghost}`)}; letter-spacing:.14em`)}>SELECT A FILE</div>
        <div style={S(`font-size:12px; color:${T.faint}; margin-top:8px; text-wrap:pretty`)}>Edits are kept in this browser until you SAVE them to the printer.</div>
      </div>}

      {!!path && !editable && <div style={S("padding:50px 0; text-align:center")}>
        <div style={S(`${mono(10.5, `color:${T.mute}`)}; letter-spacing:.1em`)}>{tooBig ? "TOO LARGE TO EDIT" : "NOT A TEXT FILE"}</div>
        <div style={S(`font-size:12px; color:${T.dim}; margin-top:8px; text-wrap:pretty`)}>
          {tooBig ? fmtBytes(meta.size) + " is past the editor's " + fmtBytes(MAX_EDIT) + " limit." : "This one is only offered as a download."}</div>
        <div style={S("margin-top:12px; display:flex; justify-content:center")}><LinkBtn href={api ? api.fileUrl("config", path) : "#"}>DOWNLOAD</LinkBtn></div>
      </div>}

      {!!path && editable && <>
        <Row gap={10} style="flex-wrap:wrap; margin-bottom:8px; row-gap:4px">
          <Label>{meta ? fmtBytes(meta.size) : DASH}</Label>
          <Label>{"MODIFIED " + (meta ? fmtWhen(meta.modified) : DASH)}</Label>
          {badges.map(b => <Tag key={b} color={BADGE[b][0]} title={BADGE[b][1]}>{b}</Tag>)}
          {status && <Label style={`color:${status[1]}`}>{status[0]}</Label>}
          {!file && !!sel && connected && <Label style={`color:${T.warn}`}>NOT IN THE CURRENT LISTING</Label>}
          <div style={S("margin-left:auto")}><Label>{readOnly ? "PERMISSIONS R" : "PERMISSIONS RW"}</Label></div>
        </Row>
        {disk.error && <div style={S(`${mono(10, `color:${T.err}`)}; padding-bottom:8px`)}>{"Could not read the file: " + disk.error}</div>}
        {!ready && !disk.error && <div style={S(`${mono(10, `color:${T.ghost}`)}; padding:60px 0; text-align:center`)}>{"Loading " + path + "…"}</div>}
        {ready && engine === "loading" && <div style={S(`${mono(10, `color:${T.ghost}`)}; padding:60px 0; text-align:center`)}>Loading the editor…</div>}
        {ready && engine === "cm" && <CodeMirrorHost key={path} lib={lib} value={text} readOnly={readOnly} filename={baseOf(path)} height={EDITOR_H} onChange={onEdit} />}
        {ready && engine === "plain" && <PlainArea value={text} readOnly={readOnly} height={EDITOR_H} onChange={onEdit} />}
        <Row gap={12} style="margin-top:8px; flex-wrap:wrap">
          <Label>{lines + " LINES"}</Label>
          <Label>{fmtBytes(bytes)}</Label>
          {!!(meta && meta.modified) && <Label>{"ON DISK " + fmtWhen(meta.modified)}</Label>}
          {engine === "cm" && <Label>CODEMIRROR 6 · ⌘F SEARCH · TAB INDENTS</Label>}
          <div style={S("margin-left:auto")}>
            <Label style={`color:${storeFail ? T.err : changed ? T.warn : T.faint}`}>
              {storeFail ? "DRAFT NOT PERSISTED — BROWSER STORAGE FULL" : changed ? "DRAFT KEPT LOCALLY UNTIL SAVED" : readOnly ? "READ ONLY ON THE PRINTER" : "IN SYNC WITH THE PRINTER"}</Label>
          </div>
        </Row>
      </>}
    </div>
    {confirm && <Confirm text={confirm.text} yes={confirm.yes} onYes={() => { const c = confirm; setConfirm(null); c.run(); }} onNo={() => setConfirm(null)} />}
  </Panel>;
}

// ---------------------------------------------------------------------------------------------
export default function Page({ store, api }) {
  const st = useStore(store);                    // pages are prop elements — subscribe for ourselves

  // Orca reloads the Device tab constantly, so every choice lives in localStorage — and everything
  // read back is coerced: a stale or hand-edited key must not take the page down.
  const [selRaw, setSel] = usePersisted("config.sel", null);
  const [sortRaw, setSort] = usePersisted("config.sort", { k: "name", dir: 1 });
  // Which kinds are visible. Persisted, and a corrupt/legacy value falls back to "everything".
  const [kindsRaw, setKinds] = usePersisted("config.kinds", ALL_KINDS);
  const kinds = React.useMemo(() => {
    const list = Array.isArray(kindsRaw) ? kindsRaw.filter(k => ALL_KINDS.includes(k)) : [];
    return new Set(list.length ? list : ALL_KINDS);
  }, [kindsRaw]);
  const [qRaw, setQ] = usePersisted("config.q", "");
  const [openRaw, setOpen] = usePersisted("config.open", { main: true, mmu: true, backups: false });
  const [openDirsRaw, setOpenDirs] = usePersisted("config.openDirs", []);
  // Two different defaults, so two lists. Backup snapshot SETS are opt-IN (openDirs) because there are
  // dozens of them and nobody wants them expanded; TREE folders are opt-OUT (closedDirs) because hiding
  // the structure by default is exactly the problem the tree is here to fix.
  const [closedDirsRaw, setClosedDirs] = usePersisted("config.closedDirs", []);
  const [tick, bump] = React.useReducer(n => n + 1, 0);
  const [draftTick, bumpDrafts] = React.useReducer(n => n + 1, 0);

  const sel = selRaw && typeof selRaw === "object" && typeof selRaw.path === "string" ? selRaw : null;
  const sort = sortRaw && typeof sortRaw === "object" && SORTS.some(s => s[0] === sortRaw.k)
    ? { k: sortRaw.k, dir: sortRaw.dir === -1 ? -1 : 1 } : { k: "name", dir: 1 };
  const q = typeof qRaw === "string" ? qRaw : "";
  const open = openRaw && typeof openRaw === "object" ? openRaw : {};
  const openDirs = Array.isArray(openDirsRaw) ? openDirsRaw.filter(x => typeof x === "string") : [];
  const closedDirs = Array.isArray(closedDirsRaw) ? closedDirsRaw.filter(x => typeof x === "string") : [];

  const log = React.useCallback((message, type) => {
    if (!store) return;
    try {
      const entry = { time: Date.now() / 1000, message: String(message), type: type || "info", local: true };
      store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
    } catch (e) { /* logging must never break the page */ }
  }, [store]);
  const act = React.useMemo(() => makeMachineActions({ api, store, log }), [api, store, log]);
  const printing = isPrintActive(st);

  const listing = useAsync(() => (api && st.connected ? walkConfig(api) : PENDING), [api, st.connected, tick]);
  const rootCfg = useAsync(() => (api && st.connected ? api.fileText("config", "printer.cfg") : PENDING), [api, st.connected, tick]);

  // Moonraker announces every change under `config` (a SAVE from here, SAVE_CONFIG, Happy Hare
  // rewriting mmu_vars.cfg at each tool change) — re-walk after a short quiet period.
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    let t = null;
    const off = api.on("filelist", ev => {
      const root = ev && ev.item && ev.item.root;
      if (root && root !== "config") return;
      clearTimeout(t); t = setTimeout(bump, 1500);
    });
    return () => { clearTimeout(t); try { off(); } catch (e) { /* already gone */ } };
  }, [api]);

  const files = React.useMemo(() => (listing.data && listing.data.files) || [], [listing.data]);
  // printer.cfg's own lines resolve with no extra request, so they paint the badges immediately; the
  // rest of the graph needs one small GET per included .cfg and lands a moment later. The union is
  // what the UI reads, so a badge only ever appears — it never flips off once shown.
  const includedFlat = React.useMemo(() => includedSet(files, typeof rootCfg.data === "string" ? rootCfg.data : ""), [files, rootCfg.data]);
  const deepIncluded = useAsync(() => (api && files.length && typeof rootCfg.data === "string"
    ? resolveIncluded(api, files, rootCfg.data) : Promise.resolve(null)), [api, files, rootCfg.data]);
  const included = React.useMemo(() => (deepIncluded.data && deepIncluded.data.size
    ? new Set([...includedFlat, ...deepIncluded.data]) : includedFlat), [includedFlat, deepIncluded.data]);
  const byPath = React.useMemo(() => new Map(files.map(f => [f.path, f])), [files]);
  const grouped = React.useMemo(() => {
    const g = { main: [], mmu: [], backups: [] };
    for (const f of files) g[classify(f.path)].push(f);
    return g;
  }, [files]);
  const draftPaths = React.useMemo(() => new Set(listDrafts()), [draftTick]);   // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  // Is anything hiding rows right now? Group headers have to say so — see renderGroup.
  const filtering = !!needle || kinds.size < ALL_KINDS.length;
  // ROOT ignores the kind filter on purpose (see KINDS): printer.cfg is always reachable.
  const match = f => (!needle || f.path.toLowerCase().includes(needle)) &&
    (() => { const k = kindOf(f, included); return k === "root" || kinds.has(k); })();
  const toggleKind = k => setKinds(prev => {
    const cur = new Set(Array.isArray(prev) && prev.length ? prev.filter(x => ALL_KINDS.includes(x)) : ALL_KINDS);
    if (cur.has(k)) cur.delete(k); else cur.add(k);
    return cur.size ? ALL_KINDS.filter(x => cur.has(x)) : ALL_KINDS;   // never filter everything away
  });
  const kindCounts = React.useMemo(() => {
    const c = { root: 0, included: 0, service: 0, backups: 0, others: 0 };
    for (const f of files) c[kindOf(f, included)]++;
    return c;
  }, [files, included]);
  const cmp = React.useMemo(() => sorter(sort), [sort.k, sort.dir]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rightOf = f => (sort.k === "modified" ? fmtWhen(f.modified) : fmtBytes(f.size));

  const selFile = sel ? byPath.get(sel.path) || null : null;
  const selGroup = sel ? classify(sel.path) : null;
  const selBadges = sel ? badgesFor(selFile || { path: sel.path, name: baseOf(sel.path) }, selGroup, included) : [];

  const pick = f => setSel({ path: f.path, name: f.name, size: f.size, modified: f.modified, permissions: f.permissions });
  const toggleGroup = id => setOpen(Object.assign({}, open, { [id]: !(open[id] === undefined ? id !== "backups" : open[id]) }));
  const toggleDir = d => setOpenDirs(openDirs.includes(d) ? openDirs.filter(x => x !== d) : openDirs.concat(d));
  const toggleTreeDir = d => setClosedDirs(closedDirs.includes(d) ? closedDirs.filter(x => x !== d) : closedDirs.concat(d));
  const setSortKey = k => setSort(sort.k === k ? { k, dir: -sort.dir } : { k, dir: k === "name" ? 1 : -1 });

  const disk = listing.data && listing.data.disk;
  const skipped = (listing.data && listing.data.skipped) || [];

  const renderRows = (rows, group, indent, labelOf) => rows.map(f => {
    const badges = badgesFor(f, group, included);
    const live = badges.length > 0;
    return <FileRow key={f.path} f={f} indent={indent} active={!!sel && sel.path === f.path} dim={group !== "backups" && !live}
      badges={badges} right={rightOf(f)} draft={draftPaths.has(f.path)} onClick={() => pick(f)} {...labelOf(f)} />;
  });

  /** Folder rows + file rows, depth-first. Folders sort by name; files use the active sort. */
  const renderTree = (node, group, depth) => {
    const out = [];
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
      const child = node.dirs.get(name);
      const key = child.path || (group + "/" + name);
      // Search should reveal what it matched, so a live needle forces every folder open.
      const isOpen = needle ? true : !closedDirs.includes(key);
      out.push(<SubHead key={key + "/h"} title={name + "/"} right={String(countTree(child))} indent={depth * 12}
        open={isOpen} onToggle={() => toggleTreeDir(key)} />);
      if (isOpen) out.push(...renderTree(child, group, depth + 1));
    }
    out.push(...renderRows(node.files.slice().sort(cmp), group, depth * 12, () => ({})));
    return out;
  };

  const renderGroup = g => {
    const all = grouped[g.id];
    const rows = all.filter(match).sort(cmp);
    const isOpen = needle ? rows.length > 0 : (open[g.id] === undefined ? g.id !== "backups" : !!open[g.id]);
    // Both numbers describe the rows on screen. Counting LIVE over the UNFILTERED group produced
    // headers reading "9 LIVE  0 / 20" on a collapsed, empty group — and with a kind unticked the
    // total stayed at 20 while nine rows showed, contradicting the folder counts right beneath it.
    const live = g.id === "backups" ? 0 : rows.filter(f => f.path === "printer.cfg" || included.has(f.path)).length;
    const head = <GroupHead key={g.id + "/h"} title={g.title} accent={g.accent} hint={g.hint} open={isOpen} onToggle={() => toggleGroup(g.id)}
      right={<>
        {!!live && <Label style={`color:${T.ok}`}>{live + " LIVE"}</Label>}
        <Label>{filtering ? rows.length + " / " + all.length : String(all.length)}</Label>
      </>} />;
    if (!isOpen) return head;
    let body;
    if (!rows.length) {
      body = <div style={S(`${mono(10, `color:${T.ghost}`)}; padding:10px 12px`)}>{filtering ? "No match" : "Nothing here"}</div>;
    } else if (g.id !== "backups") {
      // A real directory tree. The flat list used to show "KAMP/" as a faint prefix on each row, which
      // read as one long list and lost the structure entirely — folders are now their own collapsible
      // rows. MMU files drop the common "mmu/" base since every row in that group shares it.
      body = renderTree(buildTree(rows, g.id === "mmu" ? "mmu/" : ""), g.id, 0);
    } else {
      const b = bucketBackups(rows);
      const sets = b.sets.slice().sort((x, y) => cmp({ path: x.dir, size: x.size, modified: x.when }, { path: y.dir, size: y.size, modified: y.when }));
      body = <>
        {!!b.printer.length && <>
          <SubHead title="PRINTER.CFG SNAPSHOTS" right={b.printer.length} />
          {renderRows(b.printer, "backups", 6, f => ({ right: f.stamp }))}
        </>}
        {!!sets.length && <>
          <SubHead title="HAPPY HARE UPGRADE SNAPSHOTS" right={sets.length + " SETS"} />
          {sets.map(s => {
            const isOpenDir = !!needle || openDirs.includes(s.dir);
            return <React.Fragment key={s.dir}>
              <SubHead title={s.dir} right={s.stamp + " · " + s.files.length} open={isOpenDir} onToggle={() => toggleDir(s.dir)} indent={6} />
              {isOpenDir && renderRows(s.files.slice().sort(cmp), "backups", 22, f => ({ label: f.path.slice(s.dir.length + 1) }))}
            </React.Fragment>;
          })}
        </>}
        {!!b.other.length && <>
          <SubHead title="OTHER" right={b.other.length} />
          {renderRows(b.other, "backups", 6, f => ({ prefix: f.dir ? f.dir + "/" : "" }))}
        </>}
      </>;
    }
    return <React.Fragment key={g.id}>{head}{body}</React.Fragment>;
  };

  return <div style={S("flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:minmax(300px,360px) minmax(520px,1fr)")}>
    <Panel title="CONFIG FILES" accent={T.info} flat style="align-self:start"
      right={<Row gap={8}>
        {listing.data && <Label>{files.length + " FILES · " + listing.data.dirs + " DIRS"}</Label>}
        {disk && <div title={fmtBytes(disk.used) + " of " + fmtBytes(disk.total) + " used"}><Label>{fmtBytes(disk.free) + " FREE"}</Label></div>}
      </Row>}>
      <div style={S("padding:8px 10px 7px; display:flex; flex-direction:column; gap:6px; min-width:0")}>
        <Row gap={6}>
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="search config files…" style="flex:1; min-width:0" />
          {!!q && <Btn small kind="ghost" onClick={() => setQ("")} title="Clear">✕</Btn>}
          <Btn small onClick={bump} title="Re-read the config directory" disabled={!st.connected}>↻</Btn>
        </Row>
        <Row gap={8} style="flex-wrap:wrap; row-gap:6px">
          <Label>SORT</Label>
          {SORTS.map(([k, label]) => {
            const on = sort.k === k;
            return <Hv key={k} as="span" onClick={() => setSortKey(k)}
              style={`${mono(9, `letter-spacing:.1em; color:${on ? T.text : T.mute}`)}; cursor:pointer; user-select:none`} hover={`color:${T.body}`}>
              {label + (on ? (sort.dir > 0 ? " ▲" : " ▼") : "")}</Hv>;
          })}
          <div style={S("width:1px; height:11px; background:" + T.line + "; margin:0 2px")} />
          <Label>SHOW</Label>
          {KINDS.map(([id, label, colour, hint]) => {
            const on = kinds.has(id);
            return <Hv key={id} as="span" onClick={() => toggleKind(id)} title={hint + " — " + kindCounts[id] + " file(s)"}
              style={`${mono(9, `letter-spacing:.08em; color:${on ? colour : T.ghost}`)}; cursor:pointer; user-select:none; padding:1px 5px; border:1px solid ${on ? colour + "55" : T.line}; border-radius:3px; background:${on ? colour + "14" : "transparent"}`}
              hover={`color:${on ? colour : T.mute}; border-color:${T.line2}`}>{label}</Hv>;
          })}
          <div style={S("margin-left:auto; display:flex; align-items:center; gap:6px")}>
            {kinds.size < ALL_KINDS.length && <Hv as="span" onClick={() => setKinds(ALL_KINDS)} title="Show every kind again"
              style={`${mono(9, `letter-spacing:.08em; color:${T.mute}`)}; cursor:pointer`} hover={`color:${T.body}`}>ALL</Hv>}
            {printing && <div title="Klipper restarts are refused until the print ends; plain saves still work"><Chip color={T.accent} pulse>PRINTING</Chip></div>}
          </div>
        </Row>
      </div>

      {listing.error && <div style={S(`display:flex; align-items:center; gap:10px; padding:8px 12px; border-top:1px solid ${T.line}`)}>
        <span style={S(`flex:1; ${mono(10, `color:${T.err}`)}; word-break:break-word`)}>{"Could not list config/: " + listing.error}</span>
        <Btn small onClick={bump}>RETRY</Btn>
      </div>}
      {!!skipped.length && <div title={skipped.join("\n")} style={S(`${mono(9.5, `color:${T.warn}`)}; padding:6px 12px; border-top:1px solid ${T.line}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>
        {"Could not read " + skipped.join(", ")}</div>}

      <div style={S(`display:flex; flex-direction:column; max-height:clamp(320px, calc(100vh - 262px), 1100px); overflow:auto; border-top:1px solid ${T.line}`)}>
        {listing.loading && !listing.data && <div style={S(`${mono(10, `color:${T.ghost}`)}; padding:40px 12px; text-align:center; line-height:1.7`)}>
          {st.connected ? "Walking config/ …" : "Waiting for the printer…"}</div>}
        {!!listing.data && !files.length && <div style={S(`${mono(10, `color:${T.ghost}`)}; padding:40px 12px; text-align:center`)}>The config root is empty</div>}
        {!!files.length && GROUPS.map(renderGroup)}
      </div>

      {(draftPaths.size > 0 || rootCfg.error) && <div style={S(`padding:7px 12px; border-top:1px solid ${T.line}; display:flex; flex-direction:column; gap:3px`)}>
        {/* The dot on a row only shows where the row does. A draft for a file that has since been
            deleted, or that the current filter hides, would otherwise be a count with nothing behind
            it — so name every one of them here. */}
        {draftPaths.size > 0 && <div title={[...draftPaths].join("\n")} style={S(`${mono(9.5, `color:${T.warn}`)}; line-height:1.5`)}>{draftPaths.size + " unsaved draft" + (draftPaths.size === 1 ? "" : "s") + " kept in this browser"}</div>}
        {rootCfg.error && <div style={S(`${mono(9.5, `color:${T.mute}`)}; line-height:1.5`)}>{"printer.cfg could not be read — INCLUDED badges are unavailable (" + rootCfg.error + ")"}</div>}
      </div>}
    </Panel>

    <EditorPanel api={api} act={act} sel={sel} file={selFile} group={selGroup} badges={selBadges}
      printing={printing} connected={!!st.connected} onDraftsChanged={bumpDrafts} />
  </div>;
}
