// HEIGHTMAP page — the bed mesh at full size, plus the BED_MESH_* CRUD around it.
//
// All drawing is adapters/isoMesh.js (the dashboard panel's renderer): the isometric projection, the
// "fake lambert" shading, the four colour stops and the `[[]]`-after-BED_MESH_CLEAR case all live there.
// This file is layout, hover, the camera gestures and commands — it must never grow a second renderer.
//
// Camera: the renderer takes a yaw / pitch (drag), and pan / zoom are a transform of the SVG viewBox on top of
// the renderer's own fit box (so RESET VIEW is exactly the design's picture). Hover picking needs nothing
// special under any of it: the browser hit-tests the re-projected polygons.
//
// What gets drawn: pickMesh() prefers the ACTIVE mesh (bed_mesh.probed_matrix); with nothing loaded it
// falls back to the selected saved profile so the page still shows something — badged NOT LOADED, because
// a saved profile that is not applied compensates nothing.
// Mesh parameters (probe_count, pps, algo, tension) are NOT top-level bed_mesh fields — Klipper reports
// them only under profiles[<name>].mesh_params — so configfile.settings.bed_mesh is the fallback.
// Every command is refused while a job is printing OR paused: BED_MESH_CLEAR mid-job silently drops z
// compensation for the rest of the print, and probing needs the bed to itself.
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Divider, Input, Toggle, Table, Confirm, T, mono } from "../../lib/design.jsx";
import { S } from "../../lib/ui.js";
import { useStore, usePersisted } from "../../lib/useStore.js";
import { has, help } from "../../lib/caps.js";
import { renderIsoMesh, meshStats, pickMesh, colorForZ, cleanMatrix, ISO_GRADIENT_CSS, DESIGN_ZSCALE, DESIGN_YAW, DESIGN_PITCH } from "../dashboard/adapters/isoMesh.js";
import { fmtSignedMm, fmtMm } from "../dashboard/adapters/heightmap.js";
import { makeToolheadActions } from "../../lib/actions/toolhead.js";

const DASH = "—";
/** Points per side offered by the DETAIL picker; 0 = every probed point (50×50 here → 2401 quads). */
const DETAILS = [13, 25, 0];
/** Points per side drawn WHILE a camera gesture is running (see `coarse`); the picked detail returns on release. */
const DRAG_N = 13;
/** Z exaggeration slider, as a multiple of the renderer's own default (420 svg px per mm). */
const ZMIN = 0.25, ZMAX = 6, ZSTEP = 0.25;
/** Camera limits: pitch stays off both degenerate ends (edge-on collapses the ground, top-down hides the relief). */
const PITCH_MIN = 12, PITCH_MAX = 80, ZOOM_MIN = 0.5, ZOOM_MAX = 12;
/** Drag sensitivity, degrees per css px. Wheel: zoom factor per px / per line of deltaY. */
const YAW_PER_PX = 0.4, PITCH_PER_PX = 0.25, WHEEL_PX = 0.0015, WHEEL_LINE = 0.05;
/** The design's own view: yaw 45°, its isometric pitch, the renderer's fit box untouched. */
const VIEW_DEFAULT = { yaw: DESIGN_YAW, pitch: DESIGN_PITCH, zoom: 1, ox: 0, oy: 0 };

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const mm = (v, d = 1) => (num(v) === null ? DASH : v.toFixed(d));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap360 = a => ((a % 360) + 360) % 360;
/** Klipper's gcode parser splits on whitespace, so a profile name with a space (or '=') can never be addressed. */
const validName = n => /^[^\s=]+$/.test(n);

/** The persisted camera, re-validated field by field — localStorage can hold junk or an older shape. */
function cleanView(v) {
  const o = v && typeof v === "object" ? v : {};
  const f = (x, lo, hi, d) => (num(x) === null ? d : clamp(x, lo, hi));
  return {
    yaw: num(o.yaw) === null ? DESIGN_YAW : wrap360(o.yaw),
    pitch: f(o.pitch, PITCH_MIN, PITCH_MAX, DESIGN_PITCH), zoom: f(o.zoom, ZOOM_MIN, ZOOM_MAX, 1),
    ox: f(o.ox, -1e5, 1e5, 0), oy: f(o.oy, -1e5, 1e5, 0),
  };
}
const isDefaultView = c => c.yaw === DESIGN_YAW && c.pitch === DESIGN_PITCH && c.zoom === 1 && c.ox === 0 && c.oy === 0;

/** One label / value line of the PARAMETERS panel. */
function Field({ k, v, color }) {
  return <Row style="justify-content:space-between; gap:12px; padding:3px 0">
    <Label>{k}</Label><Val size={10.5} color={color || T.body}>{v}</Val></Row>;
}

/**
 * Z-scale slider in the design's own vocabulary — 3px track, fill, 8px knob, exactly the LED sliders of
 * adapters/fansLeds.js. A native <input type="range"> is the one control the OS draws for us, and its
 * thumb is far too heavy for this UI. Pointer capture keeps the drag on this element, so there is no
 * window listener to leak if the page unmounts mid-drag. The padded wrapper is the hit area (the visible
 * track is 3px, which is not a grabbable target); vertical padding only, so its width still measures the track.
 */
function Slider({ value, min, max, step, disabled, onChange }) {
  const pct = (Math.max(0, Math.min(1, (value - min) / (max - min))) * 100).toFixed(1);
  const pick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    onChange(+(min + Math.round(t * (max - min) / step) * step).toFixed(3));
  };
  const down = e => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* no pointer capture */ } pick(e); };
  const move = e => { try { if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e); } catch (err) { /* ditto */ } };
  return <div onPointerDown={disabled ? undefined : down} onPointerMove={disabled ? undefined : move}
    style={S(`flex:1; min-width:110px; max-width:260px; padding:6px 0; margin:-6px 0; touch-action:none; cursor:${disabled ? "not-allowed" : "pointer"}; opacity:${disabled ? .4 : 1}`)}>
    <div style={S(`position:relative; height:3px; border-radius:2px; background:${T.panel2}`)}>
      <div style={S(`width:${pct}%; height:100%; border-radius:2px; background:${disabled ? T.ghost : T.accent}`)} />
      <div style={S(`position:absolute; left:${pct}%; top:50%; width:8px; height:8px; margin:-4px 0 0 -4px; border-radius:50%; background:${disabled ? T.mute : T.text}; border:2px solid ${disabled ? T.ghost : T.accent}`)} />
    </div>
  </div>;
}

