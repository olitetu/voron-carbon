// Moonraker client: WebSocket JSON-RPC + REST helpers. Shared by every page.
// Usage: const api = new Moonraker(base); api.on('status', partial => …); await api.connect(); api.gcode('G28');
export class Moonraker {
  constructor(base) {
    // base '' = same origin (when hosted on the printer). Otherwise an absolute URL, e.g. 'http://myprinter.local'.
    this.base = (base || "").replace(/\/$/, "");
    this.wsUrl = (this.base ? this.base.replace(/^http/, "ws") : (location.protocol === "https:" ? "wss://" : "ws://") + location.host) + "/websocket";
    this.ws = null; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.subs = {}; this.connected = false; this.klippyState = "unknown"; this._retry = 0; this._closing = false;
  }
  on(ev, fn) { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev).add(fn); return () => this.listeners.get(ev).delete(fn); }
  emit(ev, ...a) { const s = this.listeners.get(ev); if (s) for (const fn of s) { try { fn(...a); } catch (e) { console.error("[moonraker] listener", ev, e); } } }

  connect() {
    return new Promise((resolve) => {
      this._closing = false;
      const ws = new WebSocket(this.wsUrl); this.ws = ws;
      ws.onopen = async () => {
        this._retry = 0; this.connected = true; this.emit("connected");
        try {
          await this.rpc("server.connection.identify", { client_name: "Voron Carbon", version: "0.1.0", type: "web", url: "https://github.com/" });
          const info = await this.rpc("server.info");
          this.klippyState = info.klippy_state; this.emit("server_info", info);
          if (Object.keys(this.subs).length) await this._resubscribe();
        } catch (e) { console.warn("[moonraker] identify", e); }
        resolve();
      };
      ws.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        const batch = Array.isArray(msg) ? msg : [msg];
        for (const j of batch) {
          if (j.id !== undefined && this.pending.has(j.id)) {
            const p = this.pending.get(j.id); this.pending.delete(j.id);
            if (j.error) p.reject(Object.assign(new Error(j.error.message || "rpc error"), { code: j.error.code, method: p.method }));
            else p.resolve(j.result);
            continue;
          }
          if (j.method) this._notify(j.method, j.params);
        }
      };
      ws.onclose = () => {
        this.connected = false; this.emit("disconnected");
        for (const [, p] of this.pending) p.reject(new Error("socket closed")); this.pending.clear();
        if (this._closing) return;
        const delay = Math.min(15000, 500 * Math.pow(2, this._retry++));
        setTimeout(() => this.connect(), delay);
      };
      ws.onerror = () => {};
    });
  }
  close() { this._closing = true; if (this.ws) this.ws.close(); }

  _notify(method, params) {
    const p = params || [];
    switch (method) {
      case "notify_status_update": this.emit("status", p[0], p[1]); break;
      case "notify_gcode_response": this.emit("gcode_response", p[0]); break;
      case "notify_klippy_ready": this.klippyState = "ready"; this.emit("klippy", "ready"); this._resubscribe(); break;
      case "notify_klippy_shutdown": this.klippyState = "shutdown"; this.emit("klippy", "shutdown"); break;
      case "notify_klippy_disconnected": this.klippyState = "disconnected"; this.emit("klippy", "disconnected"); break;
      case "notify_proc_stat_update": this.emit("proc_stats", p[0]); break;
      case "notify_filelist_changed": this.emit("filelist", p[0]); break;
      case "notify_history_changed": this.emit("history", p[0]); break;
      case "notify_update_refreshed": this.emit("update_refreshed", p[0]); break;
      case "notify_service_state_changed": this.emit("service_state", p[0]); break;
      case "notify_webcams_changed": this.emit("webcams", p[0]); break;
      case "notify_active_spool_set": this.emit("active_spool", p[0]); break;
      default: this.emit(method, ...p);
    }
  }

  rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("not connected"));
      const id = ++this.id;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout: " + method)); } }, 30000);
    });
  }

  /** Subscribe to printer objects ({ toolhead: null, extruder: ['temperature'] }); returns the initial full status. */
  async subscribe(objects) {
    Object.assign(this.subs, objects);
    return this._resubscribe();
  }
  async _resubscribe() {
    if (!this.connected || !Object.keys(this.subs).length) return null;
    try {
      const r = await this.rpc("printer.objects.subscribe", { objects: this.subs });
      this.emit("status", r.status, r.eventtime, true);
      return r.status;
    } catch (e) { console.warn("[moonraker] subscribe", e.message); return null; }
  }
  query(objects) { return this.rpc("printer.objects.query", { objects }); }
  objectsList() { return this.rpc("printer.objects.list").then(r => r.objects); }

  // ---- commands
  gcode(script) { return this.rpc("printer.gcode.script", { script }); }
  emergencyStop() { return this.rpc("printer.emergency_stop"); }
  printerRestart() { return this.rpc("printer.restart"); }
  firmwareRestart() { return this.rpc("printer.firmware_restart"); }
  startPrint(filename) { return this.rpc("printer.print.start", { filename }); }
  pausePrint() { return this.rpc("printer.print.pause"); }
  resumePrint() { return this.rpc("printer.print.resume"); }
  cancelPrint() { return this.rpc("printer.print.cancel"); }

  // ---- REST
  async get(path, params) {
    const u = new URL(this.base + path, location.origin);
    if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${path}`);
    const j = await r.json(); return j.result !== undefined ? j.result : j;
  }
  async post(path, body, method = "POST") {
    const r = await fetch(this.base + path, { method, headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" }, body: body instanceof FormData ? body : JSON.stringify(body || {}) });
    if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
    const j = await r.json(); return j.result !== undefined ? j.result : j;
  }
  del(path, params) { const u = new URL(this.base + path, location.origin); if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); return fetch(u, { method: "DELETE" }).then(r => r.json()).then(j => j.result); }

  serverInfo() { return this.rpc("server.info"); }
  printerInfo() { return this.rpc("printer.info"); }
  procStats() { return this.rpc("machine.proc_stats"); }
  systemInfo() { return this.rpc("machine.system_info"); }
  temperatureStore(includeMonitors = true) { return this.rpc("server.temperature_store", { include_monitors: includeMonitors }); }
  gcodeStore(count = 200) { return this.rpc("server.gcode_store", { count }).then(r => r.gcode_store); }
  webcams() { return this.rpc("server.webcams.list").then(r => r.webcams); }
  // files
  filesList(root = "gcodes") { return this.rpc("server.files.list", { root }); }
  dirInfo(path = "gcodes", extended = true) { return this.rpc("server.files.get_directory", { path, extended }); }
  fileMeta(filename) { return this.rpc("server.files.metadata", { filename }); }
  fileMetascan(filename) { return this.rpc("server.files.metascan", { filename }); }
  fileDelete(root, path) { return this.rpc("server.files.delete_file", { path: `${root}/${path}` }); }
  fileMove(source, dest) { return this.rpc("server.files.move", { source, dest }); }
  fileCopy(source, dest) { return this.rpc("server.files.copy", { source, dest }); }
  dirCreate(path) { return this.rpc("server.files.post_directory", { path }); }
  dirDelete(path, force = false) { return this.rpc("server.files.delete_directory", { path, force }); }
  fileUrl(root, path) { return `${this.base}/server/files/${root}/${encodeURIComponent(path).replace(/%2F/g, "/")}`; }
  /** `extra` = additional form fields, e.g. { print: "true" } — file_manager reads that literal string and starts the job. */
  fileUpload(file, root = "gcodes", path = "", onProgress, extra) {
    return new Promise((resolve, reject) => {
      const fd = new FormData(); fd.append("root", root); if (path) fd.append("path", path);
      if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) fd.append(k, String(v));
      fd.append("file", file, file.name);
      const x = new XMLHttpRequest(); x.open("POST", this.base + "/server/files/upload");
      // Without a timeout a stalled request never settles, and the caller's progress UI sticks at whatever
      // percentage it reached forever. This is generous on purpose: uploads here run to hundreds of MB over
      // WiFi, and Moonraker goes silent AFTER the last byte while it moves the file and scans its metadata.
      x.timeout = 15 * 60 * 1000;
      x.ontimeout = () => reject(new Error("upload timed out (no response for 15 min)"));
      x.onabort = () => reject(new Error("upload aborted"));
      x.upload.onprogress = e => onProgress && e.lengthComputable && onProgress(e.loaded / e.total);
      x.onload = () => {
        if (x.status >= 300) return reject(new Error(x.responseText || ("HTTP " + x.status)));
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) { resolve({}); }        // 2xx with an unparseable body: the upload landed, that is what matters
      };
      x.onerror = () => reject(new Error("upload failed")); x.send(fd);
      if (typeof onProgress === "function") onProgress(0, x);   // hand the caller the xhr so it can abort
    });
  }
  async fileText(root, path) { const r = await fetch(this.fileUrl(root, path)); if (!r.ok) throw new Error(r.status); return r.text(); }
  // history
  historyList(params = { limit: 50, start: 0, order: "desc" }) { return this.rpc("server.history.list", params); }
  historyTotals() { return this.rpc("server.history.totals"); }
  historyDelete(uid) { return this.rpc("server.history.delete_job", { uid }); }
  historyDeleteAll() { return this.rpc("server.history.delete_job", { all: true }); }
  // spoolman (through Moonraker's proxy — no CORS issues)
  spoolman(path, method = "GET", body) { return this.rpc("server.spoolman.proxy", Object.assign({ request_method: method, path: "/v1" + path, use_v2_response: true }, body ? { body } : {})).then(r => r.error ? Promise.reject(new Error(r.error.message)) : r.response); }
  // NOTE the method is get_spool_id, not spool_id — `server.spoolman.spool_id` is NOT registered and
  // returns -32601 Method not found, which this swallowed into a null active spool forever.
  spoolmanActive() { return this.rpc("server.spoolman.get_spool_id").then(r => r.spool_id); }
  spoolmanSetActive(spool_id) { return this.rpc("server.spoolman.post_spool_id", { spool_id }); }
  // machine / updates
  serviceRestart(service) { return this.rpc("machine.services.restart", { service }); }
  serviceStop(service) { return this.rpc("machine.services.stop", { service }); }
  serviceStart(service) { return this.rpc("machine.services.start", { service }); }
  reboot() { return this.rpc("machine.reboot"); }
  shutdown() { return this.rpc("machine.shutdown"); }
  updateStatus(refresh = false) { return this.rpc("machine.update.status", { refresh }); }
  updateRefresh() { return this.rpc("machine.update.refresh"); }
  updateClient(name) { return this.rpc("machine.update.client", { name }); }
  updateKlipper() { return this.rpc("machine.update.klipper"); }
  updateMoonraker() { return this.rpc("machine.update.moonraker"); }
  updateSystem() { return this.rpc("machine.update.system"); }
  updateFull() { return this.rpc("machine.update.full"); }
  updateRecover(name, hard = false) { return this.rpc("machine.update.recover", { name, hard }); }
  powerDevices() { return this.rpc("machine.device_power.devices").then(r => r.devices); }
  powerSet(device, action) { return this.rpc("machine.device_power.post_device", { device, action }); }
  // small persisted UI prefs (macro icons, layouts…) in Moonraker's DB, namespace 'carbon'
  dbGet(key) { return this.rpc("server.database.get_item", { namespace: "carbon", key }).then(r => r.value).catch(() => undefined); }
  dbSet(key, value) { return this.rpc("server.database.post_item", { namespace: "carbon", key, value }); }
  dbDel(key) { return this.rpc("server.database.delete_item", { namespace: "carbon", key }); }
}
