// Shell view-model: nav rail, layout keys, and the footer/top-bar values that were static text in the design.
// Style strings are the design's, verbatim; only the data source changed.
import { ROUTES, labelFor } from "../../../lib/router.js";
import { mb, printGate } from "../../../lib/actions/upload.js";

const DASH = "—";
const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : "");

/** "v0.13.0-745-gf0892d82-dirty" -> "v0.13.0-745" (the footer slot is narrow). */
export function shortVersion(v) {
  if (!v) return DASH;
  const m = String(v).match(/^(v?\d+\.\d+\.\d+(?:-\d+)?)/);
  return m ? m[1] : String(v).slice(0, 14);
}

/** seconds -> "6d 04h" / "4h 07m" / "12m" */
export function fmtUptime(s) {
  if (!Number.isFinite(s) || s < 0) return DASH;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function shellVals(ctx) {
  const st = (ctx && ctx.st) || {};
  const ui = (ctx && ctx.ui) || {};
  const A = (ctx && ctx.A) || "#ff5a33";
  const path = (ctx && ctx.route && ctx.route.path) || "/";
  const nav = (ctx && ctx.navigate) || (() => {});

  const navItems = ROUTES.map(([p, label, glyph]) => {
    const on = path === p;
    return {
      label, glyph,
      go: () => nav(p),
      style: "display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:4px; cursor:pointer; font-size:11.5px; letter-spacing:.09em; font-weight:500; transition:background .12s;" +
        (on ? `background:#141b25; color:#e8eef6; box-shadow:inset 2px 0 0 ${A};` : "color:#6b7789;"),
    };
  });

  const ps = st.procStats || {};
  const cpu = ps.system_cpu_usage && Number.isFinite(ps.system_cpu_usage.cpu) ? ps.system_cpu_usage.cpu : null;
  const mem = ps.system_memory && ps.system_memory.total
    ? (ps.system_memory.used / ps.system_memory.total) * 100 : null;
  const host = (st.printerInfo && st.printerInfo.hostname) || "";
  const file = ((st.raw && st.raw.print_stats && st.raw.print_stats.filename) || "").replace(/^.*\//, "");

  // ---- UPLOAD & PRINT (top bar) + drop-anywhere overlay. The state is UI-local (ui.upload / ui.drop, fed by
  //      logic.jsx); the print gate itself is decided in actions/upload.js — these keys only SHOW that decision,
  //      which is why the idle label drops "& PRINT" whenever the upload will not start anything. printGate() is
  //      the SAME function the action calls, so the label cannot promise a print the upload then does not start
  //      (it used to look only at print_stats, and so still said "& PRINT" while Klipper was not ready).
  const gate = printGate(st);
  const willPrint = gate.canPrint;
  const up = ui.upload || null;
  const MONO = "font-family:'JetBrains Mono',monospace";
  const btnBase = "position:relative; overflow:hidden; display:flex; align-items:center; gap:7px; padding:6px 12px; border-radius:4px; " + MONO +
    "; font-size:10px; letter-spacing:.1em; white-space:nowrap; cursor:pointer; transition:border-color .12s, color .12s, box-shadow .12s; border:1px solid ";
  let uploadLabel, uploadSub = "", uploadSubColor = "#8b98aa", uploadTitle, uploadStyle, uploadBarStyle = "display:none";
  // hover only while idle: a progress / result state is a readout, not a control
  let uploadHover = "border-color:" + A + "; color:#ffd9cf; box-shadow:0 0 16px rgba(255,90,51,.3)";
  if (!up) {
    uploadLabel = willPrint ? "⇪ UPLOAD & PRINT" : "⇪ UPLOAD";
    uploadTitle = willPrint ? "Upload .gcode files; the first one starts printing as soon as it lands"
      : cap(gate.why) + " — files are uploaded, not started";
    // accent-tinted like the design's tool chips; the faint glow is the E-STOP's neighbour's privilege
    uploadStyle = btnBase + "rgba(255,90,51,.5); color:#ff8266; background:#150f10; box-shadow:0 0 12px rgba(255,90,51,.12)";
  } else if (up.phase === "uploading") {
    const pct = Math.round((up.pct || 0) * 100);
    uploadLabel = "UPLOADING" + (up.count > 1 ? " " + (up.index + 1) + "/" + up.count : "");
    uploadSub = pct + "% · " + mb(up.loaded) + "/" + mb(up.total) + " MB";
    uploadSubColor = "#c9d3e0";
    uploadTitle = String(up.name || "") + (up.wantPrint ? " — prints when it lands" : up.busy ? " — a print is running, not started" : "");
    uploadStyle = btnBase + A + "; color:#e8eef6; background:#150f10; cursor:progress; box-shadow:0 0 14px rgba(255,90,51,.25)";
    uploadBarStyle = "position:absolute; left:0; top:0; bottom:0; width:" + pct + "%; background:linear-gradient(90deg, rgba(255,90,51,.62), rgba(255,90,51,.28)); transition:width .2s ease; pointer-events:none";
    uploadHover = "";
  } else if (up.phase === "done") {
    const shortName = String(up.printed || up.name || "").replace(/^.*\//, "");
    if (up.outcome === "printing") {
      uploadLabel = "SENT · PRINTING"; uploadSub = shortName.toUpperCase().slice(0, 28); uploadTitle = "Printing " + shortName;
    } else if (up.outcome === "uploaded_busy") {
      uploadLabel = "UPLOADED · NOT STARTED"; uploadSub = "A PRINT IS RUNNING"; uploadSubColor = "#f0b429"; uploadTitle = "Uploaded — a print is running, not started";
    } else {
      uploadLabel = "UPLOADED"; uploadSub = up.count > 1 ? up.count + " FILES" : shortName.toUpperCase().slice(0, 28); uploadTitle = "Uploaded — not started";
    }
    uploadStyle = btnBase + "rgba(61,220,196,.6); color:#3ddcc4; background:#0b1a18";
    uploadBarStyle = "position:absolute; left:0; top:0; bottom:0; width:100%; background:rgba(61,220,196,.1); pointer-events:none";
    uploadHover = "";
  } else {
    const reason = String(up.reason || "upload failed");
    uploadLabel = "UPLOAD FAILED"; uploadSub = reason.toUpperCase().slice(0, 42); uploadSubColor = "#ff8266";
    uploadTitle = (up.name ? up.name + " — " : "") + reason;
    uploadStyle = btnBase + A + "; color:" + A + "; background:#1a0c08";
    uploadHover = "";
  }
  const drop = ui.drop || null;                 // null | "ok" | "bad" — set by logic.jsx's window drag listeners
  const dropBad = drop === "bad";
  const dropColor = dropBad ? "#f0b429" : A;

  // ---- top-bar alerts button. The design shipped it with a hard-coded accent "9+" badge and no click
  //      handler, so every printer permanently claimed nine-plus unread alerts. Real sources, all already in
  //      the store: Moonraker's own server_info warnings / failed components / missing Klippy requirements,
  //      plus Klipper itself not being ready. Nothing to report → the badge is hidden, not zeroed.
  const si = st.serverInfo || {};
  const alertList = (Array.isArray(si.warnings) ? si.warnings : [])
    .concat((Array.isArray(si.failed_components) ? si.failed_components : []).map(c => "Moonraker component failed to load: " + c))
    .concat((Array.isArray(si.missing_klippy_requirements) ? si.missing_klippy_requirements : []).map(m => "Missing Klipper requirement: " + m))
    .concat(st.klippy && st.klippy !== "ready" ? ["Klipper is " + st.klippy] : []);
  const alertN = alertList.length;
  const alertTitle = alertN
    ? alertList.slice(0, 6).map(w => "• " + String(w).replace(/\s+/g, " ").slice(0, 120)).join("\n") +
      (alertN > 6 ? "\n• …and " + (alertN - 6) + " more" : "") + "\n\nOpen MACHINE for the full list"
    : "No Moonraker or Klipper warnings";

  return {
    navItems,
    mainStyle: "flex:1; display:flex; flex-direction:column; min-width:" + (ui.narrow ? "980px" : "1340px"),
    narrow: !!ui.narrow,
    wide: !ui.narrow,
    dashGridStyle: "flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:" +
      (ui.narrow ? "300px minmax(560px,1fr)" : "300px minmax(560px,1fr) 340px"),
    isDash: path === "/",
    isStub: path !== "/",
    activeLabel: labelFor(path),
    stubHint: labelFor(path) + " PANEL",

    // --- values the design hard-coded in the sidebar footer / top bar ---
    klipperVersion: shortVersion(st.printerInfo && st.printerInfo.software_version),
    klipperVersionStyle: "color:" + (st.klippy === "ready" ? "#3ddcc4" : st.klippy === "shutdown" || st.klippy === "error" ? "#ff5a33" : "#f0b429"),
    uptime: fmtUptime(ps.system_uptime),
    hostCpu: cpu === null ? DASH : cpu.toFixed(1) + " %",
    hostCpuStyle: "color:" + (cpu === null ? "#4d5a6b" : cpu >= 85 ? "#ff5a33" : cpu >= 65 ? "#f0b429" : "#8b98aa"),
    hostMem: mem === null ? DASH : Math.round(mem) + " %",
    hostname: host ? host + ".local" : (typeof location !== "undefined" && location.hostname) || "printer",
    topFile: file || DASH,

    // --- top bar alerts button (design literal: a permanent "9+") ---
    alertCount: alertN > 9 ? "9+" : String(alertN),
    alertTitle,
    alertClick: () => nav("/machine"),
    alertBadgeStyle: alertN
      ? "position:absolute; top:-5px; right:-5px; min-width:15px; height:15px; padding:0 3px; border-radius:8px; background:" + A +
        "; color:#0a0c10; font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:700; display:flex; align-items:center; justify-content:center"
      : "display:none",

    // --- UPLOAD & PRINT button (between SAVE CONFIG and EMERGENCY STOP) ---
    uploadClick: () => { try { ((ctx && ctx.pickUpload) || (() => {}))(); } catch (e) { /* the picker is best-effort */ } },
    uploadTitle, uploadStyle, uploadHover, uploadBarStyle, uploadLabel,
    uploadLabelStyle: "position:relative; z-index:1",
    uploadSub,
    uploadSubStyle: "position:relative; z-index:1; color:" + uploadSubColor + "; letter-spacing:.06em",
    uploadInputRef: (ctx && ctx.setUploadInput) || (() => {}),
    uploadInputChange: (ctx && ctx.uploadInputChange) || (() => {}),
    // --- drop-anywhere overlay ---
    dropVisible: !!drop,
    dropOverlayStyle: "position:fixed; inset:0; z-index:900; background:rgba(6,8,11,.84); display:flex; align-items:center; justify-content:center; padding:40px; pointer-events:none; animation:vRise .16s ease both",
    dropFrameStyle: "width:min(720px, 100%); padding:56px 40px; border:2px dashed " + dropColor + "; border-radius:8px; background:rgba(13,18,26,.72); display:flex; flex-direction:column; align-items:center; gap:14px; text-align:center",
    dropGlyph: dropBad ? "⊘" : "⇪",
    dropGlyphStyle: MONO + "; font-size:44px; line-height:1; color:" + dropColor,
    // A drop UPLOADS and never starts a print (logic.jsx passes noPrint) — dropping is too easy to do by
    // accident for it to begin a physical operation. `willPrint` still decides the SUBTITLE, so when a print
    // could not have started anyway the overlay says why rather than implying the drop was the reason.
    dropTitle: dropBad ? "ONLY .GCODE FILES" : "DROP TO UPLOAD",
    dropTitleStyle: MONO + "; font-size:22px; letter-spacing:.3em; color:" + (dropBad ? "#f0b429" : "#e8eef6"),
    dropSub: dropBad ? ".GCODE · .GCO · .G"
      : willPrint ? "STORED, NOT STARTED — USE UPLOAD & PRINT TO BEGIN A JOB"
        : (gate.why + " — files are stored, not started").toUpperCase(),
    dropSubStyle: MONO + "; font-size:10px; letter-spacing:.16em; color:" + (dropBad ? "#f0b429" : "#8b98aa"),
  };
}

export default shellVals;
