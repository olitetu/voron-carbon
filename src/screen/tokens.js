// ---------------------------------------------------------------------------
// Carbon Screen — design tokens for the printer's own 1024x600 panel.
//
// SEPARATE from src/lib/design.jsx on purpose. That file holds the DESKTOP
// dashboard's vocabulary (T.panel = #0d121a, 9-10px micro-labels, 3-6px radii).
// The touchscreen design is a different, darker palette on a smaller canvas with
// a legibility floor, so it gets its own tokens rather than bending the shared ones.
//
// Every colour here is copied verbatim from the KlipperScreen design export
// ("Voron KlipperScreen.dc.html"). Do not "improve" them.
// ---------------------------------------------------------------------------

/** Panel geometry. Measured from the machine, not chosen: KlipperScreen.log reports
 *  `Screen 0: 1024x600` on every restart, on a 7" panel => 0.1498 mm/px, 169.6 PPI. */
export const PANEL = { w: 1024, h: 600, mmPerPx: 0.1498, ppi: 169.6 };

export const C = {
  // grounds
  bg: "#06080b", void_: "#04060a",
  panel: "#0b0f15", panelHead: "#0d121a", panelSunk: "#0a0e13", raised: "#11171f",
  track: "#101720", barBg: "#090c11",
  // hairlines, dimmest first
  line0: "#0f151e", line1: "#131a24", line2: "#161d27", line3: "#1c2430", line4: "#24303f", line5: "#2a3648",
  // ink, brightest first
  text: "#e8eef6", body: "#c9d3e0", dim: "#8b98aa", mute: "#6b7789", faint: "#4d5a6b",
  ghost: "#3d4859", ghost2: "#2e3846",
  // meaning
  accent: "#ff5a33", accentLit: "#ff7d5c", hot: "#ff8f6b", bed: "#f0b429", cool: "#3ddcc4",
  // tinted surfaces used for on/active states
  accentBg: "#1d0e08", accentBg2: "#1a0c08", accentLine: "#4a1d13",
  okBg: "#07231d", okLine: "#114339",
  warnBg: "#231604", warnLine: "#4a3a10",
  offBg: "#12161d",
  selBg: "#150b07", rowOn: "#0f151d", navOn: "#0f1620",
  mono: "'JetBrains Mono',monospace", sans: "Barlow, system-ui, sans-serif",
};

/** Type scale for a 7" 1024x600 panel at ~450 mm.
 *  JetBrains Mono cap height is 0.73em, so 12px => 1.31 mm cap => ~10 arcmin, which is what
 *  KlipperScreen's own 22.2px GTK text achieves here. 12px is therefore the FLOOR: the design
 *  export's 8/9/9.5/10px sizes are all below it and must not be used.
 *
 *  F is scalable at runtime (the SETTINGS screen's font-size control) but every value is clamped
 *  to the floor, so turning the scale down can never make a label illegible -- it only tightens
 *  the sizes that have headroom. That is also why there is no SMALL: below 1.0 the micro-labels
 *  are already at the floor and nothing moves, so the control would lie about what it does.
 */
const BASE_F = {
  micro: 12,   // mono caps micro-label (was 10 in the 1280x800 export)
  label: 13,   // chip / button label
  chip: 14,    // emphasised chip
  body: 15,    // inline value
  val: 16,     // value
  num2: 20,    // secondary numeric
  num1: 26,    // primary numeric
  hero: 34,    // temp card
  giant: 48,   // temp screen headline (68 in the export is 11% of a 600px screen)
};

/** Minimum size below which text must not be used on this panel. */
export const F_FLOOR = 12;

/** Named scales offered by SETTINGS. See the note on BASE_F for why SMALL is absent. */
export const FONT_SCALES = { MEDIUM: 1, LARGE: 1.14, XL: 1.28 };
let _scale = 1;

/** Live type scale. Reading F.micro always returns the current, clamped size. */
export const F = {};
for (const k of Object.keys(BASE_F)) {
  Object.defineProperty(F, k, {
    enumerable: true,
    get() { return Math.max(F_FLOOR, Math.round(BASE_F[k] * _scale)); },
  });
}
/** Returns true when the scale actually changed, so the caller knows to re-render. */
export function setFontScale(name) {
  const next = FONT_SCALES[name] || 1;
  if (next === _scale) return false;
  _scale = next;
  return true;
}
export function fontScaleName() {
  return Object.keys(FONT_SCALES).find(k => FONT_SCALES[k] === _scale) || "MEDIUM";
}

/** Chrome. The status bar is PERSISTENT (the export only showed it while printing) because it
 *  carries the emergency stop, which must never be more than one tap away. */
export const L = {
  bar: 52,          // persistent status bar
  nav: 56,          // nav rail when open (8.4 mm)
  fab: 56,          // nav corner button when collapsed
  fabInset: 10,
  navItem: 120,     // (1024 - 64 corner) / 8 = 120
  navCorner: 64,
  pad: 12,          // screen padding (16 in the export)
  gap: 10,          // inter-panel gap (14 in the export)
  radius: 8, radiusSm: 6, radiusXs: 4,
  get contentH() { return PANEL.h - this.bar; },              // 548
  get contentHNavOpen() { return PANEL.h - this.bar - this.nav; }, // 492
  get contentW() { return PANEL.w; },
  get usableW() { return PANEL.w - this.pad * 2; },           // 1000
};

/** Touch targets. 1 mm = 6.7 px here; a fingertip is 8-10 mm. */
export const TAP = { min: 48, primary: 60, danger: 68, gap: 8 };

export const mono = (size = F.micro, extra = "") => `font-family:${C.mono}; font-size:${size}px; ${extra}`;

// KNOWN BENIGN: the design sets `line-height:1` on the big numerals (F.hero, F.giant)
// to keep them tight. JetBrains Mono's natural line box is ~1.17em, so such an
// element reports scrollHeight ~8px greater than offsetHeight at 48px. Nothing is
// visually clipped -- it is empty descender space -- but a naive
// "scrollHeight > offsetHeight" clipping check WILL flag it. Skip leaf text nodes
// when hunting for real clipping; the ones that matter have children.

/** The design's panel header: 3px accent bar + letterspaced mono caps label. */
export const panelHead = () =>
  `display:flex; align-items:center; gap:9px; padding:10px 13px; border-bottom:1px solid ${C.line2}; background:${C.panelHead}; flex:none`;
export const panel = (extra = "") =>
  `background:${C.panel}; border:1px solid ${C.line2}; border-radius:${L.radius}px; display:flex; flex-direction:column; min-width:0; min-height:0; ${extra}`;
