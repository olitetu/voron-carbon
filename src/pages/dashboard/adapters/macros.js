// MACROS panel + macro-library picker — view-model keys from live store state.
// Emits ONLY: macros, macroCount, macroDotsStyle, macroPickerStyle, toggleMacroPicker, macroLibrary
// (`narrow`, also listed under MACROS in tools/panel-keys.json, is the shell's shared layout key.)
//
// Data flow
//   catalog        st.macros (public gcode_macro names from printer.objects.list, 71 on this printer), sorted
//   visible tiles  st.prefs.macros.keys  → else DEFAULT_MACRO_KEYS ∩ catalog
//   glyph / label  st.prefs.macros.meta[name].{g,t} → else defaultGlyph(name) / defaultLabel(name) (keyword rules below)
//   pending edits  ui.macroEdits[name].t while the label input is being typed in (debounced save)
//   persistence    ctx.act.savePrefs(macros)  (src/lib/actions/macros.js) — optimistic store update + Moonraker DB write
//   run            ctx.act.runMacro(name)      → api.gcode(name)
// Style strings are copied verbatim from the design's renderVals() (src/pages/dashboard/logic.jsx).

export const MAX_LABEL = 10;

// The design's icon palette — verbatim.
export const ICON_SET = ["⌂","✳","▦","⌖","◎","⇱","↧","⌁","⏻","⟳","⇄","◍","✂","⇲","⇮","⊙","⊘","≡","◐","⚑","♨","❄","⌾","⬒","✱","⭘","♪","⇉","◉","▲","◆","★","⚡","⌛","⎔","⌘"];

// Default tiles — the 20 most useful standalone macros present on this printer (read live from printer.objects.list).
// Names missing from the live catalog are simply skipped, so the list degrades gracefully on another config.
export const DEFAULT_MACRO_KEYS = [
  "SMART_HOME", "G32", "MESH_CALIBRATE", "BED_MESH_CALIBRATE", "CALIBRATE_CARTOGRAPHER",
  "BLOBIFIER", "BLOBIFIER_CLEAN", "BLOBIFIER_PARK",
  "MMU__UNLOAD", "MMU__EJECT", "MMU__HOME", "MMU__RECOVER", "MMU__PRELOAD", "MMU__CHECK_GATE", "MMU_CHECK_GATES",
  "MMU__SELECT_BYPASS", "MMU__MOTORS_OFF", "MMU_FORM_TIP", "MMU__STATUS", "MMU_COLD_PULL",
];

// Default glyph by keyword (CONTRACT "Macros"), most specific first so MMU_HOME wins over HOME, UNLOAD over LOAD, …
// Matched against the upper-cased name with runs of "_" collapsed (MMU__HOME → MMU_HOME).
const GLYPH_RULES = [
  [/MMU_HOME/, "⊙"],
  [/CHANGE_TOOL|SELECT_TOOL|^T\d+$/, "⇄"],
  [/GATE_MAP|TTG/, "≡"],
  [/CHECK_GATE/, "◐"],
  [/HOME|^C?G28$/, "⌂"],
  [/QGL|QUAD_GANTRY|^G32$/, "✳"],
  [/MESH/, "▦"],
  [/CALIBRATE|Z_OFFSET|PROBE/, "⌖"],
  [/PARK/, "⇱"],
  [/M84|MOTOR/, "⌁"],
  [/POWER|SHUTDOWN/, "⏻"],
  [/RESTART/, "⟳"],
  [/CLEAN|SCRUB/, "⌾"],
  [/PURGE|BLOBIFIER/, "◍"],
  [/CUT|FORM_TIP/, "✂"],
  [/UNLOAD|EJECT|COLD_PULL/, "⇲"],
  [/LOAD/, "⇮"],
  [/BYPASS/, "⇉"],
  [/RESET|RECOVER/, "⚑"],
  [/HEAT|SOAK/, "♨"],
  [/COOL/, "❄"],
  [/FAN/, "⬒"],
  [/FILTER|NEVERMORE/, "✱"],
  [/CANCEL|EXCLUDE|^M486$/, "⊘"],
  [/PAUSE/, "⌛"],
  [/RESUME/, "▲"],
  [/TIMELAPSE|HYPERLAPSE|STREAM|FRAME/, "◉"],
  [/SERVO/, "⎔"],
  [/STATUS|QUERY|SENSOR|^GET_/, "◎"],
];
const DEFAULT_GLYPH = "◆";

