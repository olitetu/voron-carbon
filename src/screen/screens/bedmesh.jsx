// ---------------------------------------------------------------------------
// BED MESH — the probed mesh, its saved profiles, and the BED_MESH_* commands.
//
// Drawing is adapters/isoMesh.js, the renderer the dashboard HEIGHTMAP panel and the Heightmap page already use
// (projection, shading, colour ramp, the `[[]]`-after-BED_MESH_CLEAR case, pickMesh's loaded-else-saved choice,
// meshBounds). The profile rows and the profile-name rule are lib/bedmesh.js, shared with the Heightmap page. This
// file is layout, a tap readout and commands. It must never grow a second renderer.
//
// What this printer actually reports (read from voron.local, Klipper v0.13.0-745-gf0892d82):
//
//   AT IDLE NOTHING IS LOADED, USUALLY. bed_mesh.probed_matrix is [[]] and profile_name is "" (2026-09-23).
//   print_ready and print_ready_simple call BED_MESH_CALIBRATE for every job, and no macro clears the mesh
//   afterwards (BED_MESH_CLEAR appears only in MESH_CALIBRATE), so a job's mesh stays loaded until Klipper
//   restarts. Klipper does not load a profile at startup. That day the host had been up 14.6 h, and the last
//   job had ended 14.8 h earlier. With nothing loaded the viewport shows the selected saved profile, badged
//   NOT LOADED, because a profile that is not loaded corrects nothing.
//
//   THE ONLY PROFILE IS A PRINT FOOTPRINT, NOT THE BED. 'default' is 10×11 over X145.5–190.3 / Y151.2–196.7,
//   while [bed_mesh] is 50×50 over X50–300 / Y25–270. That is why every profile row shows its area, and why LOAD
//   says so when a profile covers only part of the configured area.
//
//   BED_MESH_CALIBRATE IS KAMP'S MACRO (rename_existing: _BED_MESH_CALIBRATE). Outside a job
//   exclude_object.objects is [], so it prints "No objects detected! … Defaulting to regular meshing", waits
//   G4 P5000, then scans the full configured area at PROBE_COUNT 50,50. It does NOT home and does NOT level. So
//   this screen gates it on needsHomed and warns when quad_gantry_level.applied is false. (The desktop page goes
//   through lib/actions/toolhead.js home("MESH"), which makes the same homing check and no longer assumes a
//   same-named macro homes.)
//
//   CALIBRATE REPLACES 'default'. bed_mesh.py at this commit drops the active mesh first (set_mesh(None)) and
//   ends with save_profile(PROFILE), where PROFILE defaults to "default". KAMP passes no PROFILE. save_profile
//   is configfile.set(), so every calibration also turns save_config_pending on, and every print does too. The
//   KAMP-shaped 'default' above is the live evidence: a later SAVE_CONFIG wrote a print's footprint mesh into
//   printer.cfg.
//
//   TWO SAVES THAT "SUCCEED" WITHOUT SAVING. BED_MESH_PROFILE SAVE=default gets respond_info "Profile 'default'
//   is reserved", and SAVE with no mesh loaded gets "the bed has not been probed". Neither is an error, so the
//   action layer would log "ok" for a save that never happened. Both are refused here before sending.
//
//   NAMES. The rule is lib/bedmesh.js's, shared with the desktop Heightmap page and checked there against
//   Klipper's gcode.py: only [A-Za-z0-9_.-] is ever sent, a new name is capped at PROFILE_NAME_MAX, and an
//   existing profile with any other character is shown but never sent.
//
//   PERSISTENCE. SAVE and REMOVE change the running session only. configfile.save_config_pending turns on, and
//   SAVE_CONFIG (which restarts Klipper) writes them to printer.cfg. SAVE_CONFIG is offered only while something
//   is pending, and its confirm lists what is staged, because it writes EVERYTHING staged (a Z offset too), not
//   just meshes. That list is configfile.save_config_pending_items: a written section maps to its options, a
//   removed one to null (configfile.py remove_section). lib/boot.js subscribes to it (a one-off query is the
//   fallback when the status lacks it), and the confirm caps it so the box never grows past the 548 px content area. The restart also switches heaters and steppers off,
//   so the printer has to be homed again. The confirm says that too.
//
// Every command is refused while a job is printing OR paused. whilePrinting:false alone lets a paused job
// through, so every guard below also sets the action layer's notWhilePaused: LOAD/CLEAR would change
// compensation for the rest of that print; CALIBRATE would drop its mesh and scan at horizontal_move_z 8 mm over
// a part still on the bed; SAVE_CONFIG would restart Klipper under it. Nothing is sent on render or mount:
// every command is a tap, and every command that changes the active mesh, deletes, overwrites, moves or
// restarts goes through a confirm.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Chip, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { renderIsoMesh, pickMesh, colorForZ, ISO_GRADIENT_CSS, DESIGN_ZSCALE, DESIGN_YAW }
  from "../../pages/dashboard/adapters/isoMesh.js";
