// CarbonViewer — the 3D G-code viewer bundle (dist/viewer.js).
//
// build.mjs emits this as its own IIFE (three + gcode-preview, ~178 KB gzipped) and src/pages/viewer/index.jsx
// injects it on mount; nothing else in the app touches three. This file IS the contract that page codes
// against:
//
//   window.CarbonViewer.create(canvasOrContainer, opts) -> viewer
//     viewer.processGCodeStream(stream | string, { render }) -> Promise   progressive paint while streaming
//     viewer.clear() / .dispose() / .resize() / .resetView()
//     viewer.setLayerRange(lo, hi)        0-based, inclusive; clips with shader planes, no rebuild
//     viewer.setRenderTubes(b) / .setRenderTravel(b) / .setExtrusionColors(list) / .setBuildVolume({x,y,z})
//     viewer.stats -> { layerCount, pathCount, points }   live while streaming
//     opts.onProgress(stats) / opts.onStreamEnd(stats)      (or assign viewer.onProgress later)
//
// gcode-preview's own processGCodeStream reads the WHOLE stream first and only then animates the geometry
// in; the progressive paint the page relies on is done here, from onJobUpdated, at PAINT_MS cadence.
import { GCodePreview } from "gcode-preview";

// Design tokens (src/lib/design.jsx T) — copied, not imported: this bundle must not pull React in.
const BG = "#06080b", TRAVEL = "#4d5a6b";
// Per-tool extrusion colours, indexed by T<n>. A 4-colour ERCF print uses the first four; Happy Hare can
// address up to 9 gates, so the list runs to 8 before gcode-preview's own fallback (its last colour) applies.
const TOOLS = ["#3ddcc4", "#ff5a33", "#5b7fd8", "#f0b429", "#c9d3e0", "#8b98aa", "#e8eef6", "#6b7789"];
const DEFAULT_VOLUME = { x: 350, y: 350, z: 340 };
const PAINT_MS = 300;                                    // progressive paint cadence while streaming

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const volumeOf = o => {
  const v = o && typeof o === "object" ? o : {};
  return { x: num(v.x, DEFAULT_VOLUME.x), y: num(v.y, DEFAULT_VOLUME.y), z: num(v.z, DEFAULT_VOLUME.z) };
};

/** gcode-preview parks the camera at a fixed [-100, 400, 450], tuned for a ~250 mm bed; through its 25°
 *  lens a 350 mm Voron bed then fills the frame edge to edge. Same direction, distance scaled to the bed. */
function cameraFor(bv) {
  const d = 2.9 * Math.max(bv.x, bv.y);
  // three space: gcode X -> x, gcode Y -> -z, so the bed centre (the orbit target) is (x/2, 0, -y/2)
  return [bv.x / 2 - 0.35 * d, 0.51 * d, -bv.y / 2 + 0.79 * d];
}

/** Hand gcode-preview's reader a stream of TEXT chunks whatever the caller passed in.
 *  - raw bytes (a fetch body) are decoded here
 *  - empty chunks are dropped: the library reads a zero-length chunk as end-of-stream
 *  - a missing final newline is supplied: the library keeps the last unterminated line as a tail it never parses */
function textify(stream) {
  if (typeof TransformStream !== "function") return stream;
  const dec = typeof TextDecoder === "function" ? new TextDecoder() : null;
  let last = "\n";
  return stream.pipeThrough(new TransformStream({
    transform(chunk, c) {
      const s = typeof chunk === "string" ? chunk : dec ? dec.decode(chunk, { stream: true }) : "";
      if (!s) return;
      last = s[s.length - 1];
      c.enqueue(s);
    },
    flush(c) {
      const s = dec ? dec.decode() : "";
      if (s) { last = s[s.length - 1]; c.enqueue(s); }
      if (last !== "\n") c.enqueue("\n");
    },
  }));
}