// Word abbreviations used when a spaced-out name does not fit in MAX_LABEL characters.
const ABBR = {
  CALIBRATE: "CAL", CALIBRATION: "CAL", CARTOGRAPHER: "CARTO", BLOBIFIER: "BLOB", TIMELAPSE: "TLAPSE", HYPERLAPSE: "HLAPSE",
  EXCLUDE: "EXCL", OBJECT: "OBJ", MATERIAL: "MAT", OFFSET: "OFS", PERMANENT: "PERM", STANDALONE: "SA", INITIAL: "INIT",
  TOOLHEAD: "TH", BUCKET: "BKT", SIMPLE: "SMPL", SELECT: "SEL", BYPASS: "BYP", RECOVER: "RECOV", CHECK: "CHK", QUERY: "QRY",
  PSENSOR: "PSENS", UPDATE: "UPD", HEIGHT: "HT", CHANGE: "CHG", STREAM: "STRM", DELAY: "DLY", CLEAR: "CLR", CUTTER: "CUT",
  ACTION: "ACT", DEFINE: "DEF", SETTINGS: "SET", MOTORS: "MOTOR", TEMPERATURE: "TEMP", FILAMENT: "FIL", EXTRUDER: "EXTR",
};
const FAMILY = new Set(["MMU", "BLOB", "BLOBIFIER"]);

// Hand-picked defaults where the generic rules read poorly (glyph and/or label). User overrides still win.
const CURATED = {
  CALIBRATE_CARTOGRAPHER: { t: "CARTO CAL" },
  Z_OFFSET_LEARN: { t: "Z LEARN" }, APPLY_MATERIAL_Z_OFFSET: { t: "Z APPLY" }, CLEAR_MATERIAL_Z_OFFSET: { t: "Z CLEAR" }, Z_OFFSET_SAVE_PERMANENT: { t: "Z SAVE" },
  TIMELAPSE_TAKE_FRAME: { t: "TL FRAME" }, TIMELAPSE_RENDER: { t: "TL RENDER" }, GET_TIMELAPSE_SETUP: { t: "TL SETUP" }, TEST_STREAM_DELAY: { t: "TL DELAY" },
  PRINT_READY: { t: "READY" }, PRINT_READY_SIMPLE: { t: "READY SMPL" }, PRINT_START: { t: "START" }, PRINT_END: { t: "END" }, PRINT_END_SIMPLE: { t: "END SMPL" },
  SET_PAUSE_NEXT_LAYER: { t: "PAUSE NEXT" }, SET_PAUSE_AT_LAYER: { t: "PAUSE AT" }, SET_PRINT_STATS_INFO: { t: "STATS INFO" },
  CANCEL_PRINT: { t: "CANCEL" }, VORON_PURGE: { t: "KAMP PURGE" }, TOOLHEAD_PARK_PAUSE_CANCEL: { t: "PARK TH" },
  EXCLUDE_OBJECT_DEFINE: { t: "EXCL DEF" }, EXCLUDE_OBJECT_START: { t: "EXCL START" },
  MMU_START_SETUP: { t: "MMU SETUP" }, MMU_START_CHECK: { t: "MMU CHECK" }, MMU_START_LOAD_INITIAL_TOOL: { t: "LOAD INIT" }, MMU_END: { t: "MMU END" },
  MMU_UPDATE_HEIGHT: { t: "UPD HEIGHT" }, MMU_QUERY_PSENSOR: { t: "PSENSOR" }, MMU_CHANGE_TOOL_STANDALONE: { t: "CHG TOOL" }, MMU_REMAP_TTG: { t: "TTG MAP" },
  MMU_RECOVER_STATE: { t: "RECOVER ST" }, MMU__SELECT_TOOL: { t: "SEL TOOL" }, MMU__SELECT_BYPASS: { t: "BYPASS" }, MMU__LOAD_BYPASS: { t: "LOAD BYP" },
  MMU__MOTORS_OFF: { t: "MOTORS OFF" }, MMU__HOME: { t: "MMU HOME" },
  MMU_FORM_TIP: { t: "TIP" }, EREC_CUTTER_ACTION: { t: "EREC CUT" },
  // Both are default tiles and sat side by side as "◐ CHECK GATE" / "◐ CHK GATES" — same glyph, same first
  // word, wildly different operations (the loaded gate vs. walking the selector across all eight). Named apart.
  MMU__CHECK_GATE: { t: "CHK GATE" }, MMU_CHECK_GATES: { t: "ALL GATES", g: "⭘" },
};

