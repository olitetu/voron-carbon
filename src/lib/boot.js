// Creates the Moonraker client + store and keeps the store fed. One instance per page load.
import { Moonraker } from "./moonraker.js";
import { Store } from "./store.js";
import { normalize } from "./history.js";

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
  bed_mesh: null, mmu: null, "gcode_macro _MMU_SEQUENCE_VARS": null, quad_gantry_level: null,
  // save_config_pending_items maps each section SAVE_CONFIG would rewrite to its pending options (live: {}
  // when nothing is pending). Klipper diffs status per field and sends the whole dict when it changes, and
  // mergeStatus replaces per field, so a dropped entry does not linger. The z-offset and bed-mesh screens
  // name the pending items from it.
  configfile: ["save_config_pending", "save_config_pending_items"],
  "mmu_encoder mmu_encoder": null,
  // geometry sources: the EREC cutter's feed/cut lengths and the toolhead tip vars
  "gcode_macro _EREC_VARS": null, "gcode_macro _MMU_FORM_TIP_VARS": null,
  mcu: null, "mcu mmu": null, "mcu can0": null, "mcu scanner": null, save_variables: null,
};

export function boot() {
  const api = new Moonraker(API_BASE);
  const store = new Store();
  api.on("connected", () => { store.set({ connected: true }); refreshRecentJobs(); });
  api.on("disconnected", () => store.set({ connected: false }));
  // ---- Klippy state Moonraker never announces. It notifies the disconnect, but when Klippy comes back
  // klippy_connection._check_ready (9bceead, this printer's Moonraker) announces only "ready" and "shutdown".
  // A Klippy that reconnects in "error" (a config or MCU-connect error, exactly when FIRMWARE_RESTART is the
  // way out) is never announced, nor is "startup" turning into "error", so st.klippy would stay
  // "disconnected" or "startup" until a reload. While it says one of those two, re-read server.info every
  // 2 s (a read over the open socket: no extra HTTP connection) and store the state it reports.
  // A "ready" read is neither written nor ends the watch: only the ready path below hydrates and clears
  // commandsStale, and _check_ready reports ready (_klippy_started) BEFORE it checks requirements, registers
  // methods and sends notify_klippy_ready. A Klippy that shuts down inside that window is never announced
  // either (the init path logs "transition from ready during init" and sends nothing), so the next read
  // must still run to see it. The window is a few Klippy round trips; if a second read 2 s later still says
  // ready with no notification, the notification is not coming and the ready path runs from here.
  const KLIPPY_UNANNOUNCED = ["disconnected", "startup"];
  let klippyPoll = null, klippyPollBusy = false, klippyReadyReads = 0;
  function watchKlippy(s) {
    if (KLIPPY_UNANNOUNCED.includes(s)) { klippyReadyReads = 0; if (!klippyPoll) klippyPoll = setInterval(readKlippy, 2000); }
    else if (klippyPoll) { clearInterval(klippyPoll); klippyPoll = null; }
  }
  function readKlippy() {
    if (klippyPollBusy || !api.connected) return;
    const poll = klippyPoll;
    klippyPollBusy = true;
    api.serverInfo()
      .then(info => {
        if (!info || poll !== klippyPoll) return;   // a notification settled it meanwhile
        const s = info.klippy_connected === false ? "disconnected" : String(info.klippy_state || "unknown");
        if (s === "ready") { if (++klippyReadyReads >= 2) onKlippy("ready"); return; }
        if (s !== store.state.klippy) store.set({ serverInfo: info, klippy: s });
        watchKlippy(s);
      })
      .catch(() => { /* no answer: keep the known state and try again next tick */ })
      .finally(() => { klippyPollBusy = false; });
  }
  function onKlippy(s) {
    store.set({ klippy: s, commandsStale: s !== "ready" });   // keep the last good catalogue, just flag it
    watchKlippy(s);
    if (s === "ready") hydrate();
  }
  api.on("server_info", info => { store.set({ serverInfo: info, klippy: info.klippy_state }); watchKlippy(info.klippy_state); });
  api.on("klippy", onKlippy);
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
  // ---- LATEST PRINTS: the dashboard's job card lists these once nothing is running. Moonraker announces every
  // job start and finish (notify_history_changed), so the list is current the moment a print ends, with no
  // polling. History is Moonraker's own database, so this needs no Klipper: it is fetched on every (re)connect.
  // Five rows with metadata is ~10 KB. `seq` drops a slow reply that a newer request has already superseded.
  const RECENT_N = 5;
  let recentSeq = 0;
  function refreshRecentJobs() {
    const seq = ++recentSeq;
    return api.historyList({ limit: RECENT_N, start: 0, order: "desc" })
      .then(r => { if (seq === recentSeq) store.set({ recentJobs: normalize(r) }); })
      .catch(e => console.warn("[boot] recent jobs", e.message));
  }
  api.on("history", () => refreshRecentJobs());
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
  // st.spools holds ONLY the spools currently in a gate or active. It is rebuilt from those ids on every
  // refresh: starting from the old map kept a spool that had left its gate at its last-seen location and
  // weight forever, and useSpoolList lets the store win over the list, so every detail view showed that
  // stale copy. A current id whose fetch fails keeps its previous copy (a Spoolman hiccup must not blank a
  // loaded gate). `seq` drops a slow run that a newer one has superseded, as refreshRecentJobs does.
  let spoolSeq = 0;
  async function refreshSpools() {
    const seq = ++spoolSeq;
    try {
      const gate = (store.state.raw.mmu || {}).gate_spool_id || [];
      const ids = new Set(gate.filter(i => i > 0)); if (store.state.activeSpool) ids.add(store.state.activeSpool);
      const prev = store.state.spools || {};
      const spools = {};
      await Promise.all([...ids].map(async id => {
        try { spools[id] = await api.spoolman(`/spool/${id}`); } catch { if (prev[id]) spools[id] = prev[id]; }
      }));
      if (seq === spoolSeq) store.set({ spools });
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
  // Every viewer is an HTTP stream of its own. At the camera's old quality (72 KB frames) 3 clients got
  // 6/8/0 fps each; at today's CPU encoder Q55 (~35 KB snapshot, 640x480) two viewers each get 30 fps, but an
  // unwatched stream still holds bandwidth and one of the kiosk's 6 connections per host, so it is released.
  const setVis = () => store.set({ visible: typeof document === "undefined" || !document.hidden });
  setVis();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", setVis);

  // ---- ustreamer /state: the ONLY honest source of delivered FPS.
  // An <img> carrying multipart/x-mixed-replace fires exactly one load event, at the first frame, and none
  // after (measured in Chromium 152), so frames cannot be counted client-side. ustreamer reports per-client fps and we
  // tag our own connection with ?key= (see adapters/webcam.js) to find ours exactly.
  // After a few failures the poll backs off to every 10 s rather than stopping: it used to give up for the
  // rest of the page's life, so one camera hiccup (the freeze this panel's REFRESH exists for) took the FPS
  // readout and stall detection down with it until a reload.
  // One request at a time, each aborted after 2 s (a timeout counts as a failure toward the back-off). On the
  // kiosk the page, Moonraker and ustreamer share one origin, and HTTP/1.1 allows 6 connections per host, one
  // of them held for good by the MJPEG stream: a /state that hangs, re-sent every second, would take the rest
  // within seconds and queue every Moonraker REST call behind it.
  let camStateUrl = null, camStateFails = 0, camStateTick = 0, camStateBusy = false;
  setInterval(async () => {
    camStateTick++;
    if (camStateBusy || !store.state.visible || (camStateFails > 3 && camStateTick % 10)) return;
    const cam = (store.state.webcams || [])[0];
    if (!cam || !cam.stream_url) return;
    if (!camStateUrl) {
      const b = String(cam.stream_url).split("?")[0].replace(/\/$/, "");
      camStateUrl = (/^https?:/i.test(b) ? b : api.base + b) + "/state";
    }
    camStateBusy = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    try {
      const r = await fetch(camStateUrl, { signal: ctl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();   // the signal covers the body too
      camStateFails = 0;
      store.set({ camState: j.result || j });
    } catch (e) {
      if (++camStateFails === 4) console.warn("[boot] webcam /state unavailable — retrying every 10 s");
    } finally {
      clearTimeout(timer);
      camStateBusy = false;
    }
  }, 1000);   // 685-byte poll; 1 s keeps the displayed rate honest as clients come and go

  api.connect().then(() => { if (api.klippyState === "ready") hydrate(); });
  return { api, store };
}
/**
 * Klipper's backlog + any lines the UI already logged, newest first (hydrate must not wipe them).
 * The local lines are merged into the backlog by time instead of being pinned to the head: a
 * "New file" line from before a Klippy restart used to sit above everything the restart printed.
 * Both inputs are already newest first, so this is a merge that keeps each one's own order (a
 * full sort would reshuffle the backlog wherever the Pi's clock stepped, e.g. NTP after boot).
 * Both are wall-clock epoch seconds: Moonraker's data_store stamps gcode_store lines with the Pi's
 * time.time() as it receives them, local lines carry the browser's Date.now()/1000. On the kiosk that is
 * one clock; a desktop browser is another NTP-synced machine, so skew only reorders lines within it.
 */
function mergeLog(existing, gcodeStore) {
  const backlog = (gcodeStore || []).slice().reverse().map(e => ({ time: e.time, message: e.message, type: e.type }));
  const local = (existing || []).filter(l => l && l.local);
  const out = [];
  let i = 0, j = 0;
  while (out.length < 2000 && (i < local.length || j < backlog.length)) {
    const takeLocal = j >= backlog.length || (i < local.length && (local[i].time || 0) >= (backlog[j].time || 0));
    out.push(takeLocal ? local[i++] : backlog[j++]);
  }
  return out;
}

export function appendLog(store, entry) {
  const log = [entry].concat(store.state.log).slice(0, 2000);
  store.set({ log });
}
