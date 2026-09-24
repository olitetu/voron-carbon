// ---------------------------------------------------------------------------
// SPOOLMAN — the active spool, the spool list, and which spool sits in which gate.
//
// Everything goes through Moonraker's Spoolman proxy (lib/spoolmanApi.js / api.spoolman), never to Spoolman
// directly. Spoolman 0.23.1 runs on the printer itself: [spoolman] server is http://192.168.0.167:7912, and
// 192.168.0.167 is the Pi's own wlan0 address (machine.system_info). The list, the id index and the ranking are
// the shared ones (lib/spools.js useSpoolList / filterSpools / materialsOf) -- the SPOOLMAN page and the gate
// editor show the same numbers, formatted the same way.
//
// Facts this screen is built on, read from the live printer and HH v3.4.2's source:
//
//   · 43 spools (46 with archived), nine materials: ABS 16, PLA 9, PETG 8, PLA+ 2, HIPS 2, ASA 2, ABS-GF 2,
//     PC 1, TPU-95A 1. The filter chips come from the list (materialsOf), never a hardcoded table, so a new
//     material shows up without a code change. Nine chips do not fit beside FIND in 580 px, so the row scrolls
//     sideways inside itself; the most common materials come first.
//
//   · LOCATION is written by Happy Hare, not by hand. Only five spools have one and every one of them is
//     "voron @ MMU Gate:N". The live gate is Happy Hare's own mmu.gate_spool_id, so a row's G-badge reads THAT;
//     the Spoolman location is shown as Spoolman's copy of the same fact, and can lag it.
//
//   · THE ACTIVE SPOOL FOLLOWS THE MMU. spoolman_support is `push`. On every successful load HH calls
//     _spoolman_activate_spool(gate_spool_id[gate_selected]), which sets Moonraker's active spool. Its
//     DEACTIVATE branch (spool_id == 0, sent before every unload) only sets a local None and never calls
//     Moonraker -- so after an unload the last gate's spool stays active. Live right now: gate 5 is
//     "Unloaded" and the active spool is still #46, gate 5's. The strip says which of those is the case, and
//     SET ACTIVE's confirm says HH will replace a manual choice on the next load. A load from a gate with NO
//     spool mapped (spool_id -1) changes nothing at all, so its filament is logged against whatever was
//     active before -- which is why UNMAP's confirm says so. Since HH never clears it, CLEAR ACTIVE does
//     (api.spoolmanClearActive): the button SET ACTIVE becomes when the spool shown is the active one.
//
//   · ASSIGNING MOVES A SPOOL. HH's assign_spool_id() gives the gate the spool and sets any OTHER gate holding
//     the same id to -1. The confirm names both gates. Assignment is lib/actions/mmu.js assignSpool() -- the
//     same one the gate editor uses -- which in push mode sends MMU_GATE_MAP GATE=n SPOOLID=x TEMP=<current>
//     (TEMP because an omitted TEMP silently resets the gate to 200 C; see that file). Material, colour and
//     temperature then come FROM the spool record; nothing about the filament is typed here.
//
//   · Spoolman's remaining weight is logged usage subtracted from the initial weight, not a scale reading.
//     Spools #35 and #43 read 0 g while HH marks gates 2 and 4 available. Shown as Spoolman reports it.
//
// Refusals: assignment needs the MMU idle and Spoolman reachable (with Spoolman offline HH keeps the OLD
// spool's material and colour on the gate, which is worse than not assigning). It is also refused when HH is
// disabled (cmd_MMU_GATE_MAP's check_if_disabled() only logs, so the gcode "succeeds" and nothing changes) and
// when spoolman_support is `off` (_persist_gate_map then neither pushes nor pulls: the gate would get the id
// and none of the spool's attributes). Setting or clearing the active spool needs only Moonraker and Spoolman
// -- Klipper is not involved. All confirm first and re-check at CONFIRM; a gate confirm is also refused if the
// gate map moved while it was open, because its text names who sits where, or if its command built again is
// not the one shown; CLEAR ACTIVE is refused if the active spool changed. The Spoolman badge follows Moonraker's
// notify_spoolman_status_changed, so the "Spoolman offline" refusal is not stuck at its mount-time value.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { useAsync } from "../../lib/useStore.js";
import { useSpoolList, filterSpools, materialsOf, swatch, grams, metres, spoolName, fillOf, num, EMPTY_COLOR, LOW } from "../../lib/spools.js";
import { makeMmuActions } from "../../lib/actions/mmu.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { mmu as mmuVm, badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Chip, Bar, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";

