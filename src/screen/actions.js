// ---------------------------------------------------------------------------
// Carbon Screen — the command layer.
//
// Every screen sends g-code through here rather than calling api.gcode directly,
// because three things have to be got right every single time and none of them
// are obvious at the call site.
//
// 1. THE 30 SECOND LIE.
//    src/lib/moonraker.js rpc() rejects with "timeout: <method>" after 30 s and
//    drops the pending id. printer.gcode.script only answers when the script
//    FINISHES, so MMU_LOAD, MMU_CHECK_GATES, BED_MESH_CALIBRATE,
//    QUAD_GANTRY_LEVEL, SMART_HOME, CALIBRATE_CARTOGRAPHER, PID_CALIBRATE and
//    SHAPER_CALIBRATE all reject while still happily running. Reporting that as
//    a failure is worse than useless: the user cancels or retries a move that is
//    still in progress. For a known-long command a timeout means "still running".
//
// 2. GUARDS. A one-tap command that ruins an eight-hour print needs a reason to
//    refuse, not a confirm the user learns to tap through.
//
// 3. TWO COMMANDS IN THE DESIGN ARE WRONG. See mmuRecover() and setGateMap().
// ---------------------------------------------------------------------------

import { klipperCommand } from "../lib/caps.js";

/** Commands whose script legitimately runs past the 30 s rpc window. */
const LONG = [
  /^MMU_(LOAD|UNLOAD|EJECT|PRELOAD|CHECK_GATES?|HOME|SELECT|CHANGE_TOOL|COLD_PULL|CALIBRATE)/i,
  /^BED_MESH_CALIBRATE/i, /^QUAD_GANTRY_LEVEL/i, /^SMART_HOME/i, /^G32\b/i, /^G28\b/i,
  /^CALIBRATE_CARTOGRAPHER/i, /^PID_CALIBRATE/i, /^MPC_CALIBRATE/i, /^SHAPER_CALIBRATE/i,
  /^TEST_RESONANCES/i, /^BLOBIFIER/i, /^CLEAN_NOZZLE/i, /^T\d+\b/i, /^SCREWS_TILT/i,
];
const isLong = script => LONG.some(re => re.test(String(script).trim()));
/**
 * Klipper's cmd_default re-dispatches these when the parsed name carries text: 'M117 50% DONE' parses as
 * 'M117 50%' (no letter after the 50%), and gcode.py then runs M117 with it ("Handle M117/M118/M23 gcode with
 * numeric and special characters"). Every other name with a space in it is an unknown command.
 */
const REDISPATCHED = new Set(["M117", "M118", "M23"]);
const isTimeout = e => /^timeout:/i.test((e && e.message) || "");

