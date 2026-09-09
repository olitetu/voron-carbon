// MMU · HAPPY HARE panel adapter — every template key of the MMU section, from live store state.
// Style strings are copied VERBATIM from the design's renderVals() (src/pages/dashboard/logic.jsx); only the data
// sources changed:
//   raw.mmu (Happy Hare v3.4)  gate/tool/filament/filament_pos/action/servo/gate_* maps/endless_spool_groups/encoder/…
//   st.spools (Spoolman)       names, vendors, remaining weight (via ctx.common.gateInfo / spoolDefs)
//   raw.print_stats            filament_used (per-gate breakdown integrated while the page is open, localStorage carbon.fuse.<file>)
//   raw.motion_report          real extruder feed (via ctx.common.activeFeed)
//   raw.extruder               nozzle temperature for the tool chip
//   ctx.ui                     mmuMenuOpen · servoMenuOpen · extruding · mapOpen · extrudeRate · guardsInline (UI-only state)
// Animation strings (vFlow, vFlowRoute, vFlowH, vBlade, vPulse, vSpin) are exactly the design's.
// mmuHeaderRef stays ctx.ui-driven: the host passes logic.setMmuHeader as ctx.setMmuHeader (ResizeObserver → ui.guardsInline).
// Never throws: every input may be missing before the first status update — values fall back to "—" / design defaults.
import { commonVals } from "./common.js";
import { getFileMeta } from "./job.js";

const NUM_GATES = 8;
const BYPASS = 8;                 // card index of the Bypass column (Happy Hare reports gate/tool -2 for bypass)
const UNKNOWN_COLOR = "#3d4859";  // swatch for filament we could not attribute to a gate
const noopRef = () => {};

/** Finite number or null (Moonraker fields can be null/undefined before the first status update). */
function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }
function str(v) { return v === null || v === undefined ? "" : String(v); }

// ---------------------------------------------------------------------------------------------------------------
// Nozzle diameter — Klipper's [extruder] nozzle_diameter is only in configfile.settings, which boot does not
// subscribe to. One read-only printer.objects.query per page load (retried at most once a minute) fills the cache.
const _cfg = { nozzle: null, pending: false, at: 0 };
function nozzleDiameter(st, raw, api) {
  const fromRaw = raw && raw.configfile && raw.configfile.settings && raw.configfile.settings.extruder;
  if (fromRaw && num(fromRaw.nozzle_diameter) !== null) return fromRaw.nozzle_diameter;
  // boot.js ALREADY downloads configfile.settings once per page load and parks it on st.config, so read
  // it from there before paying for a second ~200 KB query — Orca reloads this page on nearly every
  // preset change, and that made the duplicate fetch a per-reload cost rather than a one-off.
  const fromStore = st && st.config && st.config.extruder;
  if (fromStore && num(fromStore.nozzle_diameter) !== null) return fromStore.nozzle_diameter;
  if (_cfg.nozzle !== null) return _cfg.nozzle;
  if (_cfg.pending || !api || typeof api.query !== "function" || api.connected === false) return null;
  if (Date.now() - _cfg.at < 60000) return null;
  _cfg.pending = true; _cfg.at = Date.now();
  Promise.resolve()
    .then(() => api.query({ configfile: ["settings"] }))
    .then(r => {
      const e = r && r.status && r.status.configfile && r.status.configfile.settings && r.status.configfile.settings.extruder;
      const nd = e ? num(e.nozzle_diameter) : null;
      if (nd !== null) _cfg.nozzle = nd;
    })
    .catch(() => {})
    .then(() => { _cfg.pending = false; });
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Filament use per gate for the current job. print_stats.filament_used is a single running total (mm); we integrate
// its deltas and attribute each one to the gate loaded at that moment, persisting per filename in localStorage
// (carbon.fuse.<filename>) so a reload keeps the breakdown. If the job started before the page was opened the
// breakdown is only partial and is labelled honestly ("per-gate since page open").
const FUSE_PREFIX = "carbon.fuse.";
const _fuse = { file: null, last: null, used: {}, partial: false, lastGate: null, savedAt: 0, dirty: false };
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage may be unavailable */ } }

export function trackFilamentUse(ps, gate) {
  const file = str(ps && ps.filename);
  const total = num(ps && ps.filament_used);
  if (total === null) return _fuse;
  if (file !== _fuse.file) {
    const saved = file ? lsGet(FUSE_PREFIX + file) : null;
    _fuse.file = file;
    if (saved && typeof saved === "object" && saved.used && typeof saved.used === "object" && typeof saved.last === "number" && saved.last <= total + 1) {
      _fuse.used = Object.assign({}, saved.used); _fuse.last = saved.last; _fuse.partial = !!saved.partial;
      _fuse.lastGate = typeof saved.lastGate === "number" ? saved.lastGate : null;
    } else {
      _fuse.used = {}; _fuse.last = total; _fuse.partial = total > 1; _fuse.lastGate = null;
    }
    _fuse.dirty = true;
  }
  if (total < _fuse.last - 1) {            // filament_used went backwards → a new job with the same filename
    _fuse.used = {}; _fuse.last = total; _fuse.partial = total > 1; _fuse.dirty = true;
  }
  const d = total - _fuse.last;
  if (d > 0) {
    const g = gate !== null && gate !== undefined ? gate : _fuse.lastGate;
    const key = g === null || g === undefined ? "-1" : String(g);
    _fuse.used[key] = (_fuse.used[key] || 0) + d;
    _fuse.last = total; _fuse.dirty = true;
  }
  if (gate !== null && gate !== undefined) _fuse.lastGate = gate;
  const now = Date.now();
  if (_fuse.dirty && file && now - _fuse.savedAt > 5000) {
    lsSet(FUSE_PREFIX + file, { used: _fuse.used, last: _fuse.last, partial: _fuse.partial, lastGate: _fuse.lastGate, ts: now });
    _fuse.savedAt = now; _fuse.dirty = false;
  }
  return _fuse;
}

