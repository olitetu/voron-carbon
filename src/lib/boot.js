// Creates the Moonraker client + store and keeps the store fed. One instance per page load.
import { Moonraker } from "./moonraker.js";
import { Store } from "./store.js";

// Same-origin when served behind the printer's nginx; the dev override lets a local build talk to the printer.
// Your printer, for LOCAL DEVELOPMENT only. Change this, or override per-session without editing code:
//   ?api=http://myprinter.local          in the URL
//   localStorage.setItem('carbon.api', 'http://myprinter.local')
// In production Carbon is served from the printer itself, so API_BASE is "" (same origin) and none of this
// applies — the overrides are honoured only on the dev port.
const DEV_PRINTER = "http://voron.local";
const DEV_PORT = "8766";

export const API_BASE =
  new URLSearchParams(location.search).get("api") ||
  localStorage.getItem("carbon.api") ||
  (location.port === DEV_PORT ? DEV_PRINTER : "");

const CORE_SUBS = {
  webhooks: null, print_stats: null, virtual_sdcard: null, display_status: null, idle_timeout: null, pause_resume: null,
  toolhead: null, gcode_move: null, motion_report: null, extruder: null, heater_bed: null, fan: null, exclude_object: null,
  bed_mesh: null, mmu: null, "gcode_macro _MMU_SEQUENCE_VARS": null, quad_gantry_level: null, configfile: ["save_config_pending"],
  "mmu_encoder mmu_encoder": null,
  // geometry sources: the EREC cutter's feed/cut lengths and the toolhead tip vars
  "gcode_macro _EREC_VARS": null, "gcode_macro _MMU_FORM_TIP_VARS": null,
  mcu: null, "mcu mmu": null, "mcu can0": null, "mcu scanner": null, save_variables: null,
};

