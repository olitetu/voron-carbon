import React from "react";
import { createRoot } from "react-dom/client";
import { boot } from "./lib/boot.js";
import { geometry, travelForMm } from "./lib/geometry.js";
import { useRoute, navigate, restoreRoute, persistRoute } from "./lib/router.js";
import { DashboardLogic } from "./pages/dashboard/logic.jsx";
import Webcam from "./pages/webcam/index.jsx"; import Console from "./pages/console/index.jsx"; import Spoolman from "./pages/spoolman/index.jsx";
import Heightmap from "./pages/heightmap/index.jsx"; import Files from "./pages/files/index.jsx"; import Viewer from "./pages/viewer/index.jsx";
import History from "./pages/history/index.jsx"; import Config from "./pages/config/index.jsx"; import Machine from "./pages/machine/index.jsx";

const { api, store } = boot();
// handy in devtools: window.__carbon.{api,store,geometry,act}
window.__carbon = { api, store, geometry, travelForMm };
const PAGES = { "/webcam": Webcam, "/console": Console, "/spoolman": Spoolman, "/heightmap": Heightmap, "/files": Files, "/viewer": Viewer, "/history": History, "/config": Config, "/machine": Machine };

function App() {
  const route = useRoute();
  const Page = PAGES[route.path] || null;
  // The dashboard component owns the chrome (nav rail, top bar, footer) and renders the page slot when not on "/".
  return <DashboardLogic accent="#ff5a33" store={store} api={api} route={route} navigate={navigate}
    page={Page ? <Page store={store} api={api} route={route} navigate={navigate} /> : null} />;
}
// Orca reloads the Device tab at the base URL constantly, dropping the hash — restore before the
// first render so the user stays on the page they were looking at.
restoreRoute();
persistRoute();
createRoot(document.getElementById("app")).render(<App />);
