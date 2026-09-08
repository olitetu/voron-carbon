// CURRENT JOB panel + top-bar status / E-stop / SAVE CONFIG + EXCLUDE OBJECTS modal — live view-model.
// Style strings are copied verbatim from src/pages/dashboard/logic.jsx renderVals(); only the data source changed.
//
// ctx = { st, ui, set, act, log, A, api, store, common }  (see CONTRACT.md "Dashboard adapters")
// UI-only state used (logic.state, via ctx.ui / ctx.set): excludeOpen, confirmId (design) + confirmCancel, confirmSave,
// excludedAt ({ [objectName]: layer }), metaTick (bumped when file metadata arrives so the panel re-renders).
//
// Template keys returned (panel-keys.json "CURRENT JOB" + "SHELL"): jobStats, jobActions, excludeOpen, closeExclude, layerLabel,
// excludedCount, objects, confirmStyle, confirmText, confirmYes, confirmNo, statusLabel, statusStyle, statusDotStyle, estopClick,
// estopLabel, estopStyle, saveConfig.  Extra keys for text that is STATIC in the generated Template.jsx (integrator binds them):
// jobFileName (top bar), jobTitle + jobSubline (thumbnail overlay), jobProgressPct, jobRingDash + jobRingOffset (ring), jobLayerShort,
// jobBarStyle, jobEta (panel header "ETA 01:32"), jobElapsed, jobTotal, jobSlicerTotal, jobRemaining, jobFile, jobThumb, jobThumbStyle,
// saveConfigPending, saveConfigLabel, saveConfigStyle.
import { makeJobActions } from "../../../lib/actions/job.js";

// ---- file metadata cache: one api.fileMeta per filename (module-level Map). Failures are re-tried after 60 s; a hit older
//      than 10 min is refreshed in the background (a re-uploaded file keeps its name) while the cached copy keeps serving.
const META = new Map();           // filename -> { data, error, at }
const META_PENDING = new Map();   // filename -> Promise
const META_RETRY_MS = 60 * 1000, META_SOFT_TTL_MS = 10 * 60 * 1000, META_MAX = 50;
export function getFileMeta(api, filename, onLoaded) {
  if (!filename) return null;
  const hit = META.get(filename);
  const now = Date.now();
  const fresh = hit && hit.data && now - hit.at < META_SOFT_TTL_MS;
  const cooling = hit && hit.error && now - hit.at < META_RETRY_MS;
  if (!fresh && !cooling && api && typeof api.fileMeta === "function" && !META_PENDING.has(filename)) {
    const p = Promise.resolve()
      .then(() => api.fileMeta(filename))
      .then(data => { META.set(filename, { data: data || {}, error: null, at: Date.now() }); })
      .catch(err => { META.set(filename, { data: (hit && hit.data) || null, error: err || new Error("metadata failed"), at: Date.now() }); })
      .then(() => {
        META_PENDING.delete(filename);
        if (META.size > META_MAX) { const oldest = META.keys().next().value; if (oldest !== filename) META.delete(oldest); }
        try { if (onLoaded) onLoaded(); } catch (e) { /* re-render is best-effort */ }
      });
    META_PENDING.set(filename, p);
  }
  return hit && hit.data ? hit.data : null;
}
/** Test/integrator hook: drop cached metadata (all, or one filename). */
export function clearFileMeta(filename) { if (filename === undefined) META.clear(); else META.delete(filename); }