export function boot() {
  const api = new Moonraker(API_BASE);
  const store = new Store();
  api.on("connected", () => store.set({ connected: true }));
  api.on("disconnected", () => store.set({ connected: false }));
  api.on("server_info", info => store.set({ serverInfo: info, klippy: info.klippy_state }));
  api.on("klippy", s => {
    store.set({ klippy: s, commandsStale: s !== "ready" });   // keep the last good catalogue, just flag it
    if (s === "ready") hydrate();
  });
  api.on("status", (partial) => {
    store.mergeStatus(partial);
    // The cutter macro ends by backing the filament out (_MMU_STEP_SET_FILAMENT STATE=2 then
    // _MMU_STEP_UNLOAD_GATE). filament_pos leaving 0 is the only signal for that, so latch it: the
    // blade stops, and the travel baseline is kept so the retract animates instead of snapping to 0.
    const c = store.state.cutter;
    if (c && !c.parking && ((store.state.raw.mmu || {}).filament_pos ?? 0) !== 0) {
      store.set({ cutter: Object.assign({}, c, { parking: true }) });
    }
  });
  // The EREC cutter macro narrates itself; follow it so the blade animation matches the real servo.
  api.on("gcode_response", msg => {
    const m = String(msg || "");
    if (/EREC Cutter open/i.test(m)) store.setCutter("open", (store.state.raw.mmu || {}).filament_position);
    else if (/EREC Cutter closed/i.test(m)) store.setCutter("closed", (store.state.raw.mmu || {}).filament_position);
  });
  api.on("gcode_response", msg => appendLog(store, { time: Date.now() / 1000, message: msg, type: msg.startsWith("!!") ? "error" : msg.startsWith("//") ? "response" : "response" }));
  // MERGE, never replace. Moonraker's notify_proc_stat_update is an INCREMENTAL payload — it carries
  // moonraker_stats / cpu_temp / network / system_cpu_usage / system_memory but NOT system_uptime. Replacing
  // wholesale therefore blanked the uptime to "—" on every push (~1 Hz) until the 3 s full poll restored it,
  // which read as a flashing ticker in the footer.
  api.on("proc_stats", ps => store.update(s => ({ procStats: Object.assign({}, s.procStats || {}, ps || {}) })));
  api.on("webcams", w => store.set({ webcams: w.webcams || w }));
  api.on("active_spool", s => store.set({ activeSpool: s.spool_id }));
  // OrcaSlicer uploads land server-side (/api/files/local), so the only trace this client gets is Moonraker's
  // notify_filelist_changed. Surface every new g-code in the console and bump filesVersion for pages to watch.
  // The metadata scan writes .thumbs/*.png right after — dot paths are Moonraker's own bookkeeping, skipped.
  let lastNew = { path: "", at: 0 };
  api.on("filelist", ev => {
    const item = (ev && (ev.item || ev.source_item)) || {};
    if (item.root && item.root !== "gcodes") return;
    const action = String((ev && ev.action) || "");
    const path = String(item.path || "");
    if ((action === "create_file" || /upload/.test(action)) && path && !path.split("/").some(seg => seg.startsWith("."))) {
      // one upload can announce itself twice (create_file + upload_file) — one line is enough
      if (!(lastNew.path === path && Date.now() - lastNew.at < 3000)) {
        lastNew = { path, at: Date.now() };
        appendLog(store, { time: Date.now() / 1000, message: "New file: " + path.replace(/^.*\//, ""), type: "info", local: true });
      }
    }
    store.set({ filesVersion: (store.state.filesVersion || 0) + 1 });
  });

  async function hydrate() {
    try {
      const objects = await api.objectsList();
      // subscribe to every fan / led / sensor / filament sensor / macro-vars object that exists
      const subs = Object.assign({}, CORE_SUBS);
      for (const o of objects) {
        const p = o.split(" ")[0];
        if (["fan_generic", "heater_fan", "controller_fan", "temperature_fan", "temperature_sensor", "neopixel", "led", "dotstar", "filament_switch_sensor", "filament_motion_sensor", "output_pin", "heater_generic", "temperature_host"].includes(p)) subs[o] = null;
      }
      const macros = objects.filter(o => o.startsWith("gcode_macro ") && !o.split(" ")[1].startsWith("_")).map(o => o.slice(12));
      store.set({ objects, macros });
      await api.subscribe(subs);
      const [pinfo, ps, th, gs, cams, spoolId, prefs] = await Promise.all([
        api.printerInfo().catch(() => null), api.procStats().catch(() => null), api.temperatureStore().catch(() => null),
        api.gcodeStore(300).catch(() => []), api.webcams().catch(() => []), api.spoolmanActive().catch(() => null), api.dbGet("prefs").catch(() => ({})),
      ]);
      store.set({ printerInfo: pinfo, procStats: ps, tempHistory: th, webcams: cams, activeSpool: spoolId, prefs: prefs || {},
        log: mergeLog(store.state.log, gs) });
      refreshSpools();
      // configfile.settings is large (~200 KB) and static: fetched beside hydration, never gating it.
      // (It used to ALSO sit in the Promise.all above, whose 8 promises were destructured into 7
      // names — so it was downloaded twice per load and one copy silently discarded.)
      api.query({ configfile: ["settings"] })
        .then(r => store.set({ config: r.status.configfile.settings }))
        .catch(e => console.warn("[boot] configfile.settings", e.message));

      // Command catalogue. `printer.gcode.commands` is built by Klipper from EVERY registered
      // handler, so one lookup covers all three classes that objects.list cannot: [gcode_macro X],
      // natives from config sections (QUAD_GANTRY_LEVEL, Z_OFFSET_APPLY_PROBE), and Python-registered
      // commands (MMU_*). It also carries help text, which is free label/tooltip copy.
      //
      // LATCHED on purpose: Klipper's _handle_shutdown resets gcode_handlers to base_gcode_handlers,
      // so ~330 commands vanish exactly when FIRMWARE_RESTART is the thing the user needs. Only a
      // snapshot taken while klippy is ready is accepted; otherwise the last good one is kept.
      api.query({ gcode: ["commands"] })
        .then(r => {
          const cmds = (r.status && r.status.gcode && r.status.gcode.commands) || null;
          if (!cmds || store.state.klippy !== "ready") return;          // never latch a collapsed set
          store.set({ commands: cmds, commandsStale: false });
        })
        .catch(e => console.warn("[boot] gcode.commands", e.message));
    } catch (e) { console.error("[boot] hydrate", e); }
  }
  async function refreshSpools() {
    try {
      const gate = (store.state.raw.mmu || {}).gate_spool_id || [];
      const ids = new Set(gate.filter(i => i > 0)); if (store.state.activeSpool) ids.add(store.state.activeSpool);
      const spools = Object.assign({}, store.state.spools);
      await Promise.all([...ids].map(async id => { try { spools[id] = await api.spoolman(`/spool/${id}`); } catch {} }));
      store.set({ spools });
    } catch {}
  }
  // periodic side channels
  setInterval(() => { if (api.connected) api.procStats().then(ps => store.set({ procStats: ps })).catch(() => {}); }, 3000);
  setInterval(refreshSpools, 60000);
  // append live temps to the history snapshot once per second (keeps the graph moving without refetching)
  setInterval(() => {
    const th = store.state.tempHistory; if (!th) return;
    const raw = store.state.raw; const next = Object.assign({}, th);
    for (const [name, series] of Object.entries(th)) {
      const obj = raw[name] || (name === "extruder" || name === "heater_bed" ? raw[name] : null);
      if (!obj || obj.temperature === undefined) continue;
      const s = Object.assign({}, series);
      for (const k of ["temperatures", "targets", "powers", "speeds"]) if (s[k]) { const arr = s[k].slice(1); arr.push(k === "temperatures" ? obj.temperature : k === "targets" ? obj.target ?? 0 : k === "powers" ? obj.power ?? 0 : obj.speed ?? 0); s[k] = arr; }
      next[name] = s;
    }
    store.set({ tempHistory: next });
  }, 1000);

  // ---- page visibility: a hidden tab should not hold an MJPEG connection open.
  // ustreamer splits bandwidth across clients (measured: 3 clients -> 6/8/0 fps each on this
  // camera's 72 KB frames), so releasing the stream when unwatched speeds up whoever is watching.
  const setVis = () => store.set({ visible: typeof document === "undefined" || !document.hidden });
  setVis();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", setVis);

  // ---- ustreamer /state: the ONLY honest source of delivered FPS.
  // An <img> carrying multipart/x-mixed-replace fires no load event per frame in Chrome (verified 0
  // events in 6 s), so frames cannot be counted client-side. ustreamer reports per-client fps and we
  // tag our own connection with ?key= (see adapters/webcam.js) to find ours exactly.
  let camStateUrl = null, camStateFails = 0;
  setInterval(async () => {
    if (!store.state.visible || camStateFails > 3) return;
    const cam = (store.state.webcams || [])[0];
    if (!cam || !cam.stream_url) return;
    if (!camStateUrl) {
      const b = String(cam.stream_url).split("?")[0].replace(/\/$/, "");
      camStateUrl = (/^https?:/i.test(b) ? b : api.base + b) + "/state";
    }
    try {
      const r = await fetch(camStateUrl);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      camStateFails = 0;
      store.set({ camState: j.result || j });
    } catch (e) {
      if (++camStateFails > 3) console.warn("[boot] webcam /state unavailable — FPS will read '—'");
    }
  }, 1000);   // 685-byte poll; 1 s keeps the displayed rate honest as clients come and go

  api.connect().then(() => { if (api.klippyState === "ready") hydrate(); });
  return { api, store };
}
/** Klipper's backlog + any lines the UI already logged, newest first (hydrate must not wipe them). */
function mergeLog(existing, gcodeStore) {
  const backlog = (gcodeStore || []).slice().reverse().map(e => ({ time: e.time, message: e.message, type: e.type }));
  const local = (existing || []).filter(l => l && l.local);
  return local.concat(backlog).slice(0, 2000);
}

export function appendLog(store, entry) {
  const log = [entry].concat(store.state.log).slice(0, 2000);
  store.set({ log });
}