const str = v => String(v == null ? "" : v);

/** Default glyph for a macro name (user overrides are applied by macroMeta). */
export function defaultGlyph(name) {
  const raw = str(name);
  if (CURATED[raw] && CURATED[raw].g) return CURATED[raw].g;
  const n = raw.toUpperCase().replace(/_+/g, "_");
  for (const [re, g] of GLYPH_RULES) if (re.test(n)) return g;
  return DEFAULT_GLYPH;
}

/** Default tile label: strip MMU__, "_" → space, fit in MAX_LABEL chars (abbreviate → drop family prefix → cut). */
export function defaultLabel(name) {
  const raw = str(name);
  if (CURATED[raw] && CURATED[raw].t) return CURATED[raw].t;
  let words = raw.replace(/^MMU__/, "").toUpperCase().split("_").filter(Boolean);
  if (!words.length) return raw.toUpperCase().slice(0, MAX_LABEL) || "?";
  const join = ws => ws.join(" ");
  if (join(words).length <= MAX_LABEL) return join(words);
  const order = words.map((_, i) => i).sort((a, b) => words[b].length - words[a].length);
  for (const i of order) {
    if (!ABBR[words[i]]) continue;
    words = words.slice(); words[i] = ABBR[words[i]];
    if (join(words).length <= MAX_LABEL) return join(words);
  }
  if (words.length > 1 && FAMILY.has(words[0])) {
    words = words.slice(1);
    if (join(words).length <= MAX_LABEL) return join(words);
  }
  const cut = join(words).slice(0, MAX_LABEL);
  const sp = cut.lastIndexOf(" ");
  return (sp >= 3 ? cut.slice(0, sp) : cut).trim() || cut.trim() || "?";
}

