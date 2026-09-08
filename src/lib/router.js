import React from "react";
export const ROUTES = [
  ["/", "DASHBOARD", "▤"], ["/webcam", "WEBCAM", "◉"], ["/console", "CONSOLE", "›_"], ["/spoolman", "SPOOLMAN", "◍"],
  ["/heightmap", "HEIGHTMAP", "▦"], ["/files", "G-CODE FILES", "▤"], ["/viewer", "G-CODE VIEWER", "3D"], ["/history", "HISTORY", "◷"], ["/config", "CONFIG", "⌗"], ["/machine", "MACHINE", "⚙"],
];
export function currentRoute() { const h = location.hash.replace(/^#/, "") || "/"; const q = h.indexOf("?"); return { path: q >= 0 ? h.slice(0, q) : h, query: new URLSearchParams(q >= 0 ? h.slice(q + 1) : "") }; }
export function navigate(path, query) { location.hash = path + (query ? "?" + new URLSearchParams(query).toString() : ""); }

// ---------------------------------------------------------------------------
// Route persistence — required by Orca Slicer's embedded Device tab.
//
// Orca calls load_printer_url() with the CONFIGURED url on every Device-tab selection, every F5 in
// the 3D canvas, and from Sidebar::update_all_preset_comboboxes() — which fires on essentially
// every preset change. There is no same-URL guard, so the page is torn down and reloaded at the
// base URL constantly, and the `#/route` fragment is not part of that URL: it is lost every time.
//
// So the route is mirrored to localStorage and restored when the app boots with no hash. Same
// mechanism serves an ordinary browser reload. localStorage survives in Orca's webview (it never
// disables persistent storage) and is scoped per-origin, so :8767 and dev :8766 stay independent.
// ---------------------------------------------------------------------------
const ROUTE_KEY = "carbon.route";

function readStored() {
  try { return localStorage.getItem(ROUTE_KEY) || ""; } catch (e) { return ""; }
}

/** Call once before the first render. Restores the last route when the URL carries no hash. */
export function restoreRoute() {
  const h = location.hash.replace(/^#/, "");
  if (h && h !== "/") return;                      // an explicit deep link always wins
  const saved = readStored();
  if (!saved || saved === "/") return;
  if (!/^\/[A-Za-z0-9\-_/?=&.%]*$/.test(saved)) return;   // ignore anything malformed
  location.replace("#" + saved);                   // replace, so Back does not bounce
}

/** Mirror every route change into localStorage. Returns an unsubscribe. */
export function persistRoute() {
  const save = () => {
    try { localStorage.setItem(ROUTE_KEY, location.hash.replace(/^#/, "") || "/"); } catch (e) { /* private mode */ }
  };
  save();
  window.addEventListener("hashchange", save);
  return () => window.removeEventListener("hashchange", save);
}
export function useRoute() {
  const [r, setR] = React.useState(currentRoute);
  React.useEffect(() => { const f = () => setR(currentRoute()); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return r;
}
export const labelFor = path => (ROUTES.find(r => r[0] === path) || ROUTES[0])[1];
