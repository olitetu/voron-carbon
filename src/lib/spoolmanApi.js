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

/** Session cache for the 2.6 MB external catalogue — see externalFilaments(). */
const _extCache = { filaments: null, materials: null };

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

    /**
     * Spoolman's bundled catalogue of commercial filaments — what its own UI calls the database.
     *
     * 6,967 entries and 2.6 MB, with NO query parameters: it is all-or-nothing and every filter has to
     * be applied client-side. So it is fetched LAZILY (only when the picker opens, never on mounting the
     * FILAMENTS tab) and cached for the session, because pulling 2.6 MB through Moonraker's proxy twice
     * would be careless.
     */
    externalFilaments: () => (_extCache.filaments
      ? Promise.resolve(_extCache.filaments)
      : get("/external/filament").then(r => { _extCache.filaments = Array.isArray(r) ? r : []; return _extCache.filaments; })),
    externalMaterials: () => (_extCache.materials
      ? Promise.resolve(_extCache.materials)
      : get("/external/material").then(r => { _extCache.materials = Array.isArray(r) ? r : []; return _extCache.materials; })),

    info: () => get("/info"),
    health: () => get("/health"),
  };
}

/**
 * One catalogue entry -> the fields Spoolman's own filament record uses.
 *
 * The two vocabularies differ: the catalogue says `extruder_temp` / `bed_temp` / `manufacturer` where a
 * filament has `settings_extruder_temp` / `settings_bed_temp` / `vendor_id`, and `color_hexes` is a list
 * where `multi_color_hexes` is a comma-separated string. `vendors` is used to resolve the manufacturer
 * NAME to an existing vendor id; an unmatched manufacturer is returned as `vendorName` so the caller can
 * offer to create it rather than silently dropping it.
 */
export function fromExternal(e, vendors) {
  const name = String((e && e.manufacturer) || "").trim();
  const match = (Array.isArray(vendors) ? vendors : [])
    .find(v => String(v.name || "").trim().toLowerCase() === name.toLowerCase());
  const hexes = Array.isArray(e && e.color_hexes) ? e.color_hexes.filter(Boolean).join(",") : null;
  return {
    draft: {
      name: e.name || "",
      material: e.material || "",
      density: e.density ?? null,
      diameter: e.diameter ?? null,
      weight: e.weight ?? null,
      spool_weight: e.spool_weight ?? null,
      color_hex: String(e.color_hex || "").replace(/^#/, ""),
      multi_color_hexes: hexes || undefined,
      multi_color_direction: e.multi_color_direction || undefined,
      settings_extruder_temp: e.extruder_temp ?? null,
      settings_bed_temp: e.bed_temp ?? null,
      external_id: e.id || undefined,
      vendor: match ? { id: match.id, name: match.name } : null,
    },
    vendorName: match ? null : (name || null),
  };
}