export function makeActions({ api, store, log = () => {} }) {
  /** Commands currently in flight, so the UI can lock and show progress. */
  const busy = new Set();
  const emitBusy = () => store.set({ busy: [...busy] });

  /**
   * Send a script. Resolves {ok, running} rather than throwing on the 30 s
   * timeout of a long command.
   * @returns {Promise<{ok:boolean, running:boolean, error?:string}>}
   */
  async function run(script, { quiet = false } = {}) {
    const key = String(script).trim().split(/\s+/)[0];
    busy.add(key); emitBusy();
    if (!quiet) log(script, "info");
    try {
      await api.gcode(script);
      if (!quiet) log(`${key} ok`, "ok");
      return { ok: true, running: false };
    } catch (e) {
      if (isTimeout(e) && isLong(script)) {
        // Not a failure. The script is still executing; its own responses and
        // the object model will report what happens next.
        log(`${key} is still running`, "info");
        return { ok: true, running: true };
      }
      const msg = (e && e.message) || String(e);
      log(msg, "err");
      return { ok: false, running: false, error: msg };
    } finally {
      busy.delete(key); emitBusy();
    }
  }

  const st = () => store.state;
  const raw = () => store.state.raw || {};

  /**
   * Does this printer actually have the command?
   *
   * `printer.gcode.commands` is Klipper's own registry of every registered handler
   * -- 370 of them here -- so it covers all three classes printer.objects.list
   * cannot: [gcode_macro X], natives from config sections (QUAD_GANTRY_LEVEL,
   * TURN_OFF_HEATERS), and Python-registered commands (MMU_*). boot.js latches it
   * while klippy is ready.
   *
   * This exists because the design export shipped a CLEAN NOZZLE button and this
   * printer has no CLEAN_NOZZLE at all -- the equivalent is BLOBIFIER_CLEAN. A
   * button whose command does not exist is a dead end, and the catalogue is the
   * only way to know that before the user taps it.
   */
  function missing(script) {
    const cmds = st().commands;
    // No catalogue yet: try anyway. Refusing everything because we have not learned
    // the command list is worse than letting Klipper answer.
    if (!cmds) return null;
    for (const line of String(script).split("\n")) {
      // The name Klipper itself derives (lib/caps.js klipperCommand), so 'G1X10' and 'M104S200' are G1 and
      // M104. A whitespace split read them as 'G1X10' / 'M104S200' and refused valid g-code as unknown.
      let name = klipperCommand(line);
      if (!name) continue;                       // blank or comment-only: Klipper runs nothing
      if (/\s/.test(name)) {
        const head = name.split(/\s+/)[0];
        if (REDISPATCHED.has(head)) name = head;
      }
      if (!Object.prototype.hasOwnProperty.call(cmds, name)
        && !Object.prototype.hasOwnProperty.call(cmds, name.toLowerCase())) return name;
    }
    return null;
  }
  function has(script) { return !missing(script); }

  /** Reasons to refuse, in the user's words. null = allowed. */
  function blocked(what, script) {
    const s = st();
    if (!s.connected) return "Moonraker is not connected";
    if (s.klippy !== "ready") return `Klipper is ${s.klippy}`;
    if (script) {
      const gone = missing(script);
      if (gone) return `this printer has no ${gone}`;
    }
    const jobState = (raw().print_stats || {}).state;
    const paused = !!(raw().pause_resume || {}).is_paused;
    if (what.whilePrinting === false && jobState === "printing" && !paused) return "not while printing";
    // whilePrinting:false deliberately lets a PAUSED job through (unload, purge, recover all happen there).
    // For a command that changes the rest of that job or the space above the part -- a mesh load, a Z offset
    // save, a calibration probe, SAVE_CONFIG -- a pause is still a print. Both flags are read: print_stats says
    // "paused" for a virtual_sdcard job, and pause_resume.is_paused is set by PAUSE itself, which also covers a
    // pause taken with no virtual_sdcard job running (pause_resume.py sends "action:paused" to the host then).
    if (what.notWhilePaused && (jobState === "paused" || paused)) return "not while a print is paused";
    if (what.needsHomed && String((raw().toolhead || {}).homed_axes || "") !== "xyz") return "home the printer first";
    if (what.needsHot && !(raw().extruder || {}).can_extrude) return "hotend is below the minimum extrude temperature";
    if (what.needsMmu && !raw().mmu) return "no MMU on this printer";
    if (what.needsMmuIdle && (raw().mmu || {}).action !== "Idle") return `MMU is ${(raw().mmu || {}).action}`;
    return null;
  }

  /** Run only if allowed; otherwise log the reason and return it. */
  async function guarded(script, guards = {}) {
    const why = blocked(guards, script);
    if (why) { log(`${String(script).split(/\s+/)[0]} refused — ${why}`, "warn"); return { ok: false, refused: why }; }
    return run(script);
  }

  /** Say no with a reason, without pretending to send anything. */
  function refuse(what, why) {
    log(`${what} refused — ${why}`, "warn");
    return { ok: false, refused: why };
  }

  return {
    run, guarded, blocked, refuse, isLong, has, missing,
    // The command log itself, for work that does not go through run(): makeConsoleActions,
    // makeMachineActions, makeHistoryActions and friends call api.* directly and take a log(msg, kind).
    // Handing them this one puts their intent and outcome in st.screenLog; warn/err still reach the toast.
    log,
    /**
     * Optimistic update: merge a partial status into the store now, ahead of Klipper's next report
     * (Store.predict -> mergeStatus, the dashboard's path). The next real notify_status_update overwrites it,
     * so a wrong guess lasts one status tick, not forever.
     */
    predict: patch => store.predict(patch),

    // ---- Happy Hare ------------------------------------------------------
    /**
     * Tell Happy Hare the true filament state after an error.
     *
     * The design export sends `MMU_RECOVER FILAMENT_POS=1|0`. That parameter DOES
     * NOT EXIST: HH v3.4.2's cmd_MMU_RECOVER reads TOOL, GATE, BYPASS, LOADED and
     * STRICT only, so the design's command is a silent no-op at exactly the moment
     * recovery is needed. The parameter is LOADED.
     */
    mmuRecover({ loaded, tool, gate, strict } = {}) {
      const p = [];
      if (loaded !== undefined) p.push(`LOADED=${loaded ? 1 : 0}`);
      if (tool !== undefined) p.push(`TOOL=${tool}`);
      if (gate !== undefined) p.push(`GATE=${gate}`);
      if (strict !== undefined) p.push(`STRICT=${strict ? 1 : 0}`);
      return run(`MMU_RECOVER${p.length ? " " + p.join(" ") : ""}`);
    },

    /**
     * Edit one gate's map entry.
     *
     * HAZARD: HH v3.4.2 does `temperature = gcmd.get_int('TEMP', int(self.default_extruder_temp))`,
     * and default_extruder_temp is 200. So ANY MMU_GATE_MAP write that omits TEMP
     * silently rewrites that gate's temperature to 200 — on this printer that would
     * quietly drop gate 7 from 250 to 200 and under-heat every print from it. The
     * HH wiki's parameter list does not mention TEMP at all; the source does.
     * Therefore: always send TEMP, defaulting to the gate's CURRENT value.
     */
    setGateMap(gate, patch = {}) {
      // v3.4.2 keeps every attribute the command omits (name, material, color, spool id, speed, availability:
      // `x if x is not None else self.gate_x[gate]`) EXCEPT temperature, whose default is 200. So send GATE, TEMP
      // and only what actually changes. Re-sending the rest was worse than redundant: Klipper splits parameters
      // on whitespace, so a filament name with a space in it would have mangled the whole command.
      const m = raw().mmu || {};
      const temp = patch.temp != null ? patch.temp : (m.gate_temperature || [])[gate];
      const p = [`GATE=${gate}`];
      if (temp != null) p.push(`TEMP=${Math.round(temp)}`);          // never omit — see above
      if (patch.material) p.push(`MATERIAL=${String(patch.material).replace(/\s+/g, "_")}`);
      if (patch.color) p.push(`COLOR=${String(patch.color).replace(/^#/, "")}`);
      if (patch.spoolId != null) p.push(`SPOOLID=${patch.spoolId}`);
      // Single-gate MMU_GATE_MAP reads AVAILABLE, not STATUS (cmd_MMU_GATE_MAP: gcmd.get_int('AVAILABLE', ...)).
      // Klipper ignores a parameter no handler reads, so the old STATUS= was silently dropped.
      if (patch.status != null) p.push(`AVAILABLE=${patch.status}`);
      return run(`MMU_GATE_MAP ${p.join(" ")}`);
    },

    /** Endless spool is GROUPS, not a per-gate pointer. Gates sharing a number are fallbacks. */
    setEndlessGroups(groups) {
      return run(`MMU_ENDLESS_SPOOL ENABLE=1 GROUPS=${groups.join(",")}`);
    },
  };
}
