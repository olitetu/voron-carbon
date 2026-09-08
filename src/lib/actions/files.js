// FILES page actions — every write the G-CODE FILES browser can make. Contract: CONTRACT.md "Pages → files".
//
//   printFile(path)               → api.startPrint(path)                  (Klipper ready + nothing already printing)
//   deleteFile(path)              → api.fileDelete('gcodes', path)
//   deleteFolder(path)            → api.dirDelete('gcodes/<path>', true)  (recursive — the UI confirms first)
//   renameFile(path, name)        → api.fileMove('gcodes/<path>' → 'gcodes/<same dir>/<name>')
//   moveFile(path, destDir)       → api.fileMove('gcodes/<path>' → 'gcodes/<destDir>/<basename>')
//   copyFile(path, name)          → api.fileCopy('gcodes/<path>' → 'gcodes/<same dir>/<name>')
//   createFolder(dir, name)       → api.dirCreate('gcodes/<dir>/<name>')
//   uploadFile(file, dir, onPct)  → api.fileUpload(file, 'gcodes', dir, onPct)
//   downloadFile(path)            → location.assign(api.fileUrl('gcodes', path))
//
// Same shape as the other action modules: every action logs its intent to the shared console, awaits the RPC, logs
// the failure instead of throwing, and resolves true when Moonraker accepted it (false when refused or failed).
// Paths are always RELATIVE TO THE ROOT ('sub/dir/file.gcode'), the same form print_stats.filename uses; the
// 'gcodes/' prefix is added here, once, where Moonraker's move/copy/directory RPCs want a rooted path.
//
// One hazard these cannot see: server.files.move and .copy both end in shutil, which OVERWRITES an existing
// destination and reports success — a rename onto a neighbour's name destroys that file. Only the caller holds
// the directory listing, so the collision check lives in the page (promptErr), not here.

const ROOT = "gcodes";

/** Extensions Moonraker will accept into the gcodes root. Anything else is refused by the upload endpoint. */
export const GCODE_EXT = /\.(gcode|gco|g|ufp)$/i;
export const isGcode = name => GCODE_EXT.test(String(name || ""));

export const baseOf = p => String(p == null ? "" : p).split("/").pop();
export const dirOf = p => { const s = String(p == null ? "" : p); const i = s.lastIndexOf("/"); return i < 0 ? "" : s.slice(0, i); };
export const joinPath = (dir, name) => (dir ? String(dir).replace(/\/+$/, "") + "/" : "") + String(name == null ? "" : name).replace(/^\/+/, "");
/** Accepts a pasted 'gcodes/sub' or '/sub/' and returns the plain 'sub' this module works in. */
export const stripRoot = p => String(p == null ? "" : p).trim().replace(/^\/+|\/+$/g, "").replace(/^gcodes(\/|$)/i, "");

/**
 * Moonraker only indexes files whose extension it knows, so a rename that drops `.gcode` makes the file
 * disappear from the list (and from print start) with no error anywhere. Put the original one back.
 */
export function keepExtension(oldPath, newName) {
  const n = String(newName == null ? "" : newName).trim();
  const ext = (String(oldPath || "").match(GCODE_EXT) || [""])[0];
  return ext && n && !GCODE_EXT.test(n) ? n + ext : n;
}

/** null when `name` is a usable single path segment, else why not — the UI shows this and disables APPLY. */
export function validName(name) {
  const n = String(name == null ? "" : name).trim();
  if (!n) return "NAME REQUIRED";
  if (/[\\/]/.test(n)) return "NO / OR \\ IN A NAME";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(n)) return "CONTROL CHARACTERS";
  if (n === "." || n === "..") return "RESERVED NAME";
  if (n.startsWith(".")) return "A LEADING DOT HIDES THE FILE";   // Moonraker's own .thumbs cache lives there
  if (n.length > 200) return "NAME TOO LONG";
  return null;
}

const kb = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const errMsg = e => (e && e.message) || String(e);

