// MMU · HAPPY HARE actions — the real gcode behind the dashboard's MMU panel (CONTRACT.md "Exact gcode per action → MMU").
//
//   selectTool(i)          T<i>                         selectGate(g)      MMU_SELECT GATE=<g>        selectBypass()  MMU_SELECT_BYPASS
//   checkGate(g?)          MMU_CHECK_GATE [GATE=<g>]    checkGates()       MMU_CHECK_GATES
//   mmuLoad()              MMU_LOAD                     mmuUnload()        MMU_UNLOAD                 mmuEject()      MMU_EJECT
//   mmuPreload(g?)         MMU_PRELOAD [GATE=<g>]       mmuRecover()       MMU_RECOVER                mmuReset()      MMU_RESET
//   cutFilament()          EREC_CUTTER_ACTION  ← the real cut, at the MMU gate (the installed EREC cutter)
//   formTip()              MMU_FORM_TIP        ← tip forming at the TOOLHEAD; a different operation from cutting
//   servoPos(pos)          MMU_SERVO POS=<up|down>      mmuStats()         MMU_STATS DETAIL=1         mmuSettings()   MMU_TEST_CONFIG
//   editGateMap()          opens Mainsail's dashboard (its MMU panel has the gate-map editor) in a new tab
//   setEndless(gate, next) MMU_ENDLESS_SPOOL GROUPS=<g0,…,g7>  (+ MMU_ENDLESS_SPOOL ENABLE=1 when a link is set)
//   mmuAction(name)        the design's button dispatcher: PRELOAD | TIP/CUT | EJECT | CHECK | RECOVER | UNLOAD | LOAD
//   mmuMenuAction(name)    the design's ⋮ menu dispatcher: MMU_RECOVER | MMU_RESET | GATE_MAP | CHECK_GATE | STATS | SETTINGS
//
// Every action logs the command (or a short intent line), awaits api.gcode and logs errors; nothing throws.
// Usage: const act = makeMmuActions({ api, store, log });   (merged with the other panels' actions by the integrator)

import { geometry, cutTravel } from "../geometry.js";

const NUM_GATES = 8;

