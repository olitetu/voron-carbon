// Capability probing: "does this printer actually have this command?"
//
// `printer.gcode.commands` (see boot.js) is built by Klipper from every registered handler, so a
// single lookup answers for all three classes that `printer.objects.list` cannot distinguish:
//
//   [gcode_macro X]            SMART_HOME, EREC_CUTTER_ACTION, PRINT_START   (objects.list: yes)
//   native, from a section     QUAD_GANTRY_LEVEL, Z_OFFSET_APPLY_PROBE       (objects.list: NO)
//   Python-registered          MMU_UNLOAD, MMU_STATS, MMU_TEST_CONFIG        (objects.list: NO)
//
// Names are canonicalised to UPPER CASE on both sides. Klipper upper-cases a macro's alias
// (`gcode_macro.py`: `self.alias = name.upper()`) while `objects.list` preserves the config's
// casing — this printer has both `last_scrub`/`LAST_SCRUB` and `_KAMP_Settings`/`_KAMP_SETTINGS`,
// so a case-sensitive join returns false misses.

const up = n => String(n || "").trim().toUpperCase();

/** Is `name` a command this printer has registered? `null` = not known yet (catalogue not loaded). */
export function has(state, name) {
  const cmds = state && state.commands;
  if (!cmds) return null;                       // unknown -> callers should stay optimistic
  return Object.prototype.hasOwnProperty.call(cmds, up(name));
}

/** Klipper's own help text for a command, or null. Free label/tooltip copy for ~85% of commands. */
export function help(state, name) {
  const cmds = state && state.commands;
  if (!cmds) return null;
  const e = cmds[up(name)];
  const h = e && e.help;
  // Klipper's placeholder for a macro with no `description:` — not worth showing.
  return h && h !== "G-Code macro" ? h : null;
}

/** First name in `candidates` that exists; falls back to candidates[0] when nothing is known yet. */
export function pick(state, candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return null;
  if (!state || !state.commands) return list[0];
  for (const c of list) if (has(state, c)) return c;
  return null;
}

/**
 * The command name Klipper will dispatch for ONE physical line, derived step for step as this printer's
 * klippy/gcode.py (v0.13.0) _process_commands does it: cut at ';', upper-case, split on
 * args_r = ([A-Z_]+|[A-Z*]) keeping the captures, then
 *     if ''.join(parts[:2]) == 'N': cmd = ''.join(parts[3:5]).strip()    # skip a line number
 *     else:                         cmd = ''.join(parts[:3]).strip()
 * Text before the first letter is part of the name ('5G1' is the unknown command '5G1', and a bare '123' is
 * the unknown command '123'); a blank or comment-only line has no command ("").
 *
 * Splitting on whitespace or '=' instead gets the traditional form wrong: 'G1X10' is G1 and 'M104S200' is
 * M104, both valid and both sent that way by slicers, where a whitespace split yields 'G1X10' / 'M104S200' and
 * finds no such command. Extended commands come out whole ('MMU_LOAD GATE=1' -> 'MMU_LOAD'), because '_' is
 * in the name class.
 *
 * One quirk is kept on purpose: a traditional command followed by text with no second letter keeps that text
 * ('M117 50% DONE' -> 'M117 50%'). Klipper's cmd_default then re-splits on whitespace for M117/M118/M23 only;
 * that is dispatch, not naming, so it is left to the caller (see screen/actions.js missing()).
 */
const ARGS_R = /([A-Z_]+|[A-Z*])/;
export function klipperCommand(line) {
  let s = String(line == null ? "" : line).trim();
  const c = s.indexOf(";");
  if (c >= 0) s = s.slice(0, c);
  // JS split with a capturing group keeps the captures, exactly like Python's re.split.
  const parts = s.toUpperCase().split(ARGS_R);
  return (parts.slice(0, 2).join("") === "N" ? parts.slice(3, 5) : parts.slice(0, 3)).join("").trim();
}

/** Every command name, sorted — the autocomplete source for the console. */
export function allCommands(state) {
  const cmds = (state && state.commands) || null;
  return cmds ? Object.keys(cmds).sort() : [];
}
