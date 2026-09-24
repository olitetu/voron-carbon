// Bed mesh profiles, shared by the desktop Heightmap page (src/pages/heightmap) and Carbon Screen's BED MESH
// screen (src/screen/screens/bedmesh.jsx). Two things live here: the row every profile list is built from, and
// the one rule for which profile names either UI will put on a BED_MESH_PROFILE line.
//
// NAMES, as Klipper parses them (klippy/gcode.py at this printer's v0.13.0-745):
//   - _process_commands finds the command name in the line cut at its first ';', but keeps the whole line.
//   - An extended command's parameters are re-read from that whole line by _get_extended_params: shlex, posix,
//     whitespace_split, commenters '#;'. So '#' or ';' starts a comment, quotes and '\' are consumed as shell
//     quoting, whitespace separates words, and each word splits at its first '='. A word with no '=' (or an
//     unclosed quote) makes the whole line "Malformed command". Keys are upper-cased, values keep their case.
//   - get_raw_command_parameters drops a trailing '*<digits>' as a checksum, but only on a line-numbered line.
// bed_mesh.py uses the value as-is, and SAVE turns it into the config section "[bed_mesh <name>]" that SAVE_CONFIG
// writes to printer.cfg. So a ']' or a newline would damage that file.
// The UIs never quote a name. They send one only when it is made of [A-Za-z0-9_.-], and nothing in that set means
// anything to either parser. A saved profile with any other character (a hand-edited printer.cfg) is listed but
// never addressed: "REMOVE=a;b" or "REMOVE=a#b" would remove profile 'a', and "LOAD=my mesh" is a Malformed error.
//
// meshStats / meshBounds come from the dashboard's isoMesh adapter. It is pure data code, no React, and it is the
// one mesh module both UIs already draw with.
import { meshStats, meshBounds } from "../pages/dashboard/adapters/isoMesh.js";

/** A profile name the UIs will send: letters, digits, '_', '.', '-' only (see NAMES above). */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** Longest name SAVE accepts: a UI cap (Klipper has none) so a name still fits a touchscreen button's sub-line. */
export const PROFILE_NAME_MAX = 40;
/** Why an existing profile is never sent, for a disabled button's reason. */
export const UNSENDABLE = "this profile name has characters this UI will not send (only A-Z a-z 0-9 _ - .)";

/** Can this existing profile be addressed by LOAD / REMOVE? */
export const isSendableProfile = name => typeof name === "string" && PROFILE_NAME_RE.test(name);

/**
 * Why a typed name cannot be sent as BED_MESH_PROFILE SAVE=<name>, or null.
 * 'default' is refused before sending. bed_mesh.py answers SAVE=default with respond_info "Profile 'default' is
 * reserved", not an error, so the action layer would log a save that never happened. Every BED_MESH_CALIBRATE
 * writes that profile.
 */
export function saveNameProblem(name) {
  if (!name) return "enter a profile name";
  if (name === "default") return "'default' is reserved: Klipper refuses SAVE=default (every BED_MESH_CALIBRATE writes it)";
  if (name.length > PROFILE_NAME_MAX || !PROFILE_NAME_RE.test(name)) {
    return `use only A-Z a-z 0-9 _ - . and no spaces (${PROFILE_NAME_MAX} max)`;
  }
  return null;
}

/**
 * bed_mesh.profiles -> one row per saved profile, sorted by name:
 *   { name, params, stats, bounds, grid }
 *   params    the profile's mesh_params ({} when missing). Klipper reports probe_count, pps, algo and tension only
 *             here, not as top-level bed_mesh fields.
 *   stats     meshStats(points), or null when the points are unusable
 *   bounds    { min:[x,y], max:[x,y] } bed area from mesh_params, or null
 *   grid      "X×Y" (Klipper's x_count × y_count, else the matrix's cols × rows), or null when neither is known
 * Anything that is not an object gives [].
 */
export function profileRows(profiles) {
  const all = profiles && typeof profiles === "object" ? profiles : {};
  const pos = v => typeof v === "number" && Number.isFinite(v) && v > 0;
  return Object.keys(all).sort().map(name => {
    const p = all[name] || {};
    const params = p.mesh_params && typeof p.mesh_params === "object" ? p.mesh_params : {};
    const stats = meshStats(p.points);
    return {
      name, params, stats, bounds: meshBounds(null, p),
      grid: pos(params.x_count) && pos(params.y_count) ? `${params.x_count}×${params.y_count}` : stats ? `${stats.cols}×${stats.rows}` : null,
    };
  });
}