/** Public macro names from the store, de-duplicated and sorted (numeric-aware: T0 … T7). */
export function macroCatalog(st) {
  const list = st && Array.isArray(st.macros) ? st.macros : [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const name = str(m).trim();
    if (!name || name.startsWith("_") || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

/** Stored macro prefs (sanitized): { keys?: string[], meta: {…} }. `keys` undefined → defaults apply. */
export function storedMacroPrefs(st, ui) {
  const src = (ui && ui.macroPrefs) || (st && st.prefs && st.prefs.macros) || {};
  const out = { meta: {} };
  if (Array.isArray(src.keys)) {
    const seen = new Set();
    out.keys = [];
    for (const k of src.keys) { const n = str(k).trim(); if (n && !seen.has(n)) { seen.add(n); out.keys.push(n); } }
  }
  if (src.meta && typeof src.meta === "object") {
    for (const [k, v] of Object.entries(src.meta)) {
      if (!v || typeof v !== "object") continue;
      const m = {};
      if (typeof v.g === "string" && v.g.trim()) m.g = v.g;
      if (typeof v.t === "string" && v.t.trim()) m.t = v.t.toUpperCase().slice(0, MAX_LABEL);
      if (Object.keys(m).length) out.meta[k] = m;
    }
  }
  return out;
}

/** The tile list to persist / display: stored keys, or the defaults present in the catalog. */
export function effectiveMacroKeys(st, ui, catalog) {
  const stored = storedMacroPrefs(st, ui);
  if (Array.isArray(stored.keys)) return stored.keys;
  const cat = new Set(catalog || macroCatalog(st));
  return DEFAULT_MACRO_KEYS.filter(k => cat.has(k));
}

/** Resolved glyph / label / command for one macro: pending edit → saved override → default. */
export function macroMeta(st, ui, name) {
  const stored = storedMacroPrefs(st, ui);
  const ov = stored.meta[name] || {};
  const pend = (ui && ui.macroEdits && ui.macroEdits[name]) || {};
  const g = typeof pend.g === "string" && pend.g ? pend.g : (ov.g || defaultGlyph(name));
  const t = pend.t !== undefined ? pend.t : (ov.t !== undefined ? ov.t : defaultLabel(name));
  return { g, t, cmd: name };
}

// Label typing is debounced into one prefs write; module-level because ctx (and its closures) is rebuilt every render.
// One timer PER MACRO: with a single shared timer, renaming a second macro inside the 600 ms window cancelled the
// first macro's write, and its typed label then sat in ui.macroEdits unsaved for ever — visible on the tile until
// the next reload (which, in Orca's Device tab, is seconds away) and then silently gone.
const SAVE_DEBOUNCE_MS = 600;
const labelTimers = new Map();
let warnedNoSave = false;

export function macrosVals(ctx) {
  const c = ctx || {};
  const st = c.st || {};
  const ui = c.ui || {};
  const set = typeof c.set === "function" ? c.set : () => {};
  const act = c.act || {};
  const log = typeof c.log === "function" ? c.log : () => {};
  const field = typeof c.field === "function" ? c.field : (key, shown) => ({ value: shown, dirty: false, onChange: () => {}, onBlur: () => {}, onKeyDown: () => {} });

  const catalog = macroCatalog(st);
  const catSet = new Set(catalog);
  const stored = storedMacroPrefs(st, ui);
  const keys = effectiveMacroKeys(st, ui, catalog);
  const visible = keys.filter(k => catSet.has(k));

  /** Persist a macros pref object through the actions layer (contract: act.savePrefs); session-only fallback otherwise. */
  const persist = macros => {
    if (typeof act.savePrefs === "function") return act.savePrefs(macros);
    set({ macroPrefs: macros });
    if (!warnedNoSave) { warnedNoSave = true; log("Macro prefs kept for this session only — savePrefs action not wired", "warn"); }
    return Promise.resolve(false);
  };
  // Prefs are always re-read from the live store at click/fire time (never from this render's snapshot), so a save
  // that landed milliseconds ago cannot be clobbered by a stale closure.
  const liveSt = () => (c.store && c.store.state) || st;
  const liveStored = () => storedMacroPrefs(liveSt(), ui.macroPrefs ? ui : null);
  const liveKeys = () => effectiveMacroKeys(liveSt(), ui.macroPrefs ? ui : null, catalog);
  const withMeta = (name, patch) => {
    const cur = liveStored();
    const m = Object.assign({}, cur.meta[name] || {});
    if (patch.g !== undefined) { if (patch.g) m.g = patch.g; else delete m.g; }
    if (patch.t !== undefined) { if (patch.t && patch.t.trim()) m.t = patch.t; else delete m.t; }
    const meta = Object.assign({}, cur.meta);
    if (Object.keys(m).length) meta[name] = m; else delete meta[name];
    return Object.assign({}, cur, { meta });
  };
  const toggleKey = name => {
    const cur = liveStored();
    const ks = liveKeys();
    const on = ks.indexOf(name) >= 0;
    return Object.assign({}, cur, { keys: on ? ks.filter(x => x !== name) : ks.concat([name]) });
  };
  /** Commit a typed label (debounced into one prefs write). */
  const scheduleLabelSave = (name, t) => {
    clearTimeout(labelTimers.get(name));
    labelTimers.set(name, setTimeout(() => {
      labelTimers.delete(name);
      Promise.resolve(persist(withMeta(name, { t }))).then(() => {
        // drop the pending edit only if nothing newer was typed meanwhile
        set(s => {
          const edits = (s && s.macroEdits) || {};
          const cur = edits[name];
          if (!cur || cur.t !== t) return null;
          const next = Object.assign({}, edits);
          const rest = Object.assign({}, cur); delete rest.t;
          if (Object.keys(rest).length) next[name] = rest; else delete next[name];
          return { macroEdits: next };
        });
      }).catch(() => { /* savePrefs already logs; a failed write must not surface as an unhandled rejection */ });
    }, SAVE_DEBOUNCE_MS));
  };
  const run = name => {
    if (typeof act.runMacro === "function") return act.runMacro(name);
    log("Macro actions not wired — " + name, "warn");
  };

  return {
    macros: visible.map(k => {
      const m = macroMeta(st, ui, k);
      return { g: m.g, t: m.t, run: () => run(k) };
    }),
    macroCount: visible.length + " / " + catalog.length,
    macroDotsStyle: `font-family:'JetBrains Mono',monospace; font-size:11px; cursor:pointer; margin-left:10px; color:${ui.macroPickerOpen ? "#e8eef6" : "#4d5a6b"}`,
    macroPickerStyle: ui.macroPickerOpen
      ? "padding:10px 12px; border-bottom:1px solid #161d27; background:#0a0e13; animation:vRise .18s ease both"
      : "display:none",
    toggleMacroPicker: () => set(s => ({ macroPickerOpen: !(s && s.macroPickerOpen) })),
    macroLibrary: catalog.map(k => {
      const on = keys.indexOf(k) >= 0;
      const m = macroMeta(st, ui, k);
      const picking = ui.iconPickFor === k;
      return {
        g: m.g, cmd: m.cmd, mark: on ? "✓" : "+",
        add: () => persist(toggleKey(k)),
        pickIcon: () => set(s => ({ iconPickFor: (s && s.iconPickFor) === k ? null : k })),
        iconBtnStyle: "width:22px; height:22px; flex:none; display:flex; align-items:center; justify-content:center; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:13px; color:#ff5a33; border:1px solid " +
          (picking ? "#8b98aa" : "#1c2430") + "; background:#0b0f15",
        cmdStyle: "font-family:'JetBrains Mono',monospace; font-size:8px; letter-spacing:.04em; color:#4d5a6b; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap",
        label: field("mn_" + k, m.t, () => {}),
        labelInput: e => {
          const t = str(e && e.target ? e.target.value : "").toUpperCase().slice(0, MAX_LABEL);
          set(s => ({ macroEdits: Object.assign({}, (s && s.macroEdits) || {}, { [k]: Object.assign({}, ((s && s.macroEdits) || {})[k], { t }) }) }));
          scheduleLabelSave(k, t);
        },
        labelValue: m.t,
        labelStyle: "width:74px; flex:none; background:#0b0f15; border:1px solid #1c2430; border-radius:3px; padding:2px 5px; outline:none; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.04em; color:#c9d3e0",
        markStyle: "width:18px; flex:none; text-align:center; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:10px; color:" +
          (on ? "#3ddcc4" : "#4d5a6b"),
        rowStyle: "display:flex; align-items:center; gap:7px; padding:4px 5px; border-radius:3px; background:" + (on ? "#0f151d" : "transparent"),
        paletteStyle: picking
          ? "display:grid; grid-template-columns:repeat(10,1fr); gap:3px; margin:2px 0 6px; padding:6px; border:1px solid #1c2430; border-radius:4px; background:#0b0f15; animation:vRise .14s ease both"
          : "display:none",
        palette: ICON_SET.map(g => ({
          g,
          set: () => { persist(withMeta(k, { g })); set({ iconPickFor: null }); },
          style: "aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:3px; cursor:pointer; font-family:'JetBrains Mono',monospace; font-size:12px; border:1px solid " +
            (m.g === g ? "#ff5a33" : "transparent") + "; color:" + (m.g === g ? "#ff5a33" : "#8b98aa")
        }))
      };
    })
  };
}

export default macrosVals;