/** One cell of the stats strip. `big` is the RANGE cell — the number that actually decides whether to re-probe. */
function Stat({ k, v, big, color }) {
  return <div style={S(`background:${T.panel3}; padding:${big ? "7px 11px" : "8px 11px"}; min-width:0`)}>
    <Label>{k}</Label>
    <div style={S(`margin-top:${big ? 2 : 3}px; ${mono(big ? 19 : 12.5, `color:${color || T.text}`)}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}>{v}</div>
  </div>;
}

export default function Page({ store, api }) {
  const st = useStore(store);                 // pages are rendered as a prop element — subscribe or go stale

  const bm = (st.raw && st.raw.bed_mesh) || null;
  const ps = (st.raw && st.raw.print_stats) || {};
  const cfg = (st.config && st.config.bed_mesh) || null;
  const savePending = !!((st.raw && st.raw.configfile) || {}).save_config_pending;
  // A paused job counts as busy: its remaining layers still depend on the mesh that is loaded right now.
  const jobState = ps.state === "printing" ? "printing" : ps.state === "paused" ? "paused" : null;

  // View settings survive Orca's constant reloads; values are re-validated because localStorage can hold junk.
  const [rawDetail, setDetail] = usePersisted("heightmap.detail", 25);
  const [rawZ, setZ] = usePersisted("heightmap.zscale", 1);
  const [flat, setFlat] = usePersisted("heightmap.flat", false);
  const [wire, setWire] = usePersisted("heightmap.wire", false);
  const [sel, setSel] = usePersisted("heightmap.profile", "");
  const [saveName, setSaveName] = usePersisted("heightmap.saveName", "");
  const [rawCam, setCam] = usePersisted("heightmap.view", VIEW_DEFAULT);
  const detail = DETAILS.indexOf(+rawDetail) >= 0 ? +rawDetail : 25;
  const zmult = isFinite(+rawZ) ? Math.max(ZMIN, Math.min(ZMAX, +rawZ)) : 1;
  const camRaw = React.useMemo(() => cleanView(rawCam), [rawCam]);

  const [hover, setHover] = React.useState(null);
  const [drag, setDrag] = React.useState(null);         // 'rotate' | 'pan' | 'pinch' | 'idle' — cursor + hover gate
  const [confirm, setConfirm] = React.useState(null);   // { kind: 'remove'|'clear'|'calibrate'|'carto', name }
  const [busy, setBusy] = React.useState(null);         // command in flight — every button waits for it
  // `busy` drives the UI but only lands a render later, so two events in the same tick would both pass a
  // state check. The ref is the actual single-flight latch (the Input's onEnter is not a disable-able button).
  const busyRef = React.useRef(false);
  const begin = cmd => { busyRef.current = true; setBusy(cmd); };
  const end = () => { busyRef.current = false; setBusy(null); };

  /** Shared console line (the dashboard footer and the console page both read store.log). */
  const log = React.useCallback((message, type) => {
    if (!store) return;
    const entry = { time: Date.now() / 1000, message: String(message), type: type || "info", local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }, [store]);

  // BED_MESH_CALIBRATE goes through the shared toolhead action rather than a local copy: it owns the homing and
  // QGL pre-checks (including the case where printer.cfg wraps the native in a macro that homes itself) and
  // treats the 30 s rpc timeout on a probe run as "still running" instead of an error.
  const act = React.useMemo(() => makeToolheadActions({ api, store, log }), [api, store, log]);

  // ---- profiles -----------------------------------------------------------
  const profiles = React.useMemo(() => {
    const all = (bm && bm.profiles && typeof bm.profiles === "object") ? bm.profiles : {};
    return Object.keys(all).sort().map(name => {
      const p = all[name] || {};
      const mp = p.mesh_params || {};
      const s = meshStats(p.points);
      return { name, mp, s, grid: num(mp.x_count) && num(mp.y_count) ? `${mp.x_count}×${mp.y_count}` : s ? `${s.cols}×${s.rows}` : DASH };
    });
  }, [bm]);
  const activeName = bm && bm.profile_name ? String(bm.profile_name) : "";
  const names = profiles.map(p => p.name);
  // The persisted selection wins, then the loaded profile, then whatever exists.
  const selName = names.indexOf(sel) >= 0 ? sel : names.indexOf(activeName) >= 0 ? activeName : names[0] || "";
  const selProfile = profiles.find(p => p.name === selName) || null;

  // ---- what to draw -------------------------------------------------------
  const picked = React.useMemo(() => pickMesh(bm, { fallbackSaved: true, prefer: selName }), [bm, selName]);
  const stats = React.useMemo(() => (picked ? meshStats(picked.matrix) : null), [picked]);
  // The renderer's r0/c0 index the CLEANED matrix (cleanMatrix drops non-array rows and truncates every row
  // to the shortest), so the hover readout has to index that one too — the raw matrix would name the wrong
  // bed XY the moment Klipper reports a ragged payload. Same normalisation stats and the quads already use.
  const cells = React.useMemo(() => (picked ? cleanMatrix(picked.matrix) : null), [picked]);
  // A rotate/pan step re-runs the renderer AND rebuilds every <polygon>: 73 ms per pointermove at FULL detail
  // (2401 quads → ~13 fps) against 10 ms at 25×25 (576), measured in this browser — Orca's webview is slower.
  // Only ~6 ms of that is the renderer itself; the rest is 2401 React elements reconciled per frame. So the
  // gesture draws coarse (13×13 = 144 quads) and the picked detail comes back on release. Hover is gated on the
  // drag anyway, so nothing reads the coarse quads, and DETAIL 13/25 are already cheap enough to leave alone.
  const coarse = !!drag && (detail === 0 || detail > DRAG_N);
  const shown = coarse ? DRAG_N : detail;
  const view = React.useMemo(() => (picked ? renderIsoMesh(picked.matrix, {
    N: shown, zScale: flat ? 0 : DESIGN_ZSCALE * zmult, bounds: picked.bounds, frame: true, yaw: camRaw.yaw, pitch: camRaw.pitch
  }) : null), [picked, shown, flat, zmult, camRaw.yaw, camRaw.pitch]);
  /**
   * The probe point nearest a quad — its EXACT matrix z and bed XY. A quad's own z is the average of its four
   * corners (and at low detail it spans several probes), so the readout would otherwise show a number that was
   * never measured. Returns null when the cell holds junk; callers fall back to the quad average.
   */
  function probeAt(q) {
    if (!q || !cells || !stats) return null;
    const r = Math.round((q.r0 + q.r1) / 2), c = Math.round((q.c0 + q.c1) / 2);
    const row = cells[r] || null;
    const z = row && typeof row[c] === "number" && isFinite(row[c]) ? row[c] : null;
    if (z === null) return null;
    const b = picked.bounds;
    return {
      z, r, c,
      x: b && stats.cols > 1 ? b.min[0] + (c / (stats.cols - 1)) * (b.max[0] - b.min[0]) : null,
      y: b && stats.rows > 1 ? b.min[1] + (r / (stats.rows - 1)) * (b.max[1] - b.min[1]) : null,
    };
  }

  // ---- camera: pan / zoom as a viewBox transform over the renderer's fit box -------------------------
  // The renderer's box is the auto-fit for the current yaw/pitch/z (it grows only when relief spills). zoom
  // 1 / offset 0 shows exactly that box, so the default camera IS the design's picture.
  const baseBox = React.useMemo(() => (view && !view.empty ? view.viewBox.split(" ").map(Number) : null), [view]);
  const svgRef = React.useRef(null);
  const baseRef = React.useRef(baseBox); baseRef.current = baseBox;
  // What the renderer actually DREW, for the pan clamp below (the fit box alone is not enough: at a low pitch or an
  // off-centre yaw the relief covers only the middle of it, so a pan clamped to the box can still show blank space).
  const extRef = React.useRef(null); extRef.current = (view && !view.empty && view.extent) || null;
  const dragRef = React.useRef(null);                              // mirrors `drag` for the polygon closures
  // The camera as rendered: the PERSISTED pan is re-clamped against the mesh that is on screen now. localStorage can
  // hold an offset saved for a different mesh, or junk (cleanView only bounds it to ±1e5, which is 200 boxes away) —
  // and an off-screen camera paints an empty black panel with nothing to say that RESET VIEW is the way back.
  const cam = baseBox ? clampPan(camRaw) : camRaw;
  const vb = baseBox ? [baseBox[0] + cam.ox, baseBox[1] + cam.oy, baseBox[2] / cam.zoom, baseBox[3] / cam.zoom] : null;
  // The camera the handlers work from. Re-synced to React's every render, and advanced by each gesture step
  // BEFORE React has rendered it — two moves in one frame must build on each other, not both on the last render.
  // No rAF coalescing on purpose: browsers already align pointermove/wheel to the frame and drop intermediate
  // moves while the main thread is busy, and a rAF-gated commit never lands in a tab that is not compositing.
  const liveRef = React.useRef(cam); liveRef.current = cam;
  const ptrs = React.useRef(new Map());                            // pointerId → last client position
  const setMode = m => { dragRef.current = m; setDrag(m); };
  const current = () => liveRef.current;
  const commit = next => { liveRef.current = next; setCam(next); };

  /** Client px → svg user units for a given camera, replicating preserveAspectRatio="xMidYMid meet". */
  function userPoint(clientX, clientY, c) {
    const svg = svgRef.current, base = baseRef.current;
    if (!svg || !base) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const W = base[2] / c.zoom, H = base[3] / c.zoom;
    const s = Math.min(r.width / W, r.height / H);
    return { x: base[0] + c.ox + (clientX - r.left - (r.width - s * W) / 2) / s, y: base[1] + c.oy + (clientY - r.top - (r.height - s * H) / 2) / s, s };
  }
  /**
   * Pan limit: the CENTRE of the viewport has to stay over the mesh that was drawn (view.extent), not merely
   * overlap the fit box. Clamping to the box was not enough — the box is the design's nominal one, and at
   * yaw 5° / pitch 45° / zoom 1.3 a shift-drag parked all 576 quads outside the viewport with nothing but
   * RESET VIEW to explain it. With this rule a hard pan leaves the whole mesh visible at zoom ≤ 1 and a third
   * of it at 1.3; zoomed past ~2× the viewport is smaller than one corner of the extent, so it can still sit
   * over empty space beside the relief — but never further than one viewport away from it.
   * The allowed range is exactly the extent's width/height, so lo ≤ hi always. No extent (nothing drawn) → the
   * old box rule, which is all there is to go on.
   */
  function clampPan(c) {
    const base = baseRef.current;
    if (!base) return c;
    const e = extRef.current;
    const W = base[2] / c.zoom, H = base[3] / c.zoom;
    if (!e) return Object.assign({}, c, { ox: clamp(c.ox, -W + 0.1 * W, base[2] - 0.1 * W), oy: clamp(c.oy, -H + 0.1 * H, base[3] - 0.1 * H) });
    return Object.assign({}, c, {
      ox: clamp(c.ox, e.minX - W / 2 - base[0], e.maxX - W / 2 - base[0]),
      oy: clamp(c.oy, e.minY - H / 2 - base[1], e.maxY - H / 2 - base[1]),
    });
  }
  /** Zoom by `factor` about a client point — the mesh under the cursor stays under the cursor. */
  function zoomAt(c, clientX, clientY, factor) {
    const u = userPoint(clientX, clientY, c);
    const zoom = clamp(c.zoom * clamp(factor, 0.5, 2), ZOOM_MIN, ZOOM_MAX), f = zoom / c.zoom;
    if (!u || f === 1) return c;
    const base = baseRef.current, x0 = base[0] + c.ox, y0 = base[1] + c.oy;
    return clampPan(Object.assign({}, c, { zoom, ox: u.x - (u.x - x0) / f - base[0], oy: u.y - (u.y - y0) / f - base[1] }));
  }
  function panBy(c, dxPx, dyPx) {
    const u = userPoint(0, 0, c);
    return u ? clampPan(Object.assign({}, c, { ox: c.ox - dxPx / u.s, oy: c.oy - dyPx / u.s })) : c;
  }
  const rotateBy = (c, dxPx, dyPx) => Object.assign({}, c, {
    yaw: wrap360(c.yaw - dxPx * YAW_PER_PX),                        // drag right → the near edge swings right
    pitch: clamp(c.pitch + dyPx * PITCH_PER_PX, PITCH_MIN, PITCH_MAX) // drag down → pull the far edge toward you
  });

  // Pointer capture per pointer, like the Slider: no window listeners to leak, and a captured pointer sends
  // no mouseenter to the polygons, so the hover outline cannot flicker across cells while dragging.
  const onDown = e => {
    if (!baseRef.current) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* no pointer capture */ }
    if (e.button === 1 || e.button === 2) e.preventDefault();       // middle: no autoscroll; right: no context menu
    setHover(null);
    if (ptrs.current.size >= 2) { setMode("pinch"); return; }
    setMode(e.shiftKey || e.button === 1 || e.button === 2 ? "pan" : "rotate");
  };
  const onMove = e => {
    const p = ptrs.current.get(e.pointerId);
    if (!p) return;
    const n = { x: e.clientX, y: e.clientY }, c = current();
    if (ptrs.current.size >= 2) {
      // pinch: zoom about the old midpoint by the distance ratio, then follow the midpoint
      const other = [...ptrs.current.entries()].find(([id]) => id !== e.pointerId);
      ptrs.current.set(e.pointerId, n);
      if (!other) return;
      const q = other[1];
      const d0 = Math.hypot(p.x - q.x, p.y - q.y), d1 = Math.hypot(n.x - q.x, n.y - q.y);
      const m0 = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, m1 = { x: (n.x + q.x) / 2, y: (n.y + q.y) / 2 };
      commit(panBy(d0 > 0 && d1 > 0 ? zoomAt(c, m0.x, m0.y, d1 / d0) : c, m1.x - m0.x, m1.y - m0.y));
      return;
    }
    ptrs.current.set(e.pointerId, n);
    const dx = n.x - p.x, dy = n.y - p.y;
    if (dragRef.current === "pan") commit(panBy(c, dx, dy));
    else if (dragRef.current === "rotate") commit(rotateBy(c, dx, dy));
  };
  const onUp = e => {
    const had = ptrs.current.delete(e.pointerId);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    // An unknown pointer only means "ignore" while others are still down. With none left the mode MUST clear:
    // a stranded mode blocks hover for good and (since the drag draws coarse) would pin the mesh at 13×13.
    if (!had && ptrs.current.size) return;
    // a finger left a pinch: the one still down must not turn into a rotate mid-gesture
    if (ptrs.current.size === 0) setMode(null); else setMode("idle");
  };
  // Wheel must preventDefault (or the page scrolls under Orca's webview); React registers wheel as passive,
  // so this one listener is attached natively. Handlers read refs only, so the closure never goes stale.
  const hasMesh = !!baseBox;
  React.useEffect(() => {
    const el = svgRef.current;
    if (!el || !hasMesh) return undefined;
    const onWheel = e => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? WHEEL_LINE * 10 : WHEEL_PX;
      commit(zoomAt(current(), e.clientX, e.clientY, Math.exp(-e.deltaY * k)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMesh]);
  const resetView = () => commit(VIEW_DEFAULT);

  // 2401 polygons at FULL detail: built once per view, so the 1 Hz store emits do not rebuild them.
  // The stroke WIDTH is deliberately not set here — it lives on the wrapping <g> below, because it has to
  // follow the zoom, and a per-polygon width would rebuild all 2401 elements on every wheel tick (pan and
  // zoom are otherwise free: they only change the viewBox, `view` does not depend on them).
  const polys = React.useMemo(() => {
    if (!view || view.empty) return null;
    return view.quads.map((q, i) => {
      const p = probeAt(q);
      return <polygon key={i} points={q.points} fill={wire ? "none" : q.fill} fillOpacity={wire ? undefined : q.op}
        stroke={wire ? q.fill : "#0a0e13"} strokeLinejoin="round" onMouseEnter={() => { if (!dragRef.current) setHover(q); }}>
        <title>{p ? fmtSignedMm(p.z) + " mm" : q.title}</title></polygon>;
    });
  }, [view, wire]);
  // Anything measured in svg user units is multiplied by the zoom on screen, so every stroke is divided by it
  // to stay the hairline the design asks for — the axis labels already did this, the strokes did not: at ×6 the
  // 0.4 px cell edges came out 2.1 px and the ground frame became a 7 px dashed band over the mesh.
  // At zoom 1 these are the same numbers as before, so the default view is unchanged.
  const zk = cam.zoom;
  const quadStroke = view && !view.empty ? (view.cell * (wire ? 0.05 : 0.03) / zk).toFixed(3) : "0";
  const frameStroke = (0.9 / zk).toFixed(3);
  const frameDash = (5 / zk).toFixed(2) + " " + (4 / zk).toFixed(2);
  const hoverStroke = view && !view.empty ? (Math.max(0.6, view.cell * 0.12) / zk).toFixed(2) : "0";
  // A kept quad would outline the wrong cell. Layout, not passive: a plain effect runs AFTER paint, so the
  // stale outline is drawn against the new viewBox for one frame every time DETAIL or Z SCALE changes.
  React.useLayoutEffect(() => { setHover(null); }, [view]);

  const params = (picked && picked.profile && picked.profile.mesh_params) || (selProfile && selProfile.mp) || {};
  const bounds = picked && picked.bounds;
  const meshRows = bm && Array.isArray(bm.mesh_matrix) && bm.mesh_matrix.length ? bm.mesh_matrix.length : 0;
  const meshCols = meshRows && Array.isArray(bm.mesh_matrix[0]) ? bm.mesh_matrix[0].length : 0;
  const probePts = num(params.x_count) && num(params.y_count) ? params.x_count * params.y_count
    : Array.isArray(cfg && cfg.probe_count) ? cfg.probe_count[0] * cfg.probe_count[1] : null;

  // Axis labels ride the ground frame's front edges (X: fl→fr, Y: fl→bl), so they turn with the mesh and always
  // point along +axis; the text is flipped upright when the edge runs leftwards. Sized in user units divided by
  // the zoom, so they keep their on-screen size while the mesh grows — and scaled by how far the renderer had to
  // grow its own box past the design's 460×320, which `meet` pays for in scale: without that the label was 6.8 css
  // px at the default and 5.3 px at Z SCALE ×6, below anything else in this UI. Exactly 4.6 at the default view.
  const axisLabels = React.useMemo(() => {
    if (!view || view.empty || !view.frame) return null;
    const f = view.frame, P = k => [Number(f[k][0]), Number(f[k][1])];
    const fl = P("fl"), fr = P("fr"), bl = P("bl"), br = P("br");
    const C = [(fl[0] + fr[0] + bl[0] + br[0]) / 4, (fl[1] + fr[1] + bl[1] + br[1]) / 4];
    const grow = baseBox ? Math.max(1, baseBox[2] / 460, baseBox[3] / 320) : 1;
    const fs = 4.6 * grow / cam.zoom;
    const mk = (A, B, label, key) => {
      const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      let ang = Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI, flip = false;
      if (ang > 90) { ang -= 180; flip = true; } else if (ang <= -90) { ang += 180; flip = true; }
      let nx = M[0] - C[0], ny = M[1] - C[1];
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      const x = M[0] + nx * fs * 1.7, y = M[1] + ny * fs * 1.7;
      return <text key={key} x={x.toFixed(1)} y={y.toFixed(1)} transform={`rotate(${ang.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`}
        textAnchor="middle" dominantBaseline="middle" fill={T.faint} fontFamily={T.mono} fontSize={fs.toFixed(2)} letterSpacing={(fs * 0.1).toFixed(2)}
        pointerEvents="none">{flip ? "← " + label : label + " →"}</text>;
    };
    const xl = bounds ? `X ${mm(bounds.min[0], 0)}–${mm(bounds.max[0], 0)}` : "X", yl = bounds ? `Y ${mm(bounds.min[1], 0)}–${mm(bounds.max[1], 0)}` : "Y";
    return [mk(fl, fr, xl, "x"), mk(fl, bl, yl, "y")];
  }, [view, cam.zoom, baseBox, bounds]);

  // ---- commands -----------------------------------------------------------
  const can = n => has(st, n) !== false;                // null = catalogue not loaded yet → stay optimistic
  const why = (cmd, extra) => !can(cmd) ? cmd + " is not registered on this printer"
    : jobState ? "Refused while a job is " + jobState : extra || help(st, cmd) || cmd;

  /** Klipper unavailable or a job in progress — same shape as the guard in lib/actions/*.js. */
  function blocked(cmd) {
    if (!api || typeof api.gcode !== "function") { log("Command rejected — no printer connection", "err"); return true; }
    const k = st.klippy;
    if (k === "shutdown" || k === "disconnected" || k === "startup" || k === "error") {
      log("Command rejected — Klipper is " + k + (k === "shutdown" ? " (FIRMWARE_RESTART required)" : ""), "err");
      return true;
    }
    if (jobState) { log("Refused — " + cmd + " while a job is " + jobState, "warn"); return true; }
    return false;
  }

  async function send(script, okMsg) {
    if (busyRef.current || blocked(script.split(" ")[0])) return false;
    log(script);
    begin(script);
    try {
      await api.gcode(script);
      if (okMsg) log(okMsg, "ok");
      return true;
    } catch (e) {
      log((e && e.message) || String(e), "err");
      return false;
    } finally { end(); }
  }

  const loadProfile = () => selName && send(`BED_MESH_PROFILE LOAD=${selName}`, `Mesh profile '${selName}' loaded`);
  const clearMesh = () => send("BED_MESH_CLEAR", "Bed mesh cleared — no z compensation until a profile is loaded");
  const removeProfile = name => send(`BED_MESH_PROFILE REMOVE=${name}`, `Profile '${name}' removed — SAVE_CONFIG to make it permanent`);
  const doSave = name => send(`BED_MESH_PROFILE SAVE=${name}`, `Mesh saved as '${name}' — SAVE_CONFIG to write it to printer.cfg`);
  function saveProfile() {
    const name = String(saveName || "").trim() || activeName || "default";
    if (!validName(name)) { log("Profile name may not contain spaces or '=' — Klipper cannot address it", "warn"); return; }
    if (!picked || picked.saved) { log("Nothing to save — no mesh is loaded (probe one first)", "warn"); return; }
    // Klipper replaces a same-named profile without asking and the mesh it drops cannot be recovered — and the
    // field is EMPTY by default, so a bare click targets the placeholder (the loaded profile, else "default").
    if (names.indexOf(name) >= 0) { setConfirm({ kind: "overwrite", name }); return; }
    doSave(name);
  }
  async function calibrate() {
    if (busyRef.current || blocked("BED_MESH_CALIBRATE")) return;
    begin("BED_MESH_CALIBRATE");
    try { await act.home("MESH"); }        // logs, warns about an unapplied QGL, treats the 30 s rpc timeout as "still running"
    catch (e) { log((e && e.message) || String(e), "err"); }   // runConfirm does not await this — never leave a rejection unhandled
    finally { end(); }
  }
  async function cartographer() {
    if (busyRef.current || blocked("CALIBRATE_CARTOGRAPHER")) return;
    log("CALIBRATE_CARTOGRAPHER — homing, leveling and recalibrating the probe");
    begin("CALIBRATE_CARTOGRAPHER");
    try { await api.gcode("CALIBRATE_CARTOGRAPHER"); log("CALIBRATE_CARTOGRAPHER complete", "ok"); }
    catch (e) {
      const msg = (e && e.message) || String(e);
      // Same contract as the long toolhead scripts: no reply in 30 s means still running, not failed.
      if (/^timeout/i.test(msg)) log("CALIBRATE_CARTOGRAPHER still running — the result will show in the console");
      else log(msg, "err");
    } finally { end(); }
  }

  function runConfirm() {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.kind === "remove") removeProfile(c.name);
    else if (c.kind === "overwrite") doSave(c.name);
    else if (c.kind === "clear") clearMesh();
    else if (c.kind === "calibrate") calibrate();
    else if (c.kind === "carto") cartographer();
  }
  // CLEAR is confirmed like the rest: an adaptive mesh (BED_MESH_CALIBRATE ADAPTIVE=1 leaves profile_name
  // empty, so pickMesh names it "unsaved") belongs to no profile, and clearing it costs another probe run —
  // there is no LOAD that brings it back.
  const clearUnsaved = !!picked && !picked.saved && picked.name === "unsaved";
  const confirmText = !confirm ? "" :
    confirm.kind === "remove" ? `Remove profile '${confirm.name}' for good? SAVE_CONFIG is needed afterwards.`
    : confirm.kind === "overwrite" ? `Profile '${confirm.name}' already exists. Replace its mesh with the one loaded now? The old mesh is gone — only another probe run brings it back.`
    : confirm.kind === "clear" ? (clearUnsaved
        ? "Clear the mesh? It was never saved to a profile, so the only way back is another probe run."
        : `Clear the mesh? Z compensation stops until a profile is loaded — '${picked ? picked.name : "default"}' can be re-loaded from the list above.`)
    : confirm.kind === "calibrate" ? `Probe ${probePts ? probePts + " points" : "the bed"} now? Several minutes, and the toolhead moves.`
    : "Recalibrate the Cartographer? It homes, levels and replaces the saved probe model.";

  // ---- header / empty-state copy ------------------------------------------
  const meshConfigured = Array.isArray(st.objects) && st.objects.length ? st.objects.indexOf("bed_mesh") >= 0 : null;
  const emptyHint = meshConfigured === false ? "No [bed_mesh] section in printer.cfg."
    : st.klippy !== "ready" ? "Klipper is " + (st.klippy || "unknown") + " — the mesh will appear once it is ready."
    : !bm ? "Waiting for the printer's bed_mesh status…"
    : "Nothing probed and no saved profile — run BED_MESH_CALIBRATE to build one.";

  const nameChip = !picked ? <Chip color={T.mute}>NO MESH</Chip>
    : picked.saved ? <Chip color={T.warn} border="#3a2f14" bg="#14100a">SAVED · NOT LOADED</Chip>
    : <Chip color={T.ok} border="#1c3d37" bg="#0f2320" pulse={false}>LOADED</Chip>;

  const probe = hover ? probeAt(hover) : null;
  const cursor = drag === "rotate" ? "grabbing" : drag === "pan" || drag === "pinch" ? "move" : drag ? "default" : "grab";
  const camReadout = `YAW ${Math.round(cam.yaw) % 360}° · PITCH ${Math.round(cam.pitch)}° · ×${cam.zoom.toFixed(2)}`;

  return <div style={S("flex:1; display:grid; gap:10px; padding:10px; grid-template-columns:minmax(0,1fr) 340px; grid-template-rows:minmax(430px,1fr)")}>

    <Panel title="BED MESH" accent={T.info}
      right={<Row gap={8}>
        {/* X×Y, the order PROBE COUNT and the profile list use (Klipper's own x_count × y_count) — the matrix is
            [row = Y][col = X], so cols is the X count. Identical on this square 50×50, wrong on a KAMP adaptive mesh. */}
        <Val size={9} color={T.ghost}>{picked ? `${picked.name} · ${stats ? stats.cols + "×" + stats.rows : DASH}` : DASH}</Val>
        {nameChip}
      </Row>}
      bodyStyle="display:flex; flex-direction:column; gap:9px; padding:10px 12px 12px">

      {/* view controls — nothing here touches the printer */}
      <Row gap={10} style="flex:none; flex-wrap:wrap">
        <Label>DETAIL</Label>
        <Row gap={4}>{DETAILS.map(n => (
          <Btn key={n} small kind={detail === n ? "accent" : "default"} onClick={() => setDetail(n)}
            title={n ? `Draw at most ${n}×${n} points (corners kept)` : "Draw every probed point"}>{n ? n : "FULL"}</Btn>
        ))}</Row>
        <div style={S(`width:1px; height:16px; background:${T.line}`)} />
        <Label>3D</Label><Toggle on={!flat} onClick={() => setFlat(!flat)} />
        <Label>WIRE</Label><Toggle on={!!wire} onClick={() => setWire(!wire)} />
        <div style={S(`width:1px; height:16px; background:${T.line}`)} />
        <Label>Z SCALE</Label>
        <Slider value={zmult} min={ZMIN} max={ZMAX} step={ZSTEP} disabled={!!flat} onChange={setZ} />
        <Val size={10} color={flat ? T.faint : T.body}>{flat ? "FLAT" : "×" + zmult.toFixed(2)}</Val>
        <Btn small disabled={isDefaultView(cam)} onClick={resetView} style="margin-left:auto"
          title="Back to the design's view — yaw 45°, pitch 35°, fitted to the panel">RESET VIEW</Btn>
      </Row>

      {/* mesh viewport — the design's heightmap frame, scaled up to the page */}
      <div style={S(`position:relative; flex:1; min-height:0; border:1px solid ${T.line}; border-radius:4px; overflow:hidden; background:radial-gradient(ellipse at 50% 40%, #10161f, #0a0e13 70%)`)}>
        {view && !view.empty && vb ? (
          // Taken OUT of flow, like the empty state beside it. In flow, an svg with width:100% and a
          // percentage height nothing definite can resolve falls back to its viewBox aspect ratio — and the
          // renderer grows that box with the relief, so at Z SCALE ×4 the element was 1234 px tall, the page
          // grew past the viewport and the legend and stats strip dropped below the fold. Absolute means the
          // viewport box decides the size and `meet` fits the mesh into it at every exaggeration.
          // touch-action:none hands every touch to the pointer handlers (one finger turns, two pinch).
          <svg ref={svgRef} viewBox={vb.map(v => +v.toFixed(2)).join(" ")} preserveAspectRatio="xMidYMid meet"
            style={S(`position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; user-select:none; cursor:${cursor}`)}
            onMouseLeave={() => setHover(null)} onContextMenu={e => e.preventDefault()}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp}>
            {/* ground plane at z = min: stroke/dash in user units ÷ zoom, and the footprint is a constant 224 whatever the detail */}
            {view.frame && <polygon points={view.frame.points} fill="none" stroke={T.line2} strokeWidth={frameStroke} strokeDasharray={frameDash} />}
            <g strokeWidth={quadStroke}>{polys}</g>
            {axisLabels}
            {hover && <polygon points={hover.points} fill="none" stroke={T.text} strokeWidth={hoverStroke}
              strokeLinejoin="round" pointerEvents="none" />}
          </svg>
        ) : (
          <div style={S("position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:20px; text-align:center")}>
            <div style={S(`${mono(11, `letter-spacing:.3em; color:${T.accent}`)}`)}>NO MESH</div>
            <div style={S(`font-size:12px; color:${T.mute}; max-width:420px`)}>{emptyHint}</div>
          </div>
        )}
        <div style={S("position:absolute; inset:0; pointer-events:none; box-shadow:inset 0 0 30px rgba(6,8,11,.55)")} />
        {/* camera readout + gesture hint; the bed axes themselves are labelled inside the svg, on the frame.
            Only with a mesh on screen: with none there is no svg to catch a drag or a wheel, so the hint would
            be advertising three gestures that do nothing. The hint was T.line2 — a BORDER token, which as 7.5px
            text on this background measures 1.56:1, invisible; and this line is the only place the camera
            announces itself, so it is prose (T.mute, 4.2:1, like this page's other notes), not a micro-label. */}
        {view && !view.empty && vb && <>
          <span style={S(`position:absolute; left:9px; bottom:7px; pointer-events:none; ${mono(7.5, `letter-spacing:.1em; color:${T.faint}`)}`)}>{camReadout}</span>
          <span style={S(`position:absolute; right:9px; bottom:7px; pointer-events:none; ${mono(7.5, `letter-spacing:.1em; color:${T.mute}`)}`)}>DRAG ROTATE · ⇧ DRAG PAN · WHEEL ZOOM</span>
        </>}
        {hover && stats && (
          <div style={S(`position:absolute; right:9px; top:9px; display:flex; align-items:center; gap:9px; padding:6px 9px; border:1px solid ${T.line}; border-radius:4px; background:rgba(13,18,26,.92); pointer-events:none`)}>
            <span style={S(`width:9px; height:9px; border-radius:2px; background:${colorForZ(probe ? probe.z : hover.z, stats.min, stats.max)}`)} />
            <Val size={10.5} color={T.text}>{fmtSignedMm(probe ? probe.z : hover.z)} mm</Val>
            <span style={S(`${mono(9.5, `color:${T.mute}`)}`)}>
              {probe && num(probe.x) !== null ? `X ${mm(probe.x)} · Y ${mm(probe.y)}`
                : probe ? `row ${probe.r} · col ${probe.c}` : `row ${hover.r0} · col ${hover.c0}`}
            </span>
          </div>
        )}
      </div>

      {/* colour legend — the renderer's own ramp, so the bar can never drift from the fills */}
      <Row gap={9} style="flex:none">
        <Val size={8.5} color={T.info}>{stats ? fmtSignedMm(stats.min) : DASH}</Val>
        <div style={S(`flex:1; height:5px; border-radius:3px; background:${ISO_GRADIENT_CSS}`)} />
        <Val size={8.5} color={T.accent}>{stats ? fmtSignedMm(stats.max) : DASH}</Val>
      </Row>

      <div style={S(`flex:none; display:grid; grid-template-columns:1.5fr repeat(5, 1fr); gap:1px; background:${T.line}; border:1px solid ${T.line}; border-radius:4px; overflow:hidden`)}>
        <Stat big k="RANGE" v={stats ? fmtMm(stats.range) : DASH} />
        <Stat k="MIN" v={stats ? fmtSignedMm(stats.min) : DASH} color={T.info} />
        <Stat k="MAX" v={stats ? fmtSignedMm(stats.max) : DASH} color={T.accent} />
        <Stat k="MEAN" v={stats ? fmtSignedMm(stats.mean) : DASH} />
        <Stat k="σ DEV" v={stats ? fmtMm(stats.dev) : DASH} />
        <Stat k="POINTS" v={stats ? String(stats.n) : DASH} color={T.dim} />
      </div>
    </Panel>

    {/* The shell is min-height:100vh, not height:100vh, so a grid row of 1fr sizes to its tallest column's
        max-content instead of the space available: this sidebar's natural 762px was making the whole page 819px
        on every window, pushing the stats strip below the fold and scrolling the top bar away (measured at
        820×620: document 819 px against a 614 px viewport; with the cap, 620). 76px = the shell's 56px header
        plus this page's own 10px padding, top and bottom. */}
    <div style={S("display:flex; flex-direction:column; gap:10px; min-height:0; max-height:calc(100vh - 76px)")}>

      {/* 340px of header fits one chip: an in-flight command outranks the pending-config reminder, which is
          static and can wait (this printer sits at save_config_pending for days at a time). */}
      <Panel title="PROFILES" style="flex:none"
        right={busy ? <Chip color={T.warn} border="#3a2f14" bg="#14100a" pulse>{busy.split(" ")[0]}</Chip>
          : savePending ? <Chip color={T.warn} border="#3a2f14" bg="#14100a">SAVE_CONFIG PENDING</Chip> : null}
        bodyStyle="display:flex; flex-direction:column; padding:0">
        <div style={S("padding:6px 6px 0; max-height:230px; overflow:auto")}>
          <Table
            cols={[
              { k: "name", label: "PROFILE", w: "1fr", render: r => <Row gap={6}>
                <span style={S(`width:5px; height:5px; border-radius:50%; flex:none; background:${r.name === activeName ? T.ok : T.ghost}`)} />
                <span style={S(`overflow:hidden; text-overflow:ellipsis; color:${r.name === selName ? T.text : T.body}`)}>{r.name}</span></Row> },
              { k: "grid", label: "GRID", w: "58px", align: "right" },
              { k: "range", label: "RANGE mm", w: "70px", align: "right", render: r => r.s ? r.s.range.toFixed(3) : DASH },
            ]}
            rows={profiles} rowKey={r => r.name} onRow={r => setSel(r.name)}
            rowStyle={r => (r.name === selName ? "background:#131a24" : "")}
            empty="no saved profiles — probe a mesh, then SAVE" />
        </div>

        <div style={S("padding:10px 12px 12px; display:flex; flex-direction:column; gap:8px")}>
          <Row gap={6}>
            {/* with no profiles at all selName is "", so the titles have to say that rather than "'' is already loaded" */}
            <Btn kind="ok" disabled={!can("BED_MESH_PROFILE") || !!jobState || !!busy || !selName || selName === activeName}
              title={!selName ? "No saved profile to load" : selName === activeName ? `'${selName}' is already loaded` : why("BED_MESH_PROFILE", `BED_MESH_PROFILE LOAD=${selName}`)}
              onClick={loadProfile}>LOAD</Btn>
            <Btn kind="danger" disabled={!can("BED_MESH_PROFILE") || !!jobState || !!busy || !selName}
              title={!selName ? "No saved profile to remove" : why("BED_MESH_PROFILE", `BED_MESH_PROFILE REMOVE=${selName}`)}
              onClick={() => setConfirm({ kind: "remove", name: selName })}>REMOVE</Btn>
            <Btn disabled={!can("BED_MESH_CLEAR") || !!jobState || !!busy || !(picked && !picked.saved)}
              title={!picked || picked.saved ? "No mesh is loaded" : why("BED_MESH_CLEAR")}
              onClick={() => setConfirm({ kind: "clear" })} style="margin-left:auto">CLEAR</Btn>
          </Row>

          <Row gap={6}>
            <Input value={saveName} onChange={e => setSaveName(e.target.value)} onEnter={saveProfile}
              placeholder={activeName || "default"} style="flex:1; min-width:0" />
            <Btn disabled={!can("BED_MESH_PROFILE") || !!jobState || !!busy || !(picked && !picked.saved)}
              title={picked && picked.saved ? "No mesh is loaded — probe one first" : why("BED_MESH_PROFILE", "BED_MESH_PROFILE SAVE=<name> (needs SAVE_CONFIG afterwards)")}
              onClick={saveProfile}>SAVE</Btn>
          </Row>

          <Divider />

          <Row gap={6}>
            <Btn kind="accent" disabled={!can("BED_MESH_CALIBRATE") || !!jobState || !!busy}
              title={why("BED_MESH_CALIBRATE", "Probe the bed and load the result as the active mesh")}
              onClick={() => setConfirm({ kind: "calibrate" })}>CALIBRATE</Btn>
            {can("CALIBRATE_CARTOGRAPHER") && (
              <Btn kind="warn" disabled={!!jobState || !!busy}
                title={why("CALIBRATE_CARTOGRAPHER")}
                onClick={() => setConfirm({ kind: "carto" })}>CARTOGRAPHER</Btn>
            )}
          </Row>
          {/* prose, so sans at the design's note size — mono is this UI's micro-LABEL face, not its body face */}
          <div style={S(`font-size:11px; color:${T.dim}; line-height:1.5; text-wrap:pretty`)}>
            {jobState ? `Mesh commands are refused while a job is ${jobState}.`
              : `CALIBRATE probes ${probePts ? probePts + " points" : "the bed"} and takes several minutes — the toolhead moves. Saving or removing a profile also needs SAVE_CONFIG, which restarts Klipper.`}
          </div>
        </div>

        {confirm && <Confirm text={confirmText} onYes={runConfirm} onNo={() => setConfirm(null)}
          yes={confirm.kind === "remove" ? "REMOVE" : confirm.kind === "overwrite" ? "REPLACE" : confirm.kind === "clear" ? "CLEAR" : "RUN"} />}
      </Panel>

      <Panel title="MESH PARAMETERS" accent={T.ok} style="flex:1; min-height:0" bodyStyle="padding:8px 12px 12px; overflow:auto">
        <Field k="ACTIVE PROFILE" v={activeName || "none"} color={activeName ? T.text : T.mute} />
        <Field k="SHOWING" v={picked ? picked.name + (picked.saved ? " (saved)" : " (live)") : DASH} />
        <Field k="MESH AREA X" v={bounds ? `${mm(bounds.min[0])} → ${mm(bounds.max[0])}` : DASH} />
        <Field k="MESH AREA Y" v={bounds ? `${mm(bounds.min[1])} → ${mm(bounds.max[1])}` : DASH} />
        <Field k="PROBE COUNT" v={num(params.x_count) && num(params.y_count) ? `${params.x_count} × ${params.y_count}`
          : Array.isArray(cfg && cfg.probe_count) ? `${cfg.probe_count[0]} × ${cfg.probe_count[1]}` : DASH} />
        <Field k="PROBED POINTS" v={stats ? String(stats.n) : DASH} />
        <Field k="INTERPOLATED" v={meshRows && meshCols ? `${meshCols} × ${meshRows}` : DASH} />   {/* X × Y, like PROBE COUNT */}
        <Field k="ALGORITHM" v={params.algo || (cfg && cfg.algorithm) || DASH} />
        <Field k="MESH PPS" v={num(params.mesh_x_pps) !== null && num(params.mesh_y_pps) !== null ? `${params.mesh_x_pps} × ${params.mesh_y_pps}`
          : Array.isArray(cfg && cfg.mesh_pps) ? `${cfg.mesh_pps[0]} × ${cfg.mesh_pps[1]}` : DASH} />
        <Field k="TENSION" v={num(params.tension) !== null ? params.tension.toFixed(2) : num(cfg && cfg.bicubic_tension) !== null ? cfg.bicubic_tension.toFixed(2) : DASH} />
        {cfg && <>
          <Divider />
          <Field k="ZERO REFERENCE" v={Array.isArray(cfg.zero_reference_position) ? `${mm(cfg.zero_reference_position[0])}, ${mm(cfg.zero_reference_position[1])}` : DASH} />
          <Field k="FADE" v={`${mm(cfg.fade_start, 2)} → ${mm(cfg.fade_end, 2)} mm`} />
          <Field k="HORIZ MOVE Z" v={mm(cfg.horizontal_move_z, 2) + " mm"} />
          <Field k="PROBE SPEED" v={mm(cfg.speed, 0) + " mm/s"} />
          <Field k="SPLIT DELTA Z" v={mm(cfg.split_delta_z, 3) + " mm"} />
        </>}
        <Divider />
        <div style={S(`font-size:11px; color:${T.mute}; line-height:1.5; text-wrap:pretty`)}>
          Klipper reports probe count, pps and algorithm only inside a saved profile; anything missing above is read
          from printer.cfg instead. Hover the mesh for a point's exact z; drag to turn it, shift-drag to pan, wheel to zoom.
        </div>
      </Panel>
    </div>
  </div>;
}
