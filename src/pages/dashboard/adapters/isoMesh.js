// Pure isometric bed-mesh renderer, shared by the dashboard HEIGHTMAP panel (adapters/heightmap.js) and the
// Heightmap page (src/pages/heightmap). Projection, "fake lambert" shading and the 4 colour stops are the design's
// meshQuads code from src/pages/dashboard/logic.jsx (renderVals) verbatim — only the z source changed from a
// synthetic saddle to a real Klipper matrix, and the colour ramp spans the real min..max of the FULL matrix.
// The camera is optional (`yaw` / `pitch`, see isoView): without it the design's literal formula runs, so the
// dashboard panel, which never passes one, renders exactly what it always did.
// No React, no store, no side effects, never throws. Callers on a hot path should memoise on the matrix reference.
//
// Klipper conventions used throughout: matrix[row][col] with row = Y index (row 0 = mesh_min Y, the FRONT of the
// bed) and col = X index (col 0 = mesh_min X, the LEFT). bed_mesh reports `[[]]` for probed_matrix/mesh_matrix
// when no mesh is loaded (after BED_MESH_CLEAR or at startup) — that is the "empty" case here.

/** Colour stops of the design's legend gradient (#2d5fd8 → #3ddcc4 → #f0b429 → #ff5a33). */
export const ISO_STOPS = [[45, 95, 216], [61, 220, 196], [240, 180, 41], [255, 90, 51]];
/** The same ramp as CSS, for a legend bar (the dashboard template hard-codes this exact gradient). */
export const ISO_GRADIENT_CSS = "linear-gradient(90deg,#2d5fd8,#3ddcc4,#f0b429,#ff5a33)";
/** The design's viewBox (9×9 mesh, cell 28). Also returned for an empty mesh so the SVG keeps its box. */
export const DESIGN_VIEWBOX = "-230 -70 460 320";
/** The design's mesh size, cell size and z exaggeration (svg px per mm). */
export const DESIGN_N = 9;
export const DESIGN_CELL = 28;
export const DESIGN_ZSCALE = 420;
/** Ground-plane height of the design's diamond = (N-1)*cell = 8*28. The default `cell` reproduces it for any N. */
const DESIGN_FOOT = (DESIGN_N - 1) * DESIGN_CELL;
/**
 * The design's camera, as angles. Its fixed projection X=(x−y)·cell·0.866, Y=(x+y)·cell·0.5 is a yaw of 45° (the
 * viewer stands at the bed's front-left corner) seen from an elevation whose sine is 0.5/0.866 — a true isometric,
 * 35.26°. The general projection (isoView) is X=(x·cosθ − y·sinθ)·cell·(0.866/cos45°), Y=(x·sinθ + y·cosθ)·cell·
 * (0.866/cos45°)·sin(pitch) − z·zScale·cos(pitch)/cos(35.26°), which at these two angles is that formula exactly.
 */
export const DESIGN_YAW = 45;
export const DESIGN_PITCH = Math.asin(0.5 / 0.866) * 180 / Math.PI;
/** Ground-plane scale of the general projection: the design's 0.866 unrolled from cos 45°. */
const ISO_KX = 0.866 / Math.SQRT1_2;
const DESIGN_PITCH_COS = Math.cos(DESIGN_PITCH * Math.PI / 180);

/** Finite number from a matrix cell; NaN for null/undefined/""/bool/junk (Number(null) would be 0 — wrong for a probe). */
const num = v => {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && v.trim() !== "") { const z = Number(v); return Number.isFinite(z) ? z : NaN; }
  return NaN;
};
/** Optional numeric option: finite number or null (so `zScale: 0` is honoured but `zScale: null/undefined` is not). */
const numOpt = v => {
  if (v === null || v === undefined || v === "") return null;
  const z = typeof v === "number" ? v : Number(v);
  return Number.isFinite(z) ? z : null;
};
const isPair = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(num(p[0])) && Number.isFinite(num(p[1]));

/**
 * Normalises a Klipper probed_matrix / mesh_matrix into a rectangular array of numbers (NaN for junk cells).
 * Returns null when nothing is usable (undefined, [], [[]] — what bed_mesh reports after BED_MESH_CLEAR).
 */
export function cleanMatrix(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return null;
  const rows = matrix.filter(r => Array.isArray(r) && r.length);
  if (!rows.length) return null;
  const cols = rows.reduce((m, r) => Math.min(m, r.length), Infinity);
  if (!Number.isFinite(cols) || cols < 1) return null;
  return rows.map(r => { const o = new Array(cols); for (let i = 0; i < cols; i++) o[i] = num(r[i]); return o; });
}

