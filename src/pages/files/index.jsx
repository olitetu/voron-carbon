// G-CODE FILES — Moonraker file browser over the `gcodes` root.
//
// Everything shown here comes from ONE call: api.dirInfo(path, true). Moonraker's extended listing already
// carries the slicer metadata (layers, estimated time, filament, thumbnails, referenced_tools, colours), so the
// page never reads a gcode file itself — on this printer that would mean parsing up to 398 MB in the browser.
//
// Files: 209 in the root, 7.15 GB, 37 of them over 50 MB — so size is a first-class column, the list scrolls
// internally rather than growing the page, and row thumbnails are lazy (209 <img> would otherwise be 209
// round trips to the Pi on mount).
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Input, Table, Confirm, T, mono, fmtDur, fmtBytes, fmtDate } from "../../lib/design.jsx";
import { S, Hv } from "../../lib/ui.js";
import { useStore, useAsync, usePersisted } from "../../lib/useStore.js";
import { makeFilesActions, joinPath, dirOf, baseOf, stripRoot, keepExtension, validName, isGcode } from "../../lib/actions/files.js";

const BIG = 50 * 1024 * 1024, HUGE = 200 * 1024 * 1024;
const SORTS = [["name", "NAME"], ["size", "SIZE"], ["modified", "MODIFIED"], ["est", "EST"]];
const DASH = "—";
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const sizeColor = n => (n > HUGE ? T.accent : n > BIG ? T.warn : T.body);
const hasFiles = e => !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));

/**
 * Thumbnail URL for a listing entry. `relative_path` is relative to the FILE's own directory
 * (Moonraker keeps a `.thumbs` cache beside each gcode), not to the gcodes root, so the current
 * directory has to be joined back on before it becomes a URL.
 */
function thumbUrl(api, dir, f, want) {
  const list = (f && Array.isArray(f.thumbnails) ? f.thumbnails : []).filter(t => t && t.relative_path);
  if (!list.length || !api) return null;
  const byW = list.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  const best = byW.find(t => (t.width || 0) >= want) || byW[byW.length - 1];
  return api.fileUrl("gcodes", joinPath(dir, best.relative_path));
}

/**
 * Per-extruder slicer metadata arrives in TWO shapes on this printer: the ';'-joined form
 * ("ABS;ABS;PLA;…", 115 files) and a JSON array string ('["ABS", "ABS", …]', 54 files) — Orca writes
 * whichever its post-processor produced. Reading only the ';' form left the material blank on every
 * tool of a quarter of the library, and would have printed the whole '["ABS", …]' blob as the
 * material for tool 0.
 */
function listOf(v) {
  if (Array.isArray(v)) return v;
  const s = String(v == null ? "" : v).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch (e) { /* not JSON after all — fall through */ }
  }
  return s.split(";");
}
const cell = (list, i) => String(list[i] == null ? "" : list[i]).trim().replace(/^"+|"+$/g, "");

/** One tool the file actually uses: gate/tool index, its slicer colour, material and weight. */
function toolChips(f) {
  const tools = f && Array.isArray(f.referenced_tools) ? f.referenced_tools : [];
  const colors = listOf(f && f.filament_colors);
  const weights = listOf(f && f.filament_weights);
  const mats = listOf(f && f.filament_type);
  return tools.map(t => {
    const i = typeof t === "number" ? t : parseInt(t, 10);
    // Orca writes colours as #RRGGBB or #RRGGBBAA, and the alpha byte is usually 00 — which CSS reads
    // as fully transparent, i.e. an invisible swatch. Cut it back to the RGB triplet.
    const hex = cell(colors, i);
    const w = weights[i];
    return {
      t: i,
      color: /^#[0-9a-f]{6,8}$/i.test(hex) ? hex.slice(0, 7) : null,
      material: cell(mats, i),
      grams: num(typeof w === "number" ? w : parseFloat(w)),
    };
  }).filter(c => Number.isFinite(c.t));
}

/** Thumbnail with its own failed/missing state (a listed thumb can 404 after a re-upload). */
function Thumb({ src, size, radius = 3 }) {
  const [bad, setBad] = React.useState(false);
  React.useEffect(() => setBad(false), [src]);
  // max-width: the 314 px preview exactly fills the FILE panel — until the panel's own 6 px scrollbar
  // appears, which would otherwise push it into a horizontal scroll of its own.
  const box = `width:${size}px; height:${size}px; max-width:100%; flex:none; border:1px solid ${T.line}; border-radius:${radius}px; background:${T.panel2}`;
  if (!src || bad) {
    return <div style={S(`${box}; display:flex; align-items:center; justify-content:center; ${mono(Math.min(28, Math.max(9, size / 3)), `color:${T.ghost}`)}`)}>▤</div>;
  }
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBad(true)}
    style={S(`${box}; object-fit:contain`)} />;
}

/**
 * Inline text prompt for rename / move / duplicate / new folder, shaped like the design's Confirm strip.
 * Input and buttons sit on separate rows: this also renders inside the 340 px FILE panel, where one row
 * would squeeze the field down to nothing as soon as a validation message appears next to it.
 */