export function makeFilesActions({ api, store, log } = {}) {
  const L = (m, k) => { try { if (typeof log === "function") log(m, k || "info"); } catch (e) { /* console-panel logging is best-effort */ } };
  const state = () => (store && store.state) || {};
  const raw = () => state().raw || {};
  const klippy = () => String(state().klippy || "unknown");
  const printState = () => String((raw().print_stats || {}).state || "standby").toLowerCase();
  const isPaused = () => printState() === "paused" || !!(raw().pause_resume || {}).is_paused;
  const isActive = () => printState() === "printing" || isPaused();
  /** The file Klipper currently holds open (relative path), or "" — it must not be deleted, moved or renamed. */
  const printingFile = () => (isActive() ? String((raw().print_stats || {}).filename || "") : "");
  const noApi = () => { if (api) return false; L("File operation rejected — no printer connection", "err"); return true; };

  async function run(intent, kind, fn) {
    L(intent, kind);
    try { await fn(); return true; }
    catch (e) { L(errMsg(e), "err"); return false; }
  }

  /** Refuse anything that touches the file Klipper is streaming from right now. */
  function busy(path, verb) {
    const cur = printingFile();
    if (cur && cur === path) { L(verb + " refused — " + baseOf(path) + " is the file being printed", "err"); return true; }
    return false;
  }

  const actions = {
    /** PRINT → printer.print.start. Refused unless Klipper is ready and the printer is idle. */
    printFile(path) {
      if (noApi()) return Promise.resolve(false);
      const p = String(path || "").trim();
      if (!p) { L("PRINT — no file selected", "warn"); return Promise.resolve(false); }
      if (klippy() !== "ready") { L("PRINT refused — Klipper is " + klippy(), "err"); return Promise.resolve(false); }
      if (isActive()) { L("PRINT refused — " + (baseOf(printingFile()) || "a job") + " is already " + printState(), "err"); return Promise.resolve(false); }
      if (!isGcode(p)) { L("PRINT refused — " + baseOf(p) + " is not a g-code file", "err"); return Promise.resolve(false); }
      return run("PRINT " + p, "ok", () => api.startPrint(p));
    },
    /** DELETE one file. The UI asks for confirmation first. */
    deleteFile(path) {
      if (noApi()) return Promise.resolve(false);
      const p = String(path || "").trim();
      if (!p) { L("DELETE — no file selected", "warn"); return Promise.resolve(false); }
      if (busy(p, "DELETE")) return Promise.resolve(false);
      return run("DELETE " + p, "warn", () => api.fileDelete(ROOT, p));
    },
    /** DELETE a folder and everything in it (force) — the UI confirms with the file count first. */
    deleteFolder(path) {
      if (noApi()) return Promise.resolve(false);
      const p = stripRoot(path);
      if (!p) { L("DELETE FOLDER refused — that is the gcodes root", "err"); return Promise.resolve(false); }
      const cur = printingFile();
      if (cur && (cur === p || cur.startsWith(p + "/"))) { L("DELETE FOLDER refused — the file being printed is inside " + p, "err"); return Promise.resolve(false); }
      return run("DELETE FOLDER " + p + " (recursive)", "warn", () => api.dirDelete(ROOT + "/" + p, true));
    },
    /** RENAME within the same directory. The extension is preserved (see keepExtension). */
    renameFile(path, name) {
      if (noApi()) return Promise.resolve(false);
      const p = String(path || "").trim();
      const target = keepExtension(p, name);
      const bad = validName(target);
      if (!p) { L("RENAME — no file selected", "warn"); return Promise.resolve(false); }
      if (bad) { L("RENAME refused — " + bad.toLowerCase(), "err"); return Promise.resolve(false); }
      if (busy(p, "RENAME")) return Promise.resolve(false);
      const dest = joinPath(dirOf(p), target);
      if (dest === p) { L("RENAME skipped — same name", "warn"); return Promise.resolve(false); }
      return run("RENAME " + baseOf(p) + " → " + target, "info", () => api.fileMove(ROOT + "/" + p, ROOT + "/" + dest));
    },
    /**
     * MOVE to another directory, keeping the file name. destDir '' = the gcodes root; it must already exist.
     *
     * RENAME and DUPLICATE land in the folder the page is showing, so the page can see a name collision in
     * the listing it already holds. MOVE cannot — its destination is a folder the page has never listed —
     * and shutil.move OVERWRITES silently, so the destination is read here before the move commits. This is
     * the one action that pays for a round trip: the alternative is destroying a file and reporting success.
     */
    async moveFile(path, destDir) {
      if (noApi()) return false;
      const p = String(path || "").trim();
      if (!p) { L("MOVE — no file selected", "warn"); return false; }
      if (busy(p, "MOVE")) return false;
      const d = stripRoot(destDir);
      // Moonraker normalises the path and then fails to recognise the root, which surfaces as an opaque
      // "Invalid file path" — say what is actually wrong instead.
      if (d.split("/").includes("..")) { L("MOVE refused — '..' is not allowed in a destination folder", "err"); return false; }
      const name = baseOf(p);
      const dest = joinPath(d, name);
      if (dest === p) { L("MOVE skipped — already in " + (d || "the gcodes root"), "warn"); return false; }
      let there;
      try { there = await api.dirInfo(d ? ROOT + "/" + d : ROOT, false); }
      catch (e) { L("MOVE refused — cannot read " + (d || "the gcodes root") + ": " + errMsg(e), "err"); return false; }
      const files = (there && Array.isArray(there.files) ? there.files : []);
      const dirs = (there && Array.isArray(there.dirs) ? there.dirs : []);
      if (files.some(f => f && f.filename === name) || dirs.some(x => x && x.dirname === name)) {
        L("MOVE refused — " + name + " already exists in " + (d || "the gcodes root") + "; the move would overwrite it", "err");
        return false;
      }
      return run("MOVE " + p + " → " + dest, "info", () => api.fileMove(ROOT + "/" + p, ROOT + "/" + dest));
    },
    /** DUPLICATE into the same directory under a new name. */
    copyFile(path, name) {
      if (noApi()) return Promise.resolve(false);
      const p = String(path || "").trim();
      const target = keepExtension(p, name);
      const bad = validName(target);
      if (!p) { L("DUPLICATE — no file selected", "warn"); return Promise.resolve(false); }
      if (bad) { L("DUPLICATE refused — " + bad.toLowerCase(), "err"); return Promise.resolve(false); }
      const dest = joinPath(dirOf(p), target);
      if (dest === p) { L("DUPLICATE refused — the copy needs a different name", "warn"); return Promise.resolve(false); }
      return run("COPY " + baseOf(p) + " → " + target, "info", () => api.fileCopy(ROOT + "/" + p, ROOT + "/" + dest));
    },
    /** NEW FOLDER inside `dir` (relative, '' = root). */
    createFolder(dir, name) {
      if (noApi()) return Promise.resolve(false);
      const n = String(name == null ? "" : name).trim();
      const bad = validName(n);
      if (bad) { L("NEW FOLDER refused — " + bad.toLowerCase(), "err"); return Promise.resolve(false); }
      const p = joinPath(stripRoot(dir), n);
      return run("MKDIR " + p, "info", () => api.dirCreate(ROOT + "/" + p));
    },
    /**
     * Upload one file into `dir`. onProgress gets 0..1. Callers upload sequentially: these files run to
     * 400 MB and the printer writes them to the same SD card Klipper is reading the print from.
     */
    async uploadFile(file, dir, onProgress) {
      if (noApi()) return false;
      if (!file || !file.name) { L("UPLOAD — nothing to send", "warn"); return false; }
      if (!isGcode(file.name)) { L("Skipped " + file.name + " — the gcodes root only takes .gcode / .gco / .g / .ufp", "warn"); return false; }
      const d = stripRoot(dir);
      L("UPLOAD " + file.name + " (" + kb(file.size || 0) + ")" + (d ? " → " + d : ""));
      try {
        await api.fileUpload(file, ROOT, d, onProgress);
        L("Uploaded " + file.name, "ok");
        return true;
      } catch (e) {
        L("Upload failed: " + file.name + " — " + errMsg(e), "err");
        return false;
      }
    },
    /**
     * DOWNLOAD. Moonraker serves /server/files/* with `Content-Disposition: attachment`, so a same-tab
     * navigation hands the file to the browser's downloader and leaves the app exactly where it is.
     * target="_blank" is not an option here: Orca's OnNewWindow handler ejects the user into their
     * system browser and cancels the navigation.
     */
    downloadFile(path) {
      if (noApi()) return Promise.resolve(false);
      const p = String(path || "").trim();
      if (!p) { L("DOWNLOAD — no file selected", "warn"); return Promise.resolve(false); }
      L("DOWNLOAD " + p);
      try { location.assign(api.fileUrl(ROOT, p)); return Promise.resolve(true); }
      catch (e) { L(errMsg(e), "err"); return Promise.resolve(false); }
    },
  };
  return actions;
}

export default makeFilesActions;
