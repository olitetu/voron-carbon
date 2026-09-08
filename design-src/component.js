
class Component extends DCLogic {
  state = {
    active: "DASHBOARD",
    ledPicker: null,
    ledOverrides: {},
    consoleExpanded: false,
    mmuMenuOpen: false,
    macroPickerOpen: false,
    extruding: true,
    pos: { X: 102.44, Y: 215.73, Z: 1.6 },
    homed: { X: true, Y: true, Z: true },
    zOffset: 0.17,
    printState: "printing",
    estop: false,
    gate: 2,
    selector: 2,
    selectorMoving: false,
    servo: "down",
    servoMenuOpen: false,
    toolMapping: [0,1,2,3,4,5,6,7],
    endless: [null,null,4,4,null,6,null,null],
    factors: { speed: 100, extrusion: 100 },
    fanVals: { "Part Fan":30, "Chamber":40, "Exhaust":0, "Hotend Fan":80, "Controller":100 },
    targets: { "Extruder": 260, "Heater Bed": 105 },
    extrudeLen: 100,
    extrudeRate: 10,
    travel: 1,
    phase: "idle",
    layer: 8,
    tphase: 0,
    clock: "",
    edits: {},
    hoverIdx: null,
    soakMenuOpen: false,
    macroEdits: {},
    iconPickFor: null,
    excludeOpen: false,
    confirmId: null,
    objects: [
      { id:"lid_a",   name:"Lid A",        x:26,  y:24,  w:88, h:70 },
      { id:"lid_b",   name:"Lid B",        x:132, y:24,  w:88, h:70 },
      { id:"lid_c",   name:"Lid C",        x:238, y:24,  w:88, h:70 },
      { id:"frame_a", name:"Frame A",      x:26,  y:112, w:88, h:58 },
      { id:"frame_b", name:"Frame B",      x:132, y:112, w:88, h:58 },
      { id:"frame_c", name:"Frame C",      x:238, y:112, w:88, h:58 },
      { id:"clip_a",  name:"Clip A",       x:26,  y:188, w:60, h:44 },
      { id:"clip_b",  name:"Clip B",       x:104, y:188, w:60, h:44 },
      { id:"diff",    name:"Diffuser",     x:182, y:188, w:144, h:44 },
      { id:"base",    name:"Base Plate",   x:26,  y:250, w:300, h:74 }
    ].map(o => Object.assign(o, { excluded: false, excludedAtLayer: null })),
    mapOpen: null,
    log: [
      { t:"7:16", m:"MmuSyncFeedbackManager: sync state → tension" },
      { t:"7:16", m:"Tool T2 loaded from gate 2 (white)", kind:"ok" },
      { t:"7:16", m:"MmuSyncFeedbackManager: sync state → neutral" },
      { t:"7:15", m:"Gate 3 remaining below 15% threshold", kind:"warn" },
      { t:"7:15", m:"MmuSyncFeedbackManager: sync state → compressed" },
      { t:"7:15", m:"Tool swap 28 complete in 11.4s" },
      { t:"7:14", m:"mmu_encoder: 833 mm counted since load" },
      { t:"7:14", m:"Clog guard armed · flowrate 100%", kind:"ok" },
      { t:"7:13", m:"Set heater bed target to 105.0" },
      { t:"7:13", m:"Z-offset applied: 0.170" },
      { t:"7:12", m:"QUAD_GANTRY_LEVEL: max deviation 0.008" },
      { t:"7:12", m:"Chamber reached 47.6°C" }
    ],
    macroKeys: ["HOME","QGL","MESH","Z_CAL","PARK","M84","POWER","MMU_CHANGE","MMU_PURGE","MMU_CUT","MMU_UNLOAD","MMU_LOAD","MMU_HOME","MMU_RECOVER","GATE_MAP","PREHEAT","COOLDOWN","NEVERMORE","CLEAN_NOZZLE","FW_RESTART"]
  };

  macroCatalog = {
    HOME:["⌂","HOME","G28"],
    QGL:["✳","QGL","QUAD_GANTRY_LEVEL"],
    MESH:["▦","MESH","BED_MESH_CALIBRATE"],
    Z_CAL:["⌖","Z-CAL","PROBE_CALIBRATE"],
    Z_TILT:["◎","Z-TILT","Z_TILT_ADJUST"],
    PARK:["⇱","PARK","PARK_TOOLHEAD"],
    CENTER:["↧","CENTER","CENTER_TOOLHEAD"],
    M84:["⌁","M84","M84"],
    POWER:["⏻","POWER","POWER_OFF_PRINTER"],
    FW_RESTART:["⟳","FW-RST","FIRMWARE_RESTART"],
    MMU_CHANGE:["⇄","MMU CHG","MMU_CHANGE_TOOL"],
    MMU_PURGE:["◍","PURGE","MMU_PURGE"],
    MMU_CUT:["✂","CUT","MMU_CUT_FILAMENT"],
    MMU_UNLOAD:["⇲","UNLOAD","MMU_UNLOAD"],
    MMU_LOAD:["⇮","LOAD","MMU_LOAD"],
    MMU_HOME:["⊙","MMU HOME","MMU_HOME"],
    MMU_RESET:["⊘","MMU RST","MMU_RESET"],
    GATE_MAP:["≡","GATE MAP","MMU_GATE_MAP"],
    CHECK_GATE:["◐","CHK GATE","MMU_CHECK_GATE"],
    MMU_RECOVER:["⚑","RECOVER","MMU_RECOVER"],
    PREHEAT:["♨","PREHEAT","PREHEAT_ABS"],
    COOLDOWN:["❄","COOLDN","TURN_OFF_HEATERS"],
    CLEAN_NOZZLE:["⌾","CLEAN","CLEAN_NOZZLE"],
    BED_FAN:["⬒","BED FAN","BEDFANSFAST"],
    NEVERMORE:["✱","FILTER","NEVERMORE_ON"],
    SHUTDOWN:["⭘","SHUTDN","SHUTDOWN_MACHINE"],
    BEEP:["♪","BEEP","M300"],
    TEST_SPEED:["⇉","SPEEDTEST","TEST_SPEED"]
  };

  iconSet = ["⌂","✳","▦","⌖","◎","⇱","↧","⌁","⏻","⟳","⇄","◍","✂","⇲","⇮","⊙","⊘","≡","◐","⚑","♨","❄","⌾","⬒","✱","⭘","♪","⇉","◉","▲","◆","★","⚡","⌛","⎔","⌘"];

  macroMeta(k) {
    const base = this.macroCatalog[k] || ["?", k, k];
    const ov = (this.state.macroEdits || {})[k] || {};
    return { g: ov.g || base[0], t: ov.t !== undefined ? ov.t : base[1], cmd: base[2] };
  }

  setMacroMeta(k, patch) {
    this.setState(s => ({
      macroEdits: Object.assign({}, s.macroEdits, { [k]: Object.assign({}, (s.macroEdits || {})[k], patch) })
    }));
  }

  ledDefaults = [
    { k:"SB Leds",   color:"#ff5a33", pct:80,  on:true },
    { k:"Caselight", color:"#ffd8a8", pct:100, on:true },
    { k:"MMU Leds",  color:"#3ddcc4", pct:60,  on:false },
    { k:"Logo",      color:"#ff2d55", pct:100, on:false }
  ];

  ledList() {
    return this.ledDefaults.map(l => Object.assign({}, l, this.state.ledOverrides[l.k] || {}));
  }

  setLed(k, patch) {
    this.setState(s => ({
      ledOverrides: Object.assign({}, s.ledOverrides, {
        [k]: Object.assign({}, s.ledOverrides[k] || {}, patch)
      })
    }));
  }

