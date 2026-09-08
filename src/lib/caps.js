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

/** Every command name, sorted — the autocomplete source for the console. */
export function allCommands(state) {
  const cmds = (state && state.commands) || null;
  return cmds ? Object.keys(cmds).sort() : [];
}
