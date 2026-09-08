// Dashboard "HEIGHTMAP" panel view-model: live raw.bed_mesh → the design's mesh* keys.
// Keys: meshName, meshMin, meshMax, meshRange, meshDev, meshViewBox, meshQuads (see tools/panel-keys.json).
// The 50×50 probed_matrix is downsampled to ≤13×13 (corners kept) for the small preview; stats are from the full
// matrix; the isometric renderer is the design's code (adapters/isoMesh.js). Read-only, never throws.
import { renderIsoMesh, DESIGN_VIEWBOX } from "./isoMesh.js";

/** Points per side in the small preview (design used 9×9; the real mesh is 50×50). */
export const DASH_MESH_N = 13;

const DASH = "—";       // —
const MINUS = "−";      // − (the design writes "−0.041", not "-0.041")

/** "+0.062" / "−0.041" — signed, 3 decimals, typographic minus like the design. */
export function fmtSignedMm(v) {
  if (!Number.isFinite(v)) return DASH;
  const a = Math.abs(v).toFixed(3);
  return (v < 0 && a !== "0.000" ? MINUS : "+") + a;
}
/** "0.103 mm" */
export function fmtMm(v) { return Number.isFinite(v) ? v.toFixed(3) + " mm" : DASH; }

const EMPTY_VALS = () => ({
  meshName: DASH, meshMin: DASH, meshMax: DASH, meshRange: DASH, meshDev: DASH,
  meshViewBox: DESIGN_VIEWBOX, meshQuads: []
});

// The matrix reference only changes when Moonraker sends a new bed_mesh status, so one entry is enough.
let memo = { matrix: null, out: null };

export function heightmapVals(ctx) {
  try {
    const st = (ctx && ctx.st) || {};
    const bm = (st.raw && st.raw.bed_mesh) || null;
    const matrix = bm && Array.isArray(bm.probed_matrix) ? bm.probed_matrix : null;
    if (!matrix) return EMPTY_VALS();
    let out = memo.matrix === matrix ? memo.out : null;
    if (!out) { out = renderIsoMesh(matrix, { N: DASH_MESH_N }); memo = { matrix, out }; }
    if (out.empty) return EMPTY_VALS();
    const name = bm.profile_name ? String(bm.profile_name) : "mesh";
    return {
      // cols×rows = X×Y, the order Klipper itself uses (x_count × y_count) and the heightmap page shows. Identical
      // on a square mesh like this printer's 50×50; only a KAMP adaptive mesh is rectangular, and it read Y×X.
      meshName: `${name} · ${out.cols}×${out.rows}`,
      meshMin: fmtSignedMm(out.min),
      meshMax: fmtSignedMm(out.max),
      meshRange: fmtMm(out.range),
      meshDev: fmtMm(out.dev),
      meshViewBox: out.viewBox,
      meshQuads: out.quads
    };
  } catch (e) {
    return EMPTY_VALS();
  }
}