function Prompt({ label, value, hint, error, onChange, onOk, onCancel, ok = "APPLY" }) {
  return <div style={S(`flex:none; padding:9px 12px; border-top:1px solid ${T.line2}; background:${T.panel3}; display:flex; flex-direction:column; gap:6px; animation:vRise .16s ease both`)}>
    <Row gap={8}>
      <Label style="flex:none">{label}</Label>
      <Input value={value} onChange={e => onChange(e.target.value)} onEnter={() => { if (!error) onOk(); }} placeholder={hint} style="flex:1; min-width:60px" autoFocus />
    </Row>
    <Row gap={8}>
      <Val size={9} color={error ? T.warn : T.mute} style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{error || hint}</Val>
      <Btn small kind="ok" disabled={!!error} onClick={onOk}>{ok}</Btn>
      <Btn small onClick={onCancel}>CANCEL</Btn>
    </Row>
  </div>;
}

/** One label/value line of the FILE panel's metadata grid. */
function Meta({ k, children, color = T.body }) {
  return <>
    <div style={S(mono(9, `letter-spacing:.12em; color:${T.faint}`))}>{k}</div>
    <div style={S(mono(10.5, `color:${color}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`))}>{children}</div>
  </>;
}

export default function Page({ store, api, route, navigate }) {
  const st = useStore(store);

  // Orca reloads the Device tab constantly, so where the user is and what they picked live in localStorage.
  // Everything read back from there is coerced: a stale or hand-edited key must not take the page down.
  const [rawPath, setPath] = usePersisted("files.path", "");
  const [sort, setSort] = usePersisted("files.sort", { k: "modified", dir: -1 });
  const [rawQ, setQ] = usePersisted("files.q", "");
  const [selName, setSelName] = usePersisted("files.sel", "");
  const [prompt, setPrompt] = usePersisted("files.prompt", null);   // {kind:'rename'|'move'|'copy'|'mkdir', value}
  // Confirms are deliberately NOT persisted: an armed "delete this file" must never come back after a reload.
  const [confirm, setConfirm] = React.useState(null);               // {kind:'print'|'delete'|'rmdir'}
  const [queue, setQueue] = React.useState([]);
  const [drag, setDrag] = React.useState(false);
  const [note, setNote] = React.useState("");                       // last refusal/failure, shown inline (see log)
  const [tick, bump] = React.useReducer(n => n + 1, 0);
  const path = typeof rawPath === "string" ? rawPath : "";
  const q = typeof rawQ === "string" ? rawQ : "";

  // The action modules report refusals to the SHARED console — which lives on another page, so on /files a
  // refused rename or a failed delete would be silent. Errors are mirrored into a strip under the list;
  // intents ("DELETE x", "MKDIR y") and benign skips are info/warn and stay out of it.
  const log = React.useCallback((message, kind) => {
    if (kind === "err") setNote(String(message));
    if (!store) return;
    const entry = { time: Date.now() / 1000, message: String(message), type: kind || "info", local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }, [store]);
  const act = React.useMemo(() => makeFilesActions({ api, store, log }), [api, store, log]);

  // st.connected is a dependency, not just a guard: boot() opens the socket asynchronously, so a dirInfo
  // issued on the first render of a fresh load rejects with "not connected". Staying pending until the
  // socket is up keeps that non-event out of the error state — and re-lists after a reconnect for free.
  const listing = useAsync(() => (st.connected ? api.dirInfo(path ? "gcodes/" + path : "gcodes", true) : new Promise(() => {})), [path, tick, st.connected]);

  // Moonraker announces every file change (including its own thumbnail writes during a metadata scan);
  // coalesce the burst instead of re-listing 209 files per event.
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    let t = null;
    const off = api.on("filelist", ev => {
      const item = (ev && (ev.item || ev.source_item)) || {};
      if (item.root && item.root !== "gcodes") return;
      clearTimeout(t);
      t = setTimeout(bump, 400);
    });
    return () => { clearTimeout(t); if (typeof off === "function") off(); };
  }, [api]);

  const data = listing.data || {};
  const disk = data.disk_usage || null;
  const stats = ((st.raw || {}).print_stats) || {};
  const jobActive = ["printing", "paused"].includes(String(stats.state || "").toLowerCase());
  // print_stats.filename is LATCHED: Klipper keeps the last job's name through "complete", "cancelled" and
  // "error" until the next print starts. Untied from the state it would mark a finished file PRINTING for
  // ever — and leave DELETE disabled on it. Only an active job owns a file.
  const printing = jobActive ? String(stats.filename || "") : "";

  const view = React.useMemo(() => {
    const files = Array.isArray(data.files) ? data.files : [];
    const dirs = Array.isArray(data.dirs) ? data.dirs : [];
    // Dot entries are Moonraker's own bookkeeping (the .thumbs cache), never the user's files.
    const rowsF = files.filter(f => f && f.filename && !f.filename.startsWith("."))
      .map(f => Object.assign({}, f, { kind: "file", name: f.filename, path: joinPath(path, f.filename) }));
    const rowsD = dirs.filter(d => d && d.dirname && !d.dirname.startsWith("."))
      .map(d => ({ kind: "dir", name: d.dirname, path: joinPath(path, d.dirname), modified: d.modified, size: d.size }));
    const needle = String(q || "").trim().toLowerCase();
    const hit = r => !needle || r.name.toLowerCase().includes(needle);
    const key = sort && sort.k ? sort.k : "modified";
    const dir = sort && sort.dir === 1 ? 1 : -1;
    const val = r => (key === "name" ? r.name.toLowerCase() : key === "size" ? (num(r.size) || 0) : key === "est" ? (num(r.estimated_time) || 0) : (num(r.modified) || 0));
    const shown = rowsF.filter(hit).sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    // Folders stay pinned on top, name-ascending: they have no estimated time or gcode size to sort by,
    // and burying two of them among 200 files turns navigation into a hunt.
    const shownDirs = rowsD.filter(hit).sort((a, b) => a.name.localeCompare(b.name));
    return {
      rows: shownDirs.concat(shown),
      files: rowsF, dirs: rowsD,
      bytes: rowsF.reduce((n, f) => n + (num(f.size) || 0), 0),
      big: rowsF.filter(f => (num(f.size) || 0) > BIG).length,
      filtered: !!needle,
    };
  }, [data, q, sort, path]);

  const sel = selName ? view.files.find(f => f.name === selName) || null : null;
  const selPath = sel ? sel.path : "";
  const tools = sel ? toolChips(sel) : [];
  const selPrinting = !!sel && printing === selPath;
  // A directory can hold anything Moonraker will serve (the .thumbs cache is full of PNGs). PRINT and
  // VIEW only mean something for a g-code file — printFile() refuses the rest, so without this the
  // buttons offered `Start printing "foo-32x32.png"?` and then failed.
  const selGcode = !!sel && isGcode(sel.name);

  // ---- navigation / selection -----------------------------------------------------------------
  function go(next) { setPath(next); setSelName(""); setPrompt(null); setConfirm(null); setNote(""); }
  function pick(r) {
    if (r.kind === "dir") return go(r.path);
    setConfirm(null);
    setPrompt(null);
    setNote("");
    setSelName(r.name === selName ? "" : r.name);
  }
  function sortBy(k) { setSort(s => (s && s.k === k ? { k, dir: s.dir === 1 ? -1 : 1 } : { k, dir: k === "name" ? 1 : -1 })); }

  // ---- uploads --------------------------------------------------------------------------------
  const fileInput = React.useRef(null);
  const seq = React.useRef(0);
  const pending = React.useRef([]);
  const pumping = React.useRef(false);

  async function pump() {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (pending.current.length) {
        const it = pending.current.shift();
        setQueue(qs => qs.map(x => (x.id === it.id ? Object.assign({}, x, { state: "up" }) : x)));
        let last = -1;
        // it.dir, not the current one: a file lands where the user dropped it even if they browse away mid-upload.
        const ok = await act.uploadFile(it.file, it.dir, p => {
          // XHR fires progress every few KB; repaint only on whole percent, or a 400 MB file re-renders the list thousands of times.
          const pct = Math.round(p * 100);
          if (pct === last) return;
          last = pct;
          setQueue(qs => qs.map(x => (x.id === it.id ? Object.assign({}, x, { pct }) : x)));
        });
        setQueue(qs => qs.map(x => (x.id === it.id ? Object.assign({}, x, { state: ok ? "done" : "err", pct: ok ? 100 : x.pct }) : x)));
        if (ok) bump();
      }
    } finally { pumping.current = false; }
  }

  function enqueue(fileList) {
    setNote("");
    const all = Array.from(fileList || []).filter(f => f && f.name);
    const good = all.filter(f => isGcode(f.name));
    const skipped = all.filter(f => !isGcode(f.name));
    for (const f of skipped) log("Skipped " + f.name + " — the gcodes root only takes .gcode / .gco / .g / .ufp", "warn");
    if (!good.length) {
      // Those log lines land on the CONSOLE page. Dropping an .stl here used to make the overlay
      // disappear and then nothing at all happen, on this page, ever.
      if (skipped.length) {
        setNote((skipped.length === 1 ? "Skipped " + skipped[0].name : "Skipped " + skipped.length + " files")
          + " — the gcodes root only takes .gcode / .gco / .g / .ufp");
      }
      return;
    }
    if (jobActive) log("Uploading while a print runs — large files compete with Klipper for the same disk", "warn");
    const items = good.map(f => ({ id: ++seq.current, name: f.name, size: f.size || 0, pct: 0, state: "wait", file: f, dir: path }));
    setQueue(qs => qs.concat(items));
    pending.current = pending.current.concat(items);
    pump().catch(e => log("Upload queue stopped — " + ((e && e.message) || e), "err"));
  }

  const upActive = queue.filter(x => x.state === "wait" || x.state === "up");

  // ---- drop zone ------------------------------------------------------------------------------
  // The whole WINDOW while this page is mounted, not just the page's own grid.
  //
  // The shell owns a window-level UPLOAD & PRINT drop handler that sends `print:"true"` with the first
  // file (dashboard/logic.jsx onDrop → actions/upload.js). It defers to `e.defaultPrevented`, so a page
  // with its own drop zone claims the drag first — but this page only covered its grid, leaving the nav
  // rail and the top bar (measured: 21% of a 1280×800 window) belonging to the shell. A file dropped
  // there while the user is looking at this page's "drop files here" panel was uploaded to the ROOT and
  // STARTED AS A PRINT, with no confirmation. Verified against a faked fileUpload: extra={print:"true"}.
  // The shell listens in the bubble phase at window, so claiming in the CAPTURE phase always wins.
  const dragDepth = React.useRef(0);
  const dragT = React.useRef(null);
  const enqueueRef = React.useRef(enqueue);
  enqueueRef.current = enqueue;                                   // the listeners are registered once; `path` must stay fresh
  React.useEffect(() => {
    const claim = e => { if (!hasFiles(e)) return false; e.preventDefault(); return true; };
    // WKWebView drops dragleave when the pointer leaves the window — without this the overlay sticks.
    const arm = () => { clearTimeout(dragT.current); dragT.current = setTimeout(() => { dragDepth.current = 0; setDrag(false); }, 800); };
    const stop = () => { clearTimeout(dragT.current); dragDepth.current = 0; setDrag(false); };
    const onEnter = e => { if (!claim(e)) return; dragDepth.current++; setDrag(true); arm(); };
    const onOver = e => { if (!claim(e)) return; e.dataTransfer.dropEffect = "copy"; setDrag(true); arm(); };
    const onLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) stop(); };
    const onDrop = e => { if (!claim(e)) return; stop(); enqueueRef.current(e.dataTransfer.files); };
    window.addEventListener("dragenter", onEnter, true);
    window.addEventListener("dragover", onOver, true);
    window.addEventListener("dragleave", onLeave, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      clearTimeout(dragT.current);
      window.removeEventListener("dragenter", onEnter, true);
      window.removeEventListener("dragover", onOver, true);
      window.removeEventListener("dragleave", onLeave, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, []);

  // ---- prompts / confirms ---------------------------------------------------------------------
  const promptFor = prompt && typeof prompt === "object" ? prompt : null;
  // A persisted prompt outlives the reload that dropped its target; only show it while it still applies.
  const live = promptFor && (promptFor.kind === "mkdir" || !!sel);
  const promptVal = live ? String(promptFor.value == null ? "" : promptFor.value) : "";
  /**
   * Both server.files.move and .copy end in shutil, which OVERWRITES an existing destination without a
   * word — a rename onto a neighbour's name silently destroys that file. The listing is right here, so
   * the collision is caught before the RPC rather than mourned after it.
   */
  const taken = (name, mine) => {
    const n = String(name || "").toLowerCase();
    return view.files.some(f => f.name.toLowerCase() === n && f.name !== mine) || view.dirs.some(d => d.name.toLowerCase() === n);
  };
  // RENAME and DUPLICATE both land beside the original, so both are checked against this folder. The
  // difference is the file's own name: for RENAME it means "nothing to do", for DUPLICATE it is a clash.
  const nameErr = () => {
    const target = keepExtension(selPath, promptVal);
    const rename = promptFor.kind === "rename";
    return validName(target)
      || (rename && target === selName ? "UNCHANGED" : null)
      || (taken(target, rename ? selName : null) ? "NAME ALREADY USED HERE" : null);
  };
  // MOVE takes a path, so validName (which bans "/") cannot be used — but ".." must still be refused:
  // Moonraker rejects it as an unknown root, which reaches the user as an opaque "Invalid file path".
  const moveErr = () => {
    const d = stripRoot(promptVal);
    if (d.split("/").includes("..")) return "NO .. IN A FOLDER PATH";
    return d === path ? "ALREADY HERE" : null;
  };
  const promptErr = !live ? null
    : promptFor.kind === "move" ? moveErr()
      : promptFor.kind === "mkdir" ? (validName(promptVal) || (taken(promptVal, null) ? "NAME ALREADY USED HERE" : null))
        : nameErr();
  // keepExtension silently appends the original extension, so "part.stl" is saved as "part.stl.gcode".
  // Say so in the hint line rather than surprising the user with a name they never typed.
  const effective = live && (promptFor.kind === "rename" || promptFor.kind === "copy") ? keepExtension(selPath, promptVal) : "";
  const nameHint = fallback => (effective && effective !== promptVal ? "SAVED AS " + effective : fallback);

  function runPrompt() {
    if (!live || promptErr) return;
    const v = promptVal;
    const done = ok => { setPrompt(null); if (ok) bump(); };
    setNote("");
    if (promptFor.kind === "mkdir") act.createFolder(path, v).then(done).catch(() => setPrompt(null));
    else if (promptFor.kind === "rename") act.renameFile(selPath, v).then(ok => { if (ok) setSelName(keepExtension(selPath, v)); done(ok); }).catch(() => setPrompt(null));
    else if (promptFor.kind === "copy") act.copyFile(selPath, v).then(done).catch(() => setPrompt(null));
    else if (promptFor.kind === "move") act.moveFile(selPath, v).then(ok => { if (ok) setSelName(""); done(ok); }).catch(() => setPrompt(null));
  }
  function runConfirm() {
    const c = confirm;
    setConfirm(null);
    setNote("");
    if (!c) return;
    if (c.kind === "print") act.printFile(selPath).then(ok => { if (ok) navigate("/"); }).catch(() => {});
    else if (c.kind === "delete") act.deleteFile(selPath).then(ok => { if (ok) { setSelName(""); bump(); } }).catch(() => {});
    else if (c.kind === "rmdir") act.deleteFolder(path).then(ok => { if (ok) go(dirOf(path)); }).catch(() => {});
  }

  // ---- list -----------------------------------------------------------------------------------
  const cols = [
    {
      k: "name", label: "NAME", w: "minmax(200px,1fr)", render: r => (
        <Row gap={8}>
          {r.kind === "dir"
            ? <div style={S(`width:26px; height:26px; flex:none; border:1px solid ${T.line}; border-radius:3px; background:${T.panel2}; display:flex; align-items:center; justify-content:center; ${mono(11, `color:${T.warn}`)}`)}>▸</div>
            : <Thumb src={thumbUrl(api, path, r, 48)} size={26} />}
          <span style={S(`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${mono(10.5, `color:${r.path === selPath ? T.text : r.kind === "dir" ? T.dim : T.body}`)}`)}>{r.name}</span>
          {printing === r.path ? <Chip color={T.accent} bg="#1a0e09" border="#4a2318" pulse>PRINTING</Chip> : null}
          {r.kind === "file" && r.mmu_print ? <Chip color={T.ok} bg="#0f2320" border="#1c3d37">MMU</Chip> : null}
        </Row>
      ),
    },
    {
      k: "tools", label: "TOOLS", w: "104px", render: r => {
        const cs = r.kind === "file" ? toolChips(r) : [];
        if (!cs.length) return <span style={S(mono(10, `color:${T.ghost}`))}>{DASH}</span>;
        return <Row gap={5}>
          {cs.slice(0, 3).map(c => <span key={c.t} style={S("display:inline-flex; align-items:center; gap:3px")}>
            <span style={S(`width:7px; height:7px; border-radius:2px; background:${c.color || T.panel2}; border:1px solid ${T.line2}`)} />
            <span style={S(mono(9, `color:${T.mute}`))}>T{c.t}</span>
          </span>)}
          {cs.length > 3 ? <span style={S(mono(9, `color:${T.faint}`))}>+{cs.length - 3}</span> : null}
        </Row>;
      },
    },
    { k: "size", label: "SIZE", w: "86px", align: "right", render: r => <span style={S(mono(10.5, `color:${r.kind === "dir" ? T.ghost : sizeColor(num(r.size) || 0)}`))}>{r.kind === "dir" ? DASH : fmtBytes(num(r.size) || 0)}</span> },
    { k: "est", label: "EST", w: "74px", align: "right", render: r => <span style={S(mono(10.5, `color:${num(r.estimated_time) ? T.dim : T.ghost}`))}>{num(r.estimated_time) ? fmtDur(r.estimated_time) : DASH}</span> },
    { k: "modified", label: "MODIFIED", w: "116px", align: "right", render: r => <span style={S(mono(10, `color:${T.mute}`))}>{num(r.modified) ? fmtDate(r.modified) : DASH}</span> },
  ];

  // The bar is drawn from FREE, not from `used`: on this ext4 card used+free is 3 GB short of total
  // (reserved blocks), so a used-based bar read 28% while the number beside it said 33% was gone.
  const diskFree = disk && num(disk.total) ? num(disk.free) : null;
  const diskFrac = diskFree === null ? null : Math.min(1, Math.max(0, diskFree / disk.total));
  const diskPct = diskFrac === null ? 0 : Math.round((1 - diskFrac) * 100);
  const diskColor = diskFrac === null ? T.ghost : diskFrac < 0.05 ? T.err : diskFrac < 0.12 ? T.warn : T.ok;
  const crumbs = path ? path.split("/") : [];

  // minmax(0,…) like /heightmap: a 560 px floor pushed the whole page into a horizontal scroll below a
  // ~1180 px viewport, hiding the FILE panel and the E-STOP button. The list has its own scroller.
  return <div style={S("flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:minmax(0,1fr) 340px; position:relative")}>

    <Panel title="G-CODE FILES" flat style="height:calc(100vh - 76px); min-height:520px" bodyStyle="display:flex; flex-direction:column"
      right={<>
        <Val size={9.5} color={T.mute}>{view.files.length} FILES · {fmtBytes(view.bytes)}</Val>
        <Btn small onClick={() => { setConfirm(null); setNote(""); setPrompt({ kind: "mkdir", value: "" }); }}>+ FOLDER</Btn>
        <Btn small kind="accent" onClick={() => fileInput.current && fileInput.current.click()}>UPLOAD</Btn>
        <Btn small title="Reload the listing" onClick={bump}>⟳</Btn>
      </>}>

      {/* breadcrumbs + disk */}
      <div style={S(`flex:none; display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid ${T.line}`)}>
        <Hv as="span" onClick={() => go("")} style={`${mono(10, `letter-spacing:.1em; color:${path ? T.dim : T.text}`)}; cursor:pointer`} hover={`color:${T.accent}`}>GCODES</Hv>
        {crumbs.map((c, i) => <React.Fragment key={i}>
          <span style={S(mono(10, `color:${T.ghost}`))}>/</span>
          <Hv as="span" onClick={() => go(crumbs.slice(0, i + 1).join("/"))}
            style={`${mono(10, `color:${i === crumbs.length - 1 ? T.text : T.dim}`)}; cursor:pointer; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`}
            hover={`color:${T.accent}`}>{c}</Hv>
        </React.Fragment>)}
        {path ? <Btn small onClick={() => go(dirOf(path))}>↑ UP</Btn> : null}
        {path ? <Btn small kind="ghost" onClick={() => { setPrompt(null); setNote(""); setConfirm({ kind: "rmdir" }); }}>DELETE FOLDER</Btn> : null}
        <div style={S("margin-left:auto; display:flex; align-items:center; gap:8px; flex:none")}>
          <Label>DISK</Label>
          <div style={S(`width:110px; height:3px; border-radius:2px; background:${T.panel2}; overflow:hidden`)}>
            <div style={S(`width:${diskPct}%; height:100%; background:${diskColor}`)} />
          </div>
          <Val size={9.5} color={T.mute}>{diskFree === null ? DASH : fmtBytes(diskFree) + " FREE"}</Val>
        </div>
      </div>

      {/* filter + sort */}
      <div style={S(`flex:none; display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid ${T.line}`)}>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="FILTER THIS FOLDER…" style="flex:1; min-width:0" />
        {q ? <Btn small kind="ghost" onClick={() => setQ("")}>CLEAR</Btn> : null}
        <Label style="margin-left:4px">SORT</Label>
        {SORTS.map(([k, label]) => (
          <Btn key={k} small kind={sort && sort.k === k ? "accent" : "default"} onClick={() => sortBy(k)}>
            {label}{sort && sort.k === k ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
          </Btn>
        ))}
      </div>

      {/* rows */}
      <div style={S("flex:1; min-height:0; overflow:auto")}>
        {!st.connected
          ? <div style={S(`padding:26px 12px; text-align:center; ${mono(10, `letter-spacing:.2em; color:${T.ghost}`)}`)}>WAITING FOR MOONRAKER…</div>
          : listing.error
            ? <div style={S("padding:26px 12px; display:flex; flex-direction:column; align-items:center; gap:10px")}>
              <div style={S(mono(10.5, `color:${T.err}`))}>{listing.error}</div>
              <Row gap={8}>
                <Btn small onClick={bump}>RETRY</Btn>
                {path ? <Btn small kind="accent" onClick={() => go("")}>BACK TO ROOT</Btn> : null}
              </Row>
            </div>
            : listing.loading && !listing.data
              ? <div style={S(`padding:26px 12px; text-align:center; ${mono(10, `letter-spacing:.2em; color:${T.ghost}`)}`)}>READING DIRECTORY…</div>
              : <Table cols={cols} rows={view.rows} rowKey={r => r.kind + ":" + r.path} onRow={pick}
                empty={view.filtered ? "NO MATCH IN THIS FOLDER" : "EMPTY FOLDER"}
                rowStyle={r => (r.path === selPath ? "background:#131a24" : "")} />}
      </div>

      {/* last refusal — the shared console that normally carries these is on another page */}
      {note
        ? <div style={S(`flex:none; display:flex; align-items:center; gap:8px; padding:6px 12px; border-top:1px solid ${T.line2}; background:${T.panel3}`)}>
          <Val size={9.5} color={T.err} style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{note}</Val>
          <Btn small kind="ghost" onClick={() => setNote("")}>DISMISS</Btn>
        </div>
        : null}

      {/* totals */}
      <div style={S(`flex:none; display:flex; align-items:center; gap:10px; padding:6px 12px; border-top:1px solid ${T.line}`)}>
        <Val size={9.5} color={T.mute}>
          {view.dirs.length ? view.dirs.length + " FOLDERS · " : ""}{view.files.length} FILES · {fmtBytes(view.bytes)}
          {view.big ? " · " + view.big + " OVER 50 MB" : ""}
        </Val>
        {view.filtered ? <Val size={9.5} color={T.warn}>SHOWING {view.rows.length}</Val> : null}
        {listing.loading && listing.data ? <Val size={9.5} color={T.ghost}>REFRESHING…</Val> : null}
      </div>

      {live && promptFor.kind === "mkdir"
        ? <Prompt label="NEW FOLDER" value={promptVal} hint="folder name" error={promptErr} ok="CREATE"
          onChange={v => setPrompt({ kind: "mkdir", value: v })} onOk={runPrompt} onCancel={() => setPrompt(null)} />
        : null}
      {confirm && confirm.kind === "rmdir"
        ? <Confirm yes="DELETE FOLDER"
          text={`Delete the folder "${baseOf(path)}" and everything inside it — ${view.files.length} files, ${fmtBytes(view.bytes)}${view.dirs.length ? ", plus " + view.dirs.length + " sub-folder" + (view.dirs.length > 1 ? "s" : "") + " and their contents" : ""}? This cannot be undone.`}
          onYes={runConfirm} onNo={() => setConfirm(null)} />
        : null}
    </Panel>

    <div style={S("display:flex; flex-direction:column; gap:10px; height:calc(100vh - 76px); min-height:520px; min-width:0")}>

      <Panel title="FILE" flat style="flex:1; min-height:0" bodyStyle="display:flex; flex-direction:column"
        right={sel ? <Val size={9.5} color={sizeColor(num(sel.size) || 0)}>{fmtBytes(num(sel.size) || 0)}</Val> : null}>
        {!sel
          ? <div style={S(`flex:1; display:flex; align-items:center; justify-content:center; text-align:center; padding:20px; ${mono(10, `letter-spacing:.2em; color:${T.ghost}`)}`)}>
            {view.files.length ? "SELECT A FILE" : "NO FILES HERE"}
          </div>
          : <div style={S("flex:1; min-height:0; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px")}>

            <Thumb src={thumbUrl(api, path, sel, 300)} size={314} radius={5} />

            <div style={S(`${mono(11, `color:${T.text}`)}; word-break:break-all; line-height:1.45`)}>{sel.name}</div>
            <Row gap={6} style="flex-wrap:wrap">
              {selPrinting ? <Chip color={T.accent} bg="#1a0e09" border="#4a2318" pulse>PRINTING NOW</Chip> : null}
              {sel.mmu_print ? <Chip color={T.ok} bg="#0f2320" border="#1c3d37">MMU PRINT</Chip> : null}
              {num(sel.size) > BIG ? <Chip color={T.warn} bg="#14100a" border="#3a2f14">LARGE FILE</Chip> : null}
              {!sel.slicer ? <Chip color={T.mute}>NO METADATA</Chip> : null}
            </Row>

            <div style={S("display:grid; grid-template-columns:84px minmax(0,1fr); gap:5px 10px; align-items:center")}>
              <Meta k="MODIFIED">{num(sel.modified) ? fmtDate(sel.modified) : DASH}</Meta>
              <Meta k="EST TIME" color={num(sel.estimated_time) ? T.text : T.ghost}>{num(sel.estimated_time) ? fmtDur(sel.estimated_time) : DASH}</Meta>
              <Meta k="FILAMENT">{num(sel.filament_total) ? (sel.filament_total / 1000).toFixed(1) + " m" : DASH}{num(sel.filament_weight_total) ? " · " + sel.filament_weight_total.toFixed(0) + " g" : ""}</Meta>
              <Meta k="LAYERS">{num(sel.layer_count) ? sel.layer_count : DASH}{num(sel.layer_height) ? " × " + sel.layer_height + " mm" : ""}</Meta>
              <Meta k="FIRST L.">{num(sel.first_layer_height) ? sel.first_layer_height + " mm" : DASH}{num(sel.first_layer_extr_temp) ? " · " + Math.round(sel.first_layer_extr_temp) + "°/" + Math.round(sel.first_layer_bed_temp || 0) + "°" : ""}</Meta>
              <Meta k="HEIGHT">{num(sel.object_height) ? sel.object_height + " mm" : DASH}</Meta>
              <Meta k="NOZZLE">{num(sel.nozzle_diameter) ? sel.nozzle_diameter + " mm" : DASH}</Meta>
              <Meta k="SLICER">{sel.slicer ? sel.slicer + " " + (sel.slicer_version || "") : DASH}</Meta>
              {/* file size minus the header/thumbnail block: what Klipper actually streams */}
              <Meta k="GCODE" color={T.dim}>{num(sel.gcode_end_byte) && num(sel.gcode_start_byte) ? fmtBytes(sel.gcode_end_byte - sel.gcode_start_byte) : DASH}</Meta>
              <Meta k="PATH" color={T.dim}>{path || "gcodes root"}</Meta>
            </div>

            {tools.length ? <>
              <Label>TOOLS REFERENCED</Label>
              <div style={S("display:flex; flex-direction:column; gap:4px")}>
                {tools.map(c => <Row key={c.t} gap={8}>
                  <span style={S(`width:12px; height:12px; flex:none; border-radius:3px; background:${c.color || T.panel2}; border:1px solid ${T.line2}`)} />
                  <Val size={10.5} color={T.text}>T{c.t}</Val>
                  <Val size={10} color={T.mute}>{c.material || DASH}</Val>
                  <Val size={10} color={T.mute} style="margin-left:auto">{c.grams ? c.grams.toFixed(0) + " g" : ""}</Val>
                </Row>)}
              </div>
            </> : null}

            <Row gap={6} style="flex-wrap:wrap; margin-top:2px">
              <Btn kind="accent" disabled={!selGcode || jobActive || st.klippy !== "ready"}
                title={!selGcode ? sel.name + " is not a g-code file" : jobActive ? "A print is already running" : st.klippy !== "ready" ? "Klipper is " + st.klippy : "Start this print"}
                onClick={() => { setPrompt(null); setNote(""); setConfirm({ kind: "print" }); }}>PRINT</Btn>
              <Btn disabled={!selGcode} title={selGcode ? "Open in the g-code viewer" : "Only g-code files can be previewed"}
                onClick={() => navigate("/viewer", { file: selPath })}>VIEW</Btn>
              <Btn onClick={() => { setNote(""); act.downloadFile(selPath).catch(() => {}); }}>DOWNLOAD</Btn>
            </Row>
            {/* Klipper streams the running job from its path: renaming, moving or deleting it out from under
                the print kills the job. DUPLICATE only reads, so it stays available. */}
            <Row gap={6} style="flex-wrap:wrap">
              <Btn small disabled={selPrinting} title={selPrinting ? "This file is being printed" : "Rename this file"}
                onClick={() => { setConfirm(null); setNote(""); setPrompt({ kind: "rename", value: sel.name }); }}>RENAME</Btn>
              <Btn small disabled={selPrinting} title={selPrinting ? "This file is being printed" : "Move this file to another folder"}
                onClick={() => { setConfirm(null); setNote(""); setPrompt({ kind: "move", value: path }); }}>MOVE</Btn>
              <Btn small onClick={() => { setConfirm(null); setNote(""); setPrompt({ kind: "copy", value: sel.name.replace(/(\.[^.]+)?$/, m => "-copy" + (m || "")) }); }}>DUPLICATE</Btn>
              <Btn small kind="danger" disabled={selPrinting} title={selPrinting ? "This file is being printed" : "Delete this file"}
                onClick={() => { setPrompt(null); setNote(""); setConfirm({ kind: "delete" }); }}>DELETE</Btn>
            </Row>
          </div>}

        {live && promptFor.kind === "rename"
          ? <Prompt label="RENAME" value={promptVal} hint={nameHint("new name")} error={promptErr}
            onChange={v => setPrompt({ kind: "rename", value: v })} onOk={runPrompt} onCancel={() => setPrompt(null)} />
          : null}
        {live && promptFor.kind === "copy"
          ? <Prompt label="DUPLICATE AS" value={promptVal} hint={nameHint("copy name")} error={promptErr} ok="COPY"
            onChange={v => setPrompt({ kind: "copy", value: v })} onOk={runPrompt} onCancel={() => setPrompt(null)} />
          : null}
        {live && promptFor.kind === "move"
          ? <Prompt label="MOVE TO" value={promptVal} hint="existing folder, empty = gcodes root" ok="MOVE" error={promptErr}
            onChange={v => setPrompt({ kind: "move", value: v })} onOk={runPrompt} onCancel={() => setPrompt(null)} />
          : null}
        {confirm && confirm.kind === "print" && sel
          ? <Confirm yes="PRINT" text={`Start printing "${sel.name}"?` + (num(sel.estimated_time) ? ` — est ${fmtDur(sel.estimated_time)}` : "") + (num(sel.filament_weight_total) ? ` · ${sel.filament_weight_total.toFixed(0)} g` : "") + (tools.length ? ` · needs ${tools.map(c => "T" + c.t).join(" ")}` : "")}
            onYes={runConfirm} onNo={() => setConfirm(null)} />
          : null}
        {confirm && confirm.kind === "delete" && sel
          ? <Confirm yes="DELETE" text={`Delete "${sel.name}" (${fmtBytes(num(sel.size) || 0)}) permanently? This cannot be undone.`}
            onYes={runConfirm} onNo={() => setConfirm(null)} />
          : null}
      </Panel>

      <Panel title="UPLOAD" flat style="flex:none; max-height:250px" bodyStyle="display:flex; flex-direction:column"
        right={queue.length ? <Btn small kind="ghost" disabled={!!upActive.length} onClick={() => setQueue([])}>CLEAR</Btn> : null}>
        <div style={S(`flex:none; padding:9px 12px; border-bottom:1px solid ${T.line}; display:flex; align-items:center; gap:8px`)}>
          <Val size={9.5} color={T.mute}>→ {path ? path : "GCODES ROOT"}</Val>
          {/* Not refused — an upload cannot interrupt the job — but it does write to the card Klipper reads from. */}
          {jobActive ? <Chip color={T.warn} bg="#14100a" border="#3a2f14">PRINT RUNNING</Chip> : null}
          <Btn small kind="accent" style="margin-left:auto" onClick={() => fileInput.current && fileInput.current.click()}>CHOOSE FILES</Btn>
        </div>
        <div style={S("flex:1; min-height:0; overflow:auto; padding:8px 12px; display:flex; flex-direction:column; gap:7px")}>
          {!queue.length
            ? <div style={S(`padding:12px 8px; text-align:center; border:1px dashed ${T.line2}; border-radius:4px; ${mono(9.5, `letter-spacing:.16em; color:${T.mute}`)}`)}>
              DROP .GCODE FILES ANYWHERE
            </div>
            : queue.slice().reverse().map(x => <div key={x.id} style={S("display:flex; flex-direction:column; gap:3px")}>
              <Row gap={8}>
                <span style={S(`flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${mono(10, `color:${T.body}`)}`)}>{x.name}</span>
                <Val size={9} color={x.state === "err" ? T.err : x.state === "done" ? T.ok : T.mute}>
                  {x.state === "done" ? "DONE" : x.state === "err" ? "FAILED" : x.state === "up" ? x.pct + "%" : "QUEUED"}
                </Val>
                <Val size={9} color={T.faint}>{fmtBytes(x.size)}</Val>
              </Row>
              <div style={S(`height:3px; border-radius:2px; background:${T.panel2}; overflow:hidden`)}>
                <div style={S(`width:${x.state === "done" ? 100 : x.pct}%; height:100%; background:${x.state === "err" ? T.err : x.state === "done" ? T.ok : T.accent}; transition:width .2s`)} />
              </div>
            </div>)}
        </div>
      </Panel>
    </div>

    {/* Orca ejects the app on target=_blank, so uploads go through this hidden picker, never a new window. */}
    <input ref={fileInput} type="file" multiple accept=".gcode,.gco,.g,.ufp" style={S("display:none")}
      onChange={e => { enqueue(e.target.files); e.target.value = ""; }} />

    {/* fixed, because the drop zone is now the whole window (see the drop-zone effect) */}
    {drag ? <div style={S(`position:fixed; inset:6px; z-index:60; border:1px dashed ${T.accent}; border-radius:6px; background:rgba(6,8,11,.86); display:flex; align-items:center; justify-content:center; pointer-events:none; ${mono(12, `letter-spacing:.24em; color:${T.accent}`)}`)}>
      DROP TO UPLOAD → {path || "GCODES ROOT"}
    </div> : null}
  </div>;
}
