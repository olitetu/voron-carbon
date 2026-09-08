// G-CODE VIEWER — 3D, streamed.
//
// The renderer is a SEPARATE bundle (three + gcode-preview, ~178 KB gzipped against the app's
// 58.6 KB) that build.mjs emits as dist/viewer.js. Seven of the eight pages never touch it, so the
// <script> is injected here on mount and nowhere else. A clone without `three`/`gcode-preview`
// installed simply has no viewer.js — a normal state this page states plainly instead of crashing.
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Divider, Input, Toggle, Table, T, mono, fmtDur, fmtBytes, fmtDate } from "../../lib/design.jsx";
import { S } from "../../lib/ui.js";
import { useStore, useAsync, usePersisted } from "../../lib/useStore.js";

const VIEWER_SRC = "viewer.js";
let bundle = null;                       // one <script> per page load, shared by every mount

/** Inject dist/viewer.js once and resolve with window.CarbonViewer. */
function loadBundle() {
  if (typeof window !== "undefined" && window.CarbonViewer) return Promise.resolve(window.CarbonViewer);
  if (bundle) return bundle;
  bundle = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = VIEWER_SRC; el.async = true; el.dataset.carbonViewer = "1";
    el.onload = () => (window.CarbonViewer ? resolve(window.CarbonViewer) : reject(new Error("viewer.js loaded but window.CarbonViewer is missing")));
    el.onerror = () => reject(new Error("viewer.js is not on the server"));
    document.head.appendChild(el);
  }).catch(e => {
    // A dead <script> never fires again, so drop it and the memo — otherwise RETRY could not work.
    const el = document.querySelector("script[data-carbon-viewer]");
    if (el) el.remove();
    bundle = null;
    throw e;
  });
  return bundle;
}

/** The bundle contract carries no camera reset; call whichever name this build happens to expose. */
function resetCamera(v) {
  if (!v) return false;
  for (const m of ["resetView", "resetCamera", "reset"]) if (typeof v[m] === "function") { v[m](); return true; }
  if (v.controls && typeof v.controls.reset === "function") { v.controls.reset(); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Size policy — decided from the directory listing BEFORE a byte is fetched.
//
// Tubes build real geometry per extrusion and are what actually runs the GPU out of memory, so the
// cut-over is by file size, not by parse time. Measured here: gzip is already on (4.32×, ~1.29 MB/s
// of decompressed gcode), so the median 21.9 MB file arrives in ~17 s — streaming is what turns that
// from a blank canvas into geometry within a second or two. The biggest file on this printer is
// 398 MiB; no mode renders that in a browser tab, and pretending otherwise just hangs Orca.
// ---------------------------------------------------------------------------
const MB = 1048576;
const TUBE_MAX = 50 * MB, LINE_MAX = 150 * MB;

function planFor(size) {
  if (!Number.isFinite(size) || size <= 0) return { id: "lines", label: "FLAT LINES", color: T.warn, why: "size unknown — falling back to flat lines" };
  if (size <= TUBE_MAX) return { id: "tubes", label: "TUBES", color: T.ok, why: "≤ 50 MB — full shaded extrusions" };
  if (size <= LINE_MAX) return { id: "lines", label: "FLAT LINES", color: T.warn, why: "> 50 MB — tube geometry would exhaust GPU memory" };
  return { id: "refuse", label: "TOO LARGE", color: T.err, why: "> 150 MB — not renderable in a browser tab, in any mode" };
}
const modeTag = size => (!Number.isFinite(size) ? "—" : size <= TUBE_MAX ? "TUBE" : size <= LINE_MAX ? "LINE" : "BIG");

/** Tap the byte count without buffering — a 400 MB Blob is exactly what this page exists to avoid. */
function counted(body, onBytes) {
  if (typeof TransformStream !== "function") return body;      // no counter: progress falls back to layers
  return body.pipeThrough(new TransformStream({ transform(chunk, c) { onBytes(chunk.byteLength); c.enqueue(chunk); } }));
}

const GCODE_RE = /\.(gcode|gco|g|nc)$/i;
const num = n => (Number.isFinite(n) ? n.toLocaleString() : "—");
const str = v => (typeof v === "string" ? v : "");

const Kv = ({ k, v, color }) => (
  <Row style="justify-content:space-between; gap:12px"><Label>{k}</Label><Val size={10.5} color={color || T.body}>{v}</Val></Row>
);

/** Two-handle layer range. The design has no slider primitive, so this is the dashboard's
 *  click-a-bar idiom (logic.jsx barPick) with a second handle and pointer capture, which is what
 *  keeps a drag from sticking when the pointer leaves the track mid-move. */
function LayerRange({ lo, hi, count, disabled, onChange }) {
  const ref = React.useRef(null);
  const grab = React.useRef(null);
  const max = Math.max(0, count - 1);
  const at = e => {
    const r = ref.current.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) * max);
  };
  const move = e => {
    const v = at(e);
    if (grab.current === "lo") onChange(Math.min(v, hi), hi);
    else onChange(lo, Math.max(v, lo));
  };
  const down = e => {
    if (disabled || !ref.current || (e.button !== undefined && e.button !== 0)) return;   // never on right/middle
    const v = at(e);
    grab.current = Math.abs(v - lo) <= Math.abs(v - hi) ? "lo" : "hi";
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) { /* older webviews */ }
    move(e);
  };
  // A webview that refused the capture never delivers the pointerup that ends the drag, and the handle would
  // then follow the pointer across the track for the rest of the session. No buttons down means no drag.
  const drag = e => { if (!grab.current) return; if (!e.buttons) { grab.current = null; return; } move(e); };
  const pct = v => (max ? (v / max) * 100 : 0);
  return (
    <div ref={ref} onPointerDown={down} onPointerMove={drag}
      onPointerUp={() => { grab.current = null; }} onPointerCancel={() => { grab.current = null; }}
      style={S(`position:relative; height:16px; display:flex; align-items:center; touch-action:none; opacity:${disabled ? .35 : 1}; cursor:${disabled ? "default" : "ew-resize"}`)}>
      <div style={S(`position:absolute; left:0; right:0; height:3px; border-radius:2px; background:${T.panel2}; border:1px solid ${T.line}`)} />
      <div style={S(`position:absolute; left:${pct(lo)}%; width:${Math.max(0, pct(hi) - pct(lo))}%; height:3px; border-radius:2px; background:${T.accent}`)} />
      <div style={S(`position:absolute; left:${pct(lo)}%; margin-left:-1.5px; width:3px; height:12px; border-radius:1px; background:${T.info}`)} />
      <div style={S(`position:absolute; left:${pct(hi)}%; margin-left:-1.5px; width:3px; height:12px; border-radius:1px; background:${T.accent}`)} />
    </div>
  );
}

