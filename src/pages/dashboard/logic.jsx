// Dashboard controller.
//
// The design export shipped a single class whose renderVals() built ~150 view keys from FAKE state.
// That view-model now lives in src/pages/dashboard/adapters/*.js, one module per panel, fed by the live
// Moonraker store; the real commands live in src/lib/actions/*.js. This class keeps only what is genuinely
// UI-local (open menus, edit buffers, hover, step selections) plus the design's helpers (field, barPick,
// measure) and the animation ticks, then merges every adapter's keys into the object Template.jsx consumes.
import React from "react";
import Template from "./Template.jsx";

import { commonVals } from "./adapters/common.js";
import { shellVals } from "./adapters/shell.js";
import { jobVals } from "./adapters/job.js";
import { toolheadVals } from "./adapters/toolhead.js";
import { fansLedsVals } from "./adapters/fansLeds.js";
import { tempsVals } from "./adapters/temps.js";
import { extruderVals } from "./adapters/extruder.js";
import { consoleVals } from "./adapters/console.js";
import { macrosVals } from "./adapters/macros.js";
import { heightmapVals } from "./adapters/heightmap.js";
import { limitsVals } from "./adapters/limits.js";
import { mmuVals } from "./adapters/mmu.js";
import { webcamVals } from "./adapters/webcam.js";

import { makeJobActions } from "../../lib/actions/job.js";
import { makeToolheadActions } from "../../lib/actions/toolhead.js";
import { makeFansLedsActions } from "../../lib/actions/fansLeds.js";
import { makeTempsActions } from "../../lib/actions/temps.js";
import { makeExtruderActions } from "../../lib/actions/extruder.js";
import { makeConsoleActions } from "../../lib/actions/console.js";
import { makeMacrosActions } from "../../lib/actions/macros.js";
import { makeLimitsActions } from "../../lib/actions/limits.js";
import { makeMmuActions } from "../../lib/actions/mmu.js";
import { makeUploadActions, isUploadable } from "../../lib/actions/upload.js";

const ADAPTERS = [
  shellVals, jobVals, toolheadVals, fansLedsVals, tempsVals, extruderVals,
  consoleVals, macrosVals, heightmapVals, limitsVals, mmuVals, webcamVals,
];

export class DashboardLogic extends React.Component {
  state = {
    // menus / overlays
    ledPicker: null, mmuMenuOpen: false, macroPickerOpen: false, servoMenuOpen: false,
    soakMenuOpen: false, macroPickerFor: null, iconPickFor: null, mapOpen: null,
    excludeOpen: false, consoleExpanded: false,
    // edit buffers & confirms
    edits: {}, macroEdits: {}, confirmId: null, confirmCancel: false, confirmSave: false, excludedAt: {},
    // selections the design keeps in the UI
    extrudeLen: 100, extrudeRate: 10,
    // transient view state
    hoverIdx: null, narrow: false, guardsInline: false, clock: "", tphase: 0,
    metaTick: 0,
    // UPLOAD & PRINT: the top-bar button's progress/result (see actions/upload.js onState) and the drop overlay
    upload: null, drop: null,
  };

  constructor(props) {
    super(props);
    this.log = this.log.bind(this);
    const deps = { api: props.api, store: props.store, log: this.log };
    // One flat action object; the adapters call ctx.act.<name>().
    this.act = Object.assign(
      {},
      makeJobActions(deps), makeToolheadActions(deps), makeFansLedsActions(deps),
      makeTempsActions(deps), makeExtruderActions(deps), makeConsoleActions(deps),
      makeMacrosActions(deps), makeLimitsActions(deps), makeMmuActions(deps), makeUploadActions(deps),
    );
    this._warned = new Set();
    // dev handle: window.__carbon.act.<action>() from devtools
    if (typeof window !== "undefined" && window.__carbon) window.__carbon.act = this.act;
  }