// ---- formatting (design shows h:mm:ss with hours always present: "0:18:48", "9:37:27")
const DASH = "—";
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const numish = v => num(typeof v === "string" && v.trim() !== "" ? +v : v);   // metadata fields can arrive as strings
export function fmtHMS(sec) {
  const s = num(sec); if (s === null) return DASH;
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0");
}
/** "01:02 AM" — the design's ETA stat. */
export function fmtClock12(d) {
  let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12; if (h === 0) h = 12;
  return String(h).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap;
}
/** "01:32" — the design's panel-header "ETA 01:32". */
export function fmtClock24(d) { return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
const baseName = f => String(f || "").split("/").pop();
const stripGcode = f => baseName(f).replace(/\.g(code|co)?$/i, "");

// ---- layer: print_stats.info when the slicer reports it, else metadata + commanded Z (CONTRACT "LAYER")
//      layer = max(1, round((z − first_layer_height) / layer_height) + 1) · total = round((object_height − first) / lh) + 1
export function layerInfo(ps, gm, meta, active) {
  const info = (ps && ps.info) || {};
  const cur = num(info.current_layer), tot = num(info.total_layer);
  let total = tot !== null && tot > 0 ? Math.round(tot) : null;
  const lh = meta ? numish(meta.layer_height) : null;
  const objH = meta ? numish(meta.object_height) : null;
  const firstRaw = meta ? numish(meta.first_layer_height) : null;
  const first = firstRaw !== null ? firstRaw : lh;
  if (total === null && meta) {
    const lc = numish(meta.layer_count);
    if (lc !== null && lc > 0) total = Math.round(lc);
    else if (lh !== null && lh > 0 && objH !== null && objH > 0 && first !== null) total = Math.max(1, Math.round((objH - first) / lh) + 1);
  }
  if (cur !== null) return { layer: Math.max(0, Math.round(cur)), total, source: "print_stats" };
  if (!active || lh === null || lh <= 0 || first === null) return { layer: null, total, source: meta ? "metadata" : "none" };
  // commanded (gcode) Z — excludes the babystep/probe offset in homing_origin so layer boundaries line up
  const gpos = gm && Array.isArray(gm.gcode_position) ? num(gm.gcode_position[2]) : null;
  const pos = gm && Array.isArray(gm.position) ? num(gm.position[2]) : null;
  const org = gm && Array.isArray(gm.homing_origin) ? (num(gm.homing_origin[2]) || 0) : 0;
  const z = gpos !== null ? gpos : pos !== null ? pos - org : null;
  if (z === null) return { layer: null, total, source: "metadata" };
  let layer = Math.max(1, Math.round((z - first) / lh) + 1);
  if (total) layer = Math.min(layer, total);
  return { layer, total, source: "metadata" };
}

// ---- exclude_object polygons → bounding boxes in bed mm (350×350 bed; y flipped so the bed front is at the bottom of the map)
export const BED = 350;
export function objectBoxes(eo, bed = BED) {
  const list = (eo && Array.isArray(eo.objects)) ? eo.objects : [];
  return list.filter(o => o && o.name != null).map(o => {
    const name = String(o.name);
    const poly = Array.isArray(o.polygon) ? o.polygon.filter(p => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null) : [];
    let x0, y0, x1, y1;
    if (poly.length) {
      x0 = Math.min(...poly.map(p => p[0])); x1 = Math.max(...poly.map(p => p[0]));
      y0 = Math.min(...poly.map(p => p[1])); y1 = Math.max(...poly.map(p => p[1]));
    } else if (Array.isArray(o.center) && num(o.center[0]) !== null && num(o.center[1]) !== null) {
      x0 = o.center[0] - 10; x1 = o.center[0] + 10; y0 = o.center[1] - 10; y1 = o.center[1] + 10;   // no polygon: a 20 mm marker at the centre
    } else return { id: name, name, x: null, y: null, w: null, h: null, center: null };
    x0 = Math.max(0, Math.min(bed, x0)); x1 = Math.max(0, Math.min(bed, x1));
    y0 = Math.max(0, Math.min(bed, y0)); y1 = Math.max(0, Math.min(bed, y1));
    const w = Math.max(2, x1 - x0), h = Math.max(2, y1 - y0);
    // CSS top grows downward, bed Y grows toward the back → flip
    return { id: name, name, x: x0, y: Math.max(0, bed - y1), w, h, center: Array.isArray(o.center) ? o.center : null };
  });
}

// ---- confirm timers (module scope: the adapter is a pure function re-run on every render)
let cancelTimer = null, saveTimer = null;
const CONFIRM_MS = 6000;
const pct1 = v => +(v * 100).toFixed(3);   // CSS % with 3 decimals

export function jobVals(ctx) {
  ctx = ctx || {};
  const st = ctx.st || (ctx.store && ctx.store.state) || {};
  const ui = ctx.ui || {};
  const set = typeof ctx.set === "function" ? ctx.set : () => {};
  const log = typeof ctx.log === "function" ? ctx.log : () => {};
  const api = ctx.api || null;
  const A = ctx.A || (ctx.common && ctx.common.A) || "#ff5a33";
  const press = (ctx.common && ctx.common.press) || "; transition:transform .07s ease, border-color .12s";
  const act = (ctx.act && typeof ctx.act.printPause === "function") ? ctx.act : makeJobActions({ api, store: ctx.store || { state: st }, log });

  const raw = st.raw || {};
  const ps = raw.print_stats || {};
  const vsd = raw.virtual_sdcard || {};
  const ds = raw.display_status || {};
  const mr = raw.motion_report || {};
  const gm = raw.gcode_move || {};
  const eo = raw.exclude_object || {};
  const cfg = raw.configfile || {};
  const connected = st.connected !== false;
  const klippy = String(st.klippy || "unknown");

  // ---- printer / print state
  const printState = String(ps.state || "standby").toLowerCase();
  const paused = printState === "paused" || !!(raw.pause_resume || {}).is_paused;
  const printing = printState === "printing" && !paused;
  const active = printing || paused;
  const shutdown = klippy === "shutdown" || klippy === "error";
  const disconnected = klippy === "disconnected";
  const estop = shutdown || disconnected;   // the design's S.estop: red pulsing status + RESTART button

  // ---- job numbers
  const filename = String(ps.filename || "");
  const meta = filename ? getFileMeta(api, filename, () => set(s => ({ metaTick: ((s && s.metaTick) || 0) + 1 }))) : null;
  let progress = num(vsd.progress);
  if (progress === null) progress = num(ds.progress);
  if (printState === "complete") progress = 1;
  if (progress !== null) progress = Math.max(0, Math.min(1, progress));
  const printDur = num(ps.print_duration), totalDur = num(ps.total_duration);
  const slicerTotal = meta ? numish(meta.estimated_time) : null;
  const remaining = (active && progress !== null && progress > 0 && printDur !== null && printDur > 0) ? Math.max(0, printDur / progress - printDur) : null;
  const slicerRemaining = (active && slicerTotal !== null && printDur !== null) ? Math.max(0, slicerTotal - printDur) : null;
  const etaRemaining = remaining !== null ? remaining : slicerRemaining;
  const etaDate = (active && etaRemaining !== null) ? new Date(Date.now() + etaRemaining * 1000) : null;
  const { layer, total } = layerInfo(ps, gm, meta, active);
  const layerShown = layer !== null ? layer : (printState === "complete" && total ? total : null);
  const liveVel = num(mr.live_velocity), liveExt = num(mr.live_extruder_velocity);
  const flow = liveExt === null ? null : Math.max(0, liveExt * Math.PI * Math.pow(1.75 / 2, 2));
  const filamentUsed = num(ps.filament_used);
  const pct = progress === null ? null : Math.round(progress * 100);

  // ---- thumbnail (largest) from metadata; relative_path is relative to the gcode file's directory
  let thumbUrl = "";
  if (meta && Array.isArray(meta.thumbnails) && meta.thumbnails.length && api && typeof api.fileUrl === "function") {
    const best = meta.thumbnails.slice().sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    if (best && best.relative_path) {
      const dir = filename.includes("/") ? filename.slice(0, filename.lastIndexOf("/") + 1) : "";
      thumbUrl = api.fileUrl("gcodes", dir + best.relative_path);
    }
  }

  // ---- exclude objects
  const boxes = objectBoxes(eo);
  const excludedNames = Array.isArray(eo.excluded_objects) ? eo.excluded_objects.map(String) : [];
  const currentObject = eo.current_object ? String(eo.current_object) : "";
  const excludedAt = ui.excludedAt || {};   // name -> layer at which THIS UI excluded it (excluded elsewhere / unknown layer → locked)
  const layerForExclude = layerShown;
  const confirmId = ui.confirmId || null;
  const confirmObj = confirmId ? boxes.find(o => o.id === confirmId) : null;

  const excludeObject = name => {
    const o = boxes.find(x => x.id === name);
    if (!o) { set({ confirmId: null }); return; }
    set(s => ({ confirmId: null, excludedAt: Object.assign({}, (s && s.excludedAt) || {}, { [name]: layerForExclude }) }));
    Promise.resolve(act.excludeObject(name)).then(ok => {
      if (ok !== false && layerForExclude !== null) log(name + " skipped from layer " + layerForExclude, "warn");
    }).catch(() => {});
  };
  const includeObject = name => {
    const o = boxes.find(x => x.id === name);
    if (!o) return;
    const at = excludedAt[name];
    const restorable = at !== undefined && at !== null && at === layerForExclude;
    if (!restorable) {
      log("Cannot re-include " + name + " — nozzle has printed layer " + (layerForExclude !== null ? layerForExclude : "?") + " over it", "err");
      return;
    }
    set(s => { const e = Object.assign({}, (s && s.excludedAt) || {}); delete e[name]; return { excludedAt: e }; });
    act.includeObject(name);
  };

  // ---- cancel / save-config two-step confirms (UI state + 6 s timeout)
  const armCancel = () => {
    clearTimeout(cancelTimer);
    set({ confirmCancel: true });
    log("Cancel print? Click CANCEL again (CONFIRM?) within 6 s", "warn");
    cancelTimer = setTimeout(() => set({ confirmCancel: false }), CONFIRM_MS);
  };
  const doCancel = () => { clearTimeout(cancelTimer); set({ confirmCancel: false }); act.printCancel(); };
  const saveConfigPending = !!cfg.save_config_pending;
  const saveConfig = () => {
    if (klippy !== "ready") { log("SAVE_CONFIG needs Klipper ready (state: " + klippy + ")", "warn"); return; }
    if (active) { log("SAVE_CONFIG refused — it restarts Klipper and would kill the running print", "err"); return; }
    if (ui.confirmSave) { clearTimeout(saveTimer); set({ confirmSave: false }); act.saveConfig(); return; }
    clearTimeout(saveTimer);
    set({ confirmSave: true });
    log("SAVE_CONFIG restarts Klipper" + (saveConfigPending ? "" : " (nothing pending)") + " — click SAVE CONFIG again within 6 s to confirm", "warn");
    saveTimer = setTimeout(() => set({ confirmSave: false }), CONFIRM_MS);
  };

  // ---- status label (design: S.estop ? "SHUTDOWN" : printState.toUpperCase())
  const statusLabel = !connected ? "OFFLINE" : klippy === "error" ? "ERROR" : shutdown ? "SHUTDOWN" : disconnected ? "DISCONNECTED" : klippy === "startup" ? "STARTUP" : printState.toUpperCase();
  const statusColor = estop || printState === "error" ? "#ff5a33" : printing ? "#3ddcc4" : paused ? "#f0b429" : "#6b7789";
  const statusDot = estop || printState === "error" ? "#ff5a33" : printing ? "#3ddcc4" : paused ? "#f0b429" : "#4d5a6b";

  // The tile is 77 px wide and the value renders at 13 px mono (7.8 px/char), so 10+ characters wrap onto a
  // second line and break the row — which is exactly what "12.4 mm³/s" does, and flow hits double digits
  // right when speed passes ~100 mm/s. Splitting the unit out lets the template draw it at 9 px (the same
  // treatment the progress ring gives "%"), which keeps even "123.4 mm³/s" on one line.
  // Beyond the unit split the value is FITTED: JetBrains Mono is ~0.6 em/char, so a string's width is
  // predictable and the font steps down (13 -> 10.5 px) until it fits, then nowrap+clip guarantees it can
  // never wrap whatever the value. TILE_BUDGET is the tile's usable width, measured live (77 px tile).
  const TILE_BUDGET = 74;
  const fit = (v, u) => {
    let px = 13;
    const width = f => String(v).length * f * 0.6 + (u ? 2 + String(u).length * 9 * 0.6 : 0);
    while (width(px) > TILE_BUDGET && px > 10.5) px -= 0.5;
    return `font-family:'JetBrains Mono',monospace; font-size:${px}px; color:#e8eef6; white-space:nowrap; overflow:hidden`;
  };
  const stat = (k, v, u) => {
    const empty = v === null || v === undefined || v === "";
    const val = empty ? DASH : String(v), unit = empty ? "" : (u || "");
    return { k, v: val, u: unit, vStyle: fit(val, unit) };
  };
  const C = 2 * Math.PI * 43;   // ring radius 43 in the 100×100 viewBox (template: strokeDasharray 270 / offset 135 = 50 %)
  const progressOrZero = progress === null ? 0 : progress;

  return {
    // ---- CURRENT JOB
    jobStats: [
      stat("SPEED", liveVel === null ? null : String(Math.round(liveVel)), "mm/s"),
      stat("FLOW", flow === null ? null : flow.toFixed(1), "mm³/s"),
      stat("FILAMENT", filamentUsed === null ? null : (filamentUsed / 1000).toFixed(2), "m"),
      stat("LAYER", layerShown === null ? (total ? DASH : null) : String(layerShown), total ? "of " + total : (layerShown === null ? "" : "of ?")),
      stat("ESTIMATE", remaining === null ? null : fmtHMS(remaining)),
      stat("SLICER", slicerRemaining === null ? null : fmtHMS(slicerRemaining)),
      stat("TOTAL", totalDur === null ? null : fmtHMS(totalDur)),
      stat("ETA", etaDate ? fmtClock12(etaDate) : null),
    ],
    jobActions: [
      { t: paused ? "RESUME" : "PAUSE", go: () => (paused ? act.printResume() : act.printPause()) },
      { t: ui.confirmCancel ? "CONFIRM?" : "CANCEL", go: () => (ui.confirmCancel ? doCancel() : active ? armCancel() : act.printCancel()) },
      { t: "OBJECTS", go: () => set({ excludeOpen: true }) },
    ].map(a => Object.assign(a, {
      style: "background:#0d121a; padding:9px 0; text-align:center; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.1em; cursor:pointer; color:" +
        (a.t === "CONFIRM?" ? "#f0b429" : a.t === "CANCEL" ? "#8b98aa" : "#c9d3e0") + press
    })),
    // header / thumbnail-overlay values that are static text in Template.jsx (integrator binds these)
    jobFileName: filename ? baseName(filename) : DASH,                 // top bar: "Lightbox_Draft_ABS_9h28m.gcode"
    jobFile: filename ? stripGcode(filename) : DASH,                    // ".gcode" stripped
    jobTitle: currentObject || (filename ? stripGcode(filename) : DASH),   // overlay title (design shows the current object name)
    jobSubline: "TOTAL " + fmtHMS(totalDur) + " · SLICER " + fmtHMS(slicerTotal),
    jobElapsed: fmtHMS(printDur),
    jobTotal: fmtHMS(totalDur),
    jobSlicerTotal: fmtHMS(slicerTotal),
    jobRemaining: remaining === null ? DASH : fmtHMS(remaining),
    jobEta: "ETA " + (etaDate ? fmtClock24(etaDate) : DASH),          // panel header "ETA 01:32"
    jobProgressPct: pct === null ? DASH : String(pct),                 // "50" (the "%" is its own span in the template)
    jobProgress: progressOrZero,                                        // 0..1
    jobRingDash: C.toFixed(1),                                          // strokeDasharray (circumference, "270.2")
    jobRingOffset: (C * (1 - progressOrZero)).toFixed(1),               // strokeDashoffset
    jobBarStyle: "width:" + (pct === null ? 0 : pct) + "%; height:100%; background:linear-gradient(90deg,#ff5a33,#ffa07f)",
    jobLayerShort: "LAYER " + (layerShown === null ? DASH : layerShown) + "/" + (total || DASH),
    jobThumb: thumbUrl,
    jobThumbStyle: thumbUrl ? "position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:.85" : "display:none",
    jobActive: active,
    jobState: printState,

    // ---- EXCLUDE OBJECTS modal
    excludeOpen: !!ui.excludeOpen,
    closeExclude: () => set({ excludeOpen: false, confirmId: null }),
    layerLabel: "LAYER " + (layerShown === null ? DASH : layerShown) + " / " + (total || DASH),
    excludedCount: excludedNames.filter(n => boxes.some(o => o.id === n)).length + " of " + boxes.length + " excluded",
    // Empty state: OBJECTS is always clickable, and with no exclude_object definitions the modal was a blank
    // bed square next to a blank list with no explanation of why.
    objectsEmpty: boxes.length ? "" : (active
      ? "This g-code defines no objects. Object skipping needs the slicer's label-objects option (EXCLUDE_OBJECT_DEFINE / M486)."
      : "No print running. Objects appear here once a job that labels them starts."),
    objectsEmptyStyle: "padding:12px 8px; font-size:11px; line-height:1.55; color:#6b7789",
    objects: boxes.map(o => {
      const excluded = excludedNames.includes(o.id);
      const at = excludedAt[o.id];
      const restorable = excluded && at !== undefined && at !== null && at === layerForExclude;
      const pending = confirmId === o.id;
      const isCurrent = !excluded && o.id === currentObject;
      const hasBox = o.x !== null;
      return {
        name: o.name,
        current: isCurrent,
        state: excluded ? (restorable ? "EXCLUDED · restorable" : "EXCLUDED · locked") : "PRINTING",
        note: excluded ? (restorable ? "until layer " + ((layerForExclude !== null ? layerForExclude : 0) + 1) : "nozzle passed") : (isCurrent ? "current" : ""),
        noteStyle: "font-family:'JetBrains Mono',monospace; font-size:8px; letter-spacing:.04em; white-space:nowrap; color:" +
          (restorable ? "#6b7789" : isCurrent ? "#3ddcc4" : "#33404f"),
        go: () => (excluded ? includeObject(o.id) : set({ confirmId: o.id })),
        shapeStyle: (hasBox
          ? `position:absolute; left:${pct1(o.x / BED)}%; top:${pct1(o.y / BED)}%; width:${pct1(o.w / BED)}%; height:${pct1(o.h / BED)}%; `
          : "") +
          "border-radius:3px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:.14s; text-align:center; padding:2px; " +
          (pending ? "border:1px solid #f0b429; background:rgba(240,180,41,.14); box-shadow:0 0 0 3px rgba(240,180,41,.15)"
            : excluded
              ? "border:1px dashed " + (restorable ? "#5b6a7d" : "#33404f") + "; background:repeating-linear-gradient(135deg, rgba(255,90,51,.08) 0 5px, transparent 5px 10px)"
              : "border:1px solid #2c3746; background:rgba(61,220,196,.09)") +
          (isCurrent && printing ? "; box-shadow:0 0 0 1px rgba(61,220,196,.35)" : "") +
          (!hasBox ? "; display:none" : ""),
        labelStyle: "font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.04em; pointer-events:none; color:" +
          (excluded ? (restorable ? "#8b98aa" : "#4d5a6b") : "#c9d3e0") + (excluded && !restorable ? "; text-decoration:line-through" : "") +
          "; overflow:hidden; text-overflow:ellipsis; max-width:100%",   // real names are long ("LIGHTBOX_DRAFT.3MF_ID_0_COPY_0")
        rowStyle: "display:flex; align-items:center; gap:9px; padding:6px 8px; border-radius:3px; cursor:pointer; border:1px solid " +
          (pending ? "#f0b429" : "transparent"),
        dotStyle: "width:7px; height:7px; border-radius:50%; flex:none; background:" +
          (excluded ? (restorable ? "#f0b429" : "#4d5a6b") : "#3ddcc4") +
          (isCurrent && printing ? "; animation:vPulse 1.6s ease-in-out infinite" : ""),
        nameStyle: "font-size:11.5px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:" +
          (excluded ? "#6b7789" : "#c9d3e0") + (excluded ? "; text-decoration:line-through" : ""),
        actionStyle: "font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.08em; white-space:nowrap; color:" +
          (excluded ? (restorable ? "#3ddcc4" : "#3d4859") : "#6b7789"),
        action: excluded ? (restorable ? "RE-INCLUDE" : "LOCKED") : "EXCLUDE"
      };
    }),
    confirmStyle: confirmId
      ? "flex:none; padding:14px 16px; border-top:1px solid #3a2f14; background:#14100a; display:flex; align-items:center; gap:14px; animation:vRise .16s ease both"
      : "display:none",
    confirmText: confirmId
      ? "Exclude " + ((confirmObj || {}).name || confirmId) + "? The nozzle will skip it from layer " + (layerForExclude !== null ? layerForExclude : DASH) + " onward."
      : "",
    confirmYes: () => (confirmId ? excludeObject(confirmId) : null),
    confirmNo: () => set({ confirmId: null }),

    // ---- top bar: status · E-stop · SAVE CONFIG
    statusLabel,
    statusStyle: "font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.12em; color:" + statusColor,
    statusDotStyle: "width:7px; height:7px; border-radius:50%; background:" + statusDot +
      (printing || estop ? "; animation:vPulse 1.8s ease-in-out infinite" : ""),
    estopClick: () => act.estopButton(),
    estopLabel: shutdown ? "RESTART FIRMWARE" : disconnected ? "RESTART KLIPPER" : "EMERGENCY STOP",
    estopStyle: "display:flex; align-items:center; gap:7px; padding:6px 12px; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.1em; cursor:pointer; color:#ff5a33; border:1px solid " +
      (estop ? "#ff5a33" : "#4a1d13") + "; background:" + (estop ? "#3a1109" : "#1a0c08") + (estop ? "" : "; animation:vGlow 2.4s ease-in-out infinite"),
    saveConfig,
    saveConfigPending,
    saveConfigLabel: ui.confirmSave ? "CONFIRM SAVE_CONFIG?" : saveConfigPending ? "SAVE CONFIG · PENDING" : "SAVE CONFIG",
    saveConfigStyle: "display:flex; align-items:center; gap:7px; padding:6px 12px; border:1px solid " +
      (ui.confirmSave ? "#f0b429" : saveConfigPending ? "#3a2f14" : "#1c2430") + "; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.1em; color:" +
      (ui.confirmSave || saveConfigPending ? "#f0b429" : "#8b98aa") + "; cursor:pointer; background:" + (saveConfigPending || ui.confirmSave ? "#14100a" : "transparent") +
      (saveConfigPending && !ui.confirmSave ? "; animation:vGlow 2.4s ease-in-out infinite" : ""),
  };
}

export default jobVals;