import { fmtSignedMm, fmtMm } from "../../pages/dashboard/adapters/heightmap.js";
import { profileRows, isSendableProfile, saveNameProblem, UNSENDABLE } from "../../lib/bedmesh.js";

const DASH = "—";
/** Points per side drawn. The live mesh is 50×50 (2401 quads); 25×25 = 576 keeps a Pi's Chromium responsive. */
const DETAIL = 25;
/** Relief as a multiple of the renderer's own 420 svg px/mm; 0 = a flat colour map. */
const RELIEF = [["Z ×1", 1], ["Z ×3", 3], ["FLAT", 0]];
/** Camera yaw steps: the renderer's 45° default, then each other corner of the bed. */
const YAW_STEP = 90;
/** Which corner the viewer stands at, from the renderer's own ground frame (the corner drawn lowest). */
const CORNER = { fl: "FRONT-LEFT", fr: "FRONT-RIGHT", br: "BACK-RIGHT", bl: "BACK-LEFT" };
/** Busy keys (act.run's first word) that lock the mesh commands while in flight. */
const MESH_BUSY = /^(BED_MESH_|SAVE_CONFIG)/;

const CMD = {
  load: n => `BED_MESH_PROFILE LOAD=${n}`,
  remove: n => `BED_MESH_PROFILE REMOVE=${n}`,
  save: n => `BED_MESH_PROFILE SAVE=${n}`,
  clear: () => "BED_MESH_CLEAR",
  calibrate: () => "BED_MESH_CALIBRATE",
  saveconfig: () => "SAVE_CONFIG",
};
const IDLE = { whilePrinting: false, notWhilePaused: true };
const GUARDS = {
  load: IDLE, remove: IDLE, save: IDLE, clear: IDLE, calibrate: { ...IDLE, needsHomed: true }, saveconfig: IDLE,
};

/** Characters of a profile name that fit a half-width button's sub-line (156 px at F.micro, even at the XL scale).
 *  SAVE accepts up to lib/bedmesh.js PROFILE_NAME_MAX (40), so a longer name is clipped with an ellipsis. */
const SUB_CHARS = 14;
/** Staged SAVE_CONFIG sections listed by name in its confirm before "+N more". */
const PENDING_LIST = 6;

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const mm0 = v => (num(v) === null ? DASH : v.toFixed(0));
/** PanelBtn's sub-line is nowrap and unclipped, so a long name would spill into the neighbouring button. */
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const listSome = a => (a.length > PENDING_LIST ? `${a.slice(0, PENDING_LIST).join(", ")} +${a.length - PENDING_LIST} more` : a.join(", "));
const areaText = b => (b ? `X${mm0(b.min[0])}–${mm0(b.max[0])} Y${mm0(b.min[1])}–${mm0(b.max[1])}` : "");