  /** Adds a line to the shared console log (the dashboard + console page both read store.log). */
  log(message, kind) {
    const store = this.props.store;
    if (!store) return;
    const entry = { time: Date.now() / 1000, message: String(message), type: kind || "info", local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }

  componentDidMount() {
    this.measure();
    window.addEventListener("resize", this.measure);
    // Drop anywhere: window-level, so a file can land on the nav rail, the top bar or any panel. A page with its
    // own drop zone (Files) preventDefault()s first — React dispatches at #app, before the event reaches window —
    // so e.defaultPrevented reads as "already taken" and the global overlay/upload stay out of its way.
    window.addEventListener("dragenter", this.onDragEnter);
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("dragleave", this.onDragLeave);
    window.addEventListener("drop", this.onDrop);
    this._unsub = this.props.store.subscribe(() => this.forceUpdate());

    const clock = () => {
      const d = new Date();
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    };
    this.setState({ clock: clock() });
    this._tick = setInterval(() => this.setState(s => ({ tphase: s.tphase + 1, clock: clock() })), 1000);

    // There is no second travel ticker here on purpose. This class used to run a 60 ms interval easing
    // `state.travel` toward travelFromPos(), but adapters/common.js owns that easing now (easeTravel(),
    // fed by the encoder + HH's signed filament_position, which is far more accurate than the discrete
    // filament_pos anchors) and NOTHING reads ui.travel. The interval was a 16 Hz setState — and therefore
    // a 16 Hz re-render of the shell and all twelve adapters during any MMU move — feeding a dead value.
  }

  componentWillUnmount() {
    window.removeEventListener("resize", this.measure);
    window.removeEventListener("dragenter", this.onDragEnter);
    window.removeEventListener("dragover", this.onDragOver);
    window.removeEventListener("dragleave", this.onDragLeave);
    window.removeEventListener("drop", this.onDrop);
    clearInterval(this._tick);
    clearTimeout(this._uploadClearT); clearTimeout(this._dragT); clearTimeout(this._dropFlashT);
    if (this._unsub) this._unsub();
    if (this._ro) this._ro.disconnect();
  }

  // ---- UPLOAD & PRINT: hidden picker + drop anywhere ---------------------------------------
  setUploadInput = el => { this._uploadInput = el; };
  /** The top-bar button. While an upload runs the button is the progress readout, so a click does nothing new. */
  pickUpload = () => {
    const u = this.state.upload;
    if (u && u.phase === "uploading") { this.log("Upload in progress — " + (u.name || "a file") + " first", "warn"); return; }
    if (this._uploadInput) this._uploadInput.click();
  };
  uploadInputChange = e => {
    const files = Array.from((e && e.target && e.target.files) || []);
    if (e && e.target) e.target.value = "";                 // so the same file can be picked twice in a row
    this.uploadFiles(files);
  };
  /** Runs the action, mirrors its progress into ui.upload, and leaves the result on the button for a few seconds. */
  uploadFiles(files, opts) {
    const list = Array.from(files || []).filter(f => f && f.name);
    if (!list.length) return;
    const cur = this.state.upload;
    if (cur && cur.phase === "uploading") { this.log("Upload in progress — " + list.map(f => f.name).join(", ") + " not queued", "warn"); return; }
    clearTimeout(this._uploadClearT);
    if (!list.some(f => isUploadable(f.name))) this.flashDrop("bad");
    Promise.resolve()
      .then(() => this.act.uploadAndPrint(list, s => this.setState({ upload: s }), opts))
      .catch(e => {
        const reason = (e && e.message) || String(e);
        this.log("Upload failed — " + reason, "err");
        const s = { phase: "error", reason };
        this.setState({ upload: s });
        return s;
      })
      // The OUTCOME comes from the action's return value, never from this.state: the last emit's setState has
      // not been applied yet at this point (React schedules it), so reading this.state here saw the final
      // "uploading" frame, took the early return, and left SENT · PRINTING pinned on the button forever.
      .then(res => {
        const u = res && res.phase ? res : this.state.upload;
        if (!u || u.phase === "uploading") return;
        clearTimeout(this._uploadClearT);
        // A newer upload owns the button from the moment it starts — never wipe its progress readout.
        this._uploadClearT = setTimeout(
          () => this.setState(s => (s.upload && s.upload.phase !== "uploading" ? { upload: null } : null)),
          u.phase === "error" ? 6000 : 3000,
        );
      });
  }

  _dragDepth = 0;
  hasFiles = e => !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
  /** Only MIME types are known during a drag (names arrive on drop): flag "bad" when every item is clearly not g-code. */
  dropKind = e => {
    const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []).filter(i => i && i.kind === "file");
    const notGcode = t => /^(image|video|audio|font)\//.test(t) || /^application\/(pdf|zip|x-zip|gzip|x-tar|x-7z|vnd\.)/.test(t);
    return items.length && items.every(i => notGcode(String(i.type || ""))) ? "bad" : "ok";
  };
  // Compared against an instance field, not this.state: dragover fires at ~20 Hz and React batches these
  // updates, so this.state.drop lags — a drop right after a dragover would compare null to null and never clear.
  _drop = null;
  setDrop(kind) { if (this._drop === kind) return; this._drop = kind; this.setState({ drop: kind }); }
  flashDrop(kind, ms) { clearTimeout(this._dropFlashT); this.setDrop(kind); this._dropFlashT = setTimeout(() => this.setDrop(null), ms || 1600); }
  // A drag that leaves the window without a dragleave (WKWebView does this) would pin the overlay open. dragover
  // fires every ~50 ms while the pointer is over the page, so 800 ms of silence means the drag is gone.
  armDragWatchdog() { clearTimeout(this._dragT); this._dragT = setTimeout(() => { this._dragDepth = 0; this.setDrop(null); }, 800); }
  onDragEnter = e => {
    if (!this.hasFiles(e)) return;
    const taken = e.defaultPrevented;
    e.preventDefault();
    this._dragDepth++;
    this.setDrop(taken ? null : this.dropKind(e));
    this.armDragWatchdog();
  };
  onDragOver = e => {
    if (!this.hasFiles(e)) return;
    const taken = e.defaultPrevented;
    e.preventDefault();                                     // required, or the browser refuses the drop
    if (!taken) e.dataTransfer.dropEffect = "copy";
    this.setDrop(taken ? null : this.dropKind(e));
    this.armDragWatchdog();
  };
  onDragLeave = () => {
    this._dragDepth = Math.max(0, this._dragDepth - 1);
    if (!this._dragDepth) { clearTimeout(this._dragT); this.setDrop(null); }
  };
  onDrop = e => {
    if (!this.hasFiles(e)) return;
    const taken = e.defaultPrevented;
    e.preventDefault();                                     // never let the browser navigate to the dropped file
    this._dragDepth = 0;
    clearTimeout(this._dragT);
    this.setDrop(null);
    if (taken) return;                                      // the Files page queued it into the folder being browsed
    // A drop UPLOADS; it never starts a print. Dropping is easy to do by accident and starting a print is a
    // physical action, so the two are split: the top-bar button is the deliberate "upload AND print".
    this.uploadFiles(Array.from(e.dataTransfer.files || []), { noPrint: true });
  };