/** min / max / range / mean / variance / dev (population σ, like Mainsail's heightmap) over every finite value of the FULL matrix, or null. */
export function meshStats(matrix) {
  const m = cleanMatrix(matrix);
  if (!m) return null;
  let n = 0, min = Infinity, max = -Infinity, sum = 0;
  for (const row of m) for (const z of row) {
    if (!Number.isFinite(z)) continue;
    n++; sum += z;
    if (z < min) min = z;
    if (z > max) max = z;
  }
  if (!n) return null;
  const mean = sum / n;
  let sq = 0;
  for (const row of m) for (const z of row) if (Number.isFinite(z)) sq += (z - mean) * (z - mean);
  const variance = sq / n;
  return { n, rows: m.length, cols: m[0].length, min, max, range: max - min, mean, variance, dev: Math.sqrt(variance) };
}

/** Evenly spaced indices 0..len-1, at most N of them, always including both ends (so corners survive). */
export function sampleIndices(len, N) {
  if (!(len > 0)) return [];
  if (len === 1) return [0];
  const want = (N | 0) > 0 ? (N | 0) : len;
  const n = Math.max(2, Math.min(want, len));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(i * (len - 1) / (n - 1));
  return out;
}

/** Picks every ~k-th row/col so the result is ≤ N×N while keeping the four corners. N falsy → no downsampling. */
export function downsample(matrix, N) {
  const m = cleanMatrix(matrix);
  if (!m) return { matrix: [], rowIdx: [], colIdx: [] };
  const rowIdx = sampleIndices(m.length, N), colIdx = sampleIndices(m[0].length, N);
  return { matrix: rowIdx.map(r => colIdx.map(c => m[r][c])), rowIdx, colIdx };
}