function create(target, opts) {
  const o = opts || {};
  if (!target || typeof target !== "object" || !target.nodeType) throw new Error("CarbonViewer.create needs a canvas or container element");
  let canvas = target, owned = false;
  if (String(target.tagName).toLowerCase() !== "canvas") {
    canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block; width:100%; height:100%; outline:none; touch-action:none";
    target.appendChild(canvas);
    owned = true;
  }

  const bv = volumeOf(o.buildVolume);
  const colors = Array.isArray(o.extrusionColor) && o.extrusionColor.length ? o.extrusionColor.slice()
    : typeof o.extrusionColor === "string" ? o.extrusionColor : TOOLS.slice();
  const init = {
    canvas,
    buildVolume: bv,
    backgroundColor: o.backgroundColor || BG,
    extrusionColor: colors,
    travelColor: o.travelColor || TRAVEL,
    renderTravel: !!o.renderTravel,
    renderTubes: o.renderTubes !== false,
    lineWidth: num(o.lineWidth, 1),
    // The per-layer brightness ramp is baked into each line batch at draw time, so progressive painting would
    // give every batch a different ramp — and on a multi-colour print the tool colour is the signal anyway.
    disableGradient: o.disableGradient !== false,
    orthographic: !!o.orthographic,
    initialCameraPosition: Array.isArray(o.initialCameraPosition) && o.initialCameraPosition.length === 3 ? o.initialCameraPosition : cameraFor(bv),
    keepLines: false,
    devMode: false,
  };
  if (Number.isFinite(o.minLayerThreshold)) init.minLayerThreshold = o.minLayerThreshold;

  let disposed = false, lost = false, loading = false, lastPaint = 0;
  // Throws when WebGL is unavailable — the page turns that into its "could not create a WebGL context" state.
  const preview = new GCodePreview(init);
  // `sceneManager` (the getter) silently builds a NEW scene manager once dispose() nulled the old one; every
  // access here goes through the raw field so a late resize() after unmount can never resurrect a renderer.
  // A LOST context counts as gone too: three keeps the scene but draws nothing, and every call below would
  // silently do nothing while reporting success.
  const sm = () => (disposed || lost ? null : preview._sceneManager || null);

  // ---- context loss ----------------------------------------------------------------------------
  // A GL context can vanish with nothing wrong on our side: a GPU reset, a driver crash, or — the likely one
  // here — WKWebView reclaiming the oldest of the handful of contexts it allows, which Orca's reload-per-
  // preset-change makes routine. three swallows it (it preventDefaults the event and stops drawing), so
  // without this the surface freezes while the page still reports a finished render. Tell the caller.
  function notifyContext(isLost) {
    const cb = viewer.onContextLost || o.onContextLost;
    if (typeof cb !== "function") return;
    try { cb(!!isLost); } catch (e) { /* a listener must never break teardown */ }
  }
  const onLost = () => {
    if (disposed || lost) return;        // our own dispose() forces the loss — that is not a failure
    lost = true;
    // Nothing can be drawn on a dead context, but gcode-preview's rAF loop keeps calling into it forever.
    const s = preview._sceneManager;
    if (s && typeof s.cancelAnimation === "function") { try { s.cancelAnimation(); } catch (e) { /* already stopped */ } }
    notifyContext(true);
  };
  const onRestored = () => {
    if (disposed || !lost) return;
    lost = false;
    const s = preview._sceneManager;    // three re-initialises the renderer itself; restart the paint loop
    if (s && typeof s.animate === "function") { try { s.animate(); } catch (e) { /* renderer is gone */ } }
    notifyContext(false);
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  {
    // OrbitControls snapshots its reset target at construction, BEFORE gcode-preview moves the target to the
    // bed centre; without this snapshot resetView() would swing the orbit onto the bed's front-left corner.
    const c = sm() && sm().controls;
    if (c && typeof c.saveState === "function") { try { c.saveState(); } catch (e) { /* cosmetic */ } }
  }

  // Points are summed incrementally: the page polls stats every 200 ms and a 20 MB file has ~10⁶ paths.
  // The sum covers paths[0 .. idx); the LAST path is always recounted live because the interpreter pops it
  // back to in-progress at the next chunk (Job.resumeLastPath) and may append to it.
  const counted = { job: null, idx: 0, sum: 0 };
  function points(job) {
    const paths = (job && job.paths) || [];
    if (counted.job !== job || paths.length < counted.idx) { counted.job = job; counted.idx = 0; counted.sum = 0; }
    const keep = Math.max(0, paths.length - 1);
    let s = counted.sum, i = counted.idx;
    for (; i < keep; i++) s += (paths[i].vertices || []).length / 3;
    counted.idx = keep; counted.sum = s;
    const tail = paths.length ? (paths[paths.length - 1].vertices || []).length / 3 : 0;
    return Math.round(s + tail);
  }
  function stats() {
    const job = preview.job;
    return { layerCount: job ? job.countLayers || 0 : 0, pathCount: job && job.paths ? job.paths.length : 0, points: points(job) };
  }
  function emit(final) {
    const cb = viewer.onProgress || o.onProgress;
    if (typeof cb !== "function") return;
    try { cb(stats(), !!final); } catch (e) { /* a listener must never break the parse loop */ }
  }
  /** Draw job.paths[0 .. n) — only what is not on screen yet; the ObjectsManager skips paths it already built. */
  function paint(n) {
    const s = sm();
    if (!s) return;
    try {
      if (typeof s.renderFrame === "function") s.renderFrame(n);
      else if (typeof s.renderPaths === "function") s.renderPaths(n);
    } catch (e) { /* a failed frame must not abort the stream; the final paint retries everything */ }
  }

  preview.onJobUpdated = job => {
    if (disposed || job !== preview.job) return;
    const now = performance.now();
    if (now - lastPaint < PAINT_MS) return;
    lastPaint = now;
    // The last path stays undrawn on purpose: the interpreter pops it back to in-progress at the next chunk
    // and may extend it, and a path the ObjectsManager has drawn once is never drawn again.
    paint(Math.max(0, job.paths.length - 1));
    emit(false);
  };
  preview.onStreamEnd = () => {
    const cb = viewer.onStreamEnd || o.onStreamEnd;
    if (typeof cb === "function") { try { cb(stats()); } catch (e) { /* see emit */ } }
  };

  const viewer = {
    onProgress: null,
    onStreamEnd: null,
    onContextLost: null,
    get canvas() { return canvas; },
    get preview() { return preview; },
    get controls() { const s = sm(); return s ? s.controls : null; },
    get stats() { return stats(); },
    get loading() { return loading; },
    get disposed() { return disposed; },
    get contextLost() { return lost; },

    /** Stream (or string) in, progressive paint, resolves when everything is drawn. Rejects on abort/network
     *  errors exactly like fetch does — the caller owns the AbortController. */
    async processGCodeStream(input, options) {
      if (disposed) throw new Error("viewer is disposed");
      // Parsing 20 MB into a context that cannot draw is pure heat; fail loudly instead.
      if (lost) throw new Error("the WebGL context was lost — rebuild the 3D surface");
      const render = !options || options.render !== false;
      const src = input && typeof input.pipeThrough === "function" ? textify(input) : input;
      const job = preview.job;
      loading = true; lastPaint = 0;
      try {
        // render:false — gcode-preview's own end-of-stream animation would walk the whole path list again over
        // 60 frames; everything but the tail is already on screen, one final frame finishes the job.
        await preview.processGCodeStream(src, { render: false });
        if (disposed || preview.job !== job) return;
        if (render) paint(Infinity);
        emit(true);
      } finally { loading = false; }
    },

    clear() {
      if (disposed) return;
      try { preview.clear(); } catch (e) { /* first load: nothing to clear */ }
      counted.job = null; counted.idx = 0; counted.sum = 0;
      lastPaint = 0;
    },

    /** 0-based inclusive layer window. gcode-preview's bounds are 1-based; 1 and countLayers leave that side
     *  unclipped, so travel above the top layer stays visible when the range is "all". */
    setLayerRange(lo, hi) {
      const s = sm();
      const n = preview.job ? preview.job.countLayers : 0;
      if (!s || !n) return;
      const a = clamp(Math.floor(num(lo + 1, 1) - 1), 0, n - 1);
      const b = clamp(Math.floor(num(hi + 1, n) - 1), a, n - 1);
      s.startLayer = a + 1;
      s.endLayer = b + 1;
    },
    setRenderTubes(on) { const s = sm(); if (s) s.renderTubes = !!on; },      // debounced rebuild inside gcode-preview
    setRenderTravel(on) { const s = sm(); if (s) s.renderTravel = !!on; },
    setExtrusionColors(list) {
      const s = sm();
      if (!s) return;
      s.extrusionColor = Array.isArray(list) && list.length ? list.slice() : typeof list === "string" ? list : TOOLS.slice();
    },
    setBuildVolume(v) { const s = sm(); if (s) s.buildVolume = volumeOf(v); },

    resize() {
      const s = sm();
      // A hidden or not-yet-laid-out canvas has no size; gcode-preview would compute a NaN aspect from it.
      if (!s || !canvas.offsetWidth || !canvas.offsetHeight) return;
      try { s.resize(); } catch (e) { /* teardown race with the page's ResizeObserver */ }
    },
    resetView() {
      const s = sm();
      const c = s && s.controls;
      if (c && typeof c.reset === "function") { try { c.reset(); } catch (e) { /* cosmetic */ } }
    },

    dispose() {
      if (disposed) return;
      const s = preview._sceneManager;
      const r = s && s.renderer;
      disposed = true;
      // Before forceContextLoss() below fires webglcontextlost at us, and so nothing is left on a canvas
      // the caller passed in (we only remove the ones we created).
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      try { preview.dispose(); } catch (e) { /* already gone */ }
      // renderer.dispose() releases three's objects but the GL context itself lives until GC. WKWebView keeps
      // only a handful of contexts, and Orca remounts this page on every preset change — give it back now.
      try { if (r && typeof r.forceContextLoss === "function") r.forceContextLoss(); } catch (e) { /* lost already */ }
      if (owned && canvas.parentNode) { try { canvas.parentNode.removeChild(canvas); } catch (e) { /* detached */ } }
    },
  };
  return viewer;
}

const CarbonViewer = { create, tools: TOOLS.slice(), defaultVolume: { ...DEFAULT_VOLUME } };
if (typeof window !== "undefined") window.CarbonViewer = CarbonViewer;
export default CarbonViewer;