export function makeMmuActions({ api, store, log } = {}) {
  const say = (m, kind) => { try { if (typeof log === "function") log(m, kind || "info"); } catch (e) { /* console logging is best-effort */ } };
  const state = () => (store && store.state) || {};
  const raw = () => state().raw || {};
  const mmu = () => raw().mmu || {};
  const arr = k => (Array.isArray(mmu()[k]) ? mmu()[k] : []);
  const numGates = () => {
    const n = mmu().num_gates;
    return typeof n === "number" && n > 0 ? Math.min(NUM_GATES, Math.round(n)) : NUM_GATES;
  };
  const gateName = g => {
    const m = mmu();
    const id = (m.gate_spool_id || [])[g];
    const sp = id > 0 ? (state().spools || {})[id] : null;
    return (sp && sp.filament && sp.filament.name) || (m.gate_filament_name || [])[g] || (m.gate_material || [])[g] || ("gate " + g);
  };

  /** Klipper unavailable → reject like the design's blocked(). */
  function blocked() {
    const k = state().klippy;
    if (k === "shutdown" || k === "disconnected" || k === "startup" || k === "error") {
      say("Command rejected — Klipper is " + k + (k === "shutdown" ? " (FIRMWARE_RESTART required)" : ""), "err");
      return true;
    }
    if (!api || typeof api.gcode !== "function") { say("Command rejected — no printer connection", "err"); return true; }
    return false;
  }
  /** Happy Hare itself refuses most commands while it is busy; say so up front instead of waiting for the error. */
  function busy(what) {
    const a = String(mmu().action || "Idle");
    if (a !== "Idle" && a !== "") { say((what || "Command") + " refused — MMU is busy (" + a + ")", "warn"); return true; }
    return false;
  }
  function printingNow() {
    const ps = raw().print_stats || {};
    const paused = !!((raw().pause_resume || {}).is_paused) || !!mmu().is_paused;
    return ps.state === "printing" && !paused;
  }
  function loaded() { return String(mmu().filament || "").toLowerCase() === "loaded"; }

  async function run(script, okMsg) {
    try {
      await api.gcode(script);
      if (okMsg) say(okMsg, "ok");
      return true;
    } catch (e) {
      say((e && e.message) || String(e), "err");
      return false;
    }
  }
  const gateIndex = g => {
    const n = Number(g);
    return Number.isInteger(n) && n >= 0 && n < numGates() ? n : null;
  };

  // ---------------------------------------------------------------- selection
  /** Tool change: T<i>. Tool i feeds from gate ttg_map[i]. */
  async function selectTool(i) {
    if (blocked()) return false;
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0) { say("Tool ignored — invalid index", "warn"); return false; }
    const ttg = arr("ttg_map");
    const gate = typeof ttg[n] === "number" && ttg[n] >= 0 ? ttg[n] : n;
    const status = arr("gate_status")[gate];
    if (raw().mmu && status === 0) { say("T" + n + " unavailable — no filament detected in gate " + gate, "warn"); return false; }
    if (loaded() && mmu().tool === n) { say("T" + n + " already loaded from gate " + gate); return false; }
    if (printingNow()) { say("Refused — tool change while printing (pause first)", "warn"); return false; }
    if (busy("T" + n)) return false;
    if (mmu().is_locked) say("MMU is locked — Happy Hare may refuse until MMU_RECOVER", "warn");
    const cmd = "T" + n;
    say(cmd + " — " + (loaded() ? "unloading gate " + mmu().gate + ", then " : "") + "loading gate " + gate + " (" + gateName(gate) + ")", loaded() ? "warn" : "ok");
    return run(cmd, "Tool T" + n + " ready at nozzle");
  }

  /** Move the selector to a gate: MMU_SELECT GATE=<g> (Happy Hare unloads first if filament is loaded). */
  async function selectGate(g) {
    if (blocked()) return false;
    const gate = gateIndex(g);
    if (gate === null) { say("Gate ignored — invalid index", "warn"); return false; }
    const m = mmu();
    if (m.gate === gate && !loaded()) { say("Selector already at gate " + gate); return false; }
    if (printingNow()) { say("Refused — selector move while printing (pause first)", "warn"); return false; }
    if (busy("MMU_SELECT")) return false;
    if (loaded() && m.gate !== gate) say("Gate " + m.gate + " still loaded — Happy Hare will unload before moving the selector", "warn");
    const cmd = "MMU_SELECT GATE=" + gate;
    say(cmd + " — selector → gate " + gate + " (" + gateName(gate) + ")");
    return run(cmd, "MMU_SELECT GATE=" + gate + " — gate engaged");
  }

  /** MMU_SELECT_BYPASS — selector to the bypass position (manual feed straight to the extruder). */
  async function selectBypass() {
    if (blocked()) return false;
    if (mmu().has_bypass === false) { say("This MMU has no bypass configured", "warn"); return false; }
    if (mmu().gate === -2 && !loaded()) { say("Selector already at bypass"); return false; }
    if (printingNow()) { say("Refused — selector move while printing (pause first)", "warn"); return false; }
    if (busy("MMU_SELECT_BYPASS")) return false;
    if (loaded()) say("Filament still loaded — Happy Hare will unload before selecting bypass", "warn");
    say("MMU_SELECT_BYPASS");
    return run("MMU_SELECT_BYPASS", "Bypass selected — feed filament manually to the extruder");
  }

  // ---------------------------------------------------------------- gate checks
  /** MMU_CHECK_GATE — checks the current gate; pass a gate index to check a specific one (GATE=<g>). */
  async function checkGate(g) {
    if (blocked()) return false;
    if (loaded()) { say("Unload before checking gates", "warn"); return false; }
    if (printingNow()) { say("Refused — gate check while printing", "warn"); return false; }
    if (busy("MMU_CHECK_GATE")) return false;
    const gate = gateIndex(g);
    const cmd = gate === null ? "MMU_CHECK_GATE" : "MMU_CHECK_GATE GATE=" + gate;
    const which = gate === null ? (typeof mmu().gate === "number" && mmu().gate >= 0 ? mmu().gate : "?") : gate;
    say(cmd + " — advancing filament at gate " + which + " to the sensor", "warn");
    return run(cmd, "Gate check finished — see gate map");
  }
  /** MMU_CHECK_GATES — check every gate (the design's "Calibrate gates"). */
  async function checkGates() {
    if (blocked()) return false;
    if (loaded()) { say("Unload before checking gates", "warn"); return false; }
    if (printingNow()) { say("Refused — gate check while printing", "warn"); return false; }
    if (busy("MMU_CHECK_GATES")) return false;
    say("MMU_CHECK_GATES — checking all " + numGates() + " gates", "warn");
    return run("MMU_CHECK_GATES", "All gates checked — gate map updated");
  }

  // ---------------------------------------------------------------- load / unload
  async function mmuLoad() {
    if (blocked()) return false;
    const m = mmu();
    const g = typeof m.gate === "number" ? m.gate : -1;
    if (g === -1) { say("No gate selected — select a gate first", "warn"); return false; }
    if (g >= 0 && arr("gate_status")[g] === 0) { say("Gate " + g + " is empty — nothing to load", "warn"); return false; }
    if (loaded() && (m.filament_pos === 10 || m.filament_pos === undefined)) { say("Gate " + g + " already loaded"); return false; }
    if (printingNow()) { say("Refused — load while printing (pause first)", "warn"); return false; }
    if (busy("MMU_LOAD")) return false;
    say("MMU_LOAD — feeding " + (g === -2 ? "bypass" : "gate " + g + " (" + gateName(g) + ")") + " to nozzle", "ok");
    return run("MMU_LOAD", "Filament reached nozzle" + (g >= 0 ? " — gate " + g : ""));
  }
  async function mmuUnload() {
    if (blocked()) return false;
    const m = mmu();
    if (!loaded() && String(m.filament || "").toLowerCase() === "unloaded") { say("Nothing loaded", "warn"); return false; }
    if (printingNow()) { say("Refused — unload while printing (pause first)", "warn"); return false; }
    if (busy("MMU_UNLOAD")) return false;
    say("MMU_UNLOAD — forming tip and retracting to gate" + (typeof m.gate === "number" && m.gate >= 0 ? " " + m.gate : ""), "warn");
    return run("MMU_UNLOAD", "Filament parked at gate");
  }
  async function mmuEject() {
    if (blocked()) return false;
    const m = mmu();
    if (printingNow()) { say("Refused — eject while printing (pause first)", "warn"); return false; }
    if (busy("MMU_EJECT")) return false;
    if (typeof m.gate !== "number" || m.gate === -1) { say("No gate selected — nothing to eject", "warn"); return false; }
    say("MMU_EJECT — " + (loaded() ? "unloading, then " : "") + "ejecting filament from gate " + m.gate, "warn");
    return run("MMU_EJECT", "Filament ejected from gate " + m.gate);
  }
  /** MMU_PRELOAD — feed filament into the selected gate to preload it (pass a gate index for GATE=<g>). */
  async function mmuPreload(g) {
    if (blocked()) return false;
    if (loaded()) { say("Unload before preloading a gate", "warn"); return false; }
    if (printingNow()) { say("Refused — preload while printing", "warn"); return false; }
    if (busy("MMU_PRELOAD")) return false;
    const gate = gateIndex(g);
    const cmd = gate === null ? "MMU_PRELOAD" : "MMU_PRELOAD GATE=" + gate;
    say(cmd + " — insert filament into the gate now");
    return run(cmd, "Gate preloaded");
  }
  async function mmuRecover() {
    if (blocked()) return false;
    say("MMU_RECOVER — resyncing Happy Hare state from sensors", "warn");
    return run("MMU_RECOVER", "MMU state recovered");
  }
  async function mmuReset() {
    if (blocked()) return false;
    if (printingNow()) { say("Refused — MMU_RESET while printing", "warn"); return false; }
    say("MMU_RESET — clearing persisted MMU state (gate map, TTG map, statistics)", "warn");
    return run("MMU_RESET", "MMU state reset");
  }
  /**
   * The design's CUT button — a real cut on this printer.
   * Cutting happens at the MMU by the EREC gate cutter (`EREC_CUTTER_ACTION`), which is installed and already
   * runs on every unload via Happy Hare's `user_post_unload_extension`. It is NOT tip forming: forming happens
   * at the toolhead (`MMU_FORM_TIP`), and the toolhead cutter (`_MMU_CUT_TIP` and the `_CUT_TIP_*` family) is
   * fossil config for hardware that was removed.
   */
  async function cutFilament() {
    if (blocked()) return false;
    if (printingNow()) { say("Refused — cut while printing (pause first)", "warn"); return false; }
    if (busy("EREC_CUTTER_ACTION")) return false;
    say("EREC_CUTTER_ACTION — cutting filament at the gate", "warn");
    // HH sets no mmu.action for a manual macro call, so the design's cut choreography is driven here:
    // present the tip to the cutter -> shear -> store back to the spool. The blade position is where
    // sits in the drawing (just past the gate), so the head and the blade meet instead of the blade
    // shearing empty space. The "cutting" phase is held for as long as the real macro takes.
    // No scripted choreography: the macro narrates itself (RESPOND "EREC Cutter open"/"closed") and
    // boot.js turns those into store.setCutter(), so the blade follows the REAL servo and the feed
    // shows the REAL moves, repeating for however many cut_attempts are configured.
    if (store && store.signalMotion) store.signalMotion("cutting", null, 120000);
    const ok = await run("EREC_CUTTER_ACTION", "Filament cut at the gate");
    if (store) {
      store.setCutter(null);                                    // blade hidden/stopped
      if (store.signalMotion) store.signalMotion("storing", -1, 800, 0);   // retract home
    }
    return ok;
    return ok;
  }

  /** Standalone tip forming at the toolhead — a different operation from the gate cut above. */
  async function formTip() {
    if (blocked()) return false;
    if (!loaded()) { say("Nothing loaded — no tip to form", "warn"); return false; }
    if (printingNow()) { say("Refused — tip forming while printing (pause first)", "warn"); return false; }
    if (busy("MMU_FORM_TIP")) return false;
    const ext = raw().extruder || {};
    if (ext.can_extrude === false) { say("Extruder below minimum temp — heat up before forming a tip", "warn"); return false; }
    say("MMU_FORM_TIP — standalone tip forming at the toolhead", "warn");
    return run("MMU_FORM_TIP", "Tip formed");
  }

  // ---------------------------------------------------------------- servo / info
  /** MMU_SERVO POS=<up|down> (also accepts 'move'). */
  async function servoPos(pos) {
    if (blocked()) return false;
    const p = String(pos || "").toLowerCase();
    if (p !== "up" && p !== "down" && p !== "move") { say("Servo position must be up or down", "warn"); return false; }
    if (printingNow()) { say("Refused — servo move while printing (pause first)", "warn"); return false; }
    if (busy("MMU_SERVO")) return false;
    const cmd = "MMU_SERVO POS=" + p;
    say(cmd);
    return run(cmd, cmd + " — servo " + p);
  }
  async function mmuStats() {
    if (blocked()) return false;
    say("MMU_STATS DETAIL=1 — statistics follow in the console");
    return run("MMU_STATS DETAIL=1");
  }
  async function mmuSettings() {
    if (blocked()) return false;
    say("MMU_TEST_CONFIG — current Happy Hare settings follow in the console");
    return run("MMU_TEST_CONFIG");
  }
  /** Gate map editing lives in Mainsail's MMU panel; open it in a new tab (Mainsail is at the printer root). */
  function editGateMap() {
    try {
      const base = (api && api.base) ? api.base : (typeof location !== "undefined" ? location.origin : "");
      const url = base.replace(/\/$/, "") + "/#/dashboard";
      say("Opening Mainsail's MMU panel for the gate-map editor (" + url + ")");
      if (typeof window !== "undefined" && window.open) window.open(url, "_blank", "noopener");
      return true;
    } catch (e) { say((e && e.message) || String(e), "err"); return false; }
  }

  // ---------------------------------------------------------------- endless spool
  /**
   * Happy Hare models endless spool as GROUPS: gates sharing a group number are fallbacks for each other.
   * setEndless(gate, next): put `gate` into `next`'s group (next === null → a group of its own = no fallback),
   * then MMU_ENDLESS_SPOOL GROUPS=<g0,…,g7> and, when a link was made, MMU_ENDLESS_SPOOL ENABLE=1.
   */
  async function setEndless(gate, next) {
    if (blocked()) return false;
    const n = numGates();
    const g = gateIndex(gate);
    if (g === null) { say("Endless spool — invalid gate", "warn"); return false; }
    const nx = next === null || next === undefined || next === "" ? null : gateIndex(next);
    if (next !== null && next !== undefined && next !== "" && nx === null) { say("Endless spool — invalid fallback gate", "warn"); return false; }
    if (nx === g) { say("A gate cannot be its own fallback", "warn"); return false; }
    const cur = arr("endless_spool_groups");
    const groups = [];
    for (let i = 0; i < n; i++) groups.push(typeof cur[i] === "number" ? cur[i] : i);
    if (nx === null) {
      // detach: give the gate a group number nobody else uses
      let free = 0; const used = new Set(groups.filter((_, i) => i !== g));
      while (used.has(free)) free++;
      groups[g] = free;
    } else {
      groups[g] = groups[nx];
    }
    const cmd = "MMU_ENDLESS_SPOOL GROUPS=" + groups.join(",");
    say(nx === null
      ? "MMU_ENDLESS_SPOOL — gate " + g + " has no runout fallback (" + cmd + ")"
      : "MMU_ENDLESS_SPOOL — gate " + g + " → gate " + nx + " (" + gateName(nx) + ") · " + cmd, "ok");
    const ok = await run(cmd);
    if (!ok) return false;
    if (nx !== null && !mmu().endless_spool_enabled && !mmu().endless_spool) {
      say("MMU_ENDLESS_SPOOL ENABLE=1");
      return run("MMU_ENDLESS_SPOOL ENABLE=1", "Endless spool enabled");
    }
    return true;
  }

  // ---------------------------------------------------------------- dispatchers (the design's mmuAction / runMacro menu keys)
  function mmuAction(name) {
    const a = String(name || "").toUpperCase();
    switch (a) {
      case "PRELOAD": return mmuPreload();
      case "CUT": case "MMU_CUT": return cutFilament();
      case "TIP": case "FORM_TIP": return formTip();
      case "EJECT": return mmuEject();
      case "CHECK": case "CHECK_GATE": return checkGate();
      case "RECOVER": case "MMU_RECOVER": return mmuRecover();
      case "UNLOAD": case "MMU_UNLOAD": return mmuUnload();
      case "LOAD": case "MMU_LOAD": return mmuLoad();
      case "RESET": case "MMU_RESET": return mmuReset();
      case "BYPASS": return selectBypass();
      default: say("Unknown MMU action: " + name, "warn"); return Promise.resolve(false);
    }
  }
  function mmuMenuAction(name) {
    const a = String(name || "").toUpperCase();
    switch (a) {
      case "MMU_RECOVER": case "RECOVER": return mmuRecover();
      case "MMU_RESET": case "RESET": return mmuReset();
      case "GATE_MAP": case "EDIT_GATE_MAP": return Promise.resolve(editGateMap());
      case "CHECK_GATE": case "CHECK_GATES": case "CALIBRATE": return checkGates();
      case "STATS": return mmuStats();
      case "SETTINGS": return mmuSettings();
      default: say("Unknown MMU menu action: " + name, "warn"); return Promise.resolve(false);
    }
  }

  return {
    selectTool, selectGate, selectBypass, checkGate, checkGates,
    mmuLoad, mmuUnload, mmuEject, mmuPreload, mmuRecover, mmuReset, cutFilament, formTip,
    servoPos, mmuStats, mmuSettings, editGateMap, setEndless,
    mmuAction, mmuMenuAction,
    // design-name aliases
    loadSelector: mmuLoad, mmuServo: servoPos,
  };
}

export default makeMmuActions;