  // ---- design helpers, kept verbatim -------------------------------------------------
  measure = () => {
    const narrow = window.innerWidth < 1500;
    const el = this._mmuHeader;
    // title + status ≈ 350px, guards ≈ 480px — keep them on one row only when both fit
    const guardsInline = !!el && el.clientWidth >= 880;
    if (narrow !== this.state.narrow || guardsInline !== this.state.guardsInline) {
      this.setState({ narrow, guardsInline });
    }
  };

  setMmuHeader = el => {
    this._mmuHeader = el;
    if (el && !this._ro && window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.measure());
      this._ro.observe(el);
    }
    if (el) this.measure();
  };

  /** Edit-field helper: local buffer while typing, commit on Enter/blur, Escape reverts. */
  field(key, shown, commit) {
    const S = this.state;
    const val = S.edits[key] !== undefined ? S.edits[key] : shown;
    const dirty = S.edits[key] !== undefined && S.edits[key] !== shown;
    const write = t => this.setState(s => ({ edits: Object.assign({}, s.edits, { [key]: t }) }));
    const clear = () => this.setState(s => {
      const e = Object.assign({}, s.edits);
      delete e[key];
      return { edits: e };
    });
    const apply = () => { const n = parseFloat(val); clear(); if (!isNaN(n) && commit) commit(n); };
    return {
      value: val, dirty,
      onChange: e => write(e.target.value),
      onBlur: () => apply(),
      onKeyDown: e => {
        if (e.key === "Enter") { e.target.blur(); apply(); }
        else if (e.key === "Escape") { clear(); e.target.blur(); }
      },
    };
  }

  barPick(cb) {
    return e => {
      const r = e.currentTarget.getBoundingClientRect();
      cb(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100));
    };
  }

  // ---- view-model ---------------------------------------------------------------------
  renderVals() {
    const ctx = {
      st: this.props.store.state,
      ui: this.state,
      set: p => this.setState(p),
      field: this.field.bind(this),
      barPick: this.barPick.bind(this),
      act: this.act,
      log: this.log,
      A: this.props.accent ?? "#ff5a33",
      api: this.props.api,
      store: this.props.store,
      route: this.props.route,
      navigate: this.props.navigate,
      setMmuHeader: this.setMmuHeader,
      // UPLOAD & PRINT DOM hooks (adapter: shell): the hidden <input type=file> ref, its change handler, the button click
      setUploadInput: this.setUploadInput, uploadInputChange: this.uploadInputChange, pickUpload: this.pickUpload,
    };
    ctx.common = commonVals(ctx);

    const __t0 = performance.now();
    const V = {};
    for (const fn of ADAPTERS) {
      try {
        const __a = performance.now();
        Object.assign(V, fn(ctx) || {});
        if (typeof window !== "undefined" && window.__perf) {
          const b = (window.__perf.byAdapter = window.__perf.byAdapter || {});
          const n = fn.name || "?";
          b[n] = (b[n] || 0) + (performance.now() - __a);
        }
      } catch (e) {
        // A broken panel must not take the whole dashboard down.
        const name = fn.name || "adapter";
        if (!this._warned.has(name)) {
          this._warned.add(name);
          console.error(`[carbon] ${name} threw:`, e);
          this.log(`UI: ${name} failed — ${e.message}`, "err");
        }
      }
    }
    V.page = this.props.page;
    if (typeof window !== "undefined") {
      window.__V = V;                                    // dev aid: inspect the view-model in devtools
      const p = (window.__perf = window.__perf || { renders: 0, ms: 0, max: 0, emits: 0, byAdapter: {} });
      p.byAdapter = p.byAdapter || {};
      p.renders++; const d = performance.now() - __t0; p.ms += d; if (d > p.max) p.max = d;
    }
    return V;
  }

  render() {
    return <Template V={this.renderVals()} />;
  }
}

export default DashboardLogic;
