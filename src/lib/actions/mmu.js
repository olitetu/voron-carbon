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
  /** MMU_HOME — homes the selector. Refused mid-print: it drives the selector across every gate. */
  async function mmuHome() {
    if (blocked()) return false;
    if (printingNow()) { say("Refused — MMU_HOME moves the selector while printing (pause first)", "warn"); return false; }
    if (busy("MMU_HOME")) return false;
    say("MMU_HOME — homing the selector", "warn");
    return run("MMU_HOME", "Selector homed");
  }

  /**
   * MMU_RECOVER — resync Happy Hare's idea of state from the hardware.
   *
   * `loaded` maps to HH's LOADED=0|1 (verified against cmd_MMU_RECOVER: get_int('LOADED', -1, minval=0,
   * maxval=1)). Omitting it lets HH work the position out from its sensors; passing it ASSERTS the answer,
   * which is what you want when the sensors cannot tell (no toolhead sensor on this machine) and you can
   * see for yourself whether filament is at the nozzle.
   */
  async function mmuRecover(loaded) {
    if (blocked()) return false;
    const l = loaded === 1 || loaded === true ? 1 : loaded === 0 || loaded === false ? 0 : null;
    const cmd = "MMU_RECOVER" + (l === null ? "" : " LOADED=" + l);
    say(cmd + " — resyncing Happy Hare state"
      + (l === null ? " from sensors" : l ? ", asserting filament IS loaded" : ", asserting filament is NOT loaded"), "warn");
    return run(cmd, "MMU state recovered");
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
  /**
   * Gate map editing now lives IN Carbon — lib/GateEditor.jsx, opened from the MMU spool cards, the
   * SPOOLMAN gate strip and the MMU panel's menu. This is kept only so an older caller (or
   * window.__carbon.act) does not silently do nothing.
   *
   * It used to open Mainsail's dashboard in a new tab with window.open(url, "_blank"). That was the last
   * window.open in the app and the only remaining hard dependency on Mainsail — and Orca's webview ejects
   * target=_blank / window.open, so inside the Device tab it did precisely nothing.
   */
  function editGateMap() {
    say("Gate map editing is built in — use the ✎ button on a spool card, or the gate strip on the SPOOLMAN page", "warn");
    return false;
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
      case "HOME": case "MMU_HOME": return mmuHome();
      case "UNLOAD": case "MMU_UNLOAD": return mmuUnload();
      case "LOAD": case "MMU_LOAD": return mmuLoad();
      case "RESET": case "MMU_RESET": return mmuReset();
      case "BYPASS": return selectBypass();
      default: say("Unknown MMU action: " + name, "warn"); return Promise.resolve(false);
    }
  }
  // ---------------------------------------------------------------- gate map / spool assignment
  //
  // Spoolman is the SOURCE OF TRUTH for what filament is on a spool and which gate it sits in. This printer
  // runs `spoolman_support: push`, so the split of responsibility is:
  //
  //   assignSpool()   the gate -> spool mapping. Goes through Spoolman via `MMU_SPOOLMAN GATE=n SPOOLID=x`,
  //                   which calls _spoolman_set_spool_gate() and writes the association into the Spoolman DB.
  //                   Filament name / material / colour / temperature then flow back FROM Spoolman; they are
  //                   never typed in here, which is why there is no name/material/temp setter below.
  //                   HH's SPOOLID has minval=1, so a gate is CLEARED by omitting SPOOLID entirely
  //                   (-> _spoolman_unset_spool_gate), not by sending 0 or -1.
  //
  //   setGateLocal()  the two attributes Spoolman does not own. HH's own source says it: "gate_speed_override
  //                   and gate_status can be set locally". Sent with `MMU_GATE_MAP GATE=n AVAILABLE=.. SPEED=..`.
  //
  // Why not `MMU_GATE_MAP MAP={...}`: that bulk path is DESTRUCTIVE for omitted fields — spool_id defaults to
  // -1, name/material/colour to '', temp to default_extruder_temp — so it can only be used by something that
  // already holds every value. The single-gate form is preserving instead (`name if name is not None else
  // self.gate_filament_name[gate]`), which is what a UI wants.
  //
  // TEMP is passed on EVERY setGateLocal call and that is deliberate, not redundant:
  //     temperature = gcmd.get_int('TEMP', int(self.default_extruder_temp))   # omitted -> 200
  //     temperature = temperature or self.gate_temperature[gate]              # 200 is truthy, so it STICKS
  // Omitting TEMP silently rewrites the gate to default_extruder_temp. On this machine gates 2 and 7 run at
  // 250 C, so an omitted TEMP would quietly drop them to 200.

  /** Live attributes of one gate, as the dialog shows them before any edit (all read-only except the last two). */
  function gateAttrs(g) {
    const m = mmu();
    const at = (k, d) => { const v = (m[k] || [])[g]; return v === undefined || v === null ? d : v; };
    const int = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };
    return {
      spool_id: int(at("gate_spool_id", -1), -1),
      name: String(at("gate_filament_name", "") || ""),
      material: String(at("gate_material", "") || ""),
      color: String(at("gate_color", "") || ""),
      temp: int(at("gate_temperature", 0), 0),
      speed_override: int(at("gate_speed_override", 100), 100),
      status: int(at("gate_status", 0), 0)
    };
  }

  /** Happy Hare's spoolman_support mode: off | readonly | push | pull (or null when config is unread). */
  function spoolmanMode() {
    const st = (raw().configfile || {}).settings || {};
    const v = (st.mmu || {}).spoolman_support;
    return v === undefined || v === null ? null : String(v).toLowerCase();
  }

  /**
   * Point a gate at a Spoolman spool, or clear it with spoolId == null.
   *
   * WHICH COMMAND depends on spoolman_support, and getting this wrong is silent:
   *
   *   pull  — Spoolman owns the gate map. `MMU_SPOOLMAN GATE=n SPOOLID=x` writes the remote record and
   *           HH follows it (_spoolman_set_spool_gate is called with sync=True in this mode).
   *
   *   push / readonly / off — HH owns the gate map and pushes it OUT to Spoolman. Here the write must go
   *           to the LOCAL map via `MMU_GATE_MAP GATE=n SPOOLID=x`. Using MMU_SPOOLMAN in push mode looks
   *           like it works — Spoolman logs "Spool 24 assigned ... @ gate 3" — but sync is False, so HH's
   *           own map is untouched, and the next refresh/sync pushes HH's (unchanged) map back out and
   *           UNDOES the assignment: "Spool 24 unassigned from printer voron and gate 3". Verified live.
   *
   * Identity still comes from Spoolman either way: changing SPOOLID makes HH fetch that spool's record and
   * overwrite the gate's name / material / colour / temperature from it — measured, it replaced a passed
   * TEMP=200 with the spool's own 250 C. So nothing here types filament attributes in by hand.
   *
   * TEMP is passed because omitting it rewrites the gate to default_extruder_temp; see setGateLocal.
   * Clearing uses SPOOLID=-1 (GATE_MAP accepts minval=-1; note SPOOLID=0 would fall through to the
   * existing value because HH does `spool_id or self.gate_spool_id[gate]`).
   */
  async function assignSpool(gate, spoolId) {
    if (blocked()) return false;
    const g = gateIndex(gate);
    if (g === null) { say("Refused — gate " + gate + " is out of range", "warn"); return false; }
    if (busy("Spool assignment")) return false;

    const pull = spoolmanMode() === "pull";
    const cur = gateAttrs(g);
    const temp = cur.temp > 0 ? cur.temp : (tempFloor() || 0);
    const tempArg = temp > 0 ? " TEMP=" + temp : "";

    if (spoolId === null || spoolId === undefined || spoolId === "") {
      if (pull) {
        say("MMU_SPOOLMAN GATE=" + g + " — clearing the spool assignment in Spoolman", "warn");
        return run("MMU_SPOOLMAN GATE=" + g, "Gate " + g + " spool cleared");
      }
      say("MMU_GATE_MAP GATE=" + g + " SPOOLID=-1 — clearing the spool on gate " + g, "warn");
      return run("MMU_GATE_MAP GATE=" + g + " SPOOLID=-1" + tempArg, "Gate " + g + " spool cleared");
    }

    const id = Math.round(Number(spoolId));
    if (!Number.isFinite(id) || id < 1) { say("Refused — '" + spoolId + "' is not a Spoolman spool id (must be >= 1)", "warn"); return false; }
    const sp = (state().spools || {})[id];
    const label = (sp && sp.filament && (sp.filament.name || sp.filament.material)) || ("spool #" + id);

    if (pull) {
      say("MMU_SPOOLMAN GATE=" + g + " SPOOLID=" + id + " — assigning " + label + " in Spoolman");
      return run("MMU_SPOOLMAN GATE=" + g + " SPOOLID=" + id, "Gate " + g + " -> spool #" + id);
    }
    say("MMU_GATE_MAP GATE=" + g + " SPOOLID=" + id + " — assigning " + label + " (attributes follow from Spoolman)");
    return run("MMU_GATE_MAP GATE=" + g + " SPOOLID=" + id + tempArg, "Gate " + g + " -> spool #" + id);
  }

  /**
   * The two gate attributes Spoolman does not own: availability and the load speed override.
   * `patch` may carry { status, speed_override }. TEMP is always resent — see the note above.
   */
  async function setGateLocal(gate, patch) {
    if (blocked()) return false;
    const g = gateIndex(gate);
    if (g === null) { say("Refused — gate " + gate + " is out of range", "warn"); return false; }
    if (busy("Gate update")) return false;

    const cur = gateAttrs(g);
    const p = patch || {};
    const status = (p.status === undefined ? cur.status : (p.status ? 1 : 0));
    let speed = Math.round(Number(p.speed_override === undefined ? cur.speed_override : p.speed_override));
    if (!Number.isFinite(speed)) speed = cur.speed_override;
    // HH clamps SPEED to 10..150 and ERRORS outside it, so clamp here and say so rather than fail the command.
    if (speed < 10 || speed > 150) {
      const c = Math.min(150, Math.max(10, speed));
      say("Load speed override " + speed + "% is outside Happy Hare's 10-150% range — using " + c + "%", "warn");
      speed = c;
    }
    // TEMP must be > 0 or HH's `temperature or existing` falls through; a gate with no temperature yet gets
    // default_extruder_temp, which is what HH would have used anyway.
    const temp = cur.temp > 0 ? cur.temp : (tempFloor() || 0);
    const parts = ["MMU_GATE_MAP GATE=" + g, "AVAILABLE=" + status, "SPEED=" + speed];
    if (temp > 0) parts.push("TEMP=" + temp);
    say("MMU_GATE_MAP GATE=" + g + " — " + (status ? "available" : "marked empty") + ", load speed " + speed + "%");
    return run(parts.join(" "), "Gate " + g + " updated");
  }

  /** The floor HH clamps gate temperatures to (mmu.default_extruder_temp), or null when config is not loaded. */
  function tempFloor() {
    const st = (raw().configfile || {}).settings || {};
    const v = ((st.mmu || {}).default_extruder_temp);
    return typeof v === "number" ? Math.round(v) : null;
  }

  /** Ask HH to rebuild its Spoolman cache and reconcile local/remote gate maps. */
  async function refreshSpoolman() {
    if (blocked()) return false;
    say("MMU_SPOOLMAN REFRESH=1 — rebuilding the Spoolman cache and syncing the gate map");
    return run("MMU_SPOOLMAN REFRESH=1", "Spoolman refreshed");
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
    mmuLoad, mmuUnload, mmuEject, mmuPreload, mmuRecover, mmuReset, cutFilament, formTip, mmuHome,
    servoPos, mmuStats, mmuSettings, editGateMap, setEndless,
    assignSpool, setGateLocal, refreshSpoolman, gateAttrs, tempFloor,
    mmuAction, mmuMenuAction,
    // design-name aliases
    loadSelector: mmuLoad, mmuServo: servoPos,
  };
}

export default makeMmuActions;