// ---------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------
// Signed encoder movement.
//
// Happy Hare's encoder is a single pulse counter, so `encoder_pos` is an unsigned ODOMETER: it only ever
// grows, whichever way the filament went. A raw readout of it therefore can never show direction, which
// is exactly why it read as inconsistent — it was 1879.8 mm of lifetime travel, not a movement.
//
// Direction comes from HH itself (`mmu.filament_direction`, +1 load / -1 unload), so we accumulate the
// odometer's deltas WITH that sign for the current motion episode. Between episodes the last total is
// held rather than zeroed: "the last thing that happened was -1059 mm" is the useful readout when idle.
const ENC_IDLE_MS = 2500;        // no encoder change for this long ends the episode
const ENC_MIN_STEP = 0.05;       // below the encoder's own resolution (0.956 mm/pulse) — noise
const _enc = { last: null, signed: 0, quietAt: 0, dir: 0 };

export function trackEncoder(pos, direction, now) {
  if (pos === null) return null;
  const dir = direction === -1 ? -1 : 1;
  if (_enc.last === null) { _enc.last = pos; _enc.quietAt = now; _enc.dir = dir; return _enc.signed; }
  const d = pos - _enc.last;
  // A restart (or MMU_RESET) rewinds the odometer; start over rather than reporting a huge negative jump.
  if (d < -1) { _enc.last = pos; _enc.signed = 0; _enc.quietAt = now; _enc.dir = dir; return 0; }
  if (d > ENC_MIN_STEP) {
    // A leg ends when motion stops OR when the direction flips. Without the direction reset the total
    // merely counts DOWN through positive numbers during an unload — so a rewind never reads negative,
    // which is the whole point of the readout. Each leg therefore starts from zero with its own sign.
    if (now - _enc.quietAt > ENC_IDLE_MS || dir !== _enc.dir) _enc.signed = 0;
    _enc.signed += d * dir;
    _enc.last = pos;
    _enc.quietAt = now;
    _enc.dir = dir;
  }
  return _enc.signed;
}