const GATE_GUARDS = { needsMmu: true, needsMmuIdle: true };
const ROW_H = 60;
const LEFT_W = 410;   // 4 gate tiles at 91 px hold "#45" + "1.00 kg" in 12 px mono without clipping

/** Uppercase a refusal for a button's sub-line, which has room for ~18 characters. */
const short = s => { const u = String(s || "").toUpperCase(); return u.length > 18 ? u.slice(0, 17) + "…" : u; };
/** Happy Hare's gate temperature as an integer, or null for none. */
const gateTemp = g => { const t = Math.round(Number(g && g.temp)); return t > 0 ? t : null; };
const matOf = sp => String(((sp && sp.filament) || {}).material || "").trim();
/** A gate badge in the badge idiom, but in body ink: it is a location, not a warning. */
const gateBadge = `${badgeStyle("off")}; color:${C.body}; border-color:${C.line4}`;

function SpoolRow({ sp, on, active, gate, onTap }) {
  const f = sp.filament || {};
  const fill = fillOf(sp);
  const left = num(sp.remaining_weight);
  const low = fill !== null && fill < LOW;
  const col = swatch(f.color_hex) || EMPTY_COLOR;
  // A spool already in a gate says so with its badge; repeating Spoolman's "voron @ MMU Gate:N" beside it is noise.
  const loc = gate === null && sp.location ? sp.location : null;
  return (
    <Hv as="div" onClick={onTap} active={`background:${C.line1}`}
      style={`flex:none; height:${ROW_H}px; display:flex; align-items:center; gap:12px; padding:0 12px; border-bottom:1px solid ${C.line0}; cursor:pointer; background:${on ? C.selBg : "transparent"}; box-shadow:${on ? `inset 3px 0 0 ${C.accent}` : "none"}`}>
      <span style={S(`width:12px; height:40px; flex:none; border-radius:3px; background:${col}; border:1px solid ${C.line4}`)} />
      <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:4px")}>
        <span style={S(mono(F.body, `color:${on ? C.text : C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{spoolName(sp)}</span>
        <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
          {[`#${sp.id}`, f.material || "—", (f.vendor || {}).name, loc, sp.archived ? "ARCHIVED" : null].filter(Boolean).join(" · ")}
        </span>
      </div>
      {active ? <span style={S(`flex:none; ${badgeStyle("ok")}`)}>ACTIVE</span> : null}
      {gate !== null ? <span style={S(`flex:none; ${gateBadge}`)}>{`G${gate}`}</span> : null}
      <div style={S("flex:none; width:96px; display:flex; flex-direction:column; align-items:flex-end; gap:6px")}>
        <span style={S(mono(F.val, `color:${left === 0 ? C.accent : low ? C.bed : C.text}`))}>{grams(left)}</span>
        <div style={S("width:100%")}><Bar pct={fill === null ? 0 : fill * 100} color={low ? C.bed : col} h={4} /></div>
      </div>
    </Hv>
  );
}

/** One gate: who is mapped there (colour, spool id, grams left) and Happy Hare's own availability. */
function GateTile({ g, sp, here, dim, onTap }) {
  const col = swatch(sp && sp.filament && sp.filament.color_hex) || (g.hasColor ? swatch(g.color) : null) || EMPTY_COLOR;
  const left = sp ? num(sp.remaining_weight) : null;
  const fill = fillOf(sp);
  const low = fill !== null && fill < LOW;
  return (
    <Hv as="div" onClick={onTap} active="transform:translateY(1px)"
      style={`height:${TAP.primary}px; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:5px; padding:0 6px; border-radius:${L.radiusSm}px; cursor:pointer; opacity:${dim ? 0.5 : 1}; ${here
        ? `background:${C.accentBg}; border:1px solid ${C.accentLine};`
        : `background:${C.panelSunk}; border:1px solid ${C.line3};`}`}>
      <div style={S("display:flex; align-items:center; gap:5px; min-width:0")}>
        <span style={S(mono(F.label, `color:${here ? C.accent : C.dim}`))}>{`G${g.i}`}</span>
        {g.loaded ? <span title="loaded" style={S(`width:7px; height:7px; border-radius:50%; background:${C.cool}`)} /> : null}
        <span style={S(`margin-left:auto; ${mono(F.micro, `color:${g.empty ? C.bed : C.ghost}`)}`)}>{g.empty ? "EMPTY" : g.unknown ? "?" : ""}</span>
      </div>
      <span style={S(`height:5px; border-radius:3px; background:${col}; opacity:${g.empty ? 0.4 : 1}`)} />
      <div style={S(`display:flex; align-items:center; gap:3px; min-width:0; ${mono(F.micro)}; white-space:nowrap; overflow:hidden`)}>
        <span style={S(`color:${g.spoolId ? C.mute : C.ghost}`)}>{g.spoolId ? `#${g.spoolId}` : "NO SPOOL"}</span>
        <span style={S(`margin-left:auto; color:${left === 0 ? C.accent : low ? C.bed : C.dim}`)}>{sp ? grams(left) : ""}</span>
      </div>
    </Hv>
  );
}

function Fact({ k, v, color = C.body, span = 1 }) {
  return (
    <div style={S(`min-width:0; grid-column:span ${span}; display:flex; flex-direction:column; gap:3px`)}>
      <span style={S(microLabel(C.faint))}>{k}</span>
      <span style={S(mono(F.body, `color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
    </div>
  );
}

export default function Spoolman({ st, api, act, say, askInput }) {
  const [pick, setPick] = React.useState(null);       // spool the user tapped; null = follow the active spool
  const [mat, setMat] = React.useState(null);         // material facet; null = all
  const [q, setQ] = React.useState("");
  const [confirm, setConfirm] = React.useState(null);

  // Gate assignment is makeMmuActions().assignSpool -- one implementation, shared with the gate editor. The
  // factory reads store.state lazily at call time, so a view over the latest rendered state is all it needs.
  // The confirms show its spoolScript(), the command assignSpool builds from the same state. Its lines go to
  // the screen's command log (act.log: st.screenLog, and warn/err reach the toast).
  const stRef = React.useRef(st);
  stRef.current = st;
  const actRef = React.useRef(act);
  actRef.current = act;
  const mmuAct = React.useMemo(() => makeMmuActions({
    api, store: { get state() { return stRef.current; } },
    log: (msg, kind) => { const a = actRef.current; if (a && typeof a.log === "function") a.log(msg, kind); },
  }), [api]);

  // Moonraker's own view: is Spoolman reachable, are usage reports queued, which spool is it logging against.
  // Re-read whenever the store's active spool changes, so the two can never disagree for long -- the store
  // alone can be stale when boot's hydrate() never ran (Klipper was down when the panel started).
  const svc = useAsync(() => (st.connected ? api.rpc("server.spoolman.status", {}) : Promise.resolve(null)),
    [st.connected, st.activeSpool]);
  const list = useSpoolList(api, st);
  const all = list.all, byId = list.byId;

  // Moonraker's answer wins once it is in. While a re-read is in flight (useAsync keeps the previous data) the
  // store, fed by notify_active_spool_set, is the fresher of the two -- unless it never learned the id, in
  // which case falling back to it would flash "NONE" on every REFRESH.
  const svcHas = !!(svc.data && Object.prototype.hasOwnProperty.call(svc.data, "spool_id"));
  const svcId = svcHas && Number(svc.data.spool_id) > 0 ? Number(svc.data.spool_id) : null;
  const storeId = Number(st.activeSpool) > 0 ? Number(st.activeSpool) : null;
  const activeId = !svcHas ? storeId : svc.loading && storeId !== null ? storeId : svcId;
  const online = svc.data ? !!svc.data.spoolman_connected : null;          // null = not known yet
  const queued = svc.data && Array.isArray(svc.data.pending_reports) ? svc.data.pending_reports.length : 0;
  const refresh = () => { list.reload(); svc.reload(); };

  // Moonraker announces its Spoolman link going up or down (spoolman:spoolman_status_changed ->
  // notify_spoolman_status_changed, which moonraker.js re-emits under that name). Without this the badge and
  // the "Spoolman offline" refusal kept whatever the mount-time read said. Both reloads are reads.
  const reloadSvc = svc.reload, reloadList = list.reload;
  React.useEffect(() => (api && typeof api.on === "function"
    ? api.on("notify_spoolman_status_changed", () => { reloadSvc(); reloadList(); })
    : undefined), [api, reloadSvc, reloadList]);

  const raw = st.raw || {};
  const hh = raw.mmu || null;
  const m = mmuVm(st);
  const gateIds = hh && Array.isArray(hh.gate_spool_id) ? hh.gate_spool_id.slice(0, m.n) : [];
  const gateKey = gateIds.join(",");
  const gateOf = id => { const i = id > 0 ? gateIds.indexOf(id) : -1; return i >= 0 ? i : null; };

  // The list is a snapshot, and HH rewrites a spool's location in Spoolman whenever the gate map changes --
  // from here or anywhere else. Re-read it shortly after, so the rows do not keep the old location.
  const seenGates = React.useRef(gateKey);
  React.useEffect(() => {
    if (gateKey === seenGates.current) return undefined;
    seenGates.current = gateKey;
    const t = setTimeout(() => list.reload(), 2000);
    return () => clearTimeout(t);
  }, [gateKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const facets = React.useMemo(() => materialsOf(all), [all]);
  const matOn = mat && facets.some(f => f.material === mat) ? mat : null;
  const rows = React.useMemo(() => filterSpools(all, q, { activeId, gateIds, material: matOn }),
    [all, q, matOn, activeId, gateKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const selId = pick != null ? pick : activeId;
  const sel = selId != null ? byId[selId] || null : null;
  const live = activeId != null ? byId[activeId] || null : null;
  const selGate = sel ? gateOf(sel.id) : null;

  const ps = raw.print_stats || {};
  const inPrint = ps.state === "printing" || ps.state === "paused" || !!(raw.pause_resume || {}).is_paused;

  // ---- refusals, recomputed every render so CONFIRM checks the state at the moment it is tapped
  const smWhy = !st.connected ? "Moonraker offline" : online === false ? "Spoolman offline" : null;
  const mode = mmuAct.spoolmanMode();
  const gateWhy = !m.present ? "no MMU on this printer"
    : act.blocked(GATE_GUARDS, "MMU_GATE_MAP")
      // cmd_MMU_GATE_MAP starts with check_if_disabled(): with HH disabled it only logs an error and the
      // gcode still returns ok, so assignSpool would toast a success that never happened.
      || (hh.enabled === false ? "Happy Hare is disabled" : null)
      || smWhy
      // pull is allowed: assignSpool sends MMU_SPOOLMAN there, and v3.4.2's mmu_server set_spool_gate /
      // unset_spool_gate do what the confirms say. They unset every other spool at the gate, send -1 for the
      // spool's old gate on this printer, and sync back with MAP REPLACE=1: the spool's attributes, temp
      // clamped to default_extruder_temp, gate_status untouched.
      // off: _persist_gate_map neither pushes nor pulls, so the gate would get the id but none of the spool's
      // material, colour or temperature -- the opposite of what the confirm promises.
      || (mode === "off" ? "HH spoolman_support is off" : null);
  // The spool shown IS the active one (the detail follows the active spool until another is tapped), so SET
  // ACTIVE turns into CLEAR ACTIVE. That includes an active id Spoolman's list does not have (archived or
  // deleted) -- exactly the one worth clearing.
  const clearsActive = activeId !== null && selId === activeId;
  const setWhy = clearsActive ? smWhy : !sel ? "pick a spool" : smWhy;
  const clrWhy = !sel ? "pick a spool" : selGate === null ? "not in a gate" : gateWhy;

  // ---- confirms
  // The active-spool writes are Moonraker RPCs, not act.run gcode, so nothing logs them unless this does: the
  // command log keeps the record, and the toast stays because a success line in the log does not toast.
  const done = msg => { if (typeof act.log === "function") act.log(msg, "ok"); if (typeof say === "function") say(msg); };
  const askActive = sp => setConfirm({
    kind: "active", label: "SET ACTIVE SPOOL", cmd: `server.spoolman.post_spool_id spool_id=${sp.id}`,
    confirm: `Log filament use against #${sp.id} · ${spoolName(sp)} (${grams(num(sp.remaining_weight))} left)? `
      + (inPrint ? `A print is running: until the next tool change its filament is logged against #${sp.id}. ` : "")
      + "Happy Hare switches it to the loaded gate's spool again on every MMU load.",
    // Re-read Moonraker afterwards so the strip (server.spoolman.status) does not depend on
    // notify_active_spool_set arriving; a read, not a second write.
    run: () => api.spoolmanSetActive(sp.id)
      .then(() => { done(`ACTIVE SPOOL → #${sp.id}`); svc.reload(); })
      .catch(e => act.refuse("SET ACTIVE SPOOL", `Moonraker answered: ${(e && e.message) || String(e)}`)),
  });

  // HH v3.4.2 only ever SETS Moonraker's active spool (_spoolman_activate_spool after a load from a gate with a
  // spool mapped; its spool_id == 0 "deactivate" branch never calls Moonraker), so after a clear nothing is
  // logged against any spool until the next such load or a SET ACTIVE.
  const askClearActive = id => setConfirm({
    kind: "clear", id, label: "CLEAR ACTIVE SPOOL", cmd: "server.spoolman.post_spool_id (no spool_id)",
    confirm: `Stop logging filament use against #${id}${live ? " · " + spoolName(live) : ""}? `
      + (inPrint ? "A print is running: from now on its filament is logged against no spool. " : "")
      + "Happy Hare makes a spool active again when it next loads a gate that has one mapped.",
    run: () => api.spoolmanClearActive()
      .then(() => { done("ACTIVE SPOOL CLEARED"); svc.reload(); })
      .catch(e => act.refuse("CLEAR ACTIVE SPOOL", `Moonraker answered: ${(e && e.message) || String(e)}`)),
  });

  const askAssign = (sp, g) => {
    const t = gateTemp(g);
    const occId = gateIds[g.i] > 0 ? gateIds[g.i] : null;
    const occ = occId ? byId[occId] : null;
    const from = gateOf(sp.id);
    const newMat = matOf(sp);
    const newT = num(((sp.filament || {}).settings_extruder_temp));
    // HH clamps a temperature arriving from Spoolman to at least default_extruder_temp, and a spool with none
    // arrives as temp '' (v3.4.2 mmu_server _get_filament_attr), safe_int('') = 0: the gate gets the default.
    const floor = mmuAct.tempFloor();
    const effT = newT !== null ? Math.round(floor !== null ? Math.max(newT, floor) : newT) : floor;
    const oldMat = g.material && g.material !== "—" ? g.material : "";
    const changes = (oldMat && newMat && oldMat.toUpperCase() !== newMat.toUpperCase()) || (t && effT && t !== effT);
    const parts = [
      `Map #${sp.id} · ${spoolName(sp)} (${newMat || "no material"}, ${grams(num(sp.remaining_weight))}) to gate ${g.i}?`,
      occId ? `Gate ${g.i} holds #${occId}${occ ? " · " + spoolName(occ) : ""} now; it is unmapped.` : null,
      from !== null ? (m.gates[from] && m.gates[from].loaded
        ? `#${sp.id} leaves gate ${from}, the LOADED gate, which is left with no spool; its next load changes no active spool.`
        : `#${sp.id} leaves gate ${from}.`) : null,
      changes ? `The gate was ${oldMat || "no material"}${t ? " " + t + " °C" : ""} and takes ${newMat || "no material"}${effT ? " " + effT + " °C" : ""} from the spool${newT === null && effT ? " (Happy Hare's default: the spool sets no temperature)" : ""}.` : null,
      g.empty ? `Happy Hare still marks gate ${g.i} EMPTY; mapping a spool does not change that.` : null,
      inPrint ? (g.loaded
        ? `This gate is feeding the print; Moonraker keeps logging against #${activeId || "?"} until the next load.`
        : `A print is running; the next tool change into gate ${g.i} uses this spool.`) : null,
    ];
    const build = () => mmuAct.spoolScript(g.i, sp.id);
    setConfirm({
      kind: "gate", key: gateKey, label: `GATE ${g.i} ← SPOOL #${sp.id}`,
      cmd: build(), build,
      confirm: parts.filter(Boolean).join(" "),
      run: () => mmuAct.assignSpool(g.i, sp.id),
    });
  };

  const askUnmap = (sp, gi) => {
    const build = () => mmuAct.spoolScript(gi, null);
    setConfirm({
      kind: "gate", key: gateKey, label: `CLEAR GATE ${gi}`,
      cmd: build(), build,
      confirm: `Unmap #${sp.id} · ${spoolName(sp)} from gate ${gi}? The filament does not move. A load from a gate with no spool leaves Moonraker's active spool unchanged, so that filament is logged against whichever spool was active before.`
        + (inPrint ? ` A print is running${m.gates[gi] && m.gates[gi].loaded ? " from this gate" : ""}: that applies to every later tool change into gate ${gi}.` : ""),
      run: () => mmuAct.assignSpool(gi, null),
    });
  };

  // The gate tiles only render with a spool picked, so a tap always means "put the picked spool here".
  const tapGate = g => {
    if (gateWhy) { act.refuse(`GATE ${g.i}`, gateWhy); return; }
    if (selGate === g.i) askUnmap(sel, g.i); else askAssign(sel, g);
  };

  const find = async () => {
    const v = await askInput({ mode: "text", label: "FIND SPOOL", value: q, hint: "name · material · vendor · id" });
    if (v !== null) setQ(String(v).trim());
  };

  // ---- the active strip
  const liveGate = activeId ? gateOf(activeId) : null;
  const loadedHere = liveGate !== null && m.gates[liveGate] && m.gates[liveGate].loaded;
  const mmuLoaded = m.present && String(m.filament).toLowerCase() === "loaded";
  // m.filament is the MMU's state, not the active spool's gate's: with the active spool in gate 3 and gate 5
  // loaded it must not read "GATE 3 · LOADED". The bypass (gate -2) carries no spool id at all.
  const lg = mmuLoaded && Number.isInteger(m.gate) ? m.gate : null;
  const liveState = !activeId ? null
    : loadedHere ? { kind: "ok", text: `LOADED · GATE ${liveGate}` }
    : lg === -2 ? { kind: "off", text: "BYPASS LOADED" }
    : lg !== null && lg >= 0 ? { kind: "warn", text: `G${lg} LOADED · ${gateIds[lg] > 0 ? "#" + gateIds[lg] : "NO SPOOL"}` }
    : mmuLoaded ? { kind: "warn", text: "LOADED · GATE ?" }
    : liveGate !== null ? { kind: "off", text: `GATE ${liveGate} · ${String(m.filament || "").toUpperCase()}` }
    : null;
  // With Moonraker down nothing is known about Spoolman; "OFFLINE" would be a guess.
  const svcBadge = !st.connected ? ["off", "SPOOLMAN ?"]
    : svc.loading && !svc.data ? ["off", "CHECKING"]
    : svc.error ? ["warn", "SPOOLMAN ?"]
    : online ? ["ok", "SPOOLMAN"] : ["err", "SPOOLMAN OFFLINE"];
  const liveFill = fillOf(live);
  const liveCol = swatch(live && live.filament && live.filament.color_hex) || EMPTY_COLOR;
  const liveLeft = live ? num(live.remaining_weight) : null;
  const liveLow = liveFill !== null && liveFill < LOW;

  // ---- the picked spool
  const f = (sel && sel.filament) || {};
  const selFill = fillOf(sel);
  const selLeft = sel ? num(sel.remaining_weight) : null;
  const selLow = selFill !== null && selFill < LOW;
  const selCol = swatch(f.color_hex) || EMPTY_COLOR;
  const hex = /^[0-9a-f]{6}$/i.test(String(f.color_hex || "")) ? "#" + String(f.color_hex).toUpperCase() : null;
  const ext = num(f.settings_extruder_temp), bed = num(f.settings_bed_temp);

  const listBody = !st.connected ? <Empty title="MOONRAKER OFFLINE" hint="The spool list comes through Moonraker's Spoolman proxy." />
    : list.error ? <Empty title="SPOOLMAN UNREACHABLE" hint={`${list.error}.${online === false ? " Moonraker reports Spoolman disconnected." : ""} Tap REFRESH to try again.`} />
    : list.loading && !all.length ? <Empty title="LOADING SPOOLS" hint="Reading /spool through Moonraker's proxy." />
    : !all.length ? <Empty title="SPOOLMAN HAS NO SPOOLS" hint="Add spools in Spoolman; archived spools are not listed." />
    : !rows.length ? <Empty title="NO SPOOL MATCHES" hint={[q ? `"${q}"` : null, matOn].filter(Boolean).join(" · ") + " — tap ALL, or clear the search."} />
    : (
      <div className="scroll" style={S(`flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; border-top:1px solid ${C.line1}`)}>
        {rows.map(sp => (
          <SpoolRow key={sp.id} sp={sp} on={sel && sel.id === sp.id} active={sp.id === activeId}
            gate={m.present ? gateOf(sp.id) : null} onTap={() => setPick(sp.id)} />
        ))}
      </div>
    );

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      {/* ACTIVE — what Moonraker logs filament use against, right now. Tapping it brings it back into the detail. */}
      <div style={S(panel("flex:none; flex-direction:row; align-items:center; gap:12px; height:60px; padding:5px 5px 5px 14px"))}>
        <Hv as="div" onClick={() => setPick(null)} active={`background:${C.line1}`}
          style={"flex:1; min-width:0; align-self:stretch; display:flex; align-items:center; gap:12px; border-radius:6px; cursor:pointer"}>
          <span style={S(`${microLabel(C.faint)}; flex:none`)}>ACTIVE</span>
          {live ? (
            <>
              <span style={S(`width:10px; height:34px; flex:none; border-radius:3px; background:${liveCol}; border:1px solid ${C.line4}`)} />
              <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:3px")}>
                <span style={S(mono(F.val, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{spoolName(live)}</span>
                <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                  {[`#${live.id}`, matOf(live) || "—", ((live.filament || {}).vendor || {}).name].filter(Boolean).join(" · ")}
                </span>
              </div>
              <div style={S("flex:none; width:118px; display:flex; flex-direction:column; align-items:flex-end; gap:6px")}>
                <span style={S(mono(F.val, `color:${liveLeft === 0 ? C.accent : liveLow ? C.bed : C.text}`))}>{`${grams(liveLeft)} left`}</span>
                <div style={S("width:100%")}><Bar pct={liveFill === null ? 0 : liveFill * 100} color={liveLow ? C.bed : liveCol} h={4} /></div>
              </div>
              {liveState ? <span style={S(`flex:none; ${badgeStyle(liveState.kind)}`)}>{liveState.text}</span> : null}
            </>
          ) : (
            <span style={S(mono(F.label, `color:${activeId ? C.mute : C.bed}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
              {activeId
                ? (list.loading ? `#${activeId} · LOADING…` : list.error ? `#${activeId} · SPOOLMAN DID NOT ANSWER` : `#${activeId} · NOT IN SPOOLMAN'S LIST`)
                : st.connected ? "NONE — MOONRAKER IS NOT LOGGING FILAMENT USE" : "UNKNOWN — MOONRAKER OFFLINE"}
            </span>
          )}
        </Hv>
        <span style={S(`flex:none; ${badgeStyle(svcBadge[0])}`)} title={svc.error || undefined}>{svcBadge[1]}</span>
        {queued ? <span style={S(`flex:none; ${badgeStyle("warn")}`)} title="usage reports Moonraker is holding until Spoolman answers">{`${queued} QUEUED`}</span> : null}
        <div style={S("flex:none; width:112px")}>
          <PanelBtn label="REFRESH" h={TAP.min} onTap={refresh} />
        </div>
      </div>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:${LEFT_W}px minmax(0,1fr); gap:${L.gap}px`)}>

        {/* the picked spool, and the gates it can go into */}
        <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
          <Panel title={sel ? `SPOOL #${sel.id}` : "SPOOL"} style="flex:1; min-height:0" bodyStyle="padding:10px 12px; gap:9px"
            right={sel ? (
              <>
                {sel.id === activeId ? <span style={S(badgeStyle("ok"))}>ACTIVE</span> : null}
                {selGate !== null ? <span style={S(gateBadge)}>{`GATE ${selGate}`}</span> : null}
                {selLeft === 0 ? <span style={S(badgeStyle("err"))}>0 g</span> : selLow ? <span style={S(badgeStyle("warn"))}>LOW</span> : null}
                {sel.archived ? <span style={S(badgeStyle("off"))}>ARCHIVED</span> : null}
              </>
            ) : null}>
            {!sel ? (
              !selId ? <Empty title="NO SPOOL PICKED" hint="Tap a spool in the list to see it here and put it in a gate." />
                : list.loading ? <Empty title={`LOADING #${selId}`} hint="Reading the spool through Moonraker's proxy." />
                : list.error ? <Empty title={`#${selId} UNAVAILABLE`} hint={`Spoolman did not answer: ${list.error}.`} />
                : <Empty title={`#${selId} NOT IN SPOOLMAN`} hint="Moonraker names it, but Spoolman's list of unarchived spools does not have it." />
            ) : (
              <>
                <div style={S("flex:none; display:flex; align-items:center; gap:12px")}>
                  <span style={S(`width:44px; height:44px; flex:none; border-radius:6px; background:${selCol}; border:1px solid ${C.line4}`)} />
                  <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:4px")}>
                    <span style={S(mono(F.val, `color:${C.text}; line-height:1.2; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden`))}>{spoolName(sel)}</span>
                    <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                      {[f.material || "—", (f.vendor || {}).name, hex].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                </div>
                <Bar pct={selFill === null ? 0 : selFill * 100} color={selLow ? C.bed : selCol} h={6} />
                <div style={S("flex:none; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px 10px")}>
                  <Fact k="REMAINING" v={grams(selLeft)} color={selLeft === 0 ? C.accent : selLow ? C.bed : C.text} />
                  <Fact k="INITIAL" v={grams(num(sel.initial_weight) ?? num(f.weight))} color={C.dim} />
                  <Fact k="LENGTH" v={metres(num(sel.remaining_length))} color={C.dim} />
                  <Fact k="SPOOLMAN LOCATION" v={sel.location || "none set"} span={2} color={sel.location ? C.body : C.ghost} />
                  <Fact k="NOZZLE/BED" v={ext !== null || bed !== null ? `${ext ?? "—"}/${bed ?? "—"} °C` : "—"} color={C.dim} />
                </div>

                <div style={S("flex:none; display:flex; align-items:center; gap:10px; min-width:0; margin-top:2px")}>
                  <span style={S(`${microLabel(C.faint)}; flex:none`)}>ASSIGN TO GATE</span>
                  <span style={S(`margin-left:auto; ${mono(F.micro, `letter-spacing:.08em; color:${gateWhy ? C.bed : C.ghost}`)}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}>
                    {gateWhy ? gateWhy.toUpperCase() : selGate !== null ? `TAP G${selGate} TO CLEAR IT` : "TAP A GATE"}
                  </span>
                </div>
                {m.present ? (
                  <div style={S("flex:none; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px")}>
                    {m.gates.map(g => (
                      <GateTile key={g.i} g={g} sp={g.spoolId ? byId[g.spoolId] : null}
                        here={selGate === g.i} dim={!!gateWhy} onTap={() => tapGate(g)} />
                    ))}
                  </div>
                ) : (
                  <span style={S(mono(F.label, `color:${C.ghost}`))}>NO MMU — NOTHING TO ASSIGN TO</span>
                )}
              </>
            )}
          </Panel>

          {/* first column is the nav FAB's corner */}
          <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 1fr 1fr; gap:8px`)}>
            <span />
            <PanelBtn label={clearsActive ? "CLEAR ACTIVE" : "SET ACTIVE"} sub={setWhy ? short(setWhy) : `#${clearsActive ? activeId : sel.id}`}
              tone={setWhy || clearsActive ? undefined : "accent"} h={TAP.primary}
              disabled={!!setWhy} why={setWhy || undefined} onTap={() => (clearsActive ? askClearActive(activeId) : askActive(sel))} />
            <PanelBtn label={selGate !== null ? `CLEAR GATE ${selGate}` : "CLEAR GATE"} sub={clrWhy ? short(clrWhy) : `#${sel.id}`} h={TAP.primary}
              disabled={!!clrWhy} why={clrWhy || undefined} onTap={() => askUnmap(sel, selGate)} />
          </div>
        </div>

        {/* every spool: search, material facets, and a list that scrolls inside its own panel */}
        <Panel title="SPOOLS" style="min-height:0"
          right={<span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}`))}>{all.length ? `${rows.length} / ${all.length}` : "—"}</span>}>
          <div style={S("flex:none; display:flex; align-items:center; gap:6px; padding:10px 12px")}>
            <Chip label="FIND" sub={q ? (q.length > 10 ? q.slice(0, 9) + "…" : q) : "NAME · ID"} on={!!q}
              flex="none" minW={104} h={TAP.min} fs={F.label} onTap={find} />
            {q ? <Chip label="✕" flex="none" minW={TAP.min} h={TAP.min} fs={F.label} onTap={() => setQ("")} /> : null}
            <div className="scroll" style={S("flex:1; min-width:0; display:flex; gap:6px; overflow-x:auto; overflow-y:hidden; overscroll-behavior:contain")}>
              {[{ material: null, count: all.length }].concat(facets).map(fc => (
                <Chip key={fc.material || "ALL"} label={fc.material || "ALL"} sub={String(fc.count)}
                  on={(fc.material || null) === matOn} flex="none" minW={64} h={TAP.min} fs={F.label}
                  onTap={() => setMat(fc.material || null)} />
              ))}
            </div>
          </div>
          {listBody}
        </Panel>
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => {
            const c = confirm; setConfirm(null);
            // The gate confirm names who is where; if the map moved while it was open, that text is stale. Its
            // command is built again from live state too (a TEMP that moved), and must still be the one shown.
            const why = c.kind === "active" ? smWhy
              : c.kind === "clear" ? smWhy || (c.id !== activeId ? "the active spool changed while this was open — look again" : null)
              : gateWhy || (c.key !== gateKey ? "the gate map changed while this was open — look again" : null)
                || (c.build() !== c.cmd ? "the command changed while this was open — look again" : null);
            if (why) { act.refuse(c.label, why); return; }
            c.run();
          }} />
      ) : null}
    </div>
  );
}
