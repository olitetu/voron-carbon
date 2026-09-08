// esbuild: JSX -> single bundle. React is vendored UMD (window.React) — zero runtime internet dependency.
import { build, context } from "esbuild";
const watch = process.argv.includes("--watch");
const opts = {
  entryPoints: ["src/main.jsx"],
  bundle: true,
  outfile: "dist/app.js",
  format: "iife",
  target: ["es2020"],
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  alias: { react: "./src/lib/react-shim.js", "react-dom": "./src/lib/react-dom-shim.js", "react-dom/client": "./src/lib/react-dom-shim.js" },
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};
// ---------------------------------------------------------------------------
// The 3D G-code viewer ships as a SEPARATE, lazily-loaded bundle.
//
// It is ~178 KB gzipped (three + gcode-preview) against the app's 58.6 KB, and seven of the eight
// pages never touch it — so the viewer page injects <script src="viewer.js"> on mount instead. Still
// vendored at build time into one IIFE, so the zero-runtime-dependency property holds: nothing is
// resolved over the network at runtime.
//
// Absent packages are not an error: the app degrades to an honest "3D viewer bundle not installed"
// panel, so a fresh clone builds and runs without them.
// ---------------------------------------------------------------------------
import { existsSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";

// Static assets are SOURCES, not build output: index.html, base.css, the vendored fonts and the React UMD
// bundles are copied into dist/ on every build. Without this dist/ could not be regenerated from a clean
// checkout — it would come out with no HTML, no CSS, no fonts and no React, which is exactly the release a
// gitignored dist/ would have produced.
mkdirSync("dist", { recursive: true });
for (const [from, to] of [["public", "dist"], ["vendor", "dist/vendor"]]) {
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

const VIEWER_ENTRY = "src/viewer/entry.js";
const viewerOpts = {
  entryPoints: [VIEWER_ENTRY],
  bundle: true,
  outfile: "dist/viewer.js",
  format: "iife",
  target: ["es2020"],
  // lil-gui is a dev-only GUI inside gcode-preview and is NOT tree-shaken by its static import;
  // stubbing it saves ~31 KB raw for nothing.
  // Force every `three` import onto the ONE top-level package. gcode-preview pins its own range and npm can
  // nest a second copy under it; without this alias the viewer would ship three twice (~1.28 MB raw).
  alias: { "lil-gui": "./src/viewer/lil-gui-stub.js", three: path.resolve("node_modules/three") },
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};

const haveViewer = existsSync(VIEWER_ENTRY) && existsSync("node_modules/gcode-preview") && existsSync("node_modules/three");

// The Config page's code editor is CodeMirror 6 (127 KB gzip, MIT) — far too heavy to sit in app.js for one
// page, so it is its own lazily-loaded IIFE exactly like the viewer. Entry exposes window.CarbonEditor.
const EDITOR_ENTRY = "src/editor/entry.js";
const editorOpts = {
  entryPoints: [EDITOR_ENTRY],
  bundle: true,
  outfile: "dist/editor.js",
  format: "iife",
  target: ["es2020"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};
const haveEditor = existsSync(EDITOR_ENTRY) && existsSync("node_modules/codemirror");
if (!haveEditor && existsSync(EDITOR_ENTRY)) console.log("[build] editor entry present but codemirror is not installed — skipping dist/editor.js");
if (!haveViewer && existsSync(VIEWER_ENTRY)) {
  console.log("[build] viewer entry present but gcode-preview/three are not installed — skipping dist/viewer.js");
}

if (watch) {
  const c = await context(opts);
  await c.watch();
  if (haveViewer) { const v = await context(viewerOpts); await v.watch(); }
  if (haveEditor) { const e = await context(editorOpts); await e.watch(); }
  console.log("watching…");
} else {
  await build(opts);
  if (haveViewer) await build(viewerOpts);
  if (haveEditor) await build(editorOpts);
}