/** The design's colour ramp: z mapped over [min, max] (mid-ramp when the mesh is perfectly flat). */
export function colorForZ(z, min, max) {
  const stops = ISO_STOPS;
  const range = max - min;
  const t = range > 0 ? Math.max(0, Math.min(1, (z - min) / range)) : 0.5;
  const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), k = p - i;
  const c = stops[i].map((v, n) => Math.round(v + (stops[i + 1][n] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/**
 * Resolves a camera { yaw, pitch, pivot } into the coefficients the projection needs, or null for the design's own
 * view — callers keep the design's literal formula on that branch, so the default output is bit-for-bit unchanged.
 *  yaw    degrees, any value (normalised to 0..360); 45 = the design. Rotates the bed about the vertical axis.
 *  pitch  camera elevation in degrees, clamped 0 (edge-on) .. 90 (top-down); 35.26 = the design.
 *  pivot  [x, y] design-grid point the rotation happens around (the mesh centre, so the relief turns in place instead
 *         of swinging around the far corner). It projects to where the design's view puts it, at every yaw.
 */
export function isoView(yaw, pitch, pivot) {
  const yw = numOpt(yaw), pt = numOpt(pitch);
  const yawDeg = yw === null ? DESIGN_YAW : ((yw % 360) + 360) % 360;
  const pitchDeg = pt === null ? DESIGN_PITCH : Math.max(0, Math.min(90, pt));
  if (yawDeg === DESIGN_YAW && pitchDeg === DESIGN_PITCH) return null;
  const r = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
  const px = isPair(pivot) ? num(pivot[0]) : 0, py = isPair(pivot) ? num(pivot[1]) : 0;
  return {
    yaw: yawDeg, pitch: pitchDeg, c: Math.cos(r), s: Math.sin(r),
    kx: ISO_KX, ky: ISO_KX * Math.sin(p), zk: Math.cos(p) / DESIGN_PITCH_COS,
    px, py, ox: (px - py) * 0.866, oy: (px + py) * 0.5     // the pivot's design-view position, per unit cell
  };
}

/**
 * The design's projection: design x runs right-down, design y left-down, z up. Returns unrounded svg [X, Y].
 * `yaw` / `pitch` / `pivot` (see isoView) turn the camera; omitted, this is the design's fixed isometric verbatim.
 * `yaw` may also be a resolved isoView() object (or null) so hot loops resolve the trig once.
 */
export function projectIso(x, y, z, cell, zScale, yaw, pitch, pivot) {
  const v = yaw !== null && typeof yaw === "object" ? yaw : isoView(yaw, pitch, pivot);
  if (!v) return [(x - y) * cell * 0.866, (x + y) * cell * 0.5 - z * zScale];
  const dx = x - v.px, dy = y - v.py;
  return [((dx * v.c - dy * v.s) * v.kx + v.ox) * cell, ((dx * v.s + dy * v.c) * v.ky + v.oy) * cell - z * zScale * v.zk];
}

/**
 * Bed-area bounds { min:[x,y], max:[x,y] } of a mesh, from bed_mesh.mesh_min/mesh_max (active mesh) or a saved
 * profile's mesh_params {min_x,max_x,min_y,max_y}. null when unknown or degenerate (bed_mesh reports [0,0]/[0,0] when
 * no mesh is loaded).
 */
export function meshBounds(bedMesh, profile) {
  const bm = bedMesh || {};
  if (isPair(bm.mesh_min) && isPair(bm.mesh_max)) {
    const min = [num(bm.mesh_min[0]), num(bm.mesh_min[1])], max = [num(bm.mesh_max[0]), num(bm.mesh_max[1])];
    if (max[0] > min[0] || max[1] > min[1]) return { min, max };
  }
  const p = profile && profile.mesh_params;
  if (p) {
    const min = [num(p.min_x), num(p.min_y)], max = [num(p.max_x), num(p.max_y)];
    if (min.every(Number.isFinite) && max.every(Number.isFinite) && (max[0] > min[0] || max[1] > min[1])) return { min, max };
  }
  return null;
}

/**
 * Chooses what to draw from a live `raw.bed_mesh` object:
 *   { matrix, name, saved, bounds, profile } — the ACTIVE mesh (probed_matrix) when one is loaded (saved:false), else,
 *   when `fallbackSaved` is true and profiles exist, the saved "default" profile (or the first one) as saved:true.
 *   null when there is nothing usable at all.
 * `name` is bed_mesh.profile_name, or "unsaved" for a loaded mesh with no profile (an adaptive mesh, e.g. KAMP-style
 * BED_MESH_CALIBRATE ADAPTIVE=1, is not saved to a profile), or the profile key for a saved fallback.
 */
export function pickMesh(bedMesh, opts) {
  const bm = bedMesh || {};
  const o = opts || {};
  if (cleanMatrix(bm.probed_matrix)) {
    const name = bm.profile_name != null && String(bm.profile_name).trim() ? String(bm.profile_name) : "unsaved";
    const profile = bm.profiles && bm.profiles[bm.profile_name];
    return { matrix: bm.probed_matrix, name, saved: false, bounds: meshBounds(bm, profile), profile: profile || null };
  }
  if (o.fallbackSaved && bm.profiles && typeof bm.profiles === "object") {
    const keys = Object.keys(bm.profiles);
    const key = o.prefer && keys.includes(o.prefer) ? o.prefer : keys.includes("default") ? "default" : keys.find(k => cleanMatrix(bm.profiles[k] && bm.profiles[k].points));
    const profile = key != null ? bm.profiles[key] : null;
    if (profile && cleanMatrix(profile.points)) {
      return { matrix: profile.points, name: key, saved: true, bounds: meshBounds(null, profile), profile };
    }
  }
  return null;
}

const EMPTY = () => ({
  empty: true, quads: [], viewBox: DESIGN_VIEWBOX,
  min: null, max: null, range: null, mean: null, variance: null, dev: null, n: 0,
  rows: 0, cols: 0, sampled: { rows: 0, cols: 0 }, rowIdx: [], colIdx: [], cell: DESIGN_CELL, zScale: DESIGN_ZSCALE,
  colorRange: null, stops: ISO_STOPS, frame: null, extent: null, yaw: DESIGN_YAW, pitch: DESIGN_PITCH
});

/**
 * renderIsoMesh(matrix, { cell, zScale, N, range, bounds, frame, yaw, pitch }) → { quads, min, max, range, dev, viewBox, … }
 *  matrix  Klipper bed_mesh.probed_matrix (or mesh_matrix / a profile's points): matrix[row = Y index][col = X index], mm.
 *  N       downsample to at most N×N points (corners kept). Omit/0 → render every point.
 *  cell    isometric cell size in svg px. Default keeps the design's 224px footprint whatever N is (224/(N-1)).
 *  zScale  svg px per mm of z. Default = the design's 420, scaled with the footprint when `cell` is overridden.
 *          0 is honoured (flat top-down-ish colour map for a "flat" toggle).
 *  range   optional [lo, hi] for the colour ramp instead of the matrix's own min..max (e.g. a fixed ±0.1 scale).
 *  bounds  optional { min:[x,y], max:[x,y] } bed area (see meshBounds) → each quad also gets bed-mm centre `bx`, `by`.
 *  frame   when true the ground-plane frame is included in the viewBox fit (it is always returned, see below).
 *  yaw     camera yaw in degrees (default 45 = the design's view). The relief turns about its own centre, which stays
 *          where the design puts it, so the viewBox does not move with the yaw. Any value; normalised to 0..360.
 *  pitch   camera elevation in degrees, 0 edge-on .. 90 top-down (default 35.26 = the design's isometric). The relief
 *          is foreshortened like a real camera would (× cos(pitch)/cos(35.26°)); zScale is its height at the default.
 *          Omitting both (or passing the defaults) runs the design's literal formula — byte-identical output.
 * Stats (min/max/range/mean/variance/dev) always come from the FULL matrix; quads from the sampled one.
 * quads: [{ depth, points, fill, op, title, z, r0, r1, c0, c1, bx?, by? }] sorted far→near (painter's order);
 *   `depth` is the quad's distance along the view direction (x·sinθ + y·cosθ; x+y at the default) — only its ORDER
 *   means anything, and the sort holds for every yaw because a heightfield's cells can only overlap on screen along
 *   that direction. r0..r1 / c0..c1 are the ORIGINAL matrix row/col indices the quad spans (for bed-XY hover).
 * frame: ground plane at z = min as svg points — corners keyed by bed position { fl, fr, br, bl, points } (fl = X min,
 *   Y min = nearest the viewer; the X axis runs fl→fr, the Y axis fl→bl) for axis labels / a base outline.
 * extent: { minX, minY, maxX, maxY } — the bounding box of what was actually DRAWN, in the same svg user units as
 *   viewBox (the frame corners are included only when `frame` is true, matching the box fit). null when nothing was
 *   drawn. A pan/zoom camera on top of the fit box needs this: viewBox is the design's nominal box, which at a low
 *   pitch or an off-centre yaw is much larger than the relief, so clamping a pan to the BOX can still leave the mesh
 *   entirely off screen.
 * View: the viewer stands at the bed's front-left corner — far corner (X max, Y max) at the top of the diamond,
 *   front edge (Y min) is the bottom-right edge, left edge (X min) the bottom-left edge; +X goes up-right, +Y up-left.
 * Never throws: an unusable matrix returns { empty: true, quads: [], viewBox: DESIGN_VIEWBOX, min: null, … }.
 */
export function renderIsoMesh(matrix, opts) {
  const o = opts || {};
  const stats = meshStats(matrix);
  if (!stats) return EMPTY();
  const { matrix: sm, rowIdx, colIdx } = downsample(matrix, o.N);
  const Nr = sm.length, Nc = Nr ? sm[0].length : 0;
  const span = Math.max(Nr, Nc) - 1;
  const cellOpt = numOpt(o.cell);
  const cell = cellOpt !== null && cellOpt > 0 ? cellOpt : (span > 0 ? DESIGN_FOOT / span : DESIGN_CELL);
  const foot = span > 0 ? cell * span : DESIGN_FOOT;
  const k = foot / DESIGN_FOOT;
  const zsOpt = numOpt(o.zScale);
  const zScale = zsOpt !== null && zsOpt >= 0 ? zsOpt : DESIGN_ZSCALE * k;
  const fallback = stats.mean;
  // colour ramp span: the matrix's own min..max unless the caller pins one
  let cLo = stats.min, cHi = stats.max;
  if (Array.isArray(o.range) && Number.isFinite(numOpt(o.range[0])) && Number.isFinite(numOpt(o.range[1]))) {
    cLo = Math.min(+o.range[0], +o.range[1]); cHi = Math.max(+o.range[0], +o.range[1]);
  }
  // optional bed coordinates for the ORIGINAL row/col indices
  const b = o.bounds && isPair(o.bounds.min) && isPair(o.bounds.max) ? o.bounds : null;
  const bedX = c => b ? num(b.min[0]) + (stats.cols > 1 ? c / (stats.cols - 1) : 0) * (num(b.max[0]) - num(b.min[0])) : null;
  const bedY = r => b ? num(b.min[1]) + (stats.rows > 1 ? r / (stats.rows - 1) : 0) * (num(b.max[1]) - num(b.min[1])) : null;
  // camera: null = the design's fixed view (its literal formula below); else rotate about the sampled grid's centre
  const view = isoView(o.yaw, o.pitch, [(Nr - 1) / 2, (Nc - 1) / 2]);
  // design axes: x (=a) runs along −Y through the rows, y (=b) along −X through the cols
  const zAt = (x, y) => { const z = sm[Nr - 1 - x][Nc - 1 - y]; return Number.isFinite(z) ? z : fallback; };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const track = (X, Y) => {
    if (X < minX) minX = X;
    if (X > maxX) maxX = X;
    if (Y < minY) minY = Y;
    if (Y > maxY) maxY = Y;
  };
  const px = (x, y) => {
    let X, Y;
    if (!view) { X = (x - y) * cell * 0.866; Y = (x + y) * cell * 0.5 - zAt(x, y) * zScale; }
    else { const p = projectIso(x, y, zAt(x, y), cell, zScale, view); X = p[0]; Y = p[1]; }
    track(X, Y);
    return [X.toFixed(1), Y.toFixed(1)];
  };
  const color = z => colorForZ(z, cLo, cHi);
  const quads = [];
  for (let y = 0; y < Nc - 1; y++) {
    for (let x = 0; x < Nr - 1; x++) {
      const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
      const zAvg = corners.reduce((a, c) => a + zAt(c[0], c[1]), 0) / 4;
      // fake lambert shading from the slope across the quad
      const slope = (zAt(x + 1, y + 1) - zAt(x, y)) * 6;
      const r0 = rowIdx[Nr - 2 - x], r1 = rowIdx[Nr - 1 - x], c0 = colIdx[Nc - 2 - y], c1 = colIdx[Nc - 1 - y];
      const q = {
        depth: view ? x * view.s + y * view.c : x + y,
        points: corners.map(c => px(c[0], c[1]).join(",")).join(" "),
        fill: color(zAvg),
        op: (0.86 + Math.max(-0.2, Math.min(0.2, slope))).toFixed(2),
        title: zAvg.toFixed(3) + " mm",
        z: zAvg,
        r0, r1, c0, c1
      };
      if (b) { q.bx = (bedX(c0) + bedX(c1)) / 2; q.by = (bedY(r0) + bedY(r1)) / 2; }
      quads.push(q);
    }
  }
  // ground-plane frame at z = min (under the relief), corners named by bed position
  let frame = null;
  if (Nr > 0 && Nc > 0) {
    const base = stats.min;
    const P = (x, y) => projectIso(x, y, base, cell, zScale, view);
    const c = { fl: P(Nr - 1, Nc - 1), fr: P(Nr - 1, 0), br: P(0, 0), bl: P(0, Nc - 1) };
    if (o.frame) for (const key of Object.keys(c)) track(c[key][0], c[key][1]);
    const fx = p => [p[0].toFixed(1), p[1].toFixed(1)];
    frame = { fl: fx(c.fl), fr: fx(c.fr), br: fx(c.br), bl: fx(c.bl) };
    frame.points = [frame.fl, frame.fr, frame.br, frame.bl].map(p => p.join(",")).join(" ");
  }
  // the design's box, scaled to the footprint; grown only if a tall z relief would spill out of it. The camera
  // pivots about the grid centre, which sits at the same spot for every yaw, so the box needs no view-dependent shift.
  const cx = ((Nr - 1) - (Nc - 1)) * cell * 0.866 / 2;
  let x0 = cx - 230 * k, x1 = cx + 230 * k, y0 = -70 * k, y1 = 250 * k;
  if (Number.isFinite(minX)) {
    x0 = Math.min(x0, minX - 36 * k); x1 = Math.max(x1, maxX + 36 * k);
    y0 = Math.min(y0, minY - 16 * k); y1 = Math.max(y1, maxY + 16 * k);
  }
  const viewBox = [x0, y0, x1 - x0, y1 - y0].map(v => String(Math.round(v))).join(" ");
  return {
    empty: false,
    quads: quads.sort((a, b) => a.depth - b.depth),
    min: stats.min, max: stats.max, range: stats.range, mean: stats.mean, variance: stats.variance, dev: stats.dev, n: stats.n,
    rows: stats.rows, cols: stats.cols, sampled: { rows: Nr, cols: Nc }, rowIdx, colIdx, cell, zScale, viewBox,
    colorRange: [cLo, cHi], stops: ISO_STOPS, frame,
    extent: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null,
    yaw: view ? view.yaw : DESIGN_YAW, pitch: view ? view.pitch : DESIGN_PITCH
  };
}

export default renderIsoMesh;
