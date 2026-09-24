// ---------------------------------------------------------------------------
// Voron Carbon — the touchscreen glyph set.
//
// Replaces KlipperScreen's z-bolt icon theme, which disappears with it. Every
// glyph is drawn to the same rules as the macro icons in the design export:
//
//   viewBox   0 0 24 24          live area 3..21, optical centre 12,12
//   stroke    1.5, round cap + round join, NO fill
//   colour    inherited (currentColor) — the caller sets accent/dim/ghost
//   density   two to five strokes; anything busier stops reading at 24px
//
// Paths are COMPOSED from the helpers below rather than hand-typed, so a circle
// is the same circle everywhere and a spool is the same spool everywhere. That
// consistency is the whole point of an icon set; hand-typed arcs drift.
// ---------------------------------------------------------------------------

const n = v => (Math.round(v * 100) / 100).toString();

/** Closed circle, drawn as two half-arcs from the top — the export's own idiom. */
const circ = (cx, cy, r) =>
  `M${n(cx)} ${n(cy - r)}a${n(r)} ${n(r)} 0 1 0 0 ${n(2 * r)}a${n(r)} ${n(r)} 0 1 0 0 ${n(-2 * r)}`;

/** Rounded rectangle. */
const rect = (x, y, w, h, r = 0) => r
  ? `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}v${n(h - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}h${n(-(w - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}v${n(-(h - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}`
  : `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;

const line = (x1, y1, x2, y2) => `M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}`;

/** Chevron arrow head at (x,y) pointing 'up'|'down'|'left'|'right', half-width w. */
const head = (x, y, dir, w = 3.2) => ({
  up: `M${n(x - w)} ${n(y + w)}L${n(x)} ${n(y)}l${n(w)} ${n(w)}`,
  down: `M${n(x - w)} ${n(y - w)}L${n(x)} ${n(y)}l${n(w)} ${n(-w)}`,
  left: `M${n(x + w)} ${n(y - w)}L${n(x)} ${n(y)}l${n(w)} ${n(w)}`,
  right: `M${n(x - w)} ${n(y - w)}L${n(x)} ${n(y)}l${n(-w)} ${n(w)}`,
}[dir]);

/** Vertical arrow: shaft plus head. dir 1 = pointing down, -1 = pointing up. */
const arrowV = (x, y1, y2, dir = 1) =>
  `${line(x, y1, x, y2)}${head(x, y2, dir > 0 ? "down" : "up", 3)}`;

/** A filament spool: outer ring, hub, and the notch that reads as "wound". */
const spool = (cx, cy, r = 6) => `${circ(cx, cy, r)}${circ(cx, cy, r * 0.32)}`;

/** The 3-gate row that means "MMU" throughout the set. */
const gateRow = (cy, r = 2.2, xs = [6, 12, 18]) => xs.map(x => circ(x, cy, r)).join("");

const I = {};
const def = (name, d) => { I[name] = d; };

// --- shell / navigation ----------------------------------------------------
def("home",      `M3 11.5 12 4l9 7.5M6 10.2v9.8h12v-9.8M10.2 20v-5h3.6v5`);
def("back",      `${line(20, 12, 5, 12)}${head(5, 12, "left", 4)}`);
def("forward",   `${line(4, 12, 19, 12)}${head(19, 12, "right", 4)}`);
def("close",     `M6 6l12 12M18 6L6 18`);
def("menu",      `M4 7h16M4 12h16M4 17h16`);
def("more",      `${circ(5.5, 12, 1)}${circ(12, 12, 1)}${circ(18.5, 12, 1)}`);
def("check",     `M4.5 12.5l5 5L20 7`);
def("alert",     `M12 3.5 22 20H2zM12 10v4.6M12 17.4h.01`);
def("info",      `${circ(12, 12, 8.5)}M12 11v5.5M12 7.8h.01`);
def("refresh",   `M20.5 12a8.5 8.5 0 1 1-2.9-6.4M20.5 3.5V9H15`);
def("power",     `M12 3v8.5M7.5 6.5a7 7 0 1 0 9 0`);
def("stop",      `${rect(6, 6, 12, 12, 1.5)}`);
def("settings",  `${circ(12, 12, 3.2)}M12 2.6v2.6M12 18.8v2.6M21.4 12h-2.6M5.2 12H2.6M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8M18.6 18.6l-1.8-1.8M7.2 7.2 5.4 5.4`);
def("keyboard",  `${rect(2.5, 6.5, 19, 11, 1.8)}M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.4h.01M9.5 13.4h.01M13 13.4h.01M16.5 13.4h.01M8.5 16.4h7`);

// --- printer ---------------------------------------------------------------
def("nozzle",    `M9 3.5h6v6l2 4-5 7-5-7 2-4z`);
def("bed",       `M3.5 16h17M6 19.6h12M7.2 12c1.4-2.4 2.8-2.4 4.2 0s2.8 2.4 4.2 0M7.2 7.4c1.4-2.4 2.8-2.4 4.2 0s2.8 2.4 4.2 0`);
def("chamber",   `${rect(4, 8.5, 16, 12, 1.5)}M8 5.6c.9-1.6 1.8-1.6 2.7 0M13.3 5.6c.9-1.6 1.8-1.6 2.7 0`);
def("fan",       `${circ(12, 12, 2)}M12 10c0-4 1.2-6 3-6s2.6 3.4-.4 5.2M14 12c3.5 2 5.4 1.6 6.3 0s-1.4-3.6-4.4-2.6M12 14c0 4-1.2 6-3 6s-2.6-3.4.4-5.2M10 12c-3.5-2-5.4-1.6-6.3 0s1.4 3.6 4.4 2.6`);
def("led",       `M12 3.5a5.6 5.6 0 0 0-3.3 10.1v2.6h6.6v-2.6A5.6 5.6 0 0 0 12 3.5M10 19.6h4M10.6 21.5h2.8`);
def("camera",    `${rect(2.5, 6.5, 19, 12, 2)}${circ(12, 12.5, 3.4)}M8.6 6.5l1.4-2.4h4l1.4 2.4`);
def("file",      `M6 3.5h7.5L18 8v12.5H6zM13.2 3.6V8H17.8`);
def("folder",    `M3 6.5h6l2 2.4h10v11H3z`);
def("print",     `M8 5l11 7-11 7z`);
def("pause",     `M9 5v14M15 5v14`);
def("resume",    `M6 5v14M11 5l10 7-10 7z`);
def("cancel",    `${circ(12, 12, 8.5)}M9 9l6 6M15 9l-6 6`);
def("macro",     `M8.5 4.5H6.5a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2M15.5 4.5h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2`);
def("console",   `M4.5 6.5l5 5.5-5 5.5M12 17.5h7.5`);
def("wifi",      `M2.6 8.8a14 14 0 0 1 18.8 0M5.9 12.4a9.2 9.2 0 0 1 12.2 0M9.2 16a4.5 4.5 0 0 1 5.6 0M12 19.6h.01`);
def("wifiOff",   `M2.6 8.8a14 14 0 0 1 6-3.4M14.4 5.6a14 14 0 0 1 7 3.2M9.2 16a4.5 4.5 0 0 1 5.6 0M12 19.6h.01M3.5 3.5l17 17`);
def("update",    `M12 3.5v10M8.6 10.2 12 13.6l3.4-3.4M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5`);
def("bell",      `M12 3.2a6 6 0 0 0-6 6c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5a6 6 0 0 0-6-6M10.3 19.5a2 2 0 0 0 3.4 0`);
def("history",   `M3.6 12a8.4 8.4 0 1 0 2.5-6M3.5 4.5V10H9M12 7.5V12l3.2 2`);
def("clock",     `${circ(12, 12, 8.5)}M12 7.2V12l3.2 2`);
def("save",      `M5 5h11l3 3v11H5zM8.6 5v5h6.6V5M8 14h8v5H8z`);
def("graph",     `M4 4v16h16M7.5 16l3.5-4.5 3 3L19 8`);

// --- motion ----------------------------------------------------------------
def("move",      `M12 3.5v17M3.5 12h17${head(12, 3.5, "up", 2.6)}${head(12, 20.5, "down", 2.6)}${head(3.5, 12, "left", 2.6)}${head(20.5, 12, "right", 2.6)}`);
def("homeAxes",  `M3 11.5 12 4l9 7.5M6 10.2v9.8h12v-9.8M9.6 16.4l2 2 3.6-3.6`);
def("homeXY",    `M12 4.5v15M4.5 12h15M4.5 8.2V4.5H8.2`);
def("homeZ",     `M12 20.5V4.5M8.6 7.9 12 4.5l3.4 3.4M8 20.5h8`);
def("qgl",       `${rect(4, 6, 16, 12, 1)}${circ(7.6, 9.6, 1)}${circ(16.4, 9.6, 1)}${circ(7.6, 14.4, 1)}${circ(16.4, 14.4, 1)}M10.4 12h3.2`);
def("mesh",      `M4 5h16v14H4zM4 9.7h16M4 14.3h16M9.3 5v14M14.7 5v14`);
def("probe",     `M10 4h4l1 8-3 4.5-3-4.5zM4.5 20.5h15M12 16.5v4`);
def("zOffset",   `M12 3.5v9M8.6 9.1 12 12.5l3.4-3.4M4.5 16.5h15M7 20.4h10`);
def("limits",    `M4 19.5 20 4.5M4 19.5h16M4 19.5V4.5M7.5 16v-3.5M11 12.5V9M14.5 9V5.5`);
def("shaper",    `M3 12c1.6-8 3.2-8 4.8 0s3.2 6 4.8 0 3.2-4 4.8 0 2.6 3 4.6 0`);
def("motorsOff", `${circ(12, 12, 5.2)}M12 3.6v3.2M12 17.2v3.2M20.4 12h-3.2M6.8 12H3.6M4 4l16 16`);

// --- temperature -----------------------------------------------------------
def("heat",      `M12 4v8.4M12 12.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 1 0 0-7.2M16.6 5.2c1.5 1.6 3 1.6 4.5 0M16.6 9.2c1.5 1.6 3 1.6 4.5 0`);
def("cool",      `M12 3.4v17.2M4.6 7.7l14.8 8.6M4.6 16.3l14.8-8.6`);
def("target",    `${circ(12, 12, 8.4)}${circ(12, 12, 3.4)}M12 12h.01`);

// --- MMU / Happy Hare ------------------------------------------------------
def("mmu",       `${gateRow(9.5)}M3 19.6h18M6 12v4M12 12v4M18 12v4`);
def("gate",      `${circ(12, 10, 5.2)}${circ(12, 10, 1.6)}M7 19.6h10`);
def("gateEmpty", `${circ(12, 10, 5.2)}M9 19.6h6M8.4 6.4l7.2 7.2`);
def("gateLoaded",`${circ(12, 9.4, 5.2)}${circ(12, 9.4, 1.6)}${arrowV(12, 15.4, 20.6, 1)}`);
def("selector",  `M3 18.5h18M12 18.5v-5.4M8.6 13.1 12 9.7l3.4 3.4`);
def("servoUp",   `${circ(12, 13.5, 1.7)}M12 13.5 19 7.8M6.5 20.4h11M4.8 13.5a7.2 7.2 0 0 1 2.6-5.5`);
def("servoDown", `${circ(12, 10.5, 1.7)}M12 10.5 19 16.2M6.5 20.4h11M4.8 10.5a7.2 7.2 0 0 0 2.6 5.5`);
def("encoder",   `${circ(12, 12, 7.6)}${circ(12, 12, 2)}M12 4.4v2.6M12 17v2.6M4.4 12H7M17 12h2.6`);
def("cutter",    `M7 3.6l10 12M17 3.6l-10 12${circ(6, 18.8, 2.3)}${circ(18, 18.8, 2.3)}`);
def("bypass",    `M3 16h4M17 16h4M7 16a5 5 0 0 1 10 0${circ(12, 16, 1.5)}`);
def("ttg",       `M4 8.5h12M4 8.5l3-3M4 8.5l3 3M20 15.5H8M20 15.5l-3-3M20 15.5l-3 3`);
def("gateMap",   `${rect(3.5, 4.5, 6, 6, 1)}${rect(3.5, 13.5, 6, 6, 1)}M13 7.5h7.5M13 16.5h7.5M13 10.5h4.5M13 19.5h4.5`);
def("endless",   `M8 8.5a4 4 0 1 0 0 7h8a4 4 0 1 0 0-7zM12 6.5v11`);
def("sync",      `M6.5 9.5a5.5 5.5 0 0 1 9.4-2.4M17.5 14.5a5.5 5.5 0 0 1-9.4 2.4M15.9 3.4v3.7h-3.7M8.1 20.6v-3.7h3.7`);
def("syncOff",   `M6.5 9.5a5.5 5.5 0 0 1 4-4.9M17.5 14.5a5.5 5.5 0 0 1-4 4.9M4 4l16 16`);
def("clog",      `M3 12h5.5M15.5 12H21M12 4.5v3.2M12 16.3v3.2${circ(12, 12, 3.4)}M9.6 9.6l4.8 4.8`);
def("load",      `${arrowV(12, 3.6, 13, 1)}M8.6 16.4h6.8l-1.2 5.6h-4.4z`);
def("unload",    `${arrowV(12, 13, 3.6, -1)}M8.6 16.4h6.8l-1.2 5.6h-4.4z`);
def("eject",     `M12 4.2l6.6 8.6H5.4zM6.5 17.6h11M6.5 20.8h11`);
def("preload",   `${circ(12, 15.4, 4)}M12 15.4h.01M12 3.2v7.6M9.2 8 12 10.8 14.8 8`);
def("checkGate", `${circ(12, 10, 5.2)}M9.4 10l1.9 1.9 3.4-3.6M7 19.6h10`);
def("mmuHome",   `${gateRow(11)}M3 19.6h18M6 4.4 3.5 7h5z`);
def("recover",   `M20.4 12a8.4 8.4 0 1 1-2.9-6.3M20.4 3.6V9h-5.4M12 8.6v4.4M12 16.2h.01`);
def("unlock",    `${rect(5.5, 10.5, 13, 9, 1.5)}M8.8 10.5V7.8a3.2 3.2 0 0 1 6.4 0M12 14v2.6`);
def("stats",     `M4.5 20V11M9.5 20V4.5M14.5 20v-6M19.5 20V8`);
def("reset",     `M3.6 12a8.4 8.4 0 1 0 2.5-6M3.5 4.5V10H9M9.6 12l4.8 4.8M14.4 12l-4.8 4.8`);
def("calibrate", `M12 3.4v17.2M8.6 3.4h6.8M6.4 7.6h11.2M6.4 12h11.2M6.4 16.4h11.2`);
def("formTip",   `M12 3.6v8.4M9.6 12h4.8l-1.2 8.4h-2.4z`);
def("purge",     `M12 3.4c2.2 4 4.2 5.4 4.2 7.6a4.2 4.2 0 1 1-8.4 0c0-2.2 2-3.6 4.2-7.6M5 16.4h14l-1.4 5H6.4z`);
def("coldPull",  `M12 20.4v-8.4M9.6 12h4.8l-1.2-8.4h-2.4zM4.6 16.8l2.4-1M19.4 16.8l-2.4-1`);
def("tension",   `M3.5 12h4M16.5 12h4M7.5 12l2-3.5 2.5 7 2.5-7 2 3.5`);
def("compression",`M3.5 12h5M15.5 12h5M8.5 8.5v7M15.5 8.5v7M10.6 12h2.8`);
def("buffer",    `M3 6.5h11a3.5 3.5 0 0 1 0 7H7a3.5 3.5 0 0 0 0 7h14`);
def("toolChange",`${circ(7.5, 8.5, 3)}${circ(16.5, 15.5, 3)}M11 8.5h5.5v3.5M13 15.5H7.5V12`);
def("drying",    `${rect(4, 9, 16, 11.5, 1.5)}M8 6.2c.9-1.6 1.8-1.6 2.7 0M13.3 6.2c.9-1.6 1.8-1.6 2.7 0M8 2.8c.9-1.6 1.8-1.6 2.7 0M13.3 2.8c.9-1.6 1.8-1.6 2.7 0`);
def("runout",    `${circ(12, 8.5, 4.4)}M12 12.9v4.4M9.6 20.4h4.8M4.5 4.5l15 15`);
def("spool",     `${spool(12, 12, 7)}`);
def("spoolman",  `${spool(9, 12, 5.4)}M17 6.5v11M15 6.5h4M15 17.5h4`);
def("filament",  `M12 3.5v13.4M9.4 16.9h5.2l-1.1 4.6h-3z`);
def("tool",      `M6 4.5h12v6l-3.5 4v6h-5v-6L6 10.5z`);

export const ICONS = I;
export const ICON_NAMES = Object.keys(I).sort();

/** Render props for an <svg> — the caller supplies size and colour. */
export function iconProps(name) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
}
export function iconPath(name) { return I[name] || I.info; }