  hsl2hex(h, s) {
    const l = 0.55, c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    const seg = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(hp) % 6];
    const m = l - c / 2;
    return "#" + seg.map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
  }

  cfg = { X:350, Y:350, Z:310, velocity:1000, accel:6960, scv:9, cruise:50, maxExtruder:300, maxBed:120 };

  gateInfo = [
    { name:"—", mat:"—", color:"#2a3340", fill:0 },
    { name:"—", mat:"—", color:"#2a3340", fill:0 },
    { name:"White", mat:"ABS", color:"#f2f2f0", fill:.30 },
    { name:"Grey", mat:"ABS", color:"#9aa3ad", fill:.12 },
    { name:"Black", mat:"ABS", color:"#3f4650", fill:.70 },
    { name:"Yellow", mat:"PLA", color:"#f5c518", fill:1 },
    { name:"Natural", mat:"PLA", color:"#d9c9a3", fill:1 },
    { name:"Blue", mat:"PETG", color:"#3f6fd8", fill:1 }
  ];

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

  componentDidMount() {
    this.measure();
    window.addEventListener("resize", this.measure);
    const clock = () => {
      const d = new Date();
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    };
    this.setState({ clock: clock() });
    this._tempTick = setInterval(() => this.setState(s => ({ tphase: s.tphase + 1, clock: clock() })), 1000);
    this._layerTick = setInterval(() => {
      if (this.state.printState !== "printing" || this.state.excludeOpen) return;
      this.setState(s => ({ layer: s.layer + 1 }));
    }, 45000);
  }

  componentWillUnmount() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._cut);
    clearInterval(this._layerTick);
    clearInterval(this._tempTick);
    clearTimeout(this._sel);
    clearTimeout(this._move);
    window.removeEventListener("resize", this.measure);
    if (this._ro) this._ro.disconnect();
  }

  excludeObject(id) {
    const o = this.state.objects.find(x => x.id === id);
    if (!o) return;
    this.setState(s => ({
      confirmId: null,
      objects: s.objects.map(x => x.id === id ? Object.assign({}, x, { excluded: true, excludedAtLayer: s.layer }) : x)
    }));
    this.pushLog("EXCLUDE_OBJECT NAME=" + o.name + " — skipped from layer " + this.state.layer, "warn");
  }

  includeObject(id) {
    const o = this.state.objects.find(x => x.id === id);
    if (!o) return;
    if (o.excludedAtLayer !== this.state.layer) {
      this.pushLog("Cannot re-include " + o.name + " — nozzle has printed layer " + this.state.layer + " over it", "err");
      return;
    }
    this.setState(s => ({ objects: s.objects.map(x => x.id === id ? Object.assign({}, x, { excluded: false, excludedAtLayer: null }) : x) }));
    this.pushLog("EXCLUDE_OBJECT RESET=1 NAME=" + o.name + " — object re-included", "ok");
  }

  cutThenRetract(label, done) {
    const gate = this.state.gate;
    clearTimeout(this._cut);
    this.setState({ phase: "unloading", extruding: false });
    this.pushLog("Retracting filament from nozzle", "warn");
    this.animateTravel(0, () => {
      this.setState({ phase: "presenting" });
      this.pushLog("Presenting tip to cutter at gate " + gate, "warn");
      this.animateTravel(0.13, () => {
        this.setState({ phase: "cutting" });
        this.pushLog("MMU_CUT_FILAMENT — servo cutting tip", "warn");
        this._cut = setTimeout(() => {
          this.pushLog("Tip cut clean · " + label, "ok");
          this.setState({ phase: "storing" });
          this.animateTravel(0, () => { this.setState({ phase: "idle" }); if (done) done(); }, 700);
        }, 800);
      }, 700);
    });
  }

  animateTravel(to, done, duration) {
    cancelAnimationFrame(this._raf);
    const from = this.state.travel, t0 = performance.now(), ms = duration || 2200;
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      this.setState({ travel: from + (to - from) * k });
      if (k < 1) this._raf = requestAnimationFrame(step);
      else if (done) done();
    };
    this._raf = requestAnimationFrame(step);
  }

  now() { const d = new Date(); return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); }

  pushLog(m, kind) {
    this.setState(s => ({ log: [{ t: this.now(), m, kind: kind || "info" }].concat(s.log).slice(0, 40) }));
  }

  blocked() {
    if (this.state.estop) { this.pushLog("Command rejected — printer is shut down (M112). FIRMWARE_RESTART required.", "err"); return true; }
    return false;
  }

  jog(axis, delta) {
    if (this.blocked()) return;
    if (!this.state.homed[axis]) { this.pushLog("Must home axis first (G28)", "warn"); return; }
    const max = this.cfg[axis];
    let clipped = false;
    this.setState(s => {
      let v = +(s.pos[axis] + delta).toFixed(3);
      if (v < 0) { v = 0; clipped = true; }
      if (v > max) { v = max; clipped = true; }
      return { pos: Object.assign({}, s.pos, { [axis]: v }) };
    });
    this.pushLog(clipped
      ? "Move out of range: " + axis + " limit 0–" + max + " mm"
      : "G91 · G1 " + axis + (delta > 0 ? "+" : "") + delta + " F" + this.cfg.velocity * 60 + " · G90",
      clipped ? "warn" : "info");
  }

  home(kind) {
    if (this.blocked()) return;
    if (kind === "HOME") { this.setState({ pos:{X:175,Y:175,Z:10}, homed:{X:true,Y:true,Z:true} }); this.pushLog("G28 — all axes homed", "ok"); }
    else if (kind === "XY") { this.setState(s => ({ pos: Object.assign({}, s.pos, {X:175,Y:175}), homed: Object.assign({}, s.homed, {X:true,Y:true}) })); this.pushLog("G28 X Y", "ok"); }
    else if (kind === "QGL") this.pushLog("QUAD_GANTRY_LEVEL — max deviation 0.008 mm", "ok");
    else if (kind === "MESH") this.pushLog("BED_MESH_CALIBRATE — 25 points probed, range 0.062 mm", "ok");
  }

  nudgeZ(d) {
    if (this.blocked()) return;
    this.setState(s => ({ zOffset: +(s.zOffset + d).toFixed(3) }));
    this.pushLog("SET_GCODE_OFFSET Z_ADJUST=" + (d > 0 ? "+" : "") + d + " MOVE=1");
  }

  saveZ() {
    if (this.blocked()) return;
    this.pushLog("Z_OFFSET_APPLY_PROBE — saved " + this.state.zOffset.toFixed(3) + " mm, SAVE_CONFIG pending", "ok");
  }

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
    const apply = () => { const n = parseFloat(val); clear(); if (!isNaN(n)) commit(n); };
    return {
      value: val, dirty,
      onChange: e => write(e.target.value),
      onBlur: () => apply(),
      onKeyDown: e => {
        if (e.key === "Enter") { e.target.blur(); apply(); }
        else if (e.key === "Escape") { clear(); e.target.blur(); }
      }
    };
  }

  setZ(v) {
    if (this.blocked()) return;
    const n = Math.max(-5, Math.min(5, v));
    this.setState({ zOffset: +n.toFixed(3) });
    this.pushLog("SET_GCODE_OFFSET Z=" + n.toFixed(3) + " MOVE=1", "ok");
  }

  setTarget(name, v) {
    if (this.blocked()) return;
    const max = name === "Extruder" ? this.cfg.maxExtruder : this.cfg.maxBed;
    const n = Math.max(0, Math.min(max, Math.round(v)));
    if (n !== Math.round(v)) this.pushLog(name + " target clamped to 0–" + max + " °C", "warn");
    this.setState(s => ({ targets: Object.assign({}, s.targets, { [name]: n }) }));
    this.pushLog((name === "Extruder" ? "M104 S" : "M140 S") + n);
  }

  setFactor(k, v) {
    if (this.blocked()) return;
    this.setState(s => ({ factors: Object.assign({}, s.factors, { [k]: v }) }));
    this.pushLog((k === "speed" ? "M220 S" : "M221 S") + v);
  }

  setFan(k, v) {
    if (this.blocked()) return;
    this.setState(s => ({ fanVals: Object.assign({}, s.fanVals, { [k]: v }) }));
    this.pushLog(k === "Part Fan"
      ? "M106 S" + Math.round(v * 2.55)
      : "SET_FAN_SPEED FAN=" + k.toLowerCase().replace(/ /g, "_") + " SPEED=" + (v / 100).toFixed(2));
  }

  barPick(cb) {
    return e => {
      const r = e.currentTarget.getBoundingClientRect();
      cb(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100));
    };
  }

  bumpTarget(name, d) {
    if (this.blocked()) return;
    const max = name === "Extruder" ? this.cfg.maxExtruder : this.cfg.maxBed;
    const v = Math.min(max, Math.max(0, (this.state.targets[name] || 0) + d));
    this.setState(s => ({ targets: Object.assign({}, s.targets, { [name]: v }) }));
    this.pushLog((name === "Extruder" ? "M104 S" : "M140 S") + v);
  }

  soakProfiles = [
    { mat:"ABS",  bed:105, exhaust:0 },
    { mat:"ASA",  bed:105, exhaust:0 },
    { mat:"PC",   bed:110, exhaust:0 },
    { mat:"PETG", bed:85,  exhaust:40 },
    { mat:"PLA",  bed:60,  exhaust:100 },
    { mat:"TPU",  bed:50,  exhaust:60 }
  ];

  heatSoak(p) {
    this.setState({ soakMenuOpen: false });
    if (this.blocked()) return;
    this.setState(s => ({
      targets: Object.assign({}, s.targets, { "Heater Bed": p.bed }),
      fanVals: Object.assign({}, s.fanVals, { "Chamber": 40, "Exhaust": p.exhaust })
    }));
    this.pushLog("HEATSOAK MATERIAL=" + p.mat + " — M140 S" + p.bed +
      " · chamber fan 40% · exhaust " + p.exhaust + "%", "ok");
  }

  cooldown() {
    if (this.blocked()) return;
    this.setState({ targets: { "Extruder": 0, "Heater Bed": 0 } });
    this.pushLog("TURN_OFF_HEATERS", "ok");
  }

  selectTool(i) {
    if (this.blocked()) return;
    const gate = i;
    if (!this.gateInfo[gate].fill) { this.pushLog("T" + i + " unavailable — no filament detected in gate " + gate, "warn"); return; }
    if (this.state.gate === gate) { this.pushLog("T" + i + " already loaded from gate " + gate); return; }
    if (this.state.gate === null) {
      this.setState({ selector: gate, gate, extruding: true, travel: 0, phase: "loading" });
      this.pushLog("MMU_CHANGE_TOOL TOOL=" + i + " — loading gate " + gate, "ok");
      this.animateTravel(1, () => { this.setState({ phase: "idle" }); this.pushLog("Tool T" + i + " ready at nozzle", "ok"); });
      return;
    }
    this.pushLog("MMU_CHANGE_TOOL TOOL=" + i + " — unloading gate " + this.state.gate, "warn");
    this.cutThenRetract("filament parked at gate", () => {
      this.setState({ gate, selector: gate, extruding: true, phase: "loading" });
      this.pushLog("Loading gate " + gate + " (" + this.gateInfo[gate].name + ")", "ok");
      this.animateTravel(1, () => {
        this.setState({ phase: "idle" });
        this.pushLog("Tool T" + i + " ready at nozzle", "ok");
      });
    });
  }

  selectGate(g) {
    if (this.blocked()) return;
    if (this.state.selector === g && this.state.gate === g) { this.pushLog("Selector already at gate " + g); return; }
    const move = () => {
      const from = this.state.selector;
      clearTimeout(this._sel);
      this.setState({ selectorMoving: true, servo: "up" });
      this.pushLog("MMU_SERVO POS=up · selector traversing gate " + from + " → " + g);
      this._sel = setTimeout(() => {
        this.setState({ selector: g });
        this._sel = setTimeout(() => {
          this.setState({ selectorMoving: false, servo: "down" });
          this.pushLog("MMU_SELECT GATE=" + g + " — MMU_SERVO POS=down, gate engaged", "ok");
        }, 100 + Math.abs(g - from) * 110);
      }, 180);
    };
    if (this.state.gate !== null && this.state.gate !== g) {
      this.pushLog("Gate " + this.state.gate + " still loaded — unloading before moving selector", "warn");
      this.cutThenRetract("selector free to move", () => { this.setState({ gate: null }); move(); });
      return;
    }
    move();
  }

  checkGate() {
    if (this.blocked()) return;
    if (this.state.gate !== null) { this.pushLog("Unload before checking gates", "warn"); return; }
    const g = this.state.selector;
    this.setState({ phase: "checking", travel: 0 });
    this.pushLog("MMU_CHECK_GATE GATE=" + g + " — advancing filament to sensor", "warn");
    this.animateTravel(0.22, () => {
      const present = !!this.gateInfo[g].fill;
      this.pushLog(present
        ? "Gate " + g + " — filament detected (" + this.gateInfo[g].name + ")"
        : "Gate " + g + " — no filament detected", present ? "ok" : "err");
      this.animateTravel(0, () => {
        this.setState({ phase: "idle" });
        this.pushLog("Filament returned to gate " + g);
      }, 900);
    }, 900);
  }

  loadSelector() {
    if (this.blocked()) return;
    const g = this.state.selector;
    if (!this.gateInfo[g] || !this.gateInfo[g].fill) { this.pushLog("Gate " + g + " is empty — nothing to load", "warn"); return; }
    if (this.state.gate === g && this.state.travel === 1) { this.pushLog("Gate " + g + " already loaded"); return; }
    this.setState({ gate: g, extruding: true, travel: 0, phase: "loading" });
    this.pushLog("MMU_LOAD — feeding gate " + g + " to nozzle", "ok");
    this.animateTravel(1, () => {
      this.setState({ phase: "idle" });
      this.pushLog("Filament reached nozzle — gate " + g, "ok");
    });
  }

  mmuAction(a) {
    if (this.blocked()) return;
    if (a === "UNLOAD" || a === "EJECT") {
      if (this.state.gate === null) { this.pushLog("Nothing loaded", "warn"); return; }
      this.pushLog(a === "EJECT" ? "MMU_EJECT — cut and retract" : "MMU_UNLOAD — cut and retract to gate", "warn");
      this.cutThenRetract(a === "EJECT" ? "ejecting from gate" : "retracting to gate", () => {
        this.setState({ gate: null });
        this.pushLog(a === "EJECT" ? "Filament ejected from gate" : "Filament parked at gate", "ok");
      });
    } else if (a === "LOAD") {
      this.loadSelector();
    } else if (a === "PRELOAD") this.pushLog("MMU_PRELOAD — feed filament into gate to preload");
    else if (a === "CHECK") this.checkGate();
    else if (a === "RECOVER") this.pushLog("MMU_RECOVER — state resynced from encoder", "ok");
  }

  setEndless(gate, next) {
    this.setState(s => {
      const m = s.endless.slice();
      m[gate] = next;
      return { endless: m, mapOpen: null };
    });
    this.pushLog(next === null
      ? "MMU_ENDLESS_SPOOL GATE=" + gate + " GROUP=none — no runout fallback"
      : "MMU_ENDLESS_SPOOL GATE=" + gate + " NEXT=" + next + " (" + this.gateInfo[next].name + ")", "ok");
  }

  print(action) {
    if (this.blocked()) return;
    if (action === "PAUSE") { this.setState({ printState: "paused", extruding: false }); this.pushLog("PAUSE — toolhead parked", "warn"); }
    else if (action === "RESUME") { this.setState({ printState: "printing", extruding: true }); this.pushLog("RESUME", "ok"); }
    else if (action === "CANCEL") { this.setState({ printState: "idle", extruding: false }); this.pushLog("CANCEL_PRINT", "err"); }
    else this.pushLog("Opening job details");
  }

  toggleEstop() {
    const on = !this.state.estop;
    this.setState({ estop: on, printState: "idle", extruding: false });
    this.pushLog(on ? "M112 — EMERGENCY STOP, MCU shut down" : "FIRMWARE_RESTART — Klipper ready", on ? "err" : "ok");
  }

  extrudeMove(dir) {
    if (this.blocked()) return;
    const S = this.state;
    if (S.gate === null) { this.pushLog("No filament loaded — nothing to move", "warn"); return; }
    const len = S.extrudeLen, rate = S.extrudeRate;
    this.pushLog("M83 · G1 E" + (dir > 0 ? "" : "-") + len + " F" + rate * 60);
    // filament runs through the path without changing where it sits in the load sequence
    clearTimeout(this._move);
    this.setState({ phase: dir > 0 ? "extruding" : "retracting" });
    this._move = setTimeout(() => {
      this.setState({ phase: "idle" });
      this.pushLog(dir > 0 ? "Extruded " + len + " mm" : "Retracted " + len + " mm", "ok");
    }, Math.min(6000, len / rate * 1000));
  }

  runMacro(k) {
    if (k === "POWER" || k === "SHUTDOWN" || k === "FW_RESTART") {
      if (k === "FW_RESTART") { this.setState({ estop: false }); this.pushLog("FIRMWARE_RESTART — Klipper ready", "ok"); }
      else this.pushLog(k === "POWER" ? "POWER_OFF_PRINTER" : "SHUTDOWN_MACHINE", "warn");
      return;
    }
    if (this.blocked()) return;
    const map = {
      HOME: () => this.home("HOME"), QGL: () => this.home("QGL"), MESH: () => this.home("MESH"),
      Z_CAL: () => this.pushLog("PROBE_CALIBRATE — z endstop 1.982 mm", "ok"),
      Z_TILT: () => this.pushLog("Z_TILT_ADJUST — max deviation 0.011 mm", "ok"),
      PARK: () => { this.setState({ pos:{X:175,Y:340,Z:60} }); this.pushLog("PARK — toolhead at rear centre", "ok"); },
      CENTER: () => { this.setState({ pos:{X:175,Y:175,Z:50} }); this.pushLog("CENTER"); },
      M84: () => { this.setState({ homed:{X:false,Y:false,Z:false} }); this.pushLog("M84 — steppers disabled, axes unhomed", "warn"); },
      MMU_CHANGE: () => {
        const g = this.state.gate === null ? 2 : this.state.gate;
        for (let n = 1; n <= 8; n++) {
          const c = (g + n) % 8;
          if (this.gateInfo[c].fill) return this.selectTool(c);
        }
        this.pushLog("No other gate has filament", "warn");
      },
      MMU_PURGE: () => this.pushLog("MMU_PURGE — purging 120 mm to waste"),
      MMU_CUT: () => (this.state.gate === null
        ? this.pushLog("Nothing loaded to cut", "warn")
        : this.cutThenRetract("tip cut, filament retained")),
      MMU_UNLOAD: () => this.mmuAction("UNLOAD"), MMU_LOAD: () => this.mmuAction("LOAD"),
      MMU_HOME: () => this.pushLog("MMU_HOME — selector homed, gate 0", "ok"),
      MMU_RESET: () => { this.setState({ gate: null }); this.pushLog("MMU_RESET — state cleared", "warn"); },
      GATE_MAP: () => this.pushLog("MMU_GATE_MAP — 8 gates, 6 available"),
      CHECK_GATE: () => this.checkGate(), MMU_RECOVER: () => this.mmuAction("RECOVER"),
      STATS: () => this.pushLog("MMU_STATS — 28 swaps this print, 1204 lifetime"),
      SETTINGS: () => this.pushLog("Opening MMU settings"),
      PREHEAT: () => { this.setState({ targets: { "Extruder": 250, "Heater Bed": 105 } }); this.pushLog("PREHEAT_ABS — extruder 250, bed 105", "ok"); },
      COOLDOWN: () => this.cooldown(),
      CLEAN_NOZZLE: () => this.pushLog("CLEAN_NOZZLE — 6 wipes on brush"),
      BED_FAN: () => this.setFan("Chamber", this.state.fanVals["Chamber"] > 0 ? 0 : 100),
      NEVERMORE: () => this.setFan("Exhaust", this.state.fanVals["Exhaust"] > 0 ? 0 : 100),
      BEEP: () => this.pushLog("M300 — beep"),
      TEST_SPEED: () => this.pushLog("TEST_SPEED SPEED=" + this.cfg.velocity + " ACCEL=" + this.cfg.accel)
    };
    (map[k] || (() => this.pushLog(k)))();
  }

  sendConsole(e) {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (!v) return;
    e.target.value = "";
    const key = Object.keys(this.macroCatalog).find(k => k === v.toUpperCase());
    if (key) this.runMacro(key);
    else if (this.state.estop && !/FIRMWARE_RESTART/i.test(v)) this.blocked();
    else if (/FIRMWARE_RESTART/i.test(v)) { this.setState({ estop: false }); this.pushLog("FIRMWARE_RESTART — Klipper ready", "ok"); }
    else this.pushLog("› " + v);
  }

  renderVals() {
    const A = this.props.accent ?? "#ff5a33";
    const S = this.state;
    const press = "; transition:transform .07s ease, border-color .12s";
    const nav = [
      ["DASHBOARD","▤"],["WEBCAM","◉"],["CONSOLE","›_"],["SPOOLMAN","◍"],["HEIGHTMAP","▦"],
      ["G-CODE FILES","▤"],["G-CODE VIEWER","3D"],["HISTORY","◷"],["MACHINE","⚙"]
    ];
    const navItems = nav.map(([label, glyph]) => {
      const on = this.state.active === label;
      return {
        label, glyph,
        go: () => this.setState({ active: label }),
        style: "display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:4px; cursor:pointer; font-size:11.5px; letter-spacing:.09em; font-weight:500; transition:background .12s;" +
          (on ? `background:#141b25; color:#e8eef6; box-shadow:inset 2px 0 0 ${A};` : "color:#6b7789;")
      };
    });

    const spoolDefs = [
      { g:"0", name:"—",      mat:"—",   pct:"", color:"#2a3340", op:.5, fill:0 },
      { g:"1", name:"—",      mat:"—",   pct:"", color:"#2a3340", op:.5, fill:0 },
      { g:"2", name:"White",  mat:"ABS", pct:"30%", color:"#f2f2f0", op:1, fill:.30 },
      { g:"3", name:"Grey",   mat:"ABS", pct:"12%", color:"#9aa3ad", op:1, fill:.12, low:true },
      { g:"4", name:"Black",  mat:"ABS", pct:"70%", color:"#3f4650", op:1, fill:.70 },
      { g:"5", name:"Yellow", mat:"PLA", pct:"100%",color:"#f5c518", op:1, fill:1 },
      { g:"6", name:"Natural",mat:"PLA", pct:"100%",color:"#d9c9a3", op:1, fill:1 },
      { g:"7", name:"Blue",   mat:"PETG",pct:"100%",color:"#3f6fd8", op:1, fill:1 },
      { g:"BP",name:"Bypass", mat:"—",   pct:"", color:"#2a3340", op:.5, fill:0 }
    ];
    spoolDefs.forEach((s, i) => { s.active = S.gate === i; s.selected = S.selector === i; });
    const C = 2 * Math.PI * 25;
    const spools = spoolDefs.map((s, i) => ({
      go: () => (i < 8 ? this.selectGate(i) : this.pushLog("MMU_SELECT_BYPASS")),
      color: s.color, op: s.op, pct: s.pct, name: s.name, mat: s.mat, gate: s.g,
      dash: `${(C * s.fill).toFixed(1)} ${C.toFixed(1)}`,
      cardStyle: "background:" + (s.active ? "#150f10" : s.selected ? "#0f151d" : "#0d121a") +
        "; border:1px solid " + (s.active ? A : s.selected ? "#8b98aa" : "#1c2430") +
        "; border-radius:5px; padding:8px 4px 6px; min-width:0; display:flex; flex-direction:column; gap:4px; cursor:pointer; transition:border-color .15s" +
        (s.active ? "; box-shadow:0 0 14px rgba(255,90,51,.18)" : ""),
      pctStyle: "font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; color:" + (s.low ? "#f0b429" : s.pct ? "#e8eef6" : "#3d4859"),
      nameStyle: "font-size:11px; text-align:center; color:" + (s.active ? "#e8eef6" : "#8b98aa") + "; font-weight:" + (s.active ? 600 : 400),
      gateStyle: "margin:2px auto 0; min-width:22px; text-align:center; padding:1px 5px; border-radius:3px; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.06em; " +
        (s.active ? `background:${A}; color:#0a0c10; font-weight:700`
          : s.selected ? "background:#1d2734; color:#e8eef6"
          : s.fill ? "background:#12241f; color:#3ddcc4" : "background:#11161f; color:#3d4859"),
      selMark: s.selected && !s.active ? "SELECTED" : "",
      selMarkStyle: s.selected && !s.active
        ? "font-family:'JetBrains Mono',monospace; font-size:7px; letter-spacing:.1em; color:#8b98aa; text-align:center"
        : "display:none",
      spinStyle: s.active
        ? "position:absolute; inset:-3px; border-radius:50%; border:1px dashed rgba(255,90,51,.4); animation:vSpin 7s linear infinite"
        : "display:none"
    }));

    const pathGate = S.gate !== null ? S.gate : S.selector;
    const loaded = spoolDefs.find(s => s.active) || {};
    const loadedColor = loaded.color || (S.phase === "checking" ? this.gateInfo[pathGate].color : A);
    // filament linear speed from volumetric flow: 6.2 mm³/s over a 1.75 mm filament
    const flow = 6.2, feed = flow / (Math.PI * Math.pow(1.75 / 2, 2));   // ≈ 2.58 mm/s
    const PX_PER_MM = 6, pxPerSec = feed * PX_PER_MM;                    // ≈ 15.5 px/s
    // the gate→nozzle route stands for ~120 mm of filament path
    const ROUTE_MM = 120, routeSec = ROUTE_MM / feed;                    // ≈ 46 s end to end
    // print flow drives the line while printing; otherwise the extruder panel's feedrate does
    const printing = S.printState === "printing" && !S.estop;
    const activeFeed = printing ? feed * S.factors.extrusion / 100 : S.extrudeRate;
    const periodSec = 0.034 * (ROUTE_MM / activeFeed);
    const dashPeriod = periodSec.toFixed(2) + "s";
    // vFlow travels 240 units per cycle over an 18-unit dash pattern
    const dashCycle = (periodSec * 240 / 18).toFixed(2) + "s";
    const VB = 0.73;                                                     // viewBox unit → px in the rail svg
    const travel = S.travel;
    const extruding = S.extruding && S.gate !== null && travel === 1 && S.printState === "printing" && !S.estop;
    const dur = pxRun => (pxRun / pxPerSec).toFixed(2) + "s";
    const pausedSuffix = extruding ? "" : "; animation-play-state:paused";
    const moving = ["loading","unloading","presenting","storing","checking","extruding","retracting"].indexOf(S.phase) >= 0;
    const reversing = ["unloading","storing","retracting"].indexOf(S.phase) >= 0;
    const reverseSuffix = reversing ? "; animation-direction:reverse" : "";
    const flowing = extruding || moving;
    const flowSuffix = (flowing ? "" : "; animation-play-state:paused") + reverseSuffix;
    const gateX = (pathGate + 0.5) / 9 * 900;
    const headPathD = `M ${gateX} 2 L ${gateX} 28 C ${gateX} 58 450 44 450 68 L 450 94`;
    const paths = spoolDefs.slice(0, 8).map((s, i) => {
      const x = ((i + 0.5) / 9) * 900;
      const act = !!s.active;
      return {
        d: `M ${x} 2 L ${x} 28 C ${x} 58 450 44 450 68`,
        stroke: act ? loadedColor : (s.fill ? "#22303e" : "#161d27"),
        w: act ? 3.2 : 1.6,
        op: act ? 1 : (s.fill ? .8 : .4),
        dashArray: act ? "10 8" : "0",
        anim: act ? `animation:vFlow ${dashCycle} linear infinite${flowSuffix}` : ""
      };
    });

    const guard = (k, v, ok) => ({
      k, v,
      dot: `width:5px; height:5px; border-radius:50%; background:${ok ? "#3ddcc4" : "#f0b429"}` + (ok ? "" : "; animation:vPulse 1.2s ease-in-out infinite"),
      valStyle: `font-family:'JetBrains Mono',monospace; font-size:9.5px; font-weight:700; letter-spacing:.06em; color:${ok ? "#3ddcc4" : "#f0b429"}`
    });

    // oldest sample on the left, newest on the right; phase advances once a second
    const wave = (seed, i) => Math.sin((i + S.tphase) / 4 + seed) + Math.sin((i + S.tphase) / 1.7 + seed * 2) / 3;
    const series = (base, amp, color, seed, name, tBase, tAmp) => {
      const pts = [];
      for (let k = 0; k <= 60; k++) pts.push(`${(k * 620 / 60).toFixed(1)},${(base + wave(seed, k) * amp).toFixed(1)}`);
      return { points: pts.join(" "), color, name, seed, tBase, tAmp };
    };
    const tempSeries = [
      series(22, 3, "#ff5a33", 0, "Extruder", 260.3, 1.2),
      series(56, 4, "#3ddcc4", 1.4, "Cartographer", 82.0, 2.4),
      series(84, 5, "#f0b429", 2.6, "Heater Bed", 104.9, 1.1),
      series(108, 3, "#5b7fd8", 3.9, "Chamber", 47.6, 1.8)
    ];

    // each sensor scaled against the recommended maximum for its device
    const mkTemp = (name, state, curN, target, color, max, bump, device, mcu) => {
      const frac = Math.max(0, Math.min(1, curN / max));
      const hot = frac >= 0.9, warm = frac >= 0.75;
      const load = mcu ? mcu[0] : null, mem = mcu ? mcu[1] : null;
      const busy = v => v >= 85 ? "#ff5a33" : v >= 65 ? "#f0b429" : "#6b7789";
      return {
        name, state, target, device,
        cpu: mcu ? load + "%" : "",
        mem: mcu ? mem + "%" : "",
        cpuStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; text-align:right; color:" + (mcu ? busy(load) : "#1c2430"),
        memStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; text-align:right; color:" + (mcu ? busy(mem) : "#1c2430"),
        cur: curN.toFixed(1) + "°C",
        max: max + "°",
        maxStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; text-align:right; color:" +
          (hot ? "#ff5a33" : warm ? "#f0b429" : "#3d4859"),
        dot: `width:6px; height:6px; border-radius:50%; background:${color}; flex:none`,
        editable: !!bump,
        readonly: !bump,
        field: bump || { value: "", onChange: null, onBlur: null, onKeyDown: null },
        inputStyle: "width:100%; min-width:0; background:#0d121a; border:1px solid " +
          (bump && bump.dirty ? color : "#1c2430") +
          "; border-radius:3px; padding:2px 4px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:10.5px; color:#c9d3e0",
        targetStyle: "font-family:'JetBrains Mono',monospace; font-size:10.5px; text-align:right; color:#6b7789",
        rowStyle: "display:grid; grid-template-columns:6px minmax(56px,1fr) 50px 40px 28px 28px 26px 26px; align-items:center; gap:4px; padding:4px 3px; border-radius:3px",
        curStyle: `font-family:'JetBrains Mono',monospace; font-size:12px; text-align:right; color:${frac > .8 ? "#e8eef6" : "#8b98aa"}`,
        barStyle: `width:${Math.round(frac * 100)}%; height:100%; border-radius:2px; background:${hot ? "#ff5a33" : warm ? "#f0b429" : color}`
      };
    };

    const chainNode = n => {
      const segFrom = n.last ? 0.75 : n.at;
      const segTo = n.last ? 1 : 0.75;
      const seg = Math.max(0, Math.min(1, (travel - segFrom) / (segTo - segFrom)));
      const reached = travel >= n.at - 0.001;
      const front = moving && seg > 0 && seg < 1;
      return {
        label: n.label, val: reached ? n.on : n.off, badge: n.badge || "",
        linkWrap: `width:${n.w}px; flex:none; margin:0 6px 24px; position:relative`,
        linkTrack: "height:3px; border-radius:2px; background:#131a24; position:relative",
        linkFill: `width:${(seg * 100).toFixed(1)}%; height:100%; border-radius:2px; background-image:repeating-linear-gradient(90deg,${loadedColor} 0 7px, transparent 7px 13px); background-size:13px 3px; animation:vFlowH ${dashPeriod} linear infinite` +
          ((moving && seg > 0) || (extruding && seg === 1) ? "" : "; animation-play-state:paused") + reverseSuffix,
        linkHead: front
          ? `position:absolute; left:${(seg * 100).toFixed(1)}%; top:50%; width:7px; height:7px; margin:-3.5px 0 0 -3.5px; border-radius:50%; background:${loadedColor}; box-shadow:0 0 7px ${loadedColor}`
          : "display:none",
        badgeStyle: n.badge
          ? "position:absolute; left:50%; top:-16px; transform:translateX(-50%); padding:1px 5px; border-radius:3px; border:1px solid #3a2f14; background:#14100a; font-family:'JetBrains Mono',monospace; font-size:7.5px; letter-spacing:.06em; white-space:nowrap; color:#f0b429"
          : "display:none",
        nodeStyle: `width:9px; height:9px; border-radius:50%; flex:none; background:${reached && moving ? loadedColor : "#0b0f15"}; border:2px solid ${reached ? loadedColor : "#232d3a"}`,
        labStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; white-space:nowrap; color:" + (reached ? "#8b98aa" : "#3d4859"),
        valStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; white-space:nowrap; color:" + (reached ? "#c9d3e0" : "#3d4859")
      };
    };
    const bar = (pct, color) => `width:${pct}%; height:100%; background:${color}; border-radius:2px`;
    const stepStyle = on => "background:" + (on ? "#150f10" : "#0d121a") + "; border:1px solid " + (on ? A : "#1c2430") +
      "; border-radius:3px; padding:5px 0; text-align:center; font-family:'JetBrains Mono',monospace; font-size:9.5px; cursor:pointer; color:" +
      (on ? "#e8eef6" : "#6b7789") + "; transition:transform .07s ease, border-color .12s";
    const tog = on => ({
      track: `width:26px; height:14px; border-radius:8px; background:${on ? "rgba(61,220,196,.25)" : "#161d27"}; border:1px solid ${on ? "#2d6b60" : "#1c2430"}; display:flex; align-items:center; padding:1px; justify-content:${on ? "flex-end" : "flex-start"}`,
      knob: `width:10px; height:10px; border-radius:50%; background:${on ? "#3ddcc4" : "#3d4859"}`
    });

    const jogCell = (t, kind, go) => ({
      t, go,
      style: "background:" + (kind === "axis" ? "#141b25" : "#0d121a") + "; border:1px solid " + (kind === "axis" ? "#2c3746" : "#1c2430") +
        "; border-radius:3px; padding:6px 0; text-align:center; font-family:'JetBrains Mono',monospace; font-size:10px; cursor:pointer; transition:border-color .12s; color:" +
        (kind === "axis" ? A : "#8b98aa")
    });

    return {
      mainStyle: "flex:1; display:flex; flex-direction:column; min-width:" + (S.narrow ? "980px" : "1340px"),
      narrow: !!S.narrow,
      wide: !S.narrow,
      dashGridStyle: "flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:" +
        (S.narrow ? "300px minmax(560px,1fr)" : "300px minmax(560px,1fr) 340px"),
      isDash: this.state.active === "DASHBOARD",
      isStub: this.state.active !== "DASHBOARD",
      activeLabel: this.state.active,
      stubHint: this.state.active + " PANEL",
      navItems,
      jobStats: [
        { k:"SPEED", v: S.printState === "printing" ? Math.round(93 * S.factors.speed / 100) + " mm/s" : "0 mm/s" },
        { k:"FLOW", v: S.printState === "printing" ? (6.2 * S.factors.extrusion / 100).toFixed(1) + " mm³/s" : "0.0 mm³/s" },
        { k:"FILAMENT", v:"56.66 m" },
        { k:"LAYER", v: S.layer + " of 150" },
        { k:"ESTIMATE", v:"1:39:54" },
        { k:"SLICER", v:"0:18:48" },
        { k:"TOTAL", v:"9:37:27" },
        { k:"ETA", v: S.printState === "idle" ? "—" : "01:02 AM" }
      ],
      jobActions: [
        { t: S.printState === "printing" ? "PAUSE" : "RESUME", go: () => this.print(S.printState === "printing" ? "PAUSE" : "RESUME") },
        { t:"CANCEL", go: () => this.print("CANCEL") },
        { t:"OBJECTS", go: () => this.setState({ excludeOpen: true }) }
      ].map(a => Object.assign(a, {
        style: "background:#0d121a; padding:9px 0; text-align:center; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.1em; cursor:pointer; color:" +
          (a.t === "CANCEL" ? "#8b98aa" : "#c9d3e0") + press
      })),
      excludeOpen: S.excludeOpen,
      closeExclude: () => this.setState({ excludeOpen: false, confirmId: null }),
      layerLabel: "LAYER " + S.layer + " / 150",
      excludedCount: S.objects.filter(o => o.excluded).length + " of " + S.objects.length + " excluded",
      objects: S.objects.map(o => {
        const restorable = o.excluded && o.excludedAtLayer === S.layer;
        const pending = S.confirmId === o.id;
        return {
          name: o.name,
          state: o.excluded ? (restorable ? "EXCLUDED · restorable" : "EXCLUDED · locked") : "PRINTING",
          note: o.excluded ? (restorable ? "until layer " + (S.layer + 1) : "nozzle passed") : "",
          noteStyle: "font-family:'JetBrains Mono',monospace; font-size:8px; letter-spacing:.04em; white-space:nowrap; color:" +
            (restorable ? "#6b7789" : "#33404f"),
          go: () => (o.excluded ? this.includeObject(o.id) : this.setState({ confirmId: o.id })),
          shapeStyle: `position:absolute; left:${o.x / 350 * 100}%; top:${o.y / 350 * 100}%; width:${o.w / 350 * 100}%; height:${o.h / 350 * 100}%; ` +
            "border-radius:3px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:.14s; text-align:center; padding:2px; " +
            (pending ? "border:1px solid #f0b429; background:rgba(240,180,41,.14); box-shadow:0 0 0 3px rgba(240,180,41,.15)"
              : o.excluded
                ? "border:1px dashed " + (restorable ? "#5b6a7d" : "#33404f") + "; background:repeating-linear-gradient(135deg, rgba(255,90,51,.08) 0 5px, transparent 5px 10px)"
                : "border:1px solid #2c3746; background:rgba(61,220,196,.09)"),
          labelStyle: "font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.04em; pointer-events:none; color:" +
            (o.excluded ? (restorable ? "#8b98aa" : "#4d5a6b") : "#c9d3e0") + (o.excluded && !restorable ? "; text-decoration:line-through" : ""),
          rowStyle: "display:flex; align-items:center; gap:9px; padding:6px 8px; border-radius:3px; cursor:pointer; border:1px solid " +
            (pending ? "#f0b429" : "transparent"),
          dotStyle: "width:7px; height:7px; border-radius:50%; flex:none; background:" +
            (o.excluded ? (restorable ? "#f0b429" : "#4d5a6b") : "#3ddcc4"),
          nameStyle: "font-size:11.5px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:" +
            (o.excluded ? "#6b7789" : "#c9d3e0") + (o.excluded ? "; text-decoration:line-through" : ""),
          actionStyle: "font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.08em; white-space:nowrap; color:" +
            (o.excluded ? (restorable ? "#3ddcc4" : "#3d4859") : "#6b7789"),
          action: o.excluded ? (restorable ? "RE-INCLUDE" : "LOCKED") : "EXCLUDE"
        };
      }),
      confirmStyle: S.confirmId
        ? "flex:none; padding:14px 16px; border-top:1px solid #3a2f14; background:#14100a; display:flex; align-items:center; gap:14px; animation:vRise .16s ease both"
        : "display:none",
      confirmText: S.confirmId
        ? "Exclude " + (S.objects.find(o => o.id === S.confirmId) || {}).name + "? The nozzle will skip it from layer " + S.layer + " onward."
        : "",
      confirmYes: () => (S.confirmId ? this.excludeObject(S.confirmId) : null),
      confirmNo: () => this.setState({ confirmId: null }),
      statusLabel: S.estop ? "SHUTDOWN" : S.printState.toUpperCase(),
      statusStyle: "font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.12em; color:" +
        (S.estop ? "#ff5a33" : S.printState === "printing" ? "#3ddcc4" : S.printState === "paused" ? "#f0b429" : "#6b7789"),
      statusDotStyle: "width:7px; height:7px; border-radius:50%; background:" +
        (S.estop ? "#ff5a33" : S.printState === "printing" ? "#3ddcc4" : S.printState === "paused" ? "#f0b429" : "#4d5a6b") +
        (S.printState === "printing" || S.estop ? "; animation:vPulse 1.8s ease-in-out infinite" : ""),
      estopClick: () => this.toggleEstop(),
      estopLabel: S.estop ? "RESTART FIRMWARE" : "EMERGENCY STOP",
      estopStyle: "display:flex; align-items:center; gap:7px; padding:6px 12px; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.1em; cursor:pointer; color:#ff5a33; border:1px solid " +
        (S.estop ? "#ff5a33" : "#4a1d13") + "; background:" + (S.estop ? "#3a1109" : "#1a0c08") + (S.estop ? "" : "; animation:vGlow 2.4s ease-in-out infinite"),
      saveConfig: () => this.pushLog("SAVE_CONFIG — restarting Klipper", "warn"),
      axes: ["X","Y","Z"].map(n => ({
        n, v: S.homed[n] ? S.pos[n].toFixed(n === "Z" ? 3 : 2) : "?",
        max: String(this.cfg[n]),
        barStyle: bar(Math.round(S.pos[n] / this.cfg[n] * 100), S.homed[n] ? A : "#3d4859")
      })),
      homeBtns: ["HOME","XY","QGL","MESH"].map(t => ({ t, go: () => this.home(t) })),
      jogRows: [["X",[100,50,1]],["Y",[100,50,1]],["Z",[50,10,1]]].map(row => {
        const ax = row[0], st = row[1];
        return { cells: [
          jogCell("−" + st[0], null, () => this.jog(ax, -st[0])),
          jogCell("−" + st[1], null, () => this.jog(ax, -st[1])),
          jogCell("−" + st[2], null, () => this.jog(ax, -st[2])),
          jogCell(ax, "axis", () => this.home(ax === "Z" ? "HOME" : "XY")),
          jogCell("+" + st[2], null, () => this.jog(ax, st[2])),
          jogCell("+" + st[1], null, () => this.jog(ax, st[1])),
          jogCell("+" + st[0], null, () => this.jog(ax, st[0]))
        ] };
      }),
      zSteps: [-0.025, -0.005, 0.005, 0.025].map(d => ({
        t: (d > 0 ? "+" : "−") + Math.abs(d), go: () => this.nudgeZ(d)
      })),
      zField: this.field("zoff", S.zOffset.toFixed(3), v => this.setZ(v)),
      zFieldStyle: "width:62px; background:#0d121a; border:1px solid " +
        (S.edits.zoff !== undefined ? "#3ddcc4" : "#1c2430") +
        "; border-radius:3px; padding:3px 6px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:12px; color:#3ddcc4",
      saveZ: () => this.saveZ(),
      tools: [0,1,2,3,4,5,6,7].map(i => {
        const empty = !this.gateInfo[i].fill;
        const on = !empty && S.gate === i;
        return {
          n: "T" + i, go: () => this.selectTool(i),
          style: "display:flex; align-items:center; justify-content:center; gap:5px; padding:6px 0; border-radius:4px; background:" +
            (on ? "#150f10" : empty ? "#0a0e13" : "#0d121a") + "; border:1px " + (empty ? "dashed" : "solid") + " " +
            (on ? A : empty ? "#1a222c" : "#1c2430") + "; color:" +
            (on ? "#e8eef6" : empty ? "#33404f" : "#6b7789") +
            (empty ? "; cursor:not-allowed; opacity:.6" : "; cursor:pointer") + press,
          dot: "width:9px; height:9px; border-radius:50%; border:1px solid " + (empty ? "#1f2833" : "#2c3746") + "; background:" +
            (empty ? "#11161f" : this.gateInfo[i].color)
        };
      }),
      lenSteps: [100,50,25,10].map(v => ({
        t: String(v),
        style: stepStyle(S.extrudeLen === v),
        go: () => { this.setState({ extrudeLen: v }); this.pushLog("Extrude length " + v + " mm"); }
      })),
      rateSteps: [20,15,10,5].map(v => ({
        t: String(v),
        style: stepStyle(S.extrudeRate === v),
        go: () => { this.setState({ extrudeRate: v }); this.pushLog("Extrude feedrate " + v + " mm/s"); }
      })),
      factors: [
        { k:"SPEED FACTOR", key:"speed", v: S.factors.speed },
        { k:"EXTRUSION FACTOR", key:"extrusion", v: S.factors.extrusion }
      ].map(f => ({
        k: f.k, v: f.v + " %",
        set: this.barPick(p => this.setFactor(f.key, Math.max(20, p * 2))),
        fill: `width:${Math.min(100, f.v / 2)}%; height:100%; background:${A}; border-radius:2px`,
        knob: `position:absolute; left:${Math.min(100, f.v / 2)}%; top:50%; width:9px; height:9px; margin:-4.5px 0 0 -4.5px; border-radius:50%; background:#e8eef6; border:2px solid ${A}`
      })),
      extruderVals: [
        { k:"PRESSURE ADV", v:"0.02 s" }, { k:"SMOOTH TIME", v:"0.04 s" },
        { k:"LENGTH", v: S.extrudeLen + " mm" }, { k:"FEEDRATE", v: S.extrudeRate + " mm/s" }
      ],
      retract: () => this.extrudeMove(-1),
      extrude: () => this.extrudeMove(1),
      mmuHeaderRef: this.setMmuHeader,
      guardsStyle: "display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px; min-width:0; " +
        (S.guardsInline ? "flex:0 1 auto; margin-left:auto; justify-content:flex-end" : "flex:1 1 100%; justify-content:flex-start"),
      mmuGuards: [
        guard("FLOWRATE", "100%", true),
        guard("CLOG GUARD", "ACTIVE", true),
        guard("MOTOR SYNC", "SYNCED", true)
      ],
      servoLabel: "SERVO " + S.servo.toUpperCase(),
      servoDotStyle: "width:5px; height:5px; border-radius:50%; background:" +
        (S.servo === "down" ? "#3ddcc4" : "#f0b429") +
        (S.selectorMoving ? "; animation:vPulse 1s ease-in-out infinite" : ""),
      servoChipStyle: "display:flex; align-items:center; gap:6px; padding:2px 8px; border-radius:3px; cursor:pointer; white-space:nowrap; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; " +
        (S.servo === "down"
          ? "border:1px solid #1c3d37; background:#0f2320; color:#3ddcc4"
          : "border:1px solid #3a2f14; background:#14100a; color:#f0b429"),
      toggleServoMenu: () => this.setState(s => ({ servoMenuOpen: !s.servoMenuOpen })),
      servoMenuStyle: S.servoMenuOpen
        ? "position:absolute; right:0; top:24px; z-index:40; min-width:126px; padding:4px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 10px 24px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both"
        : "display:none",
      servoOptions: [
        ["down","MMU_SERVO POS=down"],
        ["up","MMU_SERVO POS=up"]
      ].map(row => ({
        t: "Servo " + row[0],
        go: () => {
          this.setState({ servo: row[0], servoMenuOpen: false });
          this.pushLog(row[1] + " — servo " + row[0], "ok");
        },
        style: "padding:5px 8px; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:9.5px; white-space:nowrap; color:" +
          (S.servo === row[0] ? "#e8eef6" : "#6b7789") + "; background:" + (S.servo === row[0] ? "#141b25" : "transparent")
      })),
      railTicks: [0,1,2,3,4,5,6,7,8].map(i => ({
        style: "width:2px; height:8px; border-radius:1px; background:" +
          (i === S.selector ? "#8b98aa" : "#1a222c")
      })),
      carriageStyle: `position:absolute; top:0; left:${((S.selector + 0.5) / 9 * 100).toFixed(2)}%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; transition:left .5s cubic-bezier(.4,0,.2,1)`,
      carriageBodyStyle: `width:26px; height:11px; border-radius:2px; background:#1a222c; border:1px solid ${S.servo === "down" ? loadedColor : "#8b98aa"}; box-shadow:0 2px 6px rgba(0,0,0,.5)`,
      servoArmStyle: `width:3px; border-radius:1px; background:${loadedColor}; transition:height .22s ease, opacity .2s; height:${S.servo === "down" ? 9 : 0}px; opacity:${S.servo === "down" ? 1 : 0}`,
      servoTipStyle: `width:9px; height:3px; border-radius:1px; transition:opacity .2s; opacity:${S.servo === "down" ? 1 : 0}; background:${loadedColor}`,
      carriageLabelStyle: `font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.12em; white-space:nowrap; flex:none; color:${S.selectorMoving ? "#8b98aa" : "#4d5a6b"}`,
      carriageLabel: S.selectorMoving ? "TRAVERSING" : "GATE " + S.selector,
      filamentUse: (() => {
        const used = { 2: 21.4, 3: 6.8, 4: 18.2, 5: 7.1, 7: 3.16 };
        const total = Object.keys(used).reduce((a, k) => a + used[k], 0);
        return Object.keys(used).map(k => {
          const g = +k, m = used[k], pct = m / total * 100;
          return {
            name: this.gateInfo[g].name,
            gate: "G" + g,
            len: m.toFixed(2) + " m",
            pct: Math.round(pct) + "%",
            barStyle: `width:${pct.toFixed(1)}%; height:100%; background:${this.gateInfo[g].color}; ` +
              (S.gate === g ? `box-shadow:0 0 10px ${this.gateInfo[g].color}` : "opacity:.85"),
            swatch: `width:8px; height:8px; border-radius:2px; flex:none; border:1px solid #2c3746; background:${this.gateInfo[g].color}`,
            nameStyle: "font-size:10.5px; white-space:nowrap; color:" + (S.gate === g ? "#e8eef6" : "#8b98aa"),
            lenStyle: "font-family:'JetBrains Mono',monospace; font-size:10px; white-space:nowrap; color:" +
              (S.gate === g ? "#e8eef6" : "#6b7789")
          };
        });
      })(),
      filamentTotal: "56.66 m",
      spools, paths, loadedColor,
      trunkAnim: `animation:vFlow ${dashCycle} linear infinite${flowSuffix}`,
      headPath: headPathD,
      routeDash: travel.toFixed(4) + " 1",
      routeStyle: "transition:none" + (S.gate === null && travel === 0 && S.phase !== "checking" ? "; opacity:0" : ""),
      routeFlowDash: travel > 0 ? "0.012 0.022" : "0 1",
      routeFlowStyle: `opacity:${travel > 0 && flowing ? .55 : 0}; animation:vFlowRoute ${dashPeriod} linear infinite${flowSuffix}`,
      headKp: travel.toFixed(4) + ";" + travel.toFixed(4),
      cutterStyle: S.phase === "cutting" ? "opacity:1" : "display:none",
      cutX1: (gateX - 11).toFixed(1),
      cutX2: (gateX + 11).toFixed(1),
      cutCx: gateX.toFixed(1),
      // a servo-driven blade shears the filament against a fixed anvil
      stubX: (gateX - 2).toFixed(1),
      anvilX: (gateX + 3).toFixed(1),
      anvilEdgeX: (gateX + 3.5).toFixed(1),
      bladeBody: `${gateX - 40},8 ${gateX - 8},8 ${gateX - 1},17 ${gateX - 8},26 ${gateX - 40},26`,
      bladeEdge: `${gateX - 11},9.5 ${gateX - 8},8 ${gateX - 1},17 ${gateX - 8},26 ${gateX - 11},24.5`,
      bladeBackX: (gateX - 44).toFixed(1),
      sparkX1: (gateX + 1).toFixed(1),
      sparkX2: (gateX + 7).toFixed(1),
      sparkX3: (gateX + 3).toFixed(1),
      sparkX4: (gateX + 11).toFixed(1),
      headGlow: `filter:drop-shadow(0 0 7px ${loadedColor}); opacity:${S.gate === null && travel === 0 && S.phase !== "checking" ? 0 : travel < 1 ? 1 : extruding ? .9 : .3}`,
      extrudeLabel: {
        cutting: "CUTTING TIP",
        presenting: "PRESENTING TIP TO CUTTER",
        storing: "STORING TO SPOOL",
        checking: "CHECKING GATE · " + Math.round(travel / 0.22 * 100) + "%",
        extruding: "MANUAL EXTRUDE · " + S.extrudeRate + " mm/s",
        retracting: "MANUAL RETRACT · " + S.extrudeRate + " mm/s"
      }[S.phase]
        || (S.phase === "loading" ? "LOADING · " + Math.round(travel * 100) + "%"
        : S.phase === "unloading" ? "UNLOADING · " + Math.round(travel * 100) + "%"
        : extruding ? "EXTRUDING · " + activeFeed.toFixed(2) + " mm/s" : "IDLE · NOT EXTRUDING"),
      toggleExtruding: () => this.setState(s => ({ extruding: !s.extruding })),
      extrudeChipStyle: "display:flex; align-items:center; gap:6px; padding:4px 9px; border-radius:3px; cursor:pointer; white-space:nowrap; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; " +
        (S.phase !== "idle" ? "border:1px solid #3a2f14; background:#14100a; color:#f0b429"
          : extruding ? "border:1px solid #1c3d37; background:#0f2320; color:#3ddcc4"
          : "border:1px solid #1c2430; background:#0d121a; color:#6b7789"),
      extrudeDotStyle: "width:5px; height:5px; border-radius:50%; background:" +
        (S.phase !== "idle" ? "#f0b429" : extruding ? "#3ddcc4" : "#4d5a6b") +
        (S.phase !== "idle" || extruding ? "; animation:vPulse 1.6s ease-in-out infinite" : ""),
      toolChipStyle: `display:flex; align-items:center; gap:7px; padding:6px 14px; border:1px solid ${A}; border-radius:4px; background:#150f10; box-shadow:0 0 14px rgba(255,90,51,.16); font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.08em; color:#e8eef6`,
      toolChipDot: `width:9px; height:9px; border-radius:2px; background:${loadedColor}; border:1px solid #2c3746`,
      toolChipLabel: S.gate === null
        ? "NO TOOL LOADED"
        : "T" + S.gate + " · " + (S.targets["Extruder"] > 0 ? "260.3°C" : "121.4°C"),
      identName: S.gate === null ? "Unloaded" : this.gateInfo[S.gate].name,
      identNameStyle: "font-size:15px; font-weight:600; color:" + (S.gate === null ? "#4d5a6b" : "#e8eef6"),
      identSwatch: "width:12px; height:12px; border-radius:2px; border:1px solid #2c3746; background:" +
        (S.gate === null ? "#11161f" : this.gateInfo[S.gate].color),
      identMeta: S.gate === null
        ? "no filament at the nozzle · select a gate to load"
        : "@" + S.gate + " · BAMBU LAB · " + this.gateInfo[S.gate].mat + " · " + S.targets["Extruder"] + "°C",
      mmuActions: ["PRELOAD","CUT","EJECT","CHECK","RECOVER","UNLOAD","LOAD"].map((t, i, arr) => ({
        t, go: () => (t === "CUT" ? this.runMacro("MMU_CUT") : this.mmuAction(t)),
        style: "padding:6px 11px; border:1px solid " + (i === arr.length - 1 ? "#4a2318" : "#1c2430") + "; background:" + (i === arr.length - 1 ? "#1a0e09" : "#0d121a") +
          "; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:.1em; color:" + (i === arr.length - 1 ? A : "#8b98aa") + "; cursor:pointer; transition:.12s"
      })),
      preNodes: [chainNode({ at:.30, from:0, label:"ENCODER", on:"833 mm", off:"—", w:62, badge:"buffer · tension", last:false })],
      postNodes: [chainNode({ at:1, from:.75, label:"NOZZLE", on:"0.4 mm", off:"empty", w:56, last:true })],

      tempSeries: tempSeries,
      graphHover: e => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 60);
        if (i !== S.hoverIdx) this.setState({ hoverIdx: i });
      },
      graphLeave: () => this.setState({ hoverIdx: null }),
      gridLines: [ {y:16},{y:48},{y:80},{y:112} ],
      hoverLineStyle: S.hoverIdx === null
        ? "display:none"
        : `position:absolute; top:0; bottom:0; left:${(S.hoverIdx / 60 * 100).toFixed(2)}%; width:1px; background:#8b98aa; opacity:.55; pointer-events:none`,
      tipStyle: S.hoverIdx === null
        ? "display:none"
        : "position:absolute; top:2px; " + (S.hoverIdx > 30 ? "right:" + ((60 - S.hoverIdx) / 60 * 100).toFixed(2) + "%; margin-right:8px" : "left:" + (S.hoverIdx / 60 * 100).toFixed(2) + "%; margin-left:8px") +
          "; z-index:5; pointer-events:none; padding:6px 8px; border:1px solid #2c3746; border-radius:4px; background:#0d121a; box-shadow:0 8px 20px rgba(0,0,0,.6); display:flex; flex-direction:column; gap:3px; animation:vRise .12s ease both",
      tipRows: S.hoverIdx === null ? [] : tempSeries.map(s => ({
        name: s.name,
        val: (s.tBase + wave(s.seed, S.hoverIdx) * s.tAmp).toFixed(1) + " °C",
        dot: `width:6px; height:6px; border-radius:50%; flex:none; background:${s.color}`
      })),
      temps: [
        mkTemp("Extruder","27 %", S.targets["Extruder"] > 0 ? 260.3 : 121.4, S.targets["Extruder"] + " °C","#ff5a33", this.cfg.maxExtruder,
          this.field("t_ext", String(S.targets["Extruder"]), v => this.setTarget("Extruder", v)), "Rapido HF"),
        mkTemp("Heater Bed","29 %", S.targets["Heater Bed"] > 0 ? 104.9 : 58.2, S.targets["Heater Bed"] + " °C","#f0b429", this.cfg.maxBed,
          this.field("t_bed", String(S.targets["Heater Bed"]), v => this.setTarget("Heater Bed", v)), "Keenovo"),
        mkTemp("Cartographer","—", 82.0, "—", "#3ddcc4", 105, null, "Cartographer 3D"),
        mkTemp("Carto Coil","—", 77.0, "—", "#3ddcc4", 100, null, "probe coil"),
        mkTemp("Chamber","—", 47.6, "—", "#5b7fd8", 60, null, "enclosure"),
        mkTemp("EBB","—", 66.9, "—", "#8b98aa", 85, null, "EBB36 toolhead", [12, 31]),
        mkTemp("MMU","—", 40.3, "—", "#8b98aa", 85, null, "MMB v1.1", [9, 24]),
        mkTemp("Octopus","—", 41.1, "—", "#8b98aa", 85, null, "Octopus board", [18, 38]),
        mkTemp("Raspberry","—", 51.3, "—", "#8b98aa", 80, null, "Raspberry Pi 5", [42, 67])
      ],
      tipTime: S.hoverIdx === null ? "" : (S.hoverIdx === 60 ? "now" : "−" + (60 - S.hoverIdx) + " s"),
      clock: S.clock,
      cooldownClick: () => this.cooldown(),
      toggleSoakMenu: () => this.setState(s => ({ soakMenuOpen: !s.soakMenuOpen })),
      soakMenuStyle: S.soakMenuOpen
        ? "position:absolute; right:0; top:24px; z-index:40; min-width:186px; padding:5px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 12px 26px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both"
        : "display:none",
      soakOptions: this.soakProfiles.map(p => ({
        mat: p.mat,
        detail: "bed " + p.bed + "°C · exhaust " + p.exhaust + "%",
        go: () => this.heatSoak(p),
        style: "display:flex; align-items:baseline; gap:8px; padding:5px 8px; border-radius:3px; cursor:pointer; white-space:nowrap; color:#8b98aa"
      })),

      fans: [["Part Fan", A],["Chamber","#5b7fd8"],["Exhaust","#3ddcc4"],["Hotend Fan", A],["Controller","#3ddcc4"]].map(row => ({
        k: row[0], v: S.fanVals[row[0]] + " %", bar: bar(S.fanVals[row[0]], row[1]),
        set: this.barPick(p => this.setFan(row[0], p))
      })),
      leds: (presetStyle => this.ledList().map(l => {
        const open = this.state.ledPicker === l.k;
        return Object.assign({
          k: l.k, hex: l.color.toUpperCase(), pctLabel: l.on ? l.pct + " %" : "off",
          openPicker: () => this.setState({ ledPicker: open ? null : l.k }),
          closePicker: () => this.setState({ ledPicker: null }),
          toggle: () => this.setLed(l.k, { on: !l.on }),
          pickHue: e => {
            const r = e.currentTarget.getBoundingClientRect();
            const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
            let h = Math.atan2(dy, dx) * 180 / Math.PI + 90; if (h < 0) h += 360;
            const sat = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
            this.setLed(l.k, { color: this.hsl2hex(h, sat), on: true });
          },
          swatchStyle: `width:16px; height:16px; border-radius:3px; flex:none; cursor:pointer; transition:border-color .12s; border:1px solid ${open ? "#8b98aa" : "#2c3746"}; background:${l.color}; opacity:${l.on ? 1 : .3}` +
            (l.on ? `; box-shadow:0 0 8px ${l.color}66` : ""),
          sliderSet: this.barPick(p => this.setLed(l.k, { pct: p })),
          onStyle: presetStyle(l.on),
          offStyle: presetStyle(!l.on),
          setOn: () => this.setLed(l.k, { on: true }),
          setOff: () => this.setLed(l.k, { on: false }),
          sliderStyle: "position:relative; width:52px; height:3px; flex:none; border-radius:2px; background:#161d27; cursor:pointer",
          sliderFill: `width:${l.pct}%; height:100%; border-radius:2px; background:${l.on ? l.color : "#2c3746"}`,
          sliderKnob: `position:absolute; left:${l.pct}%; top:50%; width:8px; height:8px; margin:-4px 0 0 -4px; border-radius:50%; background:${l.on ? "#e8eef6" : "#8b98aa"}; border:2px solid ${l.on ? l.color : "#3d4859"}`,
          pctField: this.field("led_" + l.k, String(l.pct), v => this.setLed(l.k, { pct: Math.max(0, Math.min(100, Math.round(v))) })),
          pctSuffixStyle: `font-family:'JetBrains Mono',monospace; font-size:10px; flex:none; color:${l.on ? "#6b7789" : "#3d4859"}`,
          pctInputStyle: "width:26px; flex:none; background:transparent; border:1px solid " +
            (this.state.edits["led_" + l.k] !== undefined ? "#8b98aa" : "transparent") +
            "; border-radius:3px; padding:1px 3px; text-align:right; outline:none; font-family:'JetBrains Mono',monospace; font-size:10px; color:" +
            (l.on ? "#e8eef6" : "#4d5a6b"),
          pickerStyle: open
            ? "display:flex; gap:10px; margin-top:9px; padding:10px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; animation:vRise .18s ease both"
            : "display:none",
          wheelStyle: "position:relative; width:74px; height:74px; flex:none; border-radius:50%; cursor:crosshair; border:1px solid #2c3746; background:conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
          markerStyle: `position:absolute; left:50%; top:50%; width:11px; height:11px; margin:-5.5px 0 0 -5.5px; border-radius:50%; background:${l.color}; border:2px solid #e8eef6; box-shadow:0 0 6px rgba(0,0,0,.6)`,
          hexStyle: `font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:.06em; color:${l.color}`,
          levels: [0, 25, 50, 80, 100].map(v => ({
            t: v, set: () => this.setLed(l.k, { pct: v, on: v > 0 }),
            style: "padding:4px 0; text-align:center; border-radius:3px; cursor:pointer; transition:.12s; font-family:'JetBrains Mono',monospace; font-size:9px; border:1px solid " +
              (l.on && l.pct === v ? "#8b98aa" : "#1c2430") + "; background:#0b0f15; color:" + (l.on && l.pct === v ? "#e8eef6" : "#6b7789")
          }))
        });
      }))(on => "padding:2px 5px; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:8px; letter-spacing:.06em; border:1px solid " +
        (on ? "#2c3746" : "transparent") + "; background:" + (on ? "#141b25" : "transparent") + "; color:" + (on ? "#e8eef6" : "#4d5a6b")),
      logLines: S.log.slice(0, this.state.consoleExpanded ? 40 : 12).map(l => ({
        t: l.t, m: l.m,
        style: "min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:" +
          ({ ok:"#3ddcc4", warn:"#f0b429", err:"#ff5a33" }[l.kind] || "#8b98aa")
      })),
      sendConsole: e => this.sendConsole(e),
      macros: S.macroKeys.map(k => {
        const m = this.macroMeta(k);
        return { g: m.g, t: m.t, run: () => this.runMacro(k) };
      }),
      macroCount: this.state.macroKeys.length + " / " + Object.keys(this.macroCatalog).length,
      macroDotsStyle: `font-family:'JetBrains Mono',monospace; font-size:11px; cursor:pointer; margin-left:10px; color:${this.state.macroPickerOpen ? "#e8eef6" : "#4d5a6b"}`,
      macroPickerStyle: this.state.macroPickerOpen
        ? "padding:10px 12px; border-bottom:1px solid #161d27; background:#0a0e13; animation:vRise .18s ease both"
        : "display:none",
      toggleMacroPicker: () => this.setState(s => ({ macroPickerOpen: !s.macroPickerOpen })),
      macroLibrary: Object.keys(this.macroCatalog).map(k => {
        const on = S.macroKeys.indexOf(k) >= 0;
        const m = this.macroMeta(k);
        const picking = S.iconPickFor === k;
        return {
          g: m.g, cmd: m.cmd, mark: on ? "✓" : "+",
          add: () => this.setState(s => ({
            macroKeys: on ? s.macroKeys.filter(x => x !== k) : s.macroKeys.concat([k])
          })),
          pickIcon: () => this.setState(s => ({ iconPickFor: s.iconPickFor === k ? null : k })),
          iconBtnStyle: "width:22px; height:22px; flex:none; display:flex; align-items:center; justify-content:center; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:13px; color:#ff5a33; border:1px solid " +
            (picking ? "#8b98aa" : "#1c2430") + "; background:#0b0f15",
          cmdStyle: "font-family:'JetBrains Mono',monospace; font-size:8px; letter-spacing:.04em; color:#4d5a6b; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap",
          label: this.field("mn_" + k, m.t, null),
          labelInput: e => this.setMacroMeta(k, { t: e.target.value.toUpperCase().slice(0, 10) }),
          labelValue: m.t,
          labelStyle: "width:74px; flex:none; background:#0b0f15; border:1px solid #1c2430; border-radius:3px; padding:2px 5px; outline:none; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.04em; color:#c9d3e0",
          markStyle: "width:18px; flex:none; text-align:center; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:10px; color:" +
            (on ? "#3ddcc4" : "#4d5a6b"),
          rowStyle: "display:flex; align-items:center; gap:7px; padding:4px 5px; border-radius:3px; background:" + (on ? "#0f151d" : "transparent"),
          paletteStyle: picking
            ? "display:grid; grid-template-columns:repeat(10,1fr); gap:3px; margin:2px 0 6px; padding:6px; border:1px solid #1c2430; border-radius:4px; background:#0b0f15; animation:vRise .14s ease both"
            : "display:none",
          palette: this.iconSet.map(g => ({
            g,
            set: () => { this.setMacroMeta(k, { g }); this.setState({ iconPickFor: null }); },
            style: "aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:12px; border:1px solid " +
              (m.g === g ? "#ff5a33" : "transparent") + "; color:" + (m.g === g ? "#ff5a33" : "#8b98aa")
          }))
        };
      }),
      mmuMenu: [["Recover state","MMU_RECOVER"],["Reset MMU","MMU_RESET"],["Edit gate map","GATE_MAP"],["Calibrate gates","CHECK_GATE"],["Filament stats","STATS"],["MMU settings","SETTINGS"]].map(row => ({
        t: row[0],
        go: () => { this.setState({ mmuMenuOpen: false }); this.runMacro(row[1]); },
        style: "padding:6px 10px; border-radius:3px; cursor:pointer; font-size:11.5px; color:#8b98aa"
      })),
      mmuDotsStyle: `font-family:'JetBrains Mono',monospace; font-size:12px; cursor:pointer; margin-left:auto; color:${this.state.mmuMenuOpen ? "#e8eef6" : "#4d5a6b"}`,
      mmuMenuStyle: this.state.mmuMenuOpen
        ? "position:absolute; right:12px; top:44px; z-index:20; min-width:158px; padding:5px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 10px 26px rgba(0,0,0,.6); display:flex; flex-direction:column; gap:1px; animation:vRise .16s ease both"
        : "display:none",
      toggleMmuMenu: () => this.setState(s => ({ mmuMenuOpen: !s.mmuMenuOpen })),
      toggleConsole: () => this.setState(s => ({ consoleExpanded: !s.consoleExpanded })),
      consoleArrow: this.state.consoleExpanded ? "▼" : "◀",
      consoleArrowStyle: "width:20px; height:20px; margin-left:8px; border:1px solid #1c2430; border-radius:3px; display:flex; align-items:center; justify-content:center; font-family:'JetBrains Mono',monospace; font-size:9px; color:#8b98aa; cursor:pointer; transition:.12s",
      consoleBodyStyle: `display:flex; flex-direction:column; gap:3px; transition:max-height .28s ease; max-height:${this.state.consoleExpanded ? 1100 : 112}px; overflow-y:${this.state.consoleExpanded ? "auto" : "hidden"}`,
      meshName: "default · 9×9",
      meshMin: "−0.041",
      meshMax: "+0.062",
      meshRange: "0.103 mm",
      meshDev: "0.018 mm",
      meshViewBox: "-230 -70 460 320",
      meshQuads: (() => {
        const N = 9, cell = 28, zScale = 420;
        // gentle saddle: low front-left, high back-right, slight dish in the middle
        const zAt = (x, y) => {
          const nx = x / (N - 1) - 0.5, ny = y / (N - 1) - 0.5;
          return 0.028 * (nx + ny) - 0.034 * (nx * nx + ny * ny) + 0.012 * Math.sin(nx * 7) * Math.cos(ny * 5);
        };
        const px = (x, y) => [
          ((x - y) * cell * 0.866).toFixed(1),
          ((x + y) * cell * 0.5 - zAt(x, y) * zScale).toFixed(1)
        ];
        const stops = [[45,95,216],[61,220,196],[240,180,41],[255,90,51]];
        const color = z => {
          const t = Math.max(0, Math.min(1, (z + 0.041) / 0.103));
          const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), k = p - i;
          const c = stops[i].map((v, n) => Math.round(v + (stops[i + 1][n] - v) * k));
          return `rgb(${c[0]},${c[1]},${c[2]})`;
        };
        const quads = [];
        for (let y = 0; y < N - 1; y++) {
          for (let x = 0; x < N - 1; x++) {
            const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
            const zAvg = corners.reduce((a, c) => a + zAt(c[0], c[1]), 0) / 4;
            // fake lambert shading from the slope across the quad
            const slope = (zAt(x + 1, y + 1) - zAt(x, y)) * 6;
            quads.push({
              depth: x + y,
              points: corners.map(c => px(c[0], c[1]).join(",")).join(" "),
              fill: color(zAvg),
              op: (0.86 + Math.max(-0.2, Math.min(0.2, slope))).toFixed(2),
              title: zAvg.toFixed(3) + " mm"
            });
          }
        }
        return quads.sort((a, b) => a.depth - b.depth);
      })(),
      limits: [
        { k:"Velocity", v: String(this.cfg.velocity), u:"mm/s" },
        { k:"Acceleration", v: String(this.cfg.accel), u:"mm/s²" },
        { k:"Square Corner Vel", v: String(this.cfg.scv), u:"mm/s" },
        { k:"Min Cruise Ratio", v: String(this.cfg.cruise), u:"%" },
        { k:"Z Offset", v: S.zOffset.toFixed(3), u:"mm" }
      ],
      toolMap: [0,1,2,3,4,5,6,7,null].map(i => {
        const bypass = i === null;
        const next = bypass ? null : S.endless[i];
        const linked = !bypass && next !== null;
        const open = !bypass && S.mapOpen === i;
        return {
          tool: bypass ? "BP" : "G" + i,
          gate: bypass ? "—" : (next === null ? "off" : "G" + next),
          cycle: () => (bypass ? this.pushLog("Bypass has no endless-spool group") : this.setState(s => ({ mapOpen: s.mapOpen === i ? null : i }))),
          menuStyle: open
            ? "position:absolute; left:0; top:26px; z-index:30; min-width:132px; padding:4px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 10px 24px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both"
            : "display:none",
          options: bypass ? [] : [null,0,1,2,3,4,5,6,7].filter(v => v !== i).map(v => ({
            t: v === null ? "no fallback" : "→ Gate " + v + " · " + this.gateInfo[v].name,
            pick: () => this.setEndless(i, v),
            style: "display:flex; align-items:center; gap:7px; padding:5px 7px; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:9.5px; white-space:nowrap; color:" +
              (next === v ? "#e8eef6" : "#6b7789") + "; background:" + (next === v ? "#141b25" : "transparent"),
            dot: "width:8px; height:8px; border-radius:50%; flex:none; border:1px solid #2c3746; background:" +
              (v === null ? "#11161f" : this.gateInfo[v].color)
          })),
          wrapStyle: "position:relative" + (open ? "; z-index:30" : ""),
          style: "display:flex; align-items:center; gap:4px; padding:4px 6px; border-radius:3px; cursor:pointer; transition:border-color .12s; background:" +
            (linked ? "#0f1a1d" : "#0d121a") + "; border:1px solid " + (open ? "#8b98aa" : linked ? "#1c3d37" : "#1c2430"),
          toolStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.04em; color:" + (bypass ? "#3d4859" : "#8b98aa"),
          gateStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; color:" + (linked ? "#3ddcc4" : "#4d5a6b")
        };
      })
    };
  }
}