export function mmuVals(ctx) {
  const c = ctx || {};
  const st = c.st || (c.store && c.store.state) || {};
  const ui = c.ui || {};
  const act = c.act || {};
  const api = c.api || null;
  const set = typeof c.set === "function" ? c.set : () => {};
  const log = typeof c.log === "function" ? c.log : () => {};
  const common = c.common || commonVals(Object.assign({}, c, { st }));
  const raw = st.raw || {};
  const mmu = raw.mmu || {};
  const ps = raw.print_stats || {};
  const arr = k => (Array.isArray(mmu[k]) ? mmu[k] : []);
  const call = (name, ...args) => {
    if (act && typeof act[name] === "function") return act[name](...args);
    log(name + " — MMU actions not wired", "warn");
    return undefined;
  };

  // ---- shared derived values (adapters/common.js)
  const {
    A, spoolDefs, gateInfo, loadedColor, pathGate, gate, selector, servo, phase, travel,
    moving, extruding, printing, activeFeed, dashPeriod, dashCycle, flowSuffix, reverseSuffix,
  } = common;
  const selectorMoving = !!common.selectorMoving;
  const tool = typeof common.tool === "number" ? common.tool : (typeof mmu.tool === "number" ? mmu.tool : -1);
  const extrudeRate = num(common.extrudeRate) !== null ? common.extrudeRate : (num(ui.extrudeRate) !== null ? ui.extrudeRate : 10);
  const extruderTemp = num(common.extruderTemp) !== null ? common.extruderTemp : num((raw.extruder || {}).temperature);
  const gi = i => (Array.isArray(gateInfo) && gateInfo[i]) || { name: "—", mat: "—", color: "#2a3340", fill: 0, empty: true, vendor: "", temp: null };
  const loadedInfo = gate !== null ? gi(gate) : null;
  const active = mmu.active_filament && typeof mmu.active_filament === "object" ? mmu.active_filament : null;

  // ---- gate → nozzle route geometry (design: 9 columns over a 900-unit viewBox)
  const gateX = ((pathGate === null || pathGate === undefined ? 0 : pathGate) + 0.5) / 9 * 900;
  const headPathD = `M ${gateX} 2 L ${gateX} 28 C ${gateX} 58 450 44 450 68 L 450 94`;
  const paths = spoolDefs.slice(0, NUM_GATES).map((s, i) => {
    const x = ((i + 0.5) / 9) * 900;
    const act_ = !!s.active;
    return {
      d: `M ${x} 2 L ${x} 28 C ${x} 58 450 44 450 68`,
      stroke: act_ ? loadedColor : (s.fill ? "#22303e" : "#161d27"),
      w: act_ ? 3.2 : 1.6,
      op: act_ ? 1 : (s.fill ? .8 : .4),
      dashArray: act_ ? "10 8" : "0",
      anim: act_ ? `animation:vFlow ${dashCycle} linear infinite${flowSuffix}` : ""
    };
  });

  // ---- spool cards (8 gates + Bypass)
  const C = 2 * Math.PI * 25;
  const spools = spoolDefs.map((s, i) => ({
    go: () => (i < NUM_GATES ? call("selectGate", i) : call("selectBypass")),
    // "Change filament" — opens the shared gate editor (lib/GateEditor.jsx). The whole card is one big
    // onClick that SELECTS the gate, so this must swallow the event or clicking edit would also move the
    // selector. Bypass has no gate map entry, hence no button.
    edit: i < NUM_GATES ? (e => { if (e && e.stopPropagation) e.stopPropagation(); set({ gateEditor: i }); }) : null,
    editTitle: i < NUM_GATES ? "Change the filament in gate " + i : "",
    // Contrast, not decoration: this shipped at 9px in #4d5a6b, which is 2.67:1 on the card ground and
    // effectively invisible — the same ratio the owner had already rejected for the temperature labels.
    // An interactive control needs MORE contrast than body text, so it sits at T.dim (#8b98aa, 6.4:1)
    // with a real border and a slightly larger glyph. The card is only ~65px wide at narrow widths, so
    // a corner control is the only affordance that fits; it has to be legible rather than subtle.
    // Kept in the top-right corner (owner's choice) but made unmissable: 20px chip, near-white glyph on
    // a raised ground with a light border. #e8eef6 on #1d2734 is ~11:1 — it now reads as a button rather
    // than a smudge. Two earlier passes failed by being subtle (2.67:1, then 5.9:1 but still 11px/grey).
    editStyle: i < NUM_GATES
      ? "position:absolute; top:2px; right:2px; width:20px; height:20px; display:flex; align-items:center; justify-content:center; border-radius:4px; border:1px solid #4a5666; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:12px; line-height:1; color:#e8eef6; background:#1d2734; box-shadow:0 1px 3px rgba(0,0,0,.5)"
      : "display:none",
    color: s.color, op: s.op, pct: s.pct, name: s.name, gate: s.g,
    // Material AND spool id on one line ("ABS · #43"). The id is the thing you cross-reference against
    // Spoolman, so it cannot live at 8px/#4d5a6b (2.67:1) like the bare material did — it reads at
    // T.mute now, and the id is dropped rather than shown as "#-1" when the gate has no spool.
    mat: (function () {
      const id = num((mmu.gate_spool_id || [])[i]);
      const m = s.mat ? String(s.mat) : "";
      return id !== null && id > 0 ? (m ? m + " · #" + id : "#" + id) : m;
    })(),
    matStyle: "font-family:'JetBrains Mono',monospace; font-size:8.5px; color:#6b7789; text-align:center; letter-spacing:.05em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis",
    dash: `${(C * s.fill).toFixed(1)} ${C.toFixed(1)}`,
    cardStyle: "background:" + (s.active ? "#150f10" : s.selected ? "#0f151d" : "#0d121a") +
      "; border:1px solid " + (s.active ? A : s.selected ? "#8b98aa" : "#1c2430") +
      "; border-radius:5px; padding:8px 4px 6px; min-width:0; display:flex; flex-direction:column; gap:4px; cursor:pointer; transition:border-color .15s; position:relative" +
      (s.active ? "; box-shadow:0 0 14px rgba(255,90,51,.18)" : ""),
    pctStyle: "font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; color:" + (s.low ? "#f0b429" : s.pct ? "#e8eef6" : "#3d4859"),
    // Single line with an ellipsis: below ~1500 px the spool card is ~54 px wide, and a two-word filament
    // name ("Tangerine Yellow" measures 80 px at 11 px) wrapped to a second line and pushed the card out of
    // alignment with its neighbours. Ellipsis is the design's existing answer to this (see Table in
    // design.jsx); the full name stays reachable via the card's title.
    nameStyle: "font-size:11px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; color:" + (s.active ? "#e8eef6" : "#8b98aa") + "; font-weight:" + (s.active ? 600 : 400),
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

  // ---- guards (header chips)
  // Three states, not two: `unknown` (nothing is measuring this) must read as neutral grey. A guard with
  // no data used to fall through to the not-ok branch and sat there pulsing amber, which says "something
  // is wrong" about a reading that simply does not exist.
  const guard = (k, v, ok, unknown) => ({
    k, v,
    dot: `width:5px; height:5px; border-radius:50%; background:${unknown ? "#4d5a6b" : ok ? "#3ddcc4" : "#f0b429"}` +
      (unknown || ok ? "" : "; animation:vPulse 1.2s ease-in-out infinite"),
    valStyle: `font-family:'JetBrains Mono',monospace; font-size:9.5px; font-weight:700; letter-spacing:.06em; color:${unknown ? "#6b7789" : ok ? "#3ddcc4" : "#f0b429"}`
  });
  // Happy Hare publishes the encoder as its own Klipper object, NOT nested under mmu.
  // ---- live gate-cutter state (from the EREC macro's own console output)
  const cut = st.cutter || null;
  // `parking` latches (boot.js) when filament_pos leaves 0 after the final cut — i.e. the macro has
  // finished cutting and is backing the filament out. Blade stops and stows for that leg.
  const cutting = !!cut && !cut.parking;
  const shearing = cutting && cut.state === "closed";
  const geoCfg = (ctx.common && ctx.common.geo) || {};
  // The design's keyframes are a LOOPING demo cycle (vBlade sweeps in at 42 % and back out at 78 %).
  // The real hardware is a servo that closes ONCE and holds: _EREC_VARS servo_open_angle 180 ->
  // servo_closed_angle 15, held for servo_duration, driven by the macro's open/closed events. So the
  // blade is transition-driven (sweep in, hold, sweep out) and the one-shot flourishes (spark, the
  // cut-off stub falling away) fire once per close rather than looping.
  const SWEEP = "cubic-bezier(.2,0,.1,1)";
  // The cut happens BY closing: the blade passes straight THROUGH the filament and comes to rest
  // against the anvil — it never stops short and presses on it. The filament occupies
  // gateX-2..gateX+2 and the anvil starts at gateX+3, while the blade tip sits at gateX-1 when
  // untranslated, so the closed pose carries it +4px: past the filament, onto the anvil.
  const bladePose = shearing
    ? `transform:translateX(4px); transition:transform .16s ${SWEEP}`        // closed: through, on the anvil
    : `transform:translateX(-30px); transition:transform .26s ${SWEEP}`;     // open: parked clear
  const shearPose = shearing
    ? "transform:translateX(3px); transition:transform .12s ease-out"        // upper length kicks aside
    : "transform:translateX(0); transition:transform .3s ease";
  const stubPose = shearing
    ? "animation:vStub .9s cubic-bezier(.3,0,.2,1) 1 both"                   // cut piece drops away, once
    : "transform:none; opacity:1";
  const flashPose = shearing
    ? "animation:vFlash .45s linear 1 both"                                  // spark, once
    : "opacity:0";

  const enc = (st.raw && st.raw["mmu_encoder mmu_encoder"]) ||
    (mmu.encoder && typeof mmu.encoder === "object" ? mmu.encoder : {});
  const clog = num(mmu.clog_detection);
  const fg = mmu.flowguard && typeof mmu.flowguard === "object" ? mmu.flowguard : {};
  const fgTrigger = str(fg.trigger).trim();
  const syncDrive = !!mmu.sync_drive;
  const sfs = str(mmu.sync_feedback_state).trim().toLowerCase();
  const sfsActive = sfs && sfs !== "inactive" && sfs !== "disabled" && sfs !== "unknown";
  // FLOWRATE: HH v2 exposed mmu.flowrate; v3.4 moves the encoder flow rate to mmu.encoder.flow_rate (meaningful while
  // the encoder's clog detection is enabled, i.e. during a print) and adds sync_feedback_flow_rate (100 % = neutral).
  // Every source is gated on being LIVE. sync_feedback_flow_rate in particular sits at its neutral 100 while the
  // feedback sensor is `inactive`, so reading it unconditionally painted a confident teal "FLOWRATE 100%" on an idle
  // printer with the encoder disabled — a measurement of nothing. No live source now reads "—" in neutral grey.
  let flowrate = num(mmu.flowrate);
  if (flowrate === null && enc.enabled && num(enc.flow_rate) !== null) flowrate = enc.flow_rate;
  if (flowrate === null && sfsActive) flowrate = num(mmu.sync_feedback_flow_rate);
  const mmuGuards = [
    guard("FLOWRATE", flowrate === null ? "—" : Math.round(flowrate) + "%", flowrate !== null && flowrate >= 85, flowrate === null),
    guard("CLOG GUARD", fgTrigger ? fgTrigger.toUpperCase() : (clog !== null && clog > 0 ? "ACTIVE" : "OFF"), !fgTrigger && clog !== null && clog > 0),
    guard("MOTOR SYNC", syncDrive ? "SYNCED" : "OFF", syncDrive || !printing)
  ];
  if (sfsActive) mmuGuards.push(guard("SYNC FEEDBACK", sfs.toUpperCase(), !/clog|tangle|error|runout/.test(sfs)));

  // ---- filament used this print, per gate
  //
  // Live integration (trackFilamentUse) only attributes filament to gates it has actually WATCHED change,
  // so opening the dashboard mid-print dumped the whole job onto whichever gate happened to be loaded.
  // The slicer already knows the real answer and Moonraker exposes it: `filament_weights` is grams per TOOL
  // and `referenced_tools` says which are used (this job: T2 33.42 g, T3 44.87 g, T4 96.65 g, T7 3.25 g).
  // So the plan is the source of truth whenever live tracking is partial, mapped tool -> gate through
  // Happy Hare's ttg_map. Live tracking still wins when it covers the whole print, because then it is
  // measured rather than predicted.
  const fuse = trackFilamentUse(ps, gate);
  const meta = getFileMeta(ctx.api, str(ps.filename)) || {};
  const planW = Array.isArray(meta.filament_weights) ? meta.filament_weights : null;
  const ttg = Array.isArray(mmu.ttg_map) ? mmu.ttg_map : null;
  const planTotalG = planW ? planW.reduce((a, w) => a + (num(w) || 0), 0) : 0;
  const usePlan = !!planW && planTotalG > 0 && fuse.partial;

  // Both units, always. The two sources give different quantities — the slicer plan is GRAMS per tool,
  // live integration is MILLIMETRES of filament_used — so whichever we have is converted to the other
  // through the gate's own Spoolman record:
  //     grams = mm * pi*(d/2)^2 / 1000 * density        (mm^3 -> cm^3 -> g)
  // Diameter and density come from the spool assigned to that gate, so a 1.75 mm ABS at 1.04 g/cm^3 and
  // a 2.85 mm PLA are each converted with their own numbers. Falls back to 1.75 / 1.24 when Spoolman has
  // no record for the gate, and `estimated` marks the whole row so a guess never reads as a measurement.
  const DEF_DIA = 1.75, DEF_DENSITY = 1.24;
  const gramsPerMm = g => {
    const id = num((mmu.gate_spool_id || [])[g]);
    const f = (id !== null && id > 0 && (st.spools || {})[id] && (st.spools || {})[id].filament) || null;
    const dia = num(f && f.diameter) || DEF_DIA;
    const den = num(f && f.density) || DEF_DENSITY;
    return Math.PI * (dia / 2) * (dia / 2) / 1000 * den;   // g per mm of filament
  };
  let usedKeys, gramsOf, mmOf, estimated;
  if (usePlan) {
    // tool index -> gate (identity unless the TTG map has been remapped)
    const byGate = {};
    planW.forEach((w, tool) => {
      const grams = num(w) || 0;
      if (grams <= 0) return;
      const g = ttg && Number.isInteger(ttg[tool]) ? ttg[tool] : tool;
      byGate[String(g)] = (byGate[String(g)] || 0) + grams;
    });
    usedKeys = Object.keys(byGate);
    gramsOf = k => byGate[k];
    mmOf = k => byGate[k] / (gramsPerMm(+k) || 1);
    estimated = true;
  } else {
    usedKeys = Object.keys(fuse.used).filter(k => (fuse.used[k] || 0) > 0);
    gramsOf = k => fuse.used[k] * gramsPerMm(+k);
    mmOf = k => fuse.used[k];
    estimated = false;
  }
  // RANKED BY GRAMS, heaviest first — the ordering the owner asked for. It was gate index, which buried
  // the filament that actually dominated the job (Black 112.4 g sat third behind White 36.6 g).
  usedKeys = usedKeys.sort((a, b) => gramsOf(b) - gramsOf(a) || (+a) - (+b));
  const weightOf = gramsOf;
  const unitOf = (v, k) => gramsOf(k).toFixed(1) + " g · " + (mmOf(k) / 1000).toFixed(2) + " m";
  const usedTotal = usedKeys.reduce((a, k) => a + weightOf(k), 0);
  const filamentUse = usedKeys.map(k => {
    const g = +k, pct = usedTotal > 0 ? weightOf(k) / usedTotal * 100 : 0;
    const known = g >= 0 && g <= BYPASS;
    const info = known ? gi(g) : { name: "Unknown gate", color: UNKNOWN_COLOR };
    const color = info.color || UNKNOWN_COLOR;
    const on = gate !== null && gate === g;
    return {
      name: info.name || "—",
      gate: g === BYPASS ? "BP" : known ? "G" + g : "G?",
      len: unitOf(weightOf(k), k),
      pct: Math.round(pct) + "%",
      barStyle: `width:${pct.toFixed(1)}%; height:100%; background:${color}; ` +
        (on ? `box-shadow:0 0 10px ${color}` : "opacity:.85"),
      swatch: `width:8px; height:8px; border-radius:2px; flex:none; border:1px solid #2c3746; background:${color}`,
      nameStyle: "font-size:10.5px; white-space:nowrap; color:" + (on ? "#e8eef6" : "#8b98aa"),
      lenStyle: "font-family:'JetBrains Mono',monospace; font-size:10px; white-space:nowrap; color:" +
        (on ? "#e8eef6" : "#6b7789")
    };
  });
  // ---- per-card print progress ---------------------------------------------------------------------
  // Each spool card gets its own thin bar: how far through THIS filament's share of the current job we
  // are. Distinct from the ring above it, which is the spool's remaining stock — one is "how much of
  // this print is done in this colour", the other is "how much of this reel is left".
  //
  //   denominator: the slicer's plan for that gate  (metadata.filament_weights, grams per TOOL, mapped
  //                tool -> gate through Happy Hare's ttg_map)
  //   numerator:   what live integration has actually attributed to that gate, converted mm -> g with
  //                that gate's own density and diameter (gramsPerMm, same converter as the breakdown)
  //
  // The numerator can only ever be what this page watched, so on a job that was already running it
  // reads low. `partial` says so, and the tooltip states it rather than letting a short bar imply the
  // filament is barely used.
  const plannedByGate = {};
  if (planW) {
    planW.forEach((w, tool) => {
      const g2 = num(w) || 0;
      if (g2 <= 0) return;
      const gg = ttg && Number.isInteger(ttg[tool]) ? ttg[tool] : tool;
      plannedByGate[String(gg)] = (plannedByGate[String(gg)] || 0) + g2;
    });
  }
  spools.forEach((sp, i) => {
    if (i >= NUM_GATES) return;                       // Bypass has no plan and no gate map entry
    const key = String(i);
    const planned = num(plannedByGate[key]);
    const usedG = (num(fuse.used[key]) || 0) * gramsPerMm(i);
    if (planned === null || planned <= 0) {
      sp.useTrackStyle = "display:none";
      sp.useBarStyle = "display:none";
      sp.useTitle = "";
      return;
    }
    const pct = Math.max(0, Math.min(100, usedG / planned * 100));
    const col = sp.color || UNKNOWN_COLOR;
    sp.useTrackStyle = "height:3px; border-radius:2px; background:#11161f; overflow:hidden; margin-top:1px";
    sp.useBarStyle = `width:${pct.toFixed(1)}%; height:100%; border-radius:2px; background:${col}; ` +
      `opacity:${pct > 0 ? 0.95 : 0}; transition:width .4s ease`;
    sp.useTitle = usedG.toFixed(1) + " g of " + planned.toFixed(1) + " g planned this print ("
      + Math.round(pct) + "%)" + (fuse.partial ? " — measured only since this page opened" : "");
  });

  const totalMm = num(ps.filament_used);
  // Say plainly which of the two the per-gate split came from — a predicted split must never read as measured.
  // With nothing printed yet the bar list is empty, so claiming "0.00 m used · measured per gate" asserts a
  // measurement of an empty set; the strip says so instead (it is also the panel's only empty state).
  const filamentTotal = totalMm === null ? "—"
    : (totalMm <= 0 && !filamentUse.length) ? "no filament used yet"
      : (totalMm / 1000).toFixed(2) + " m used"
        + (usePlan ? " · split from slicer plan (" + planTotalG.toFixed(0) + " g)" : " · measured per gate");

  // ---- chain nodes (encoder → extruder → nozzle)
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
      title: n.title || "",
      valStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; white-space:nowrap; color:" +
        (n.valColor ? n.valColor : reached ? "#c9d3e0" : "#3d4859")
    };
  };
  const encPos = num(enc.encoder_pos) !== null ? enc.encoder_pos
    : num(mmu.encoder_pos) !== null ? mmu.encoder_pos
    : num((raw["mmu_encoder mmu_encoder"] || {}).encoder_pos);
  // Signed movement, not the odometer. Shown ALWAYS: the encoder measures whatever moves, so gating the
  // readout on the filament having reached this chain node (n.on vs n.off) blanked it whenever the gate
  // was unloaded — which read as "only works while printing".
  const encMoved = trackEncoder(encPos, num(mmu.filament_direction), Date.now());
  const encoderOn = encMoved === null ? "—"
    : (encMoved > 0.5 ? "+" : "") + Math.round(encMoved) + " mm";
  // teal advancing, amber rewinding, grey at rest — the sign is the point, so it is also colour-coded.
  const encoderValColor = encMoved === null ? null
    : Math.abs(encMoved) < 0.5 ? "#6b7789" : encMoved > 0 ? "#3ddcc4" : "#f0b429";
  const encoderBadge = sfsActive ? "buffer · " + sfs : "";
  const nd = nozzleDiameter(st, raw, api);
  const nozzleOn = nd !== null ? nd + " mm" : "loaded";

  // ---- header status (extra keys — the generated template hard-codes "PRINTING · 28 SWAPS"; bind these to fix it)
  const swaps = num(mmu.num_toolchanges);
  const mmuPaused = !!mmu.is_paused;
  const enabled = mmu.enabled !== false;
  const actionStr = str(mmu.action || "Idle");
  const mmuStatusLabel = !raw.mmu ? "MMU · NO DATA"
    : common.estop ? "SHUTDOWN"
    : !enabled ? "MMU DISABLED"
    : mmuPaused ? "PAUSED · " + (str(mmu.reason_for_pause).trim().toUpperCase() || "MMU ERROR")
    : printing ? "PRINTING · " + (swaps === null ? "—" : swaps) + " SWAP" + (swaps === 1 ? "" : "S")
    : actionStr !== "Idle" && actionStr !== "" ? actionStr.toUpperCase()
    : common.printState === "paused" ? "PAUSED · " + (swaps === null ? "—" : swaps) + " SWAPS"
    : gate !== null ? "IDLE · " + (tool >= 0 ? "T" + tool : gate === BYPASS ? "BYPASS" : "LOADED")
    : mmu.is_homed === false ? "IDLE · NOT HOMED" : "IDLE";
  const statusColor = common.estop || mmuPaused ? "#ff5a33" : !enabled ? "#4d5a6b" : printing || (actionStr !== "Idle" && actionStr !== "") ? "#3ddcc4" : "#6b7789";
  const mmuStatusStyle = `display:flex; align-items:center; gap:6px; flex:none; white-space:nowrap; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.1em; color:${statusColor}`;
  const mmuStatusDotStyle = `width:5px; height:5px; border-radius:50%; background:${statusColor}` +
    (printing || mmuPaused || (actionStr !== "Idle" && actionStr !== "") ? "; animation:vPulse 1.6s ease-in-out infinite" : "");

  // ---- endless spool (HH groups: gates sharing a group number are runout fallbacks; "next" = next gate in the group)
  const groups = arr("endless_spool_groups");
  const nextOf = i => {
    const g = groups[i];
    if (typeof g !== "number") return null;
    for (let k = 1; k < NUM_GATES; k++) { const j = (i + k) % NUM_GATES; if (groups[j] === g) return j; }
    return null;
  };

  // ---- ident / tool chip
  const vendor = loadedInfo ? str(loadedInfo.vendor).trim() : "";
  const identMat = loadedInfo ? (loadedInfo.mat && loadedInfo.mat !== "—" ? loadedInfo.mat : str(active && active.material)) : "";
  const identTemp = loadedInfo ? (num(loadedInfo.temp) !== null ? loadedInfo.temp : num(active && active.temperature)) : null;
  const identMeta = gate === null
    ? "no filament at the nozzle · select a gate to load"
    : gate === BYPASS
      ? "@bypass · manual feed" + (identMat ? " · " + identMat : "") + (identTemp !== null ? " · " + identTemp + "°C" : "")
      : ["@" + gate, vendor ? vendor.toUpperCase() : "", identMat || "—", identTemp !== null ? identTemp + "°C" : "—"].filter(Boolean).join(" · ");
  const identName = gate === null ? "Unloaded"
    : gate === BYPASS ? (str(active && active.filament_name).trim() || "Bypass")
    : (loadedInfo.name && loadedInfo.name !== "—" ? loadedInfo.name : (str(active && active.filament_name).trim() || "Gate " + gate));
  const toolChipLabel = gate === null
    ? "NO TOOL LOADED"
    : (tool >= 0 ? "T" + tool : gate === BYPASS ? "BYPASS" : "T?") + " · " + (extruderTemp !== null ? extruderTemp.toFixed(1) + "°C" : "—");

  // ---- carriage position along the rail (design: 9 columns)
  const carriageCol = selector === null || selector === undefined ? 4 : selector;
  const carriageLabel = selectorMoving ? "TRAVERSING"
    : selector === null || selector === undefined ? (mmu.is_homed === false ? "NOT HOMED" : "GATE ?")
    : selector === BYPASS ? "BYPASS" : "GATE " + selector;

  return {
    mmuHeaderRef: typeof c.setMmuHeader === "function" ? c.setMmuHeader
      : (c.logic && typeof c.logic.setMmuHeader === "function") ? c.logic.setMmuHeader : noopRef,
    guardsStyle: "display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px; min-width:0; " +
      (ui.guardsInline ? "flex:0 1 auto; margin-left:auto; justify-content:flex-end" : "flex:1 1 100%; justify-content:flex-start"),
    mmuGuards,
    servoLabel: "SERVO " + servo.toUpperCase(),
    servoDotStyle: "width:5px; height:5px; border-radius:50%; background:" +
      (servo === "down" ? "#3ddcc4" : "#f0b429") +
      (selectorMoving ? "; animation:vPulse 1s ease-in-out infinite" : ""),
    servoChipStyle: "display:flex; align-items:center; gap:6px; padding:2px 8px; border-radius:3px; cursor:pointer; white-space:nowrap; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; " +
      (servo === "down"
        ? "border:1px solid #1c3d37; background:#0f2320; color:#3ddcc4"
        : "border:1px solid #3a2f14; background:#14100a; color:#f0b429"),
    toggleServoMenu: () => set(s => ({ servoMenuOpen: !(s && s.servoMenuOpen) })),
    servoMenuStyle: ui.servoMenuOpen
      ? "position:absolute; right:0; top:24px; z-index:40; min-width:126px; padding:4px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 10px 24px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both"
      : "display:none",
    servoOptions: [
      ["down", "MMU_SERVO POS=down"],
      ["up", "MMU_SERVO POS=up"]
    ].map(row => ({
      t: "Servo " + row[0],
      go: () => { set({ servoMenuOpen: false }); call("servoPos", row[0]); },
      style: "padding:5px 8px; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:9.5px; white-space:nowrap; color:" +
        (servo === row[0] ? "#e8eef6" : "#6b7789") + "; background:" + (servo === row[0] ? "#141b25" : "transparent")
    })),
    railTicks: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => ({
      style: "width:2px; height:8px; border-radius:1px; background:" +
        (i === selector ? "#8b98aa" : "#1a222c")
    })),
    carriageStyle: `position:absolute; top:0; left:${((carriageCol + 0.5) / 9 * 100).toFixed(2)}%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; transition:left .5s cubic-bezier(.4,0,.2,1)`,
    carriageBodyStyle: `width:26px; height:11px; border-radius:2px; background:#1a222c; border:1px solid ${servo === "down" ? loadedColor : "#8b98aa"}; box-shadow:0 2px 6px rgba(0,0,0,.5)`,
    servoArmStyle: `width:3px; border-radius:1px; background:${loadedColor}; transition:height .22s ease, opacity .2s; height:${servo === "down" ? 9 : 0}px; opacity:${servo === "down" ? 1 : 0}`,
    servoTipStyle: `width:9px; height:3px; border-radius:1px; transition:opacity .2s; opacity:${servo === "down" ? 1 : 0}; background:${loadedColor}`,
    carriageLabelStyle: `font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.12em; white-space:nowrap; flex:none; color:${selectorMoving ? "#8b98aa" : "#4d5a6b"}`,
    carriageLabel,
    filamentUse,
    filamentTotal,
    spools, paths, loadedColor,
    trunkAnim: `animation:vFlow ${dashCycle} linear infinite${flowSuffix}`,
    headPath: headPathD,
    routeDash: travel.toFixed(4) + " 1",
    routeStyle: "transition:none" + (gate === null && travel === 0 && phase !== "checking" ? "; opacity:0" : ""),
    routeFlowDash: travel > 0 ? "0.012 0.022" : "0 1",
    routeFlowStyle: `opacity:${travel > 0 && common.flowing ? .55 : 0}; animation:vFlowRoute ${dashPeriod} linear infinite${flowSuffix}`,
    headKp: travel.toFixed(4) + ";" + travel.toFixed(4),
    // Blade is VISIBLE for the whole cut operation (the macro opens the cutter first) but only
    // ANIMATES while the cutter is closed — that is the actual shear. `cut.state` comes from the
    // macro's own RESPOND lines, so this follows the real servo rather than a timer.
    // Shown ONLY once the macro reports the cutter open — not on the phase, which would reveal the
    // blade ~1 s early. HH's own toolchange cut runs the same macro, so the events fire there too.
    cutterStyle: cutting ? "opacity:1" : "display:none",
    stubAnim: stubPose,
    shearAnim: shearPose,
    bladeAnim: bladePose,
    flashAnim: flashPose,
    cutState: cut ? cut.state : null,
    cutCount: cut ? cut.cuts : 0,
    cutAttempts: geoCfg.cutAttempts,
    cutX1: (gateX - 11).toFixed(1),
    cutX2: (gateX + 11).toFixed(1),
    cutCx: gateX.toFixed(1),
    // a servo-driven blade shears the filament against a fixed anvil (EREC gate cutter on this printer)
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
    headGlow: `filter:drop-shadow(0 0 7px ${loadedColor}); opacity:${gate === null && travel === 0 && phase !== "checking" ? 0 : travel < 1 ? 1 : extruding ? .9 : .3}`,
    extrudeLabel: {
      cutting: "CUTTING TIP",
      presenting: "PRESENTING TIP TO CUTTER",
      storing: "STORING TO SPOOL",
      checking: "CHECKING GATE · " + Math.min(100, Math.round(travel / 0.22 * 100)) + "%",
      extruding: "MANUAL EXTRUDE · " + extrudeRate + " mm/s",
      retracting: "MANUAL RETRACT · " + extrudeRate + " mm/s"
    }[phase]
      || (phase === "loading" ? "LOADING · " + Math.round(travel * 100) + "%"
      : phase === "unloading" ? "UNLOADING · " + Math.round(travel * 100) + "%"
      : extruding ? "EXTRUDING · " + (num(activeFeed) === null ? "—" : activeFeed.toFixed(2)) + " mm/s"
      // Nothing is moving: say what the extruder IS rather than a bare "IDLE". Job state wins (it is the
      // more useful fact mid-print), then the filament's resting position from Happy Hare's filament_pos
      // (0 = UNLOADED ... 10 = LOADED); anything between the two is a real in-between, so name it.
      : (function () {
          const js = String(ps.state || "").toLowerCase();
          if (js === "paused" || !!(raw.pause_resume || {}).is_paused) return "PAUSED";
          if (js === "printing") return "PRINTING";
          const fp = num(mmu.filament_pos);
          if (fp === null) return "IDLE · NOT EXTRUDING";
          if (fp >= 10) return "LOADED";
          if (fp <= 0) return "UNLOADED";
          return "PARTIALLY LOADED · POS " + fp;
        })()),
    toggleExtruding: () => set(s => ({ extruding: !(s ? s.extruding !== false : true) })),
    extrudeChipStyle: "display:flex; align-items:center; gap:6px; padding:4px 9px; border-radius:3px; cursor:pointer; white-space:nowrap; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.08em; " +
      (phase !== "idle" ? "border:1px solid #3a2f14; background:#14100a; color:#f0b429"
        : extruding ? "border:1px solid #1c3d37; background:#0f2320; color:#3ddcc4"
        : "border:1px solid #1c2430; background:#0d121a; color:#6b7789"),
    extrudeDotStyle: "width:5px; height:5px; border-radius:50%; background:" +
      (phase !== "idle" ? "#f0b429" : extruding ? "#3ddcc4" : "#4d5a6b") +
      (phase !== "idle" || extruding ? "; animation:vPulse 1.6s ease-in-out infinite" : ""),
    toolChipStyle: `display:flex; align-items:center; gap:7px; padding:6px 14px; border:1px solid ${A}; border-radius:4px; background:#150f10; box-shadow:0 0 14px rgba(255,90,51,.16); font-family:'JetBrains Mono',monospace; font-size:11px; letter-spacing:.08em; color:#e8eef6`,
    toolChipDot: `width:9px; height:9px; border-radius:2px; background:${loadedColor}; border:1px solid #2c3746`,
    toolChipLabel,
    identName,
    identNameStyle: "font-size:15px; font-weight:600; color:" + (gate === null ? "#4d5a6b" : "#e8eef6"),
    identSwatch: "width:12px; height:12px; border-radius:2px; border:1px solid #2c3746; background:" +
      (gate === null ? "#11161f" : gi(gate).color),
    identMeta,
    // CUT runs EREC_CUTTER_ACTION — the cutter is at the MMU, not the toolhead (tip forming is a separate
    // button). EJECT dropped: UNLOAD parks the filament at the gate, which is the operation actually wanted;
    // EJECT pushes it fully out of the MMU and was only ever a slower way to have to reload.
    mmuActions: ["PRELOAD", "CUT", "CHECK", "RECOVER", "UNLOAD", "LOAD"].map((t, i, all) => ({
      t, go: () => call("mmuAction", t),
      style: "padding:6px 11px; border:1px solid " + (i === all.length - 1 ? "#4a2318" : "#1c2430") + "; background:" + (i === all.length - 1 ? "#1a0e09" : "#0d121a") +
        "; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:.1em; color:" + (i === all.length - 1 ? A : "#8b98aa") + "; cursor:pointer; transition:.12s"
    })),
    preNodes: [chainNode({ at: .30, from: 0, label: "ENCODER", on: encoderOn, off: encoderOn, w: 62,
      badge: encoderBadge, last: false, valColor: encoderValColor,
      title: encPos === null ? "" : "Lifetime encoder travel: " + Math.round(encPos) + " mm" })],
    postNodes: [chainNode({ at: 1, from: .75, label: "NOZZLE", on: nozzleOn, off: "empty", w: 56, last: true })],
    // "Edit gate map" opens the in-app gate editor for the SELECTED gate. It used to dispatch GATE_MAP,
    // which opened Mainsail's MMU panel in a new tab — dead inside Orca's webview, and a dependency on
    // the app Carbon is meant to replace. Same dialog as the spool cards' edit button: one implementation.
    mmuMenu: [["Recover state", "MMU_RECOVER"], ["Reset MMU", "MMU_RESET"], ["Edit gate map", "GATE_EDITOR"], ["Calibrate gates", "CHECK_GATE"], ["Filament stats", "STATS"], ["MMU settings", "SETTINGS"]].map(row => ({
      t: row[0],
      go: () => {
        set({ mmuMenuOpen: false });
        if (row[1] === "GATE_EDITOR") {
          const sel = Number(gate);   // `gate` is the selected gate from ctx.common (null when unknown)
          set({ gateEditor: Number.isInteger(sel) && sel >= 0 && sel < NUM_GATES ? sel : 0 });
          return;
        }
        call("mmuMenuAction", row[1]);
      },
      style: "padding:6px 10px; border-radius:3px; cursor:pointer; font-size:11.5px; color:#8b98aa"
    })),
    mmuDotsStyle: `font-family:'JetBrains Mono',monospace; font-size:12px; cursor:pointer; margin-left:auto; color:${ui.mmuMenuOpen ? "#e8eef6" : "#4d5a6b"}`,
    mmuMenuStyle: ui.mmuMenuOpen
      ? "position:absolute; right:12px; top:44px; z-index:20; min-width:158px; padding:5px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 10px 26px rgba(0,0,0,.6); display:flex; flex-direction:column; gap:1px; animation:vRise .16s ease both"
      : "display:none",
    toggleMmuMenu: () => set(s => ({ mmuMenuOpen: !(s && s.mmuMenuOpen) })),
    toolMap: [0, 1, 2, 3, 4, 5, 6, 7, null].map(i => {
      const bypass = i === null;
      const next = bypass ? null : nextOf(i);
      const linked = !bypass && next !== null;
      const open = !bypass && ui.mapOpen === i;
      return {
        tool: bypass ? "BP" : "G" + i,
        gate: bypass ? "—" : (next === null ? "off" : "G" + next),
        cycle: () => (bypass ? log("Bypass has no endless-spool group") : set(s => ({ mapOpen: (s && s.mapOpen) === i ? null : i }))),
        menuStyle: open
          ? "position:absolute; left:0; top:26px; z-index:30; min-width:132px; padding:4px; border:1px solid #1c2430; border-radius:5px; background:#0d121a; box-shadow:0 10px 24px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both"
          : "display:none",
        options: bypass ? [] : [null, 0, 1, 2, 3, 4, 5, 6, 7].filter(v => v !== i).map(v => ({
          t: v === null ? "no fallback" : "→ Gate " + v + " · " + gi(v).name,
          pick: () => { set({ mapOpen: null }); call("setEndless", i, v); },
          style: "display:flex; align-items:center; gap:7px; padding:5px 7px; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:9.5px; white-space:nowrap; color:" +
            (next === v ? "#e8eef6" : "#6b7789") + "; background:" + (next === v ? "#141b25" : "transparent"),
          dot: "width:8px; height:8px; border-radius:50%; flex:none; border:1px solid #2c3746; background:" +
            (v === null ? "#11161f" : gi(v).color)
        })),
        wrapStyle: "position:relative" + (open ? "; z-index:30" : ""),
        style: "display:flex; align-items:center; gap:4px; padding:4px 6px; border-radius:3px; cursor:pointer; transition:border-color .12s; background:" +
          (linked ? "#0f1a1d" : "#0d121a") + "; border:1px solid " + (open ? "#8b98aa" : linked ? "#1c3d37" : "#1c2430"),
        toolStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.04em; color:" + (bypass ? "#3d4859" : "#8b98aa"),
        gateStyle: "font-family:'JetBrains Mono',monospace; font-size:9px; color:" + (linked ? "#3ddcc4" : "#4d5a6b")
      };
    }),
    // ---- extras (not consumed by the generated template yet; bind the header's static "PRINTING · 28 SWAPS" to these)
    mmuStatusLabel, mmuStatusStyle, mmuStatusDotStyle,
  };
}

export default mmuVals;