export default function BedMesh({ st, act, api, askInput, say }) {
  const [sel, setSel] = React.useState("");
  const [yaw, setYaw] = React.useState(DESIGN_YAW);
  const [relief, setRelief] = React.useState(1);
  const [cell, setCell] = React.useState(null);           // index of the tapped quad
  const [confirm, setConfirm] = React.useState(null);     // { kind, name, label, cmd, confirm }
  const calStarted = React.useRef(0);
  // The keyboard and the confirm-text read are awaited. The keyboard lives in the App, so the screen can
  // close while it is open. Nothing is sent, and no confirm opens, from a screen that is gone.
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reading = React.useRef(false);                     // one SAVE_CONFIG pending-items read at a time

  const raw = st.raw || {};
  const bm = raw.bed_mesh || null;
  const ps = raw.print_stats || {};
  const paused = !!(raw.pause_resume || {}).is_paused;
  const jobState = ps.state === "printing" && !paused ? "printing" : ps.state === "paused" || paused ? "paused" : null;
  const savePending = !!(raw.configfile || {}).save_config_pending;
  const cfg = (st.config || {}).bed_mesh || null;
  const qglOff = !!raw.quad_gantry_level && raw.quad_gantry_level.applied === false;
  const busyKey = (st.busy || []).find(k => MESH_BUSY.test(k)) || null;
  // idle_timeout reads "Printing" whenever Klipper is executing g-code, so outside a job it means a command
  // (this screen's CALIBRATE past act.run's 30 s window, or anything else) is still running.
  const klipperBusy = !jobState && (raw.idle_timeout || {}).state === "Printing";
  if (calStarted.current && !klipperBusy && busyKey !== "BED_MESH_CALIBRATE") calStarted.current = 0;
  const probing = busyKey === "BED_MESH_CALIBRATE" || (!!calStarted.current && klipperBusy);

  // ---- profiles ---------------------------------------------------------------------------------------
  const profilesRef = bm ? bm.profiles : null;
  const profiles = React.useMemo(() => profileRows(profilesRef), [profilesRef]);
  const names = profiles.map(p => p.name);
  const activeName = bm && bm.profile_name ? String(bm.profile_name) : "";
  const selName = names.includes(sel) ? sel : names.includes(activeName) ? activeName : names[0] || "";
  const selProfile = profiles.find(p => p.name === selName) || null;

  // ---- what to draw -----------------------------------------------------------------------------------
  const picked = React.useMemo(() => pickMesh(bm, { fallbackSaved: true, prefer: selName }), [bm, selName]);
  const loaded = !!picked && !picked.saved;
  const view = React.useMemo(() => (picked ? renderIsoMesh(picked.matrix, {
    N: DETAIL, zScale: DESIGN_ZSCALE * relief, bounds: picked.bounds, frame: true, yaw,
  }) : null), [picked, relief, yaw]);
  const drawn = view && !view.empty ? view : null;
  // A kept index would outline a different cell of the new mesh. Layout effect: no stale frame gets painted.
  React.useLayoutEffect(() => { setCell(null); }, [view]);

  // Built once per view: the store emits many times a second and these do not change with it.
  const polys = React.useMemo(() => (drawn ? drawn.quads.map((q, i) => (
    <polygon key={i} data-i={i} points={q.points} fill={q.fill} fillOpacity={q.op} stroke={C.panelSunk} strokeLinejoin="round" />
  )) : null), [drawn]);
  const onTapMesh = e => {
    // getAttribute returns null off a cell, and Number(null) is 0, which would select cell 0.
    const a = e.target && e.target.getAttribute ? e.target.getAttribute("data-i") : null;
    const i = a === null ? NaN : Number(a);
    if (Number.isInteger(i)) setCell(c => (c === i ? null : i));
  };
  const q = drawn && cell !== null ? drawn.quads[cell] || null : null;
  const nearest = drawn && drawn.frame
    ? Object.keys(CORNER).reduce((a, k) => (Number(drawn.frame[k][1]) > Number(drawn.frame[a][1]) ? k : a), "fl")
    : null;
  // Does a profile cover only part of the configured area? (the KAMP footprint case)
  const partial = b => !!(b && cfg && Array.isArray(cfg.mesh_min) && Array.isArray(cfg.mesh_max)
    && (b.min[0] > cfg.mesh_min[0] + 1 || b.min[1] > cfg.mesh_min[1] + 1 || b.max[0] < cfg.mesh_max[0] - 1 || b.max[1] < cfg.mesh_max[1] - 1));
  const cfgArea = cfg && Array.isArray(cfg.mesh_min) && Array.isArray(cfg.mesh_max)
    ? areaText({ min: cfg.mesh_min, max: cfg.mesh_max }) : "";
  const probeCount = cfg && Array.isArray(cfg.probe_count) ? `${cfg.probe_count[0]}×${cfg.probe_count[1] || cfg.probe_count[0]}` : "";

  // ---- guards -----------------------------------------------------------------------------------------
  const lockWhy = act.blocked(IDLE)
    || (busyKey ? `${busyKey} is still running` : null)
    || (klipperBusy ? "Klipper is busy running a command" : null);

  /** The reason a command cannot run now, in the user's words, or null. `name` undefined = not typed yet. */
  function whyFor(kind, name) {
    const specific =
      kind === "load" ? (!name ? "no saved profile to load" : !isSendableProfile(name) ? UNSENDABLE : name === activeName ? `'${name}' is already loaded` : null)
      : kind === "remove" ? (!name ? "no saved profile to remove" : !isSendableProfile(name) ? UNSENDABLE : null)
      : kind === "save" ? (!loaded ? "no mesh is loaded: CALIBRATE or LOAD one first" : name !== undefined ? saveNameProblem(name) : null)
      : kind === "clear" ? (!loaded ? "no mesh is loaded" : null)
      : kind === "saveconfig" ? (!savePending ? "nothing is waiting for SAVE_CONFIG" : null)
      : null;
    return specific || act.blocked(GUARDS[kind], CMD[kind](name || "")) || lockWhy;
  }
  // The keyboard and the pending-items read are awaited; what they return is checked against the state
  // current THEN, not the render that opened them.
  const latest = React.useRef(null);
  latest.current = { whyFor, names, activeName };

  function send(kind, name) {
    const what = CMD[kind](name || "").split(" ").slice(0, 2).join(" ");
    if (!alive.current) return act.refuse(what, "the BED MESH screen was closed first");
    const why = latest.current.whyFor(kind, name);
    if (why) return act.refuse(what, why);
    if (kind === "calibrate") { calStarted.current = Date.now(); say("BED_MESH_CALIBRATE: probing the bed"); }
    return act.guarded(CMD[kind](name || ""), GUARDS[kind]).then(r => {
      // Only a reply that says "still running" keeps the PROBING latch. Refused, failed or finished all end it.
      if (kind === "calibrate" && !(r && r.ok && r.running)) calStarted.current = 0;
      if (r && r.ok && !r.running && (kind === "save" || kind === "remove")) {
        say(`${kind === "save" ? "saved" : "removed"} '${name}' for this session. SAVE_CONFIG keeps it`);
      }
      return r;
    });
  }

  // ConfirmBox's CONFIRM sits at x 517–775, y 333–401 on the panel, and LOAD sits at x 692–848, y 373–421
  // (measured at 1024×600). A double tap on LOAD would land its second tap on CONFIRM; ConfirmBox itself
  // ignores CONFIRM for its first 400 ms (move.jsx CONFIRM_ARM_MS), which covers that.
  const ask = (kind, name, label, text) => setConfirm({ kind, name, label, cmd: CMD[kind](name || ""), confirm: text });

  const onLoad = () => {
    const p = selProfile;
    const orphan = loaded && !names.includes(activeName);
    ask("load", selName, "LOAD PROFILE",
      `Make '${selName}' the active mesh? Z compensation follows it on every move from now on.`
      + (p && partial(p.bounds) ? ` It covers only ${areaText(p.bounds)}, a part of the configured ${cfgArea}.` : "")
      + (orphan ? " The mesh loaded now is in no profile and will be lost." : ""));
  };
  const onRemove = () => ask("remove", selName, "REMOVE PROFILE",
    `Remove profile '${selName}'? It leaves the list now`
    + (selName === activeName ? " (the loaded mesh stays active until cleared)" : "")
    + ". SAVE_CONFIG makes the removal permanent in printer.cfg.");
  const onClear = () => ask("clear", undefined, "CLEAR MESH",
    `Clear the active mesh${activeName ? ` ('${activeName}')` : ""}? Z compensation stops until a profile is loaded.`
    + (names.includes(activeName) ? " It stays in the profile list." : " It is in no profile, so only a new probe brings it back."));
  // KAMP meshes the defined print objects when there are any (they stay defined after a job until the next file
  // loads), else the full configured grid. So the configured probe_count is the size only when this is 0.
  const objs = ((raw.exclude_object || {}).objects || []).length;
  const onCalibrate = () => {
    ask("calibrate", undefined, "BED MESH CALIBRATE",
      (objs
        ? `Scan the bed now? KAMP adapts the mesh to the ${objs} object${objs > 1 ? "s" : ""} still defined from the last file.`
        : `Scan the bed now? With no print objects KAMP waits 5 s, then scans the full ${probeCount || "configured"} mesh${cfgArea ? " over " + cfgArea : ""}.`)
      + " The toolhead moves. The active mesh is dropped first."
      + ` The result ${names.includes("default") ? "replaces profile 'default'" : "is stored as profile 'default'"} for this session and is staged for SAVE_CONFIG.`
      + (qglOff ? " QGL is NOT applied: the mesh will record gantry tilt." : ""));
  };
  async function onSave() {
    const pre = whyFor("save");
    if (pre) return act.refuse("SAVE", pre);
    const v = await askInput({ mode: "text", label: "SAVE MESH AS", value: "", hint: "A-Z 0-9 _ - .  NO SPACES" });
    if (v === null) return undefined;
    if (!alive.current) return act.refuse("SAVE", "the BED MESH screen was closed before OK");
    const name = String(v).trim();
    const now = latest.current;
    const why = now.whyFor("save", name);
    if (why) return act.refuse("SAVE", why);
    // Klipper replaces a same-named profile without a word, and the mesh it drops is gone.
    if (now.names.includes(name)) {
      return ask("save", name, "REPLACE PROFILE",
        `Profile '${name}' already exists. Replace it with the loaded mesh (${now.activeName || "unsaved"})? The old '${name}' mesh cannot be recovered.`);
    }
    return send("save", name);
  }
  async function onSaveConfig() {
    const pre = whyFor("saveconfig");
    if (pre) return act.refuse("SAVE_CONFIG", pre);
    if (reading.current) return undefined;                 // a second tap while the list is still loading
    // What SAVE_CONFIG would write. configfile.py: a set section maps to its options, a removed one to null.
    // lib/boot.js subscribes to it, so the pushed status is used. Only when the status does not carry the field
    // is it fetched here, with a read-only query.
    let items = (raw.configfile || {}).save_config_pending_items;
    if (items === undefined) {
      reading.current = true;
      try {
        const r = await api.query({ configfile: ["save_config_pending_items"] });
        items = r && r.status && r.status.configfile ? r.status.configfile.save_config_pending_items : undefined;
      } catch (e) { items = undefined; } finally { reading.current = false; }
      if (!alive.current) return undefined;
    }
    const known = !!items && typeof items === "object";
    const writes = known ? Object.keys(items).filter(k => items[k] !== null) : null;
    const removes = known ? Object.keys(items).filter(k => items[k] === null) : null;
    ask("saveconfig", undefined, "SAVE CONFIG",
      "Write every staged change to printer.cfg and restart Klipper? It writes everything staged, not only mesh profiles."
      + (writes && writes.length ? ` Writes: ${listSome(writes)}.` : "")
      + (removes && removes.length ? ` Removes: ${listSome(removes)}.` : "")
      + (writes === null ? " (Could not read the staged list.)" : "")
      + " Heaters and motors switch off, so the printer has to be homed again.");
  }

  // ---- empty state: no bed_mesh object at all ---------------------------------------------------------
  if (!bm) {
    const hint = !st.connected ? "Moonraker is not connected."
      : st.klippy !== "ready" ? `Klipper is ${st.klippy || "unknown"}. The mesh appears once it is ready.`
      : Array.isArray(st.objects) && st.objects.length && !st.objects.includes("bed_mesh") ? "There is no [bed_mesh] section in printer.cfg."
      : "Waiting for the printer's bed_mesh status.";
    return (
      <div style={S(`height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px`)}>
        <div style={S(panel("height:100%"))}><Empty title="NO BED MESH" hint={hint} /></div>
      </div>
    );
  }

  // raw.bed_mesh is the last status Moonraker pushed. While Klipper is down it is not the printer's state now,
  // and after a restart nothing is loaded whatever it last said.
  const live = st.connected && st.klippy === "ready";
  const badge = !live ? { kind: "off", text: !st.connected ? "OFFLINE" : `KLIPPER ${String(st.klippy || "unknown").toUpperCase()}` }
    : probing ? { kind: "warn", text: "PROBING" }
    : loaded ? { kind: "ok", text: "LOADED" }
    : picked ? { kind: "warn", text: "NOT LOADED" }
    : { kind: "off", text: "NO MESH" };
  const headLine = picked && drawn
    ? `${picked.name} · ${drawn.cols}×${drawn.rows}${picked.bounds ? " · " + areaText(picked.bounds) : ""}`
    : DASH;
  // The ends of the renderer's own ramp, so the MIN / MAX figures carry the colour the mesh draws them in.
  const ramp = drawn && drawn.colorRange ? drawn.colorRange : null;

  /** A PanelBtn whose disabled state still answers a tap: the reason goes to the toast (a title never shows on glass).
   *  A plain function, not a component: a component declared in render would remount every button per store emit. */
  const btn = ({ label, sub, tone, h = TAP.min, why, onTap, span }) => (
    <div onClick={why ? () => act.refuse(label, why) : undefined} style={S(span ? "grid-column:1 / -1" : "")}>
      <PanelBtn label={label} sub={sub} tone={tone} h={h} disabled={!!why} why={why || undefined} onTap={onTap} />
    </div>
  );

  const stats = [
    ["RANGE", drawn ? fmtMm(drawn.range) : DASH, C.text, true],
    ["MIN", drawn ? fmtSignedMm(drawn.min) : DASH, ramp ? colorForZ(drawn.min, ramp[0], ramp[1]) : C.dim],
    ["MAX", drawn ? fmtSignedMm(drawn.max) : DASH, ramp ? colorForZ(drawn.max, ramp[0], ramp[1]) : C.dim],
    ["σ DEV", drawn ? fmtMm(drawn.dev) : DASH, C.body],
    ["POINTS", drawn ? String(drawn.n) : DASH, C.dim],
  ];

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      {/* ---- left: the mesh, its legend, its numbers ---- */}
      <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0; min-width:0`)}>
        <Panel title="BED MESH" style="flex:1; min-height:0"
          right={<>
            <span style={S(mono(F.label, `color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>{headLine}</span>
            <span style={S(badgeStyle(badge.kind))}>{badge.text}</span>
          </>}
          bodyStyle="padding:10px 12px; gap:8px">

          <div style={S(`flex:1; min-height:0; position:relative; display:flex; border:1px solid ${C.line2}; border-radius:${L.radiusSm}px; overflow:hidden; background:radial-gradient(ellipse at 50% 40%, ${C.raised}, ${C.panelSunk} 70%)`)}>
            {drawn ? (
              <svg viewBox={drawn.viewBox} preserveAspectRatio="xMidYMid meet"
                style={S("position:absolute; inset:0; width:100%; height:100%; display:block")}>
                {drawn.frame ? <polygon points={drawn.frame.points} fill="none" stroke={C.line3} strokeWidth="0.9" strokeDasharray="5 4" /> : null}
                <g strokeWidth={(drawn.cell * 0.03).toFixed(3)} onClick={onTapMesh} style={S("cursor:pointer")}>{polys}</g>
                {q ? <polygon points={q.points} fill="none" stroke={C.text} strokeWidth={(Math.max(0.6, drawn.cell * 0.12)).toFixed(2)}
                  strokeLinejoin="round" pointerEvents="none" /> : null}
              </svg>
            ) : (
              <Empty title="NO MESH"
                hint={probing ? "Probing. The new mesh appears here when BED_MESH_CALIBRATE finishes."
                  : profiles.length ? `Nothing is loaded, and profile '${selName}' has no usable points to draw.`
                  : "Nothing is loaded and there is no saved profile. CALIBRATE probes one."} />
            )}

            {drawn ? (
              <>
                {/* view only, nothing here reaches the printer */}
                <div style={S("position:absolute; top:8px; left:8px; display:flex; gap:6px")}>
                  {RELIEF.map(([label, k]) => (
                    <Chip key={label} label={label} on={relief === k} onTap={() => setRelief(k)} h={TAP.min} fs={F.label} flex={0} minW={66} />
                  ))}
                  <Chip label={"↻ 90°"} onTap={() => setYaw(y => (y + YAW_STEP) % 360)} h={TAP.min} fs={F.label} flex={0} minW={74} />
                </div>
                <span style={S(`position:absolute; left:10px; bottom:8px; pointer-events:none; ${mono(F.micro, `letter-spacing:.12em; color:${C.faint}`)}`)}>
                  {`VIEW FROM ${CORNER[nearest] || "FRONT-LEFT"} · TAP A CELL`}
                </span>
                {q ? (
                  <div style={S(`position:absolute; right:8px; top:8px; display:flex; flex-direction:column; align-items:flex-end; gap:3px; padding:8px 11px; border:1px solid ${C.line4}; border-radius:${L.radiusSm}px; background:${C.raised}; pointer-events:none`)}>
                    <div style={S("display:flex; align-items:center; gap:8px")}>
                      <span style={S(`width:11px; height:11px; border-radius:2px; background:${q.fill}`)} />
                      <span style={S(mono(F.num2, `color:${C.text}`))}>{fmtSignedMm(q.z)}</span>
                      <span style={S(mono(F.label, `color:${C.faint}`))}>mm</span>
                    </div>
                    <span style={S(mono(F.micro, `letter-spacing:.08em; color:${C.mute}`))}>
                      {num(q.bx) !== null && num(q.by) !== null ? `X ${q.bx.toFixed(1)} · Y ${q.by.toFixed(1)}` : `ROW ${q.r0} · COL ${q.c0}`}
                    </span>
                    <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}`))}>CELL AVERAGE</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {/* legend: the renderer's own ramp */}
          <div style={S("flex:none; display:flex; align-items:center; gap:10px")}>
            <span style={S(mono(F.label, `color:${stats[1][2]}; white-space:nowrap`))}>{stats[1][1]}</span>
            <div style={S(`flex:1; height:6px; border-radius:3px; background:${drawn ? ISO_GRADIENT_CSS : C.track}`)} />
            <span style={S(mono(F.label, `color:${stats[2][2]}; white-space:nowrap`))}>{stats[2][1]}</span>
          </div>
        </Panel>

        {/* stats. The first column is the nav corner button's. */}
        <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 1.4fr repeat(4,1fr); gap:6px`)}>
          <span />
          {stats.map(([k, v, col, big]) => (
            <div key={k} style={S(panel("padding:7px 10px; gap:3px; justify-content:center"))}>
              <span style={S(microLabel(C.faint))}>{k}</span>
              <span style={S(mono(big ? F.num2 : F.val, `color:${col}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ---- right: profiles and the commands ---- */}
      <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
        <Panel title="PROFILES" style="flex:1; min-height:0"
          right={savePending ? <span style={S(badgeStyle("warn"))}>CFG PENDING</span> : null}
          bodyStyle="padding:8px; gap:8px">
          <div style={S("flex:none; display:flex; align-items:center; gap:8px; padding:0 4px")}>
            <span style={S(microLabel(C.faint))}>ACTIVE</span>
            <span style={S(`margin-left:auto; ${mono(F.label, `color:${!live ? C.mute : loaded ? C.cool : C.bed}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}`)}>
              {!live ? `${DASH} · printer not ready` : loaded ? activeName || "unsaved mesh" : "none · no z compensation"}
            </span>
          </div>

          <div style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:6px")}>
            {profiles.length ? profiles.map(p => {
              const on = p.name === selName;
              const act_ = live && p.name === activeName && loaded;
              return (
                <Hv as="div" key={p.name} onClick={() => setSel(p.name)} active={`background:${C.line1}`}
                  style={`flex:none; display:flex; align-items:center; gap:10px; min-height:${TAP.min + 8}px; padding:6px 10px; border-radius:${L.radiusSm}px; cursor:pointer; ${on
                    ? `background:${C.selBg}; border:1px solid ${C.accentLine};`
                    : `background:${C.panelSunk}; border:1px solid ${C.line2};`}`}>
                  <span style={S(`width:8px; height:8px; border-radius:50%; flex:none; background:${act_ ? C.cool : C.ghost}`)} />
                  <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:3px")}>
                    <div style={S("display:flex; align-items:baseline; gap:8px; min-width:0")}>
                      <span style={S(mono(F.body, `color:${on ? C.text : C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>{p.name}</span>
                      <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.dim}; white-space:nowrap`)}`)}>{p.stats ? fmtMm(p.stats.range) : DASH}</span>
                    </div>
                    <span style={S(mono(F.micro, `color:${partial(p.bounds) ? C.bed : C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                      {`${p.grid || DASH}${p.bounds ? " · " + areaText(p.bounds) : ""}`}
                    </span>
                  </div>
                </Hv>
              );
            }) : (
              <span style={S(`${mono(F.label, `color:${C.faint}`)}; padding:10px 4px; text-wrap:pretty`)}>
                No saved profiles. CALIBRATE probes one and stores it as 'default'.
              </span>
            )}
          </div>

          <span style={S(`flex:none; ${mono(F.micro, `color:${lockWhy ? C.bed : C.faint}; line-height:1.3; padding:0 4px`)}; text-wrap:pretty`)}>
            {lockWhy ? `MESH COMMANDS LOCKED: ${lockWhy.toUpperCase()}`
              : "SAVE AND REMOVE LAST UNTIL KLIPPER RESTARTS. SAVE_CONFIG WRITES THEM TO PRINTER.CFG."}
          </span>
        </Panel>

        <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:8px")}>
          {btn({ label: "LOAD", sub: clip(selName, SUB_CHARS) || DASH, tone: "accent", why: whyFor("load", selName), onTap: onLoad })}
          {btn({ label: "REMOVE", sub: clip(selName, SUB_CHARS) || DASH, tone: "danger", why: whyFor("remove", selName), onTap: onRemove })}
          {btn({ label: "SAVE AS…", sub: "LOADED MESH", why: whyFor("save"), onTap: onSave })}
          {btn({ label: "CLEAR", sub: "ACTIVE MESH", why: whyFor("clear"), onTap: onClear })}
          {btn({ span: true, label: "CALIBRATE", h: TAP.primary, tone: "accent",
            sub: probing ? "PROBING…" : `${objs ? `ADAPTIVE · ${objs} OBJ · ` : probeCount ? probeCount + " · " : ""}TOOLHEAD MOVES`,
            why: whyFor("calibrate"), onTap: onCalibrate })}
          {savePending ? btn({ span: true, label: "SAVE_CONFIG", sub: "WRITES CFG · RESTARTS KLIPPER", tone: "danger",
            why: whyFor("saveconfig"), onTap: onSaveConfig }) : null}
        </div>
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => {
            const c = confirm;
            setConfirm(null); send(c.kind, c.name);
          }} />
      ) : null}
    </div>
  );
}