export default function Page({ store, api, route, navigate }) {
  const st = useStore(store);

  // Orca reloads the Device tab on nearly every preset change, so every choice here is persisted.
  const [selRaw, setSel] = usePersisted("viewer.file", "");
  const [dirRaw, setDir] = usePersisted("viewer.dir", "");
  const [filterRaw, setFilter] = usePersisted("viewer.filter", "");
  const [tubes, setTubes] = usePersisted("viewer.tubes", true);
  const [embed, setEmbed] = usePersisted("viewer.embed", false);
  // Kept with the file it belongs to: restoring "layers 0-50" onto a different model is nonsense.
  const [rangeRaw, setRange] = usePersisted("viewer.range", { f: "", lo: 0, hi: -1 });
  // localStorage is user-writable and outlives every version of this page, so nothing read back from
  // it is dereferenced raw: one value of the wrong type would white-screen the tab on first render.
  const sel = str(selRaw), dir = str(dirRaw), filter = str(filterRaw);
  const range = rangeRaw && typeof rangeRaw === "object" ? rangeRaw : { f: "", lo: 0, hi: -1 };

  const [lib, setLib] = React.useState(() => (typeof window !== "undefined" && window.CarbonViewer) || null);
  const [libErr, setLibErr] = React.useState(null);
  const [ctxLost, setCtxLost] = React.useState(false);         // the GPU took the WebGL context back
  const [surfaceKey, setSurfaceKey] = React.useState(0);       // bump to tear the surface down and rebuild it
  const [phase, setPhase] = React.useState("idle");            // idle | loading | ready | error
  const [err, setErr] = React.useState(null);
  const [prog, setProg] = React.useState({ bytes: 0, layers: 0, ms: 0 });
  const [stats, setStats] = React.useState(null);
  const [thumbBad, setThumbBad] = React.useState(false);       // a listed thumbnail can 404 after a re-upload

  const hostRef = React.useRef(null);
  const viewerRef = React.useRef(null);
  const abortRef = React.useRef(null);
  const gotRef = React.useRef(0);
  const startRef = React.useRef(0);

  /** Shared console line (the dashboard + console page both read store.log). */
  const log = React.useCallback((message, type) => {
    try {
      const entry = { time: Date.now() / 1000, message: String(message), type: type || "info", local: true };
      store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
    } catch (e) { /* logging must never break the page */ }
  }, [store]);

  // ---- selection ---------------------------------------------------------------------
  // Deep link from the files page (/viewer?filename=… , the contract also writes ?file=). Consumed
  // once and stripped: Orca restores the whole route on every reload, so a query left in the hash
  // would re-select that file over whatever the user picked afterwards, all day long.
  const deep = route && route.query ? (route.query.get("filename") || route.query.get("file") || "") : "";
  React.useEffect(() => {
    if (!deep) return;
    setSel(deep);
    navigate("/viewer");
  }, [deep]);   // eslint-disable-line react-hooks/exhaustive-deps

  const printing = String(((st.raw || {}).print_stats || {}).filename || "");
  const jobActive = ["printing", "paused"].includes(String(((st.raw || {}).print_stats || {}).state || "").toLowerCase());
  const defaulted = React.useRef(false);
  React.useEffect(() => {
    if (defaulted.current || sel || deep || !printing) return;
    defaulted.current = true;                       // only ever a first-visit default, never a snap-back
    setSel(p => p || printing);                     // functional: a deep link queued in the same commit wins
  }, [printing, sel, deep, setSel]);

  // ---- listing + metadata ------------------------------------------------------------
  const root = "gcodes" + (dir ? "/" + dir : "");
  // st.connected is a dependency, not just a guard: boot() opens the socket asynchronously, so an
  // rpc issued on the first render of a fresh load rejects with "not connected" — and Orca hands
  // this page a fresh load constantly. Staying pending until the socket is up keeps that non-event
  // out of the error state, and re-lists after a reconnect for free.
  //
  // extended=false on purpose: this printer's 209 files are 263 KB extended against 24.6 KB plain,
  // and the size policy only needs `size`. The one selected file gets the rich metadata below.
  const listing = useAsync(() => (st.connected ? api.dirInfo(root, false) : new Promise(() => {})), [root, st.connected]);
  const reloadList = listing.reload;
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    // Moonraker announces every file change, its own thumbnail writes during a metadata scan
    // included; coalesce the burst instead of re-listing the whole directory per event.
    let t = null;
    const off = api.on("filelist", ev => {
      const item = (ev && (ev.item || ev.source_item)) || {};
      if (item.root && item.root !== "gcodes") return;
      clearTimeout(t);
      t = setTimeout(reloadList, 400);
    });
    return () => { clearTimeout(t); if (typeof off === "function") off(); };
  }, [api, reloadList]);

  // The result carries the file it describes: useAsync keeps the PREVIOUS data while it reloads, and a
  // stale `size` here is not cosmetic — it picks the render plan. Selecting the 398 MB file straight
  // after a 48 MB one used to show "TUBES · ≤ 50 MB" with RENDER enabled for the whole round-trip.
  const meta = useAsync(() => (!sel ? Promise.resolve(null) : st.connected ? api.fileMeta(sel).then(m => (m && typeof m === "object" ? { ...m, forFile: sel } : m)) : new Promise(() => {})), [sel, st.connected]);
  const info = meta.data && meta.data.forFile === sel ? meta.data : null;

  const files = (listing.data && listing.data.files) || [];
  const dirs = (listing.data && listing.data.dirs) || [];
  const fullPath = name => (dir ? dir + "/" : "") + name;
  const listed = files.find(f => fullPath(f.filename) === sel) || null;
  // The directory row is authoritative the instant it exists, so a listed file never waits on metadata.
  const size = (listed && listed.size) || (info && info.size) || 0;
  const sizing = !size && !!sel && meta.loading;
  const plan = sel && !sizing ? planFor(size) : null;    // never show a plan chosen from a size we do not have yet
  const blocked = !!plan && plan.id === "refuse";
  const showCanvas = !!lib && !embed && !blocked;

  const rows = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    const up = dir ? [{ kind: "up", name: "..", size: null }] : [];
    const ds = dirs.map(d => String(d.dirname || "")).filter(n => n && !n.startsWith(".")).map(n => ({ kind: "dir", name: n, size: null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const fs = files.filter(f => GCODE_RE.test(f.filename))
      .filter(f => !q || f.filename.toLowerCase().includes(q))
      .map(f => ({ kind: "file", name: f.filename, size: f.size, modified: f.modified, path: fullPath(f.filename) }))
      .sort((a, b) => (b.modified || 0) - (a.modified || 0));
    return up.concat(ds, fs);
  }, [files, dirs, dir, filter]);

  // ---- viewer lifecycle --------------------------------------------------------------
  React.useEffect(() => {
    let alive = true;
    // setLib(() => v), never setLib(v): if the bundle exports a callable (a class or factory) React
    // would take it for a state updater and store whatever calling it returned.
    loadBundle().then(v => { if (alive) setLib(() => v); }).catch(e => { if (alive) setLibErr(e.message || String(e)); });
    return () => { alive = false; };
  }, []);

  // The bed grid and the opening camera are sized from these. They arrive over the socket, which on a cold
  // Orca reload can land AFTER viewer.js does — so they are also pushed into a viewer that was built on the
  // fallback (this printer is 335×355×320, nothing like the 350×350×310 default).
  const axis = Array.isArray(((st.raw || {}).toolhead || {}).axis_maximum) ? st.raw.toolhead.axis_maximum : null;
  const bx = Number(axis && axis[0]) || 350, by = Number(axis && axis[1]) || 350, bz = Number(axis && axis[2]) || 310;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!lib || !showCanvas || !host) return undefined;
    let v = null;
    try {
      v = lib.create(host, { backgroundColor: T.bg, renderTubes: tubes, buildVolume: { x: bx, y: by, z: bz } });
    } catch (e) {
      setLibErr("viewer.js could not create a WebGL context: " + (e.message || String(e)));
      return undefined;
    }
    viewerRef.current = v;
    // The bundle reports a context the browser took away — three keeps the scene and simply stops drawing,
    // so without this the panel freezes mid-model while every control still claims to work.
    v.onContextLost = isLost => {
      if (!isLost) return;
      setCtxLost(true);
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }   // nothing left to draw into
      setPhase(p => (p === "loading" ? "idle" : p));
    };
    setPhase("idle"); setStats(null); setCtxLost(false);
    const ro = window.ResizeObserver ? new ResizeObserver(() => { try { v.resize(); } catch (e) { /* teardown race */ } }) : null;
    if (ro) ro.observe(host);
    return () => {
      if (ro) ro.disconnect();
      viewerRef.current = null;
      // The surface this load was streaming into is going away (MAINSAIL, a >150 MB pick, unmount): finish
      // the fetch here or it runs to completion and stamps "ready" onto a viewer that no longer exists.
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      setPhase(p => (p === "loading" ? "idle" : p));
      setCtxLost(false);                              // a loss belongs to the surface that had it
      try { v.dispose(); } catch (e) { /* already gone */ }
    };
    // Re-created only when the surface itself appears, disappears, or is rebuilt after a context loss.
  }, [lib, showCanvas, surfaceKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A late toolhead must not leave the bed grid drawn at the fallback size for the rest of the session.
  React.useEffect(() => {
    const v = viewerRef.current;
    if (!v || !axis) return;
    try { v.setBuildVolume({ x: bx, y: by, z: bz }); } catch (e) { /* bundle predates setBuildVolume */ }
  }, [bx, by, bz, lib, showCanvas, surfaceKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  // Progress is polled, not pushed: a setState per chunk would re-render the page hundreds of times.
  React.useEffect(() => {
    if (phase !== "loading") return undefined;
    const id = setInterval(() => {
      const s = viewerRef.current && viewerRef.current.stats;
      setProg({ bytes: gotRef.current, layers: (s && s.layerCount) || 0, ms: performance.now() - startRef.current });
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  // "ready" alone is not enough to drive the controls: switching to MAINSAIL (or picking a >150 MB file)
  // disposes the surface without touching `phase`, and a lost context leaves it drawing nothing. Every
  // control that steers the render — and every stat that describes it — hangs off a LIVE surface.
  const live = phase === "ready" && showCanvas && !ctxLost;
  const count = live ? (stats && stats.layerCount) || 0 : 0;
  const lo = range.f === sel ? Math.min(range.lo, Math.max(0, count - 1)) : 0;
  const hi = range.f === sel && range.hi >= 0 ? Math.min(range.hi, Math.max(0, count - 1)) : Math.max(0, count - 1);

  React.useEffect(() => {
    const v = viewerRef.current;
    if (!v || !live || !count) return;
    try { v.setLayerRange(lo, hi); } catch (e) { /* bundle predates setLayerRange */ }
  }, [lo, hi, count, live]);

  React.useEffect(() => {
    const v = viewerRef.current;
    if (!v || !live) return;
    try { v.setRenderTubes(plan && plan.id === "tubes" && tubes); } catch (e) { /* bundle predates setRenderTubes */ }
  }, [tubes, live, plan && plan.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- load / abort ------------------------------------------------------------------
  /** Drop the parsed job and every buffer it put on the GPU. Aborting or changing files leaves the
   *  surface describing a file it no longer shows: without this the half-built model stays resident —
   *  measured at 3 progressive batches for a 3 MB abort, and hundreds of MB for the large files ABORT
   *  exists for — and shows through the 72 %-opaque idle overlay. */
  const clearSurface = React.useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    try { v.clear(); } catch (e) { /* nothing has been rendered yet */ }
  }, []);

  // Whoever aborts owns the phase; the abandoned load sees abortRef move and returns silently.
  const stop = React.useCallback(quiet => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    setPhase(p => (p === "loading" ? "idle" : p));
    if (!quiet) log("VIEWER — load aborted", "warn");
    // The abandoned parse unwinds a few microtasks after the signal fires, so the clear waits a turn —
    // and skips entirely when a newer load has already claimed the viewer (load() calls stop() first).
    setTimeout(() => { if (!abortRef.current) clearSurface(); }, 0);
  }, [log, clearSurface]);

  // One reset point for every way the file can change — a row click, a deep link, the printing-file
  // default. Without it a load still in flight when the selection moves finishes and stamps its
  // layer counts, stats and "ready" onto a file they do not describe.
  const shown = React.useRef(null);
  React.useEffect(() => {
    if (shown.current === sel) return;
    shown.current = sel;
    stop(true);
    clearSurface();                                 // the surface no longer describes the selected file
    setPhase("idle"); setErr(null); setStats(null); setThumbBad(false);
    setProg({ bytes: 0, layers: 0, ms: 0 });
  }, [sel, stop, clearSurface]);

  const load = React.useCallback(async () => {
    const v = viewerRef.current;
    if (!v || !sel || !plan || plan.id === "refuse") return;
    stop(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    gotRef.current = 0; startRef.current = performance.now();
    setPhase("loading"); setErr(null); setStats(null); setProg({ bytes: 0, layers: 0, ms: 0 });
    log(`VIEWER — streaming ${sel} (${size ? fmtBytes(size) : "size unknown"}, ${plan.label.toLowerCase()})`, "info");
    // Read-only, but off the same disk Klipper streams the job from — the files page warns on uploads for this.
    if (jobActive && size > TUBE_MAX) log("VIEWER — reading a large file while a print runs competes with Klipper for the same disk", "warn");
    let capped = false;
    try {
      try { v.clear(); } catch (e) { /* first load */ }
      try { v.setRenderTubes(plan.id === "tubes" && tubes); } catch (e) { /* bundle predates it */ }
      if (typeof TextDecoderStream !== "function") throw new Error("this webview has no TextDecoderStream");
      const r = await fetch(api.fileUrl("gcodes", sel), { signal: ctrl.signal });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText || "fetch failed"}`);
      if (!r.body) throw new Error("this webview cannot stream responses");
      // The size policy runs off the directory listing. A file that is not IN that listing (a deep link or
      // the printing-file default while the picker sits in a subfolder) and whose metadata Moonraker never
      // scanned reaches here with size 0 — which reads as "unknown", not as "refused", and would walk the
      // 417 MB file on this printer straight past the 150 MB gate. The stream itself holds the line.
      const text = counted(r.body, n => {
        gotRef.current += n;
        if (!capped && gotRef.current > LINE_MAX) { capped = true; ctrl.abort(); }
      }).pipeThrough(new TextDecoderStream());
      await v.processGCodeStream(text, { render: true });
      if (abortRef.current !== ctrl) return;                     // aborted, or superseded by a newer load
      const s = v.stats || {};
      abortRef.current = null;
      setStats(s);
      setRange(p => ((p && p.f) === sel ? p : { f: sel, lo: 0, hi: -1 }));   // a restored range for THIS file survives
      setPhase("ready");
      const secs = (performance.now() - startRef.current) / 1000;
      log(`VIEWER — ${sel}: ${num(s.layerCount)} layers, ${num(s.pathCount)} paths in ${secs.toFixed(1)} s`, "ok");
      // Streamed to the end and produced nothing: an empty file, a .gcode that is not one, or pure travel.
      // `layerCount` alone would not do — a non-planar job (vase mode, conical slicing) renders fine with no
      // layer index at all, and gcode-preview drops that index the moment it sees one.
      if (!s.pathCount) log(`VIEWER — ${sel}: no printable geometry — nothing to show`, "warn");
      else if (!s.layerCount) log(`VIEWER — ${sel}: non-planar job — no layer index, the layer range is off`, "warn");
    } catch (e) {
      if (abortRef.current !== ctrl) return;                     // abort/supersede is not a failure
      abortRef.current = null;
      const m = capped
        ? `stopped after ${fmtBytes(LINE_MAX)} — this file is bigger than a browser tab can render and the directory listing never gave its size`
        : (e && e.message) || String(e);
      clearSurface();                                            // a half-parsed job is still holding the GPU
      setErr(m); setPhase("error");
      log("VIEWER — " + sel + ": " + m, "err");
    }
  }, [api, sel, plan, size, tubes, jobActive, stop, log, setRange, clearSurface]);

  // ---- Mainsail escape hatch ---------------------------------------------------------
  // Mainsail sits at the printer root on :80 while Carbon is served from :8767 on the same host, so
  // the port comes off. Its router is in HISTORY mode — there is NO '#' — and the query wants the
  // root prefix: /viewer?filename=gcodes/<relpath>. Embedded, never target=_blank: Orca's
  // OnNewWindow handler would eject the user into their system browser and cancel the navigation.
  const mainsail = React.useMemo(() => {
    const host = String(api.base || location.origin).replace(/:\d+$/, "");
    return host + "/viewer?filename=" + encodeURIComponent("gcodes/" + sel).replace(/%2F/g, "/");
  }, [api, sel]);
  const [frameUp, setFrameUp] = React.useState(false);
  React.useEffect(() => { setFrameUp(false); }, [mainsail, embed]);   // a new src is a new load

  const select = row => {
    if (row.kind === "up") return setDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
    if (row.kind === "dir") return setDir(dir ? dir + "/" + row.name : row.name);
    if (row.path === sel) return;
    setSel(row.path);                                 // the reset effect above drops any in-flight render
  };

  const busy = phase === "loading";
  const shownSize = size ? fmtBytes(size) : "SIZE UNKNOWN";
  const pct = size ? Math.min(100, (prog.bytes / size) * 100) : 0;
  const rate = prog.ms > 300 ? prog.bytes / prog.ms / 1000 : 0;      // bytes/ms -> MB/s (decimal, like the measurement)
  const eta = rate > 0 && size > prog.bytes ? (size - prog.bytes) / (rate * 1e6) : 0;

  // A 300×300 thumbnail is ~7 KB. Moonraker reports `relative_path` against the FILE's own directory
  // (its .thumbs cache sits beside the gcode) — NOT the folder being browsed, which is a different
  // place the moment a deep link or the printing-file default selects something outside `dir`.
  const selDir = sel.includes("/") ? sel.slice(0, sel.lastIndexOf("/") + 1) : "";
  const thumb = ((info && info.thumbnails) || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  const thumbUrl = thumb && thumb.relative_path ? api.fileUrl("gcodes", selDir + thumb.relative_path) : null;

  // The shell's <main> is min-height:100vh with no definite height, so `flex:1` alone would leave this
  // row content-driven: the 209-row list would stretch the page and drag the absolutely-positioned
  // canvas host to the same height. Both columns are pinned to the viewport, as on the files page.
  return (
    <div style={S("flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:340px minmax(560px,1fr)")}>

      {/* ---- left rail: pick a file, see the plan, drive the render ---- */}
      <div style={S("display:flex; flex-direction:column; gap:10px; height:calc(100vh - 76px); min-height:520px; min-width:0")}>

        <Panel title="SOURCE FILE" style="flex:1; min-height:220px" bodyStyle="display:flex; flex-direction:column; gap:8px; padding:8px 10px; min-height:0"
          right={<Row gap={6}>
            <Btn small kind="ghost" onClick={() => navigate("/files")} title="Open the file browser">BROWSE</Btn>
            <Btn small kind="ghost" onClick={reloadList} title="Re-read the directory">↻</Btn>
          </Row>}>
          <Row gap={6}>
            <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter…" style="flex:1; min-width:0" />
            <Val size={9} color={T.faint}>{dir ? "/" + dir : "gcodes"}</Val>
          </Row>
          <div style={S("flex:1; min-height:0; overflow:auto; margin:0 -10px; padding:0 10px")}>
            {!st.connected && <div style={S(`padding:14px 2px; ${mono(10, `letter-spacing:.2em; color:${T.mute}`)}`)}>WAITING FOR MOONRAKER…</div>}
            {st.connected && listing.loading && !listing.data && <div style={S(`padding:14px 2px; ${mono(10, `color:${T.mute}`)}`)}>READING DIRECTORY…</div>}
            {/* `dir` is persisted, so a folder deleted from elsewhere would otherwise be a dead end: the ".."
                row lives in the table, and the table is exactly what an error replaces. */}
            {st.connected && listing.error && <Row gap={8} style="padding:10px 2px; flex-wrap:wrap">
              <Val size={10} color={T.err}>{listing.error}</Val><Btn small onClick={reloadList}>RETRY</Btn>
              {!!dir && <Btn small onClick={() => setDir("")}>↑ ROOT</Btn>}
            </Row>}
            {st.connected && !listing.error && (listing.data || !listing.loading) && <Table
              cols={[
                { k: "name", label: "FILE", w: "minmax(0,1fr)", render: r => (
                  <Row gap={6}>
                    <span style={S(`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${r.kind === "file" ? (r.path === sel ? T.text : T.body) : T.dim}`)}>{r.kind === "file" ? r.name : (r.kind === "up" ? ".." : "▸ " + r.name)}</span>
                    {r.path && r.path === printing && <Chip color={T.accent} border="#4a2318" bg="#1a0e09">PRINTING</Chip>}
                  </Row>) },
                { k: "size", label: "SIZE", w: "70px", align: "right", render: r => (r.size == null ? "—" : fmtBytes(r.size)) },
                { k: "mode", label: "MODE", w: "44px", align: "right", render: r => (r.size == null ? "" :
                  <span style={S(`color:${planFor(r.size).color}`)}>{modeTag(r.size)}</span>) },
              ]}
              rows={rows} rowKey={r => r.kind + ":" + r.name} onRow={select}
              rowStyle={r => (r.path && r.path === sel ? "background:#131a24" : "")}
              empty={filter ? "NO MATCH" : "NO G-CODE FILES"} />}
          </div>
        </Panel>

        <Panel title="RENDER PLAN" accent={plan ? plan.color : T.line2}
          right={plan && <Chip color={plan.color} border={plan.color + "44"} bg={T.panel2}>{plan.label}</Chip>}>
          {!sel && <div style={S(`${mono(10, `color:${T.mute}`)}; padding:6px 0`)}>NO FILE SELECTED</div>}
          {!!sel && <div style={S("display:flex; flex-direction:column; gap:6px")}>
            <Row gap={8} align="flex-start">
              {thumbUrl && !thumbBad && <img src={thumbUrl} alt="" decoding="async" onError={() => setThumbBad(true)}
                style={S(`width:56px; height:56px; object-fit:contain; border:1px solid ${T.line}; border-radius:4px; background:${T.panel2}; flex:none`)} />}
              <div style={S("min-width:0; flex:1; display:flex; flex-direction:column; gap:3px")}>
                <div style={S(`${mono(10.5, `color:${T.text}`)}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)} title={sel}>{sel.replace(/^.*\//, "")}</div>
                <Val size={9.5} color={T.mute}>{sizing ? "READING METADATA…" : shownSize}</Val>
                {info && <Val size={9.5} color={T.faint}>{[
                  info.layer_count ? info.layer_count + " layers" : null,
                  info.estimated_time ? fmtDur(info.estimated_time) : null,
                  info.modified ? fmtDate(info.modified) : null,
                ].filter(Boolean).join("  ·  ")}</Val>}
                {/* Moonraker answers "Metadata not available" for anything it never scanned (a file dropped in
                    over SSH, a scan still running). Silence there reads as "no thumbnail"; it is why the plan
                    below may have had to guess. */}
                {!info && !sizing && !!meta.error && <Val size={9.5} color={T.warn}
                  style="display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
                  >NO METADATA · {meta.error}</Val>}
              </div>
            </Row>
            {plan && <div style={S(`${mono(9.5, `color:${plan.color}`)}; letter-spacing:.04em`)}>{plan.why}</div>}
            <Divider />
            {busy ? <div style={S("display:flex; flex-direction:column; gap:6px")}>
              <div style={S(`height:4px; border-radius:2px; background:${T.panel2}; overflow:hidden`)}>
                <div style={S(`height:100%; width:${pct.toFixed(1)}%; background:${T.accent}; transition:width .2s linear`)} />
              </div>
              <Row style="justify-content:space-between">
                <Val size={9.5} color={T.dim}>{fmtBytes(prog.bytes)}{size ? " / " + fmtBytes(size) : ""}  ·  {prog.layers} layers</Val>
                <Val size={9.5} color={T.mute}>{rate ? rate.toFixed(2) + " MB/s" : "…"}{eta > 1 ? "  ·  " + fmtDur(eta) + " left" : ""}</Val>
              </Row>
              <Btn kind="danger" onClick={() => stop()}>ABORT LOAD</Btn>
            </div> : <Row gap={6}>
              <Btn kind="accent" disabled={!sel || blocked || !showCanvas || sizing || ctxLost} onClick={load}
                title={blocked ? "Refused — over 150 MB" : embed ? "Switch back to CARBON 3D to render here" : !lib ? "The 3D bundle is not available" : ctxLost ? "The WebGL context was lost — rebuild the surface first" : "Stream and render"}
                style="flex:1; text-align:center">{live ? "RELOAD" : "RENDER"}</Btn>
            </Row>}
          </div>}
        </Panel>

        <Panel title="CONTROLS">
          <div style={S("display:flex; flex-direction:column; gap:8px")}>
            <Row style="justify-content:space-between">
              <Label>LAYERS {count ? `${lo + 1}–${hi + 1}` : "—"}</Label>
              <Val size={9.5} color={T.mute}>{count ? "OF " + count : "—"}</Val>
            </Row>
            <LayerRange lo={lo} hi={hi} count={count} disabled={!live || count < 2}
              onChange={(a, b) => setRange({ f: sel, lo: a, hi: b >= count - 1 ? -1 : b })} />
            <Row gap={6}>
              <Btn small disabled={!live} onClick={() => setRange({ f: sel, lo: 0, hi: -1 })}>ALL</Btn>
              <Btn small disabled={!live || !count} onClick={() => setRange({ f: sel, lo: 0, hi: 0 })} title="First layer only — the one worth inspecting">FIRST</Btn>
              <Btn small disabled={!live || !count} onClick={() => setRange({ f: sel, lo: hi, hi: hi >= count - 1 ? -1 : hi })} title="Collapse the range to its top layer">SINGLE</Btn>
            </Row>
            <Divider />
            <Row style="justify-content:space-between">
              <Label>TUBES</Label>
              <Row gap={8}>
                {plan && plan.id === "lines" && <Val size={9} color={T.warn}>LOCKED OFF</Val>}
                <Toggle on={!!tubes && (!plan || plan.id === "tubes")}
                  onClick={() => { if (!plan || plan.id === "tubes") setTubes(!tubes); else log("VIEWER — tubes stay off above 50 MB; the GPU cannot hold that much geometry", "warn"); }} />
              </Row>
            </Row>
            <Btn small disabled={!live} onClick={() => { if (viewerRef.current && !resetCamera(viewerRef.current)) log("VIEWER — this viewer bundle exposes no camera reset", "warn"); }}>RESET VIEW</Btn>
            <Divider />
            <Kv k="LAYERS" v={live && stats ? num(stats.layerCount) : "—"} />
            <Kv k="PATHS" v={live && stats ? num(stats.pathCount) : "—"} />
            <Kv k="POINTS" v={live && stats ? num(stats.points) : "—"} />
          </div>
        </Panel>
      </div>

      {/* ---- right: the render surface ---- */}
      <Panel title="G-CODE VIEWER" flat style="height:calc(100vh - 76px); min-height:520px"
        bodyStyle="position:relative; overflow:hidden; border-radius:0 0 5px 5px"
        right={<Row gap={6}>
          <Btn small kind={embed ? "ghost" : "accent"} onClick={() => { if (embed) { stop(true); setEmbed(false); } }}>CARBON 3D</Btn>
          <Btn small kind={embed ? "accent" : "ghost"} disabled={!sel} title="Mainsail's own viewer, embedded"
            onClick={() => { stop(true); setEmbed(true); }}>MAINSAIL</Btn>
        </Row>}>

        {/* #121212 is Mainsail's own theme-color, so the frame does not flash a different dark before it paints. */}
        {embed && sel && <React.Fragment>
          <iframe src={mainsail} title="Mainsail G-code viewer" onLoad={() => setFrameUp(true)}
            style={S("position:absolute; inset:0; width:100%; height:100%; border:0; background:#121212")} />
          {/* Mainsail is a whole SPA booting over the same WiFi, and this hatch is used exactly when the file
              is enormous: without this the panel is a flat rectangle for seconds with nothing to read. */}
          {!frameUp && <Center>
            <Val size={11} color={T.dim}>LOADING MAINSAIL…</Val>
            <Val size={10} color={T.faint}>{mainsail.replace(/^https?:\/\//, "")}</Val>
          </Center>}
        </React.Fragment>}

        {!embed && showCanvas && <div key={surfaceKey} ref={hostRef} style={S("position:absolute; inset:0")} />}

        {/* overlays — every non-rendering state is part of the design, not an afterthought */}
        {!embed && !lib && !libErr && <Center><Val size={11} color={T.dim}>LOADING 3D BUNDLE…</Val></Center>}

        {/* WKWebView hands out a handful of GL contexts and takes the oldest back; Orca rebuilds this page on
            every preset change. Nothing here is broken — the surface just has to be built again. */}
        {showCanvas && ctxLost && <Center>
          <Val size={11} color={T.err}>3D CONTEXT LOST</Val>
          <Val size={10.5} color={T.dim} style="max-width:460px; text-align:center; line-height:1.6">
            The browser took this page's WebGL context back, so nothing is being drawn any more. Rebuilding the
            surface starts a new one; the file has to be streamed again.
          </Val>
          <Row gap={6}>
            <Btn small kind="accent" onClick={() => { setCtxLost(false); setSurfaceKey(k => k + 1); }}>REBUILD SURFACE</Btn>
            <Btn small kind="ghost" disabled={!sel} onClick={() => { stop(true); setEmbed(true); }}>USE MAINSAIL</Btn>
          </Row>
        </Center>}

        {!embed && libErr && <Center>
          <Val size={11} color={T.accent}>3D VIEWER BUNDLE NOT INSTALLED</Val>
          <Val size={11} color={T.dim} style="max-width:460px; text-align:center; line-height:1.6">{libErr}</Val>
          <Val size={10.5} color={T.faint} style="max-width:460px; text-align:center; line-height:1.6">
            dist/viewer.js is built only when three + gcode-preview are installed (see build.mjs). Mainsail's viewer works meanwhile.
          </Val>
          <Row gap={6}>
            <Btn small onClick={() => { setLibErr(null); loadBundle().then(v => setLib(() => v)).catch(e => setLibErr(e.message || String(e))); }}>RETRY</Btn>
            <Btn small kind="accent" disabled={!sel} onClick={() => setEmbed(true)}>USE MAINSAIL</Btn>
          </Row>
        </Center>}

        {!embed && lib && blocked && <Center>
          <Val size={11} color={T.err}>{fmtBytes(size)} — REFUSED</Val>
          <Val size={11} color={T.dim} style="max-width:520px; text-align:center; line-height:1.6">
            A file this large cannot be rendered in a browser tab in any mode: the parsed geometry alone would run to
            gigabytes. Nothing has been fetched. Mainsail's own viewer can take over this panel — it downloads and parses
            the whole file in one go, so be aware it will very likely stall too.
          </Val>
          <Btn small kind="accent" onClick={() => setEmbed(true)}>OPEN MAINSAIL VIEWER</Btn>
        </Center>}

        {!sel && (embed || lib) && !ctxLost && <Center><Val size={11} color={T.mute}>SELECT A G-CODE FILE</Val></Center>}

        {!embed && lib && !blocked && !ctxLost && !!sel && phase === "idle" && <Center>
          <Val size={11} color={T.dim}>{sel.replace(/^.*\//, "")}</Val>
          <Val size={10.5} color={T.faint}>{sizing ? "READING METADATA…" : `${shownSize} · ${plan ? plan.label.toLowerCase() : ""}`}</Val>
          <Btn kind="accent" disabled={sizing} onClick={load}>RENDER</Btn>
        </Center>}

        {/* Streamed clean and produced nothing: an empty file, travel-only gcode, or a .gcode that is not one.
            Without this the panel is an empty bed that looks exactly like a viewer that failed to draw. Judged
            on paths, never on layers: a non-planar job draws perfectly and has no layer index. */}
        {live && stats && !stats.pathCount && <Center>
          <Val size={11} color={T.warn}>NO GEOMETRY</Val>
          <Val size={10.5} color={T.dim} style="max-width:460px; text-align:center; line-height:1.6">
            {sel.replace(/^.*\//, "")} streamed to the end without a single layer — no extrusion moves were found in it.
          </Val>
        </Center>}

        {!embed && lib && phase === "loading" && !ctxLost && <div style={S("position:absolute; left:0; right:0; bottom:0; padding:10px 12px; background:linear-gradient(to top,rgba(6,8,11,.92),rgba(6,8,11,0)); display:flex; flex-direction:column; gap:6px")}>
          <div style={S(`height:3px; border-radius:2px; background:${T.panel2}; overflow:hidden`)}>
            <div style={S(`height:100%; width:${pct.toFixed(1)}%; background:${T.accent}; transition:width .2s linear`)} />
          </div>
          <Row style="justify-content:space-between">
            <Val size={9.5} color={T.dim}>STREAMING · {fmtBytes(prog.bytes)}{size ? " / " + fmtBytes(size) : ""} · {prog.layers} layers</Val>
            <Btn small kind="danger" onClick={() => stop()}>ABORT</Btn>
          </Row>
        </div>}

        {!embed && lib && phase === "error" && !ctxLost && <Center>
          <Val size={11} color={T.err}>RENDER FAILED</Val>
          <Val size={10.5} color={T.dim} style="max-width:460px; text-align:center; line-height:1.6">{err}</Val>
          <Row gap={6}><Btn small onClick={load}>RETRY</Btn><Btn small kind="ghost" onClick={() => setEmbed(true)}>USE MAINSAIL</Btn></Row>
        </Center>}
      </Panel>
    </div>
  );
}

/** Centred overlay used by every non-rendering state of the surface. */
function Center({ children }) {
  return <div style={S("position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:30px; background:rgba(6,8,11,.72); animation:vRise .16s ease both")}>{children}</div>;
}
