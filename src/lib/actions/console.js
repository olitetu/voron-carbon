// Console actions — CONTRACT: sendConsole(text): api.gcode(text). The command is echoed into the console log first
// (the design's `pushLog("› " + v)`), then sent; errors are logged as 'err' and nothing throws. No code runs at import.
//
// Usage (integrator): const act = { ...makeConsoleActions({ api, store, log }), ...otherPanelActions };
//
// Three commands are routed to their dedicated Moonraker endpoints instead of the gcode queue, because that is what a
// user typing them in a console needs when Klipper is wedged (a long macro or a shutdown blocks printer.gcode.script):
//   M112             → api.emergencyStop()      (printer.emergency_stop)
//   FIRMWARE_RESTART → api.firmwareRestart()    (printer.firmware_restart)
//   RESTART          → api.printerRestart()     (printer.restart)
// Everything else, including multi-line scripts pasted into the input, goes through api.gcode(script).

const ESTOP_RE = /^M112\b/i;
const FW_RESTART_RE = /^FIRMWARE_RESTART\s*$/i;
const RESTART_RE = /^RESTART\s*$/i;

export function makeConsoleActions({ api, store, log } = {}) {
  const say = (msg, kind) => { try { if (typeof log === "function") log(msg, kind || "info"); } catch {} };
  const klippy = () => (store && store.state ? store.state.klippy : undefined);

  /** Send one console line. Resolves true when Moonraker accepted it, false otherwise (already logged). */
  async function sendConsole(text) {
    const script = String(text == null ? "" : text).trim();
    if (!script) return false;
    say("› " + script, "info");
    if (!api || typeof api.gcode !== "function") { say("Not connected to Moonraker", "err"); return false; }
    try {
      if (ESTOP_RE.test(script)) {
        // printer.emergency_stop takes no script, so a pasted block that STARTS with M112 loses its
        // remaining lines. Halting is still the right call — say so rather than dropping them silently.
        const extra = script.split(/\r?\n/).length > 1 ? " (the rest of the pasted script was not sent)" : "";
        if (typeof api.emergencyStop === "function") await api.emergencyStop(); else await api.gcode(script);
        say("Emergency stop sent — FIRMWARE_RESTART required to recover" + extra, "warn");
        return true;
      }
      // Both restart endpoints answer by dropping the websocket, so Klipper never echoes anything for
      // them: without a line here the console just goes quiet and the command looks like it was eaten.
      if (FW_RESTART_RE.test(script) && typeof api.firmwareRestart === "function") {
        await api.firmwareRestart(); say("Firmware restart requested — Klipper will reconnect in a few seconds", "warn"); return true;
      }
      if (RESTART_RE.test(script) && typeof api.printerRestart === "function") {
        await api.printerRestart(); say("Restart requested — Klipper will reconnect in a few seconds", "warn"); return true;
      }
      await api.gcode(script);
      return true;
    } catch (err) {
      let msg = (err && err.message) || String(err);
      const k = klippy();
      if (k && k !== "ready" && !/klipp/i.test(msg)) msg += " — Klipper is " + k + (k === "shutdown" ? " (FIRMWARE_RESTART required)" : "");
      say(msg, "err");
      return false;
    }
  }

  return { sendConsole };
}

export default makeConsoleActions;
