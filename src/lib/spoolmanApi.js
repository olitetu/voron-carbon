// Spoolman REST, typed.
//
// Every call goes through Moonraker's proxy (api.spoolman -> server.spoolman.proxy), NOT the browser
// directly. That matters here: Spoolman runs on a DIFFERENT host from the printer on this setup
// ([spoolman] server: http://192.168.0.167:7912), so direct calls would need CORS on Spoolman and would
// be a second origin for Orca's webview to fail on. Through the proxy everything is same-origin to
// Moonraker. Verified: a PATCH sent this way reaches Spoolman and returns Spoolman's own status.
//
// Scope is deliberately the inventory surface — spools, filaments, vendors and the lookups their forms
// need. Custom-field SCHEMA (/field/* writes), the external product catalogue, backup/export, settings
// and location renaming are left to Spoolman's own UI; see the SPOOLMAN page's last tab.
//
// Field names come from Spoolman 0.23.1's own OpenAPI (/api/v1/openapi.json):
//   Spool    archived comment extra filament first_used id initial_weight last_used location lot_nr
//            price registered remaining_length remaining_weight spool_weight used_length used_weight
//   Filament article_number color_hex comment density diameter external_id extra id material
//            multi_color_direction multi_color_hexes name price registered settings_bed_temp
//            settings_extruder_temp spool_weight vendor weight
//   Vendor   comment empty_spool_weight external_id extra id name registered

/** Spoolman rejects unknown keys, so a PATCH body is built from a whitelist rather than a spread. */
const SPOOL_WRITABLE = ["filament_id", "price", "initial_weight", "spool_weight", "first_used", "last_used",
  "remaining_weight", "used_weight", "location", "lot_nr", "comment", "archived", "extra"];
const FILAMENT_WRITABLE = ["name", "vendor_id", "material", "price", "density", "diameter", "weight",
  "spool_weight", "article_number", "comment", "settings_extruder_temp", "settings_bed_temp",
  "color_hex", "multi_color_hexes", "multi_color_direction", "external_id", "extra"];
const VENDOR_WRITABLE = ["name", "comment", "empty_spool_weight", "external_id", "extra"];

function pick(body, allowed) {
  const out = {};
  for (const k of allowed) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
}
const qs = params => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
};

export function makeSpoolman(api) {
  if (!api || typeof api.spoolman !== "function") return null;
  const get = p => api.spoolman(p);
  const send = (p, method, body) => api.spoolman(p, method, body);

  return {
    // ---- spools ------------------------------------------------------------------------------------
    // `allow_archived` defaults to false in Spoolman, so archived spools are invisible unless asked for.
    listSpools: (opts = {}) => get("/spool" + qs({
      allow_archived: opts.archived ? "true" : undefined,
      filament_id: opts.filamentId, location: opts.location, lot_nr: opts.lot,
      sort: opts.sort, limit: opts.limit, offset: opts.offset,
    })),
    getSpool: id => get("/spool/" + id),
    createSpool: body => send("/spool", "POST", pick(body, SPOOL_WRITABLE.concat(["filament_id"]))),
    updateSpool: (id, patch) => send("/spool/" + id, "PATCH", pick(patch, SPOOL_WRITABLE)),
    deleteSpool: id => send("/spool/" + id, "DELETE"),
    /** Archiving is a PATCH, not DELETE — the spool stays for history. */
    archiveSpool: (id, archived = true) => send("/spool/" + id, "PATCH", { archived: !!archived }),
    /** Record consumption. Exactly one of use_weight (g) / use_length (mm). */
    useSpool: (id, body) => send("/spool/" + id + "/use", "PUT", pick(body, ["use_weight", "use_length"])),
    /** Correct remaining from a scale reading: the TOTAL measured weight including the empty spool. */
    measureSpool: (id, weight) => send("/spool/" + id + "/measure", "PUT", { weight }),

    // ---- filaments ---------------------------------------------------------------------------------
    listFilaments: (opts = {}) => get("/filament" + qs({ vendor_id: opts.vendorId, material: opts.material, sort: opts.sort })),
    getFilament: id => get("/filament/" + id),
    createFilament: body => send("/filament", "POST", pick(body, FILAMENT_WRITABLE)),
    updateFilament: (id, patch) => send("/filament/" + id, "PATCH", pick(patch, FILAMENT_WRITABLE)),
    deleteFilament: id => send("/filament/" + id, "DELETE"),

    // ---- vendors -----------------------------------------------------------------------------------
    listVendors: () => get("/vendor"),
    createVendor: body => send("/vendor", "POST", pick(body, VENDOR_WRITABLE)),
    updateVendor: (id, patch) => send("/vendor/" + id, "PATCH", pick(patch, VENDOR_WRITABLE)),
    deleteVendor: id => send("/vendor/" + id, "DELETE"),

    // ---- lookups that feed the forms ---------------------------------------------------------------
    materials: () => get("/material"),
    locations: () => get("/location"),
    articleNumbers: () => get("/article-number"),
    lotNumbers: () => get("/lot-number"),
    /**
     * Custom-field DEFINITIONS, read-only — we render their values and must preserve them.
     * This printer has one: spool.printer_name, which Happy Hare writes when it assigns a spool to a
     * gate ("Spool 24 assigned to printer voron @ gate 3"). A write that dropped `extra` would break
     * that mapping, which is why every PATCH here is a whitelisted partial and never a full replace.
     */
    fields: entity => get("/field/" + entity),

    info: () => get("/info"),
    health: () => get("/health"),
  };
}
