// ---------------------------------------------------------------------------
// GATE MAP — per-gate view and editor for the ERCF, plus the bypass slot. A full screen (MORE -> GATE MAP)
// and the body of the MMU screen's GATE MAP tab (`embedded`: no outer padding or title, the host owns the
// chrome). Embedded still keeps the nav-button column in its bottom row: the shell's FAB is a frame-level
// overlay at left:10 bottom:10 (56 px, z 30) and sits over the MMU tab body's bottom-left corner too, which is
// why mmu.jsx's own STATUS action bar reserves the same column. Dropping it would put CHOOSE SPOOL under it.
//
// SPOOLMAN IS THE SOURCE OF TRUTH (the owner's rule). Name, material, colour and temperature belong to the
// spool record, so choosing the SPOOL is the edit: makeMmuActions().assignSpool() in lib/actions/mmu.js,
// the same call the dashboard's gate editor makes. Nothing about the filament is typed in by hand. This
// printer runs spoolman_support: push (live: mmu.spoolman_support and [mmu] both say "push"), so the
// assignment is the LOCAL `MMU_GATE_MAP GATE=n SPOOLID=x`; assignSpool's comments explain why
// MMU_SPOOLMAN would be silently undone in push mode.
//
// What Happy Hare v3.4.2's cmd_MMU_GATE_MAP actually reads for a single gate (read from the source):
//   AVAILABLE  -1..2   UNKNOWN / EMPTY / AVAILABLE ("Spool") / BUFFERED ("Buffer"), HH's own four words.
//   SPEED      10..150 a % multiplier on this gate's gear moves (speed AND accel), default 100.
//   SPOOLID    minval -1. `spool_id or existing`, so 0 keeps the old id and -1 clears it.
//   TEMP       `get_int('TEMP', default_extruder_temp)` then `temperature or existing`: an omitted TEMP
//              becomes 200 and sticks. act.setGateMap, assignSpool and setGateLocal all send it.
//   pull mode  only AVAILABLE and SPEED apply; TEMP is ignored and SPOOLID/NAME/MATERIAL/COLOR error.
// assign_spool_id() clears the same spool from any other gate, so a spool can sit in one gate only; the
// confirm says so when that will happen.
//
// Gate temperature matters less than it looks: _ensure_safe_extruder_temperature() heats to it only when
// the nozzle target is below min_extrude_temp (210 here). While printing HH defers to the slicer. So the
// manual TEMP override is offered only when no spool supplies one — the owner's rule. It lasts only on a gate
// with NO spool. Push mode re-sends every mapped gate's Spoolman attributes at each Klipper start
// (_spoolman_sync) and whenever that gate's mapping changes. For a spool with no settings_extruder_temp,
// v3.4.2's mmu_server sends temp '' and HH keeps max(safe_int('') = 0, default_extruder_temp), so the
// override goes back to 200. The TEMP confirm says so. The
// same function discards any target `<= min_extrude_temp` for default_extruder_temp, so the keypad's floor
// is min_extrude_temp + 1: a gate set to exactly 210 would never be heated to. Live, default_extruder_temp
// (200) is itself below min_extrude_temp (210), so a gate left at HH's default is one HH will not heat to;
// the panel says so rather than presenting 200 °C as a usable value.
//
// Spool attribution mid-print: HH makes a gate's spool active in Moonraker only when it LOADS that gate
// (_spoolman_activate_spool after a load). Re-mapping never touches the active spool, so the confirms say
// the change lands at the next load rather than claiming it re-attributes the running job.
//
// Live state this was built against (2026-09-23, read-only): 8 gates, has_bypass, gate_status
// [0,0,2,2,2,1,0,2], spools [-,-,35,45,43,46,-,23], empty gates at HH's 200 °C default and the ABS spools at
// 250, every speed override 100, endless_spool_groups [0..7] with endless spool ON — i.e. every gate is its
// own group and nothing has a spare. Group LETTERS are HH's (chr(ord('A') + group)), so gate 5's group
// reads "F" here exactly as it does in HH's "EndlessSpool Group F" pause message.
//
// The bypass has no gate-map entry: the gate_* arrays hold gates 0..7 only, and _set_gate_selected()
// publishes an EMPTY active_filament while the bypass (-2) is selected. So its card says what it is and
// offers nothing to edit, rather than inventing a ninth column of data.
//
// MMU_CHECK_GATE refuses (check_if_bypass) when tool_selected is the bypass and filament_pos is not
// UNLOADED, and (check_if_not_homed) when the selector is not homed; both are said before the tap.
//
// Nothing here is sent on render or mount; the spool list is fetched (read-only, via Moonraker's Spoolman
// proxy) only when the picker is opened. Every write goes through a confirm and is re-checked — guards AND
// the control's own reason, for the gate the confirm names — at the moment CONFIRM is tapped. A command that
// lib/actions/mmu.js builds is built again at CONFIRM too, and refused if it no longer matches the one shown.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel, panelHead } from "../tokens.js";
import { mmu as mmuVm, badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Chip, Bar, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { GATE, GATE_STATES } from "../../lib/hh.js";
import { makeMmuActions } from "../../lib/actions/mmu.js";
import { fmtDate } from "../../lib/design.jsx";
import { useSpoolList, filterSpools, materialsOf, swatch, grams, metres, whenSeconds, spoolName, fillOf, num, EMPTY_COLOR, LOW } from "../../lib/spools.js";

const BYPASS = -2;   // Happy Hare's TOOL_GATE_BYPASS
const MAP_GUARDS = { needsMmu: true, needsMmuIdle: true };
// MMU_CHECK_GATE moves filament and, if a tool is loaded, first runs a full unload with a toolhead park.
const CHECK_GUARDS = { needsMmu: true, needsMmuIdle: true, whilePrinting: false };

/** HH's four availability states in its own vocabulary (lib/hh.js GATE_STATES), each with this screen's colour. */
const AVAIL_COL = { [GATE.EMPTY]: C.ghost, [GATE.AVAILABLE]: C.cool, [GATE.BUFFER]: C.cool, [GATE.UNKNOWN]: C.bed };
const AVAIL = GATE_STATES.map(a => Object.assign({ col: AVAIL_COL[a.v] }, a));
const availOf = v => AVAIL.find(a => a.v === v) || { v, label: String(v), sub: "", word: "?", col: C.bed };
const letter = grp => (Number.isInteger(grp) && grp >= 0 ? String.fromCharCode(65 + grp) : "?");

/** One gate, Spoolman first and Happy Hare's mirrored copy only where Spoolman has nothing. */
function gateRow(mm, byId, i, n) {
  const at = k => (Array.isArray(mm[k]) ? mm[k][i] : undefined);
  const id = num(at("gate_spool_id"));
  const spoolId = id !== null && id > 0 ? id : null;
  const sp = spoolId ? byId[spoolId] || null : null;
  const fil = (sp && sp.filament) || {};
  const groups = Array.isArray(mm.endless_spool_groups) ? mm.endless_spool_groups : [];
  const group = Number.isInteger(groups[i]) ? groups[i] : null;
  const hh = { name: String(at("gate_filament_name") || ""), material: String(at("gate_material") || ""), color: String(at("gate_color") || "") };
  return {
    i, spoolId, sp, hh,
    status: num(at("gate_status")),
    name: sp ? spoolName(sp) : hh.name,
    material: fil.material || hh.material,
    vendor: (fil.vendor && fil.vendor.name) || "",
    color: swatch(fil.color_hex) || swatch(hh.color),
    fill: fillOf(sp),
    remain: num(sp && sp.remaining_weight),
    total: num(sp && sp.initial_weight) ?? num(fil.weight),
    temp: num(at("gate_temperature")),
    spoolTemp: num(fil.settings_extruder_temp),
    speed: num(at("gate_speed_override")),
    group,
    mates: group === null ? [] : Array.from({ length: n }, (_, j) => j).filter(j => j !== i && groups[j] === group),
    tools: (Array.isArray(mm.ttg_map) ? mm.ttg_map : []).map((gt, t) => (gt === i ? t : null)).filter(t => t !== null),
  };
}

function Swatch({ color, size, radius = 6 }) {
  return (
    <span style={S(`flex:none; width:${size}px; height:${size}px; border-radius:${radius}px; ${color
      ? `background:${color}; border:1px solid ${C.line5}`
      : `background:${C.panelSunk}; border:1px dashed ${C.line4}`}`)} />
  );
}

function Fact({ k, v, color = C.body }) {
  return (
    <div style={S("min-width:0; display:flex; flex-direction:column; gap:3px")}>
      <span style={S(microLabel(C.faint))}>{k}</span>
      <span style={S(mono(F.label, `color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
    </div>
  );
}

/** A gate in the strip. Tapping only picks what the panels below show; nothing is sent. */
function GateCard({ r, on, onTap }) {
  const a = availOf(r.status);
  const empty = r.status === GATE.EMPTY;
  return (
    <Hv as="div" onClick={onTap} active="transform:translateY(1px)"
      style={`min-width:0; height:124px; padding:7px 8px; display:flex; flex-direction:column; gap:4px; border-radius:7px; cursor:pointer; transition:border-color .16s, background .16s; ${on
        ? `background:${C.selBg}; border:1px solid ${C.accentLine};`
        : `background:${C.panelSunk}; border:1px solid ${C.line2};`}`}>
      <div style={S("display:flex; align-items:center; justify-content:space-between; gap:4px")}>
        <span style={S(mono(F.label, `color:${on ? C.accent : C.dim}`))}>{r.i}</span>
        <span style={S(mono(F.micro, `letter-spacing:.06em; color:${a.col}`))}>{a.word}</span>
      </div>
      <div style={S("display:flex; align-items:center; gap:6px; min-width:0")}>
        <Swatch color={r.color} size={22} radius={5} />
        <span style={S(mono(F.label, `color:${empty ? C.mute : C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{r.material || "—"}</span>
      </div>
      <Bar pct={r.fill === null ? 0 : r.fill * 100} color={r.fill !== null && r.fill <= LOW ? C.bed : C.cool} h={4} />
      <span style={S(mono(F.micro, `color:${C.dim}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{r.name || "—"}</span>
      <span style={S(mono(F.micro, `color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
        {r.spoolId ? `#${r.spoolId} ${r.remain === null ? "—" : grams(r.remain)}` : "NO SPOOL"}
      </span>
      <div style={S("display:flex; align-items:center; justify-content:space-between; gap:4px")}>
        <span style={S(mono(F.micro, `color:${C.faint}`))}>{r.temp ? `${Math.round(r.temp)}°` : "—"}</span>
        <span style={S(`${mono(F.micro, `color:${r.mates.length ? C.cool : C.ghost}`)}; padding:0 5px; border:1px solid ${r.mates.length ? C.okLine : C.line3}; border-radius:3px`)}>{letter(r.group)}</span>
      </div>
    </Hv>
  );
}

function BypassCard({ on, here, loaded, onTap }) {
  return (
    <Hv as="div" onClick={onTap} active="transform:translateY(1px)"
      style={`min-width:0; height:124px; padding:7px 8px; display:flex; flex-direction:column; gap:4px; border-radius:7px; cursor:pointer; ${on
        ? `background:${C.selBg}; border:1px solid ${C.accentLine};`
        : `background:${C.panelSunk}; border:1px dashed ${C.line3};`}`}>
      <div style={S("display:flex; align-items:center; justify-content:space-between; gap:4px")}>
        <span style={S(mono(F.label, `color:${on ? C.accent : C.dim}`))}>BP</span>
        <span style={S(mono(F.micro, `color:${here ? C.cool : C.ghost}`))}>{here ? (loaded ? "LOADED" : "SEL") : ""}</span>
      </div>
      <div style={S("display:flex; align-items:center; gap:6px; min-width:0")}>
        <Swatch color={null} size={22} radius={5} />
        <span style={S(mono(F.label, `color:${C.mute}`))}>BYPASS</span>
      </div>
      <span style={S(mono(F.micro, `color:${C.faint}`))}>manual feed</span>
      <span style={S(mono(F.micro, `color:${C.ghost}`))}>no gate map</span>
    </Hv>
  );
}

/** Small chooser sheet in the confirm's idiom (only the endless-spool group uses it). */
function Sheet({ title, children, onClose }) {
  return (
    <div onClick={onClose} style={S("position:absolute; inset:0; z-index:45; background:rgba(4,6,9,.82); display:flex; align-items:center; justify-content:center; animation:ksFade .14s ease both")}>
      <div onClick={e => e.stopPropagation()}
        style={S(`width:660px; background:${C.panel}; border:1px solid ${C.line4}; border-radius:9px; overflow:hidden; animation:ksRise .18s ease both`)}>
        <div style={S(panelHead())}>
          <span style={S(`width:3px; height:12px; background:${C.bed}; border-radius:1px`)} />
          <span style={S(mono(F.label, `letter-spacing:.18em; color:${C.text}`))}>{title}</span>
        </div>
        <div style={S("padding:14px 16px 16px; display:flex; flex-direction:column; gap:12px")}>{children}</div>
      </div>
    </div>
  );
}

export default function GateMap({ st, api, act, askInput, embedded = false }) {
  const m = mmuVm(st);
  const raw = st.raw || {};
  const mm = raw.mmu || {};
  const cfg = st.config || {};

  const [pick, setPick] = React.useState(() => {
    const g = Number(mm.gate);
    return g === BYPASS ? BYPASS : Number.isInteger(g) && g >= 0 ? g : 0;
  });
  const [picking, setPicking] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [mat, setMat] = React.useState(null);
  const [groupOpen, setGroupOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState(null);
  React.useEffect(() => { setPicking(false); setGroupOpen(false); setQ(""); setMat(null); }, [pick]);

  // The spool list is only fetched while the picker is open (useSpoolList is inert when disabled); byId
  // always carries the gate spools boot.js re-reads every 60 s, so the cards need no request of their own.
  const list = useSpoolList(api, st, { enabled: picking });
  const byId = list.byId;

  // makeMmuActions reads a store (`store.state`) at CALL time, so a view over the latest render is all it needs.
  // It reads spoolman_support from the LIVE mmu object first (MMU_TEST_CONFIG can change it at runtime), then
  // [mmu] from st.config. The confirms show its own spoolScript / gateLocalScript, built from the same state by
  // the same code assignSpool / setGateLocal send with, so the command previewed is the command sent.
  // Its lines go to the screen's command log (act.log: st.screenLog, and warn/err reach the toast), the same
  // place every other write on this screen reports to.
  const live = React.useRef(st); live.current = st;
  const actRef = React.useRef(act); actRef.current = act;
  const mmuAct = React.useMemo(() => makeMmuActions({
    api,
    store: { get state() { return live.current || {}; } },
    log: (msg, kind) => { const a = actRef.current; if (a && typeof a.log === "function") a.log(msg, kind); },
  }), [api]);

  const wrap = embedded
    ? `flex:1; min-height:0; height:100%; display:flex; flex-direction:column; gap:${L.gap}px; position:relative`
    : `height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`;
  const fabCol = L.fab + L.fabInset;

  if (!m.present) {
    return (
      <div style={S(wrap)}>
        <div style={S(panel("flex:1; min-height:0; margin-bottom:" + (embedded ? 0 : fabCol - L.pad) + "px"))}>
          <Empty title="NO MMU CONFIGURED" hint="Klipper reports no Happy Hare `mmu` object, so there is no gate map to show." />
        </div>
      </div>
    );
  }

  const n = m.n;
  const rows = Array.from({ length: n }, (_, i) => gateRow(mm, byId, i, n));
  const isBypass = pick === BYPASS;
  const g = isBypass ? BYPASS : Math.max(0, Math.min(n - 1, pick));
  const r = isBypass ? null : rows[g];

  const mode = mmuAct.spoolmanMode();
  const pull = mode === "pull";
  const defTemp = mmuAct.tempFloor();
  const minT = num((cfg.extruder || {}).min_extrude_temp);
  const maxT = num((cfg.extruder || {}).max_temp);
  const inPrint = ["printing", "paused"].indexOf((raw.print_stats || {}).state) >= 0;
  const gateIds = Array.isArray(mm.gate_spool_id) ? mm.gate_spool_id : [];
  const spoolCmd = pull ? "MMU_SPOOLMAN" : "MMU_GATE_MAP";
  // GROUPS must carry num_gates entries (cmd_MMU_ENDLESS_SPOOL rejects any other count), so without HH's own
  // array there is nothing honest to send for the other seven gates.
  const groupsLive = Array.isArray(mm.endless_spool_groups) && mm.endless_spool_groups.length === n
    && mm.endless_spool_groups.every(x => Number.isInteger(x) && x >= 0);
  // assignSpool and setGateLocal go through makeMmuActions, which needs the Moonraker client itself.
  const noApi = api && typeof api.gcode === "function" ? null : "this screen was opened without the Moonraker client";

  // ---- why each control is (un)available, for ANY gate: the render uses the picked gate, and CONFIRM re-asks
  // for the gate the confirm names (the keyboard leaves the strip tappable, so that can differ) ------------
  const bypassLoaded = m.tool === BYPASS && m.filamentPos !== 0;   // HH check_if_bypass(): tool_selected + filament_pos
  const whysFor = gi => {
    const x = gi === BYPASS ? null : rows[gi];
    const bp = x ? null : "the bypass has no gate-map entry";
    const map = bp || act.blocked(MAP_GUARDS, "MMU_GATE_MAP");
    const spool = bp || act.blocked(MAP_GUARDS, spoolCmd) || noApi
      || (mode === "off" ? "Happy Hare's spoolman_support is off, so a spool id would not bring its filament" : null);
    return {
      map, spool,
      clear: spool || (!x.spoolId ? "no spool in this gate" : null),
      speed: map || noApi,
      temp: map
        || (pull ? "spoolman_support is pull: Spoolman owns the temperature" : null)
        || (x.spoolId && !x.sp ? `spool #${x.spoolId} is not loaded from Spoolman yet` : null)
        || (x.spoolId && x.spoolTemp !== null ? `spool #${x.spoolId} sets ${Math.round(x.spoolTemp)} °C — change it in Spoolman` : null)
        || (minT === null || maxT === null ? "extruder temperature limits are not loaded yet" : null),
      group: bp || act.blocked(MAP_GUARDS, "MMU_ENDLESS_SPOOL")
        || (!groupsLive ? "Happy Hare has not published its endless-spool groups" : null),
      check: bp || act.blocked(CHECK_GUARDS, `MMU_CHECK_GATE GATE=${gi}`)
        || (!m.isHomed ? "the MMU selector is not homed" : null)
        || (bypassLoaded ? "the bypass is loaded — unload it first" : null),
    };
  };
  const why = isBypass ? null : whysFor(g);
  const bypassWhy = isBypass ? "the bypass has no gate-map entry" : null;
  const mapWhy = bypassWhy || why.map;
  const spoolWhy = bypassWhy || why.spool;
  const clearWhy = bypassWhy || why.clear;
  const speedWhy = bypassWhy || why.speed;
  const tempWhy = bypassWhy || why.temp;
  const groupWhy = bypassWhy || why.group;
  const checkWhy = bypassWhy || why.check;

  // ---- confirm plumbing: every write, re-checked at the moment of CONFIRM --------------------------------
  // `kind` names the whysFor() entry to re-ask, so a state change while the confirm was up (the spool got a
  // temperature, the gate lost its spool, the selector unhomed) refuses instead of sending a stale write.
  // `cmd` may be a builder (mmuAct.spoolScript / gateLocalScript read the live store): it is shown as built now
  // and built again at CONFIRM, and a different result (the gate's TEMP moved) refuses rather than send a
  // command the user never saw. assignSpool / setGateLocal then build that same string once more to send it.
  const ask = (label, text, cmd, guards, script, kind, exec) => {
    const build = typeof cmd === "function" ? cmd : null;
    setConfirm({ label, confirm: text, cmd: build ? build() : cmd, build, guards, script, kind, gate: g, exec });
  };
  const onYes = () => {
    const c = confirm; setConfirm(null);
    if (!c) return;
    const no = act.blocked(c.guards, c.script) || (c.kind ? whysFor(c.gate)[c.kind] : null)
      || (c.build && c.build() !== c.cmd ? "the command changed while this was open — look again" : null);
    if (no) { act.refuse(c.label, no); return; }
    c.exec();
  };

  // Happy Hare sets Moonraker's active spool ONLY when it loads a gate (_spoolman_activate_spool after a load);
  // re-mapping a gate never touches it. So mid-print the attribution changes at this gate's next load, not now.
  const feeding = m.gate === g && m.filament === "Loaded";
  const activeTxt = st.activeSpool ? `#${st.activeSpool}` : "the active spool";
  const chooseSpool = sp => {
    if (sp.id === r.spoolId) { setPicking(false); return; }
    const f = sp.filament || {};
    const other = gateIds.indexOf(sp.id);
    ask(`GATE ${g} · SPOOL #${sp.id}`,
      [`Put spool #${sp.id} (${spoolName(sp)}${f.material ? " · " + f.material : ""}) in gate ${g}?`,
        "Happy Hare then takes the name, material, colour and temperature from its Spoolman record.",
        // The push sync brings default_extruder_temp for a spool with no temperature (see the header).
        num(f.settings_extruder_temp) === null ? `That filament has no extruder temperature in Spoolman, so this gate gets Happy Hare's default${defTemp !== null ? ` ${defTemp} °C` : ""}; set one in Spoolman if it needs more.` : "",
        // cmd_MMU_GATE_MAP keeps gate_status when AVAILABLE is omitted, so a spool id alone never un-empties a gate.
        r.status === GATE.EMPTY ? `Happy Hare still marks gate ${g} EMPTY; set its availability or CHECK GATE once it is loaded.` : "",
        other >= 0 && other !== g ? `It sits in gate ${other} now — Happy Hare clears it from there.` : "",
        inPrint ? (feeding
          ? `This gate is feeding the print: Moonraker keeps logging its filament against ${activeTxt} until Happy Hare next loads this gate.`
          : "A print is running: Happy Hare makes the new spool active in Moonraker when it next loads this gate.") : ""].filter(Boolean).join(" "),
      () => mmuAct.spoolScript(g, sp.id),
      MAP_GUARDS, spoolCmd, "spool",
      () => { setPicking(false); mmuAct.assignSpool(g, sp.id); });
  };

  const clearSpool = () => ask(`GATE ${g} · CLEAR SPOOL`,
    `Take spool #${r.spoolId} out of gate ${g}?` + (pull
      ? " Spoolman drops the association and Happy Hare follows it."
      : " Happy Hare keeps the gate's name, material and colour until another spool is chosen.")
      + (inPrint && feeding ? ` This gate is feeding the print: Moonraker keeps logging against ${activeTxt} until the next load.` : ""),
    () => mmuAct.spoolScript(g, null),
    MAP_GUARDS, spoolCmd, "clear", () => mmuAct.assignSpool(g, null));

  const setAvail = a => {
    if (a.v === r.status) return;
    ask(`GATE ${g} · ${a.label}`,
      `Tell Happy Hare gate ${g} is ${a.label} (${a.sub.toLowerCase()})? Nothing is checked — this overrides what Happy Hare believes. CHECK GATE makes it look instead.`,
      `MMU_GATE_MAP GATE=${g}${r.temp !== null ? ` TEMP=${Math.round(r.temp)}` : ""} AVAILABLE=${a.v}`,
      MAP_GUARDS, "MMU_GATE_MAP", "map", () => act.setGateMap(g, { status: a.v }));
  };

  // _ensure_safe_extruder_temperature() throws away any heat target `<= min_extrude_temp` and uses
  // default_extruder_temp instead, so a gate set to exactly min_extrude_temp would never be used: the floor
  // offered is one degree above it.
  const tLo = minT === null ? null : Math.floor(minT) + 1;
  const setTemp = async () => {
    const v = await askInput({ mode: "numeric", label: `GATE ${g} TEMP`, value: r.temp !== null ? Math.round(r.temp) : "",
      unit: "°C", min: tLo, max: maxT, allowNegative: false, hint: `${tLo}–${maxT} · ABOVE MIN EXTRUDE` });
    if (v === null) return;
    const t = Math.round(Number(v));
    if (!Number.isFinite(t) || t === Math.round(r.temp)) return;
    // The keypad already refuses out-of-range values; this keeps the command honest if a caller's does not.
    if (t < tLo || t > maxT) { act.refuse(`GATE ${g} TEMP`, `${t} °C is outside ${tLo}–${maxT} °C`); return; }
    ask(`GATE ${g} · TEMP ${t} °C`,
      `Set gate ${g} to ${t} °C? Happy Hare heats to this when it must load or unload this gate with the nozzle below ${minT} °C; while printing it follows the slicer.`
        // Offered for a mapped gate only when its spool has no temperature, and the Spoolman sync resets exactly that.
        + (r.spoolId && mode && mode !== "off" ? ` Spool #${r.spoolId} has no temperature in Spoolman, so the next sync (every Klipper start) puts this gate back to Happy Hare's default${defTemp !== null ? ` ${defTemp} °C` : ""}.` : ""),
      `MMU_GATE_MAP GATE=${g} TEMP=${t}`, MAP_GUARDS, "MMU_GATE_MAP", "temp", () => act.setGateMap(g, { temp: t }));
  };

  const setSpeed = async () => {
    const v = await askInput({ mode: "numeric", label: `GATE ${g} LOAD SPEED`, value: r.speed !== null ? r.speed : 100,
      unit: "%", min: 10, max: 150, allowNegative: false, hint: "10–150 % · HAPPY HARE'S RANGE" });
    if (v === null) return;
    const s = Math.round(Number(v));
    if (!Number.isFinite(s) || s === r.speed) return;
    // setGateLocal sends SPEED and TEMP only: HH keeps the availability it holds, so an availability HH changes
    // while this confirm is up is not written back over.
    ask(`GATE ${g} · SPEED ${s} %`,
      `Scale gate ${g}'s gear moves (speed and acceleration) to ${s} %? Slower helps a spool that slips or tangles.`,
      () => mmuAct.gateLocalScript(g, { speed_override: s }),
      MAP_GUARDS, "MMU_GATE_MAP", "speed", () => mmuAct.setGateLocal(g, { speed_override: s }));
  };

  // Only used once groupsLive holds (groupWhy blocks the chooser otherwise); the `: i` fallback never reaches a command.
  const groupsNow = Array.from({ length: n }, (_, i) => (groupsLive ? mm.endless_spool_groups[i] : i));
  const pickGroup = grp => {
    setGroupOpen(false);
    if (grp === groupsNow[g]) return;
    const next = groupsNow.slice(); next[g] = grp;
    const mates = next.map((x, i) => (x === grp && i !== g ? i : null)).filter(i => i !== null);
    ask(`GATE ${g} · GROUP ${letter(grp)}`,
      `Put gate ${g} in endless-spool group ${letter(grp)}? ` + (mates.length
        ? `Gates that share a group are runout spares for each other: gate ${g} and gate ${mates.join(", ")}.`
        : `No other gate is in group ${letter(grp)}, so gate ${g} has no spare.`)
        + (m.endlessEnabled ? "" : " Endless spool is OFF — this also turns it on."),
      `MMU_ENDLESS_SPOOL ENABLE=1 GROUPS=${next.join(",")}`, MAP_GUARDS, "MMU_ENDLESS_SPOOL", "group",
      () => act.setEndlessGroups(next));
  };

  const askCheck = () => ask(`CHECK GATE ${g}`,
    `Have Happy Hare feed gate ${g} to its sensor and mark it for real?` + (m.filament !== "Unloaded"
      ? " Filament is not unloaded: Happy Hare runs a full unload first, which parks the toolhead." : ""),
    `MMU_CHECK_GATE GATE=${g}`, CHECK_GUARDS, `MMU_CHECK_GATE GATE=${g}`, "check",
    () => act.guarded(`MMU_CHECK_GATE GATE=${g}`, CHECK_GUARDS));

  const openPicker = () => { setQ(""); setMat(null); setPicking(true); };
  const search = async () => {
    const v = await askInput({ mode: "text", label: "SEARCH SPOOLS", value: q, hint: "NAME · MATERIAL · VENDOR · ID" });
    if (v !== null) setQ(v);
  };

  // ---- derived text ---------------------------------------------------------------------------------------
  const here = !isBypass && m.gate === g;
  // Kept to 18 characters or fewer: the tile's sub-label is nowrap in a 159 px column.
  const tempSource = !r ? "" : r.spoolTemp !== null
    ? (Math.round(r.spoolTemp) === Math.round(r.temp) ? "FROM SPOOL" : `SPOOL ${Math.round(r.spoolTemp)}°`)
    : r.temp !== null && defTemp !== null && Math.round(r.temp) === Math.round(defTemp) ? "HH DEFAULT" : "MANUAL";
  // Gate lists get long in a shared group (all ABS in one group = 4+ spares); past three, count them instead.
  const gateList = (pre, gs, none) => (!gs.length ? none : gs.length <= 3 ? `${pre} G${gs.join(" G")}` : `${pre} ${gs.length} GATES`);
  const modeKind = !mode ? "off" : mode === "off" ? "warn" : "ok";
  const headRight = (
    <>
      <span style={S(badgeStyle(modeKind))}>{`SPOOLMAN ${mode ? mode.toUpperCase() : "?"}`}</span>
      <span style={S(badgeStyle(m.endlessEnabled ? "ok" : "off"))}>{`ENDLESS ${m.endlessEnabled ? "ON" : "OFF"}`}</span>
    </>
  );
  const lastUsed = r && r.sp ? whenSeconds(r.sp.last_used) : null;
  const noteLine = (s, i) => <span key={i} style={S(mono(F.micro, `color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{s}</span>;
  // PanelBtn's `why` is a title attribute, which a finger never sees, so the reasons are also said in words.
  // Two lines fit the panel; refusals come first, then the explanation of the temperature, then the legend.
  const notes = !r ? [] : [
    mapWhy ? `LOCKED · ${mapWhy}` : null,
    !mapWhy && tempWhy ? `TEMP · ${tempWhy}` : null,
    spoolWhy && spoolWhy !== mapWhy ? `SPOOL · ${spoolWhy}` : null,
    groupWhy && groupWhy !== mapWhy ? `GROUP · ${groupWhy}` : null,
    checkWhy && checkWhy !== mapWhy ? `CHECK GATE · ${checkWhy}` : null,
    // Live: default_extruder_temp 200 < min_extrude_temp 210, so the empty gates sit at a temperature HH discards.
    !tempWhy ? (r.temp !== null && minT !== null && r.temp <= minT ? `TEMP · ${Math.round(r.temp)} °C ≤ min extrude ${Math.round(minT)} °C: HH will not heat to it`
      : tempSource === "HH DEFAULT" ? `TEMP · no spool temperature — ${Math.round(r.temp)} °C is Happy Hare's default`
      : "TEMP · used only when HH must heat a cold nozzle for this gate") : null,
    "SPEED scales gear moves · same GROUP letter = runout spares",
  ].filter(Boolean).slice(0, 2);

  return (
    <div style={S(wrap)}>
      {embedded ? null : (
        <div style={S("flex:none; height:34px; display:flex; align-items:center; gap:12px; min-width:0")}>
          <span style={S(`width:3px; height:15px; background:${C.accent}; border-radius:1px`)} />
          <span style={S(mono(F.label, `letter-spacing:.18em; color:${C.text}; white-space:nowrap`))}>GATE MAP</span>
          <span style={S(mono(F.micro, `letter-spacing:.14em; color:${C.faint}; white-space:nowrap`))}>{m.title}</span>
          <span style={S(`margin-left:auto; ${mono(F.micro, `letter-spacing:.1em; color:${C.faint}; white-space:nowrap`)}`)}>
            SPOOLMAN HOLDS THE FILAMENT · PICK THE SPOOL, THE GATE FOLLOWS
          </span>
        </div>
      )}

      {/* the strip: every gate plus the bypass */}
      <div style={S(`flex:none; display:grid; grid-template-columns:repeat(${n + (m.hasBypass ? 1 : 0)},minmax(0,1fr)); gap:8px`)}>
        {rows.map(x => <GateCard key={x.i} r={x} on={!isBypass && x.i === g} onTap={() => setPick(x.i)} />)}
        {m.hasBypass ? <BypassCard on={isBypass} here={m.gate === BYPASS} loaded={m.gate === BYPASS && m.filament === "Loaded"} onTap={() => setPick(BYPASS)} /> : null}
      </div>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 520px; gap:${L.gap}px`)}>
        {isBypass ? (
          <>
            <Panel title="BYPASS"
              right={m.gate === BYPASS ? <span style={S(badgeStyle(m.filament === "Loaded" ? "ok" : "off"))}>{m.filament === "Loaded" ? "LOADED" : "SELECTED"}</span> : null}
              bodyStyle="padding:12px 14px; gap:10px">
              <span style={S(`font-size:${F.body}px; color:${C.body}; line-height:1.45; text-wrap:pretty`)}>
                The bypass feeds filament to the extruder by hand. Happy Hare keeps no gate-map entry for it and
                publishes no active filament while it is selected, so there is nothing here to read or edit.
              </span>
              <div style={S("margin-top:auto; display:grid; grid-template-columns:1fr 1fr; gap:10px")}>
                <Fact k="SELECTOR" v={m.gate === BYPASS ? "AT THE BYPASS" : m.gate >= 0 ? `GATE ${m.gate}` : "UNKNOWN"} />
                <Fact k="MOONRAKER ACTIVE SPOOL" v={st.activeSpool ? `#${st.activeSpool}` : "NONE"} />
              </div>
            </Panel>
            <Panel title="HAPPY HARE · BYPASS" right={headRight} bodyStyle="padding:12px 14px">
              <Empty title="NOTHING TO EDIT" hint="Happy Hare tracks no filament for the bypass: what you feed it by hand is what prints." />
            </Panel>
          </>
        ) : (
          <>
            {/* what Spoolman says is in this gate */}
            <Panel title={`GATE ${g} · ${r.tools.length ? r.tools.map(t => "T" + t).join(" ") : "NO TOOL"}`}
              right={here ? <span style={S(badgeStyle(m.filament === "Loaded" ? "ok" : "off"))}>{m.filament === "Loaded" ? "LOADED" : "SELECTOR HERE"}</span> : null}
              bodyStyle="padding:12px 14px; gap:10px">
              <div style={S("display:flex; align-items:center; gap:14px; min-width:0")}>
                <Swatch color={r.color} size={60} radius={10} />
                <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:4px")}>
                  <span style={S(mono(F.num2, `color:${r.name ? C.text : C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                    {r.name || (r.spoolId ? `SPOOL #${r.spoolId}` : "NO SPOOL")}
                  </span>
                  <span style={S(mono(F.label, `color:${C.dim}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                    {[r.material, r.vendor].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span style={S(mono(F.micro, `letter-spacing:.08em; color:${r.spoolId && !r.sp ? C.bed : C.faint}`))}>
                    {r.sp ? `SPOOL #${r.spoolId} · SPOOLMAN` : r.spoolId ? `SPOOL #${r.spoolId} · NOT FETCHED FROM SPOOLMAN` : "NO SPOOL ASSIGNED"}
                  </span>
                </div>
              </div>
              <div style={S("display:flex; flex-direction:column; gap:6px")}>
                <div style={S("display:flex; align-items:center; gap:10px")}>
                  <span style={S(microLabel(C.faint))}>REMAINING</span>
                  <span style={S(`margin-left:auto; ${mono(F.label, `color:${r.fill !== null && r.fill <= LOW ? C.bed : C.body}`)}`)}>
                    {r.sp ? `${grams(r.remain)} of ${grams(r.total)}${r.fill !== null ? ` · ${Math.round(r.fill * 100)}%` : ""}` : "—"}
                  </span>
                </div>
                <Bar pct={r.fill === null ? 0 : r.fill * 100} color={r.fill !== null && r.fill <= LOW ? C.bed : C.cool} h={8} />
              </div>
              <div style={S("display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px")}>
                <Fact k="LENGTH LEFT" v={r.sp ? metres(num(r.sp.remaining_length)) : "—"} />
                <Fact k="USED" v={r.sp ? grams(num(r.sp.used_weight)) : "—"} />
                <Fact k="LAST USED" v={lastUsed === null ? "—" : fmtDate(lastUsed)} />
              </div>
              {/* HH's mirrored copy — what it will actually use, and the tell when it has drifted from Spoolman */}
              <span style={S(`margin-top:auto; ${mono(F.micro, `letter-spacing:.06em; color:${C.ghost}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}`)}>
                {`HH COPY · ${[r.hh.material, r.hh.name, r.hh.color ? "#" + r.hh.color.toUpperCase() : "", r.temp !== null ? Math.round(r.temp) + "°C" : ""].filter(Boolean).join(" · ") || "NOTHING RECORDED"}`}
              </span>
            </Panel>

            {/* what Happy Hare holds for this gate */}
            <Panel title={`HAPPY HARE · GATE ${g}`} right={headRight} bodyStyle="padding:10px 12px; gap:8px">
              <span style={S(microLabel(C.faint))}>AVAILABILITY · NOTHING IS CHECKED</span>
              <div style={S("flex:none; display:grid; grid-template-columns:repeat(4,1fr); gap:8px")}>
                {AVAIL.map(a => (
                  <Chip key={a.v} label={a.label} sub={a.sub} on={r.status === a.v} h={TAP.min} fs={F.label}
                    disabled={!!mapWhy} onTap={() => setAvail(a)} />
                ))}
              </div>
              <div style={S("flex:none; display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:2px")}>
                <PanelBtn label={r.temp !== null ? `${Math.round(r.temp)} °C` : "—"} sub={`TEMP · ${tempSource}`} h={TAP.primary}
                  disabled={!!tempWhy} why={tempWhy} onTap={setTemp} />
                <PanelBtn label={r.speed !== null ? `${r.speed} %` : "—"} sub="LOAD SPEED" h={TAP.primary}
                  disabled={!!speedWhy} why={speedWhy} onTap={setSpeed} />
                <PanelBtn label={`GROUP ${letter(r.group)}`} sub={gateList("SPARE", r.mates, "NO SPARE")} h={TAP.primary}
                  disabled={!!groupWhy} why={groupWhy} onTap={() => setGroupOpen(true)} />
              </div>
              <div style={S("margin-top:auto; display:flex; flex-direction:column; gap:4px; min-width:0")}>
                {notes.map(noteLine)}
              </div>
            </Panel>
          </>
        )}
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:${fabCol}px 1.3fr 1fr 1fr; gap:8px`)}>
        <span />
        <PanelBtn label="CHOOSE SPOOL" sub={r && r.spoolId ? `NOW #${r.spoolId}` : "FROM SPOOLMAN"} tone="accent" h={TAP.primary}
          disabled={!!spoolWhy} why={spoolWhy} onTap={openPicker} />
        <PanelBtn label="CLEAR SPOOL" sub={r && r.spoolId ? `REMOVE #${r.spoolId}` : "NO SPOOL"} h={TAP.primary}
          disabled={!!clearWhy} why={clearWhy} onTap={clearSpool} />
        <PanelBtn label="CHECK GATE" sub="HH LOOKS FOR FILAMENT" h={TAP.primary}
          disabled={!!checkWhy} why={checkWhy} onTap={askCheck} />
      </div>

      {picking && r ? (
        <SpoolPicker gate={g} curId={r.spoolId} gateIds={gateIds} activeId={st.activeSpool || null}
          list={list} q={q} mat={mat} setMat={setMat} onSearch={search} onClearSearch={() => setQ("")}
          onPick={chooseSpool} onClose={() => setPicking(false)} embedded={embedded} fabCol={fabCol} />
      ) : null}

      {groupOpen && r ? (
        <Sheet title={`GATE ${g} · ENDLESS-SPOOL GROUP`} onClose={() => setGroupOpen(false)}>
          <span style={S(`font-size:${F.body}px; color:${C.body}; text-wrap:pretty`)}>
            Gates that share a letter are spares for each other: when one runs out, Happy Hare continues from another
            in the same group. A letter no other gate uses means no spare.
          </span>
          <div style={S("display:grid; grid-template-columns:repeat(4,1fr); gap:8px")}>
            {Array.from({ length: n }, (_, grp) => {
              const members = groupsNow.map((x, i) => (x === grp && i !== g ? i : null)).filter(i => i !== null);
              return (
                <Chip key={grp} label={`GROUP ${letter(grp)}`} sub={gateList("WITH", members, "NO OTHER GATE")}
                  on={groupsNow[g] === grp} h={TAP.primary} fs={F.label} onTap={() => pickGroup(grp)} />
              );
            })}
          </div>
          <PanelBtn label="CANCEL" h={TAP.min} onTap={() => setGroupOpen(false)} />
        </Sheet>
      ) : null}

      {confirm ? <ConfirmBox a={confirm} onNo={() => setConfirm(null)} onYes={onYes} /> : null}
    </div>
  );
}

/** The spool picker. Assignment is the only identity write, and it lands in Spoolman's terms. */
function SpoolPicker({ gate, curId, gateIds, activeId, list, q, mat, setMat, onSearch, onClearSearch, onPick, onClose, embedded, fabCol }) {
  const rows = filterSpools(list.all, q, { activeId, gateIds, material: mat });
  // Facets come from the list itself (lib/spools.js), so a new material appears without a code change.
  const facets = [{ material: null, count: list.all.length }].concat(materialsOf(list.all).slice(0, 6));
  return (
    <div style={S(`position:absolute; inset:0; z-index:40; background:${C.bg}; display:flex; flex-direction:column; gap:${L.gap}px; padding:${embedded ? 0 : L.pad}px; animation:ksFade .14s ease both`)}>
      <div style={S("flex:none; display:flex; align-items:center; gap:8px; min-width:0")}>
        <span style={S(`width:3px; height:15px; background:${C.accent}; border-radius:1px; flex:none`)} />
        <span style={S(mono(F.label, `letter-spacing:.16em; color:${C.text}; white-space:nowrap; flex:none`))}>{`GATE ${gate} · CHOOSE SPOOL`}</span>
        <div style={S("flex:1; min-width:0; display:flex; gap:6px; overflow-x:auto")}>
          {facets.map(f => (
            <Chip key={f.material || "ALL"} label={f.material || "ALL"} sub={String(f.count)} flex={0} minW={72} h={TAP.min} fs={F.label}
              on={(f.material || null) === mat} onTap={() => setMat(f.material || null)} />
          ))}
        </div>
        {/* nowrap chip: a long query would push the row off the panel, so the label is cut to 12 characters */}
        <Chip label={q ? `"${q.length > 12 ? q.slice(0, 11) + "…" : q}"` : "SEARCH"} on={!!q} flex={0} minW={132} h={TAP.min} fs={F.label} onTap={onSearch} />
        {q ? <Chip label="✕" flex={0} minW={TAP.min} h={TAP.min} fs={F.label} onTap={onClearSearch} /> : null}
      </div>

      <div style={S(panel("flex:1; min-height:0; padding:8px"))}>
        {list.loading && !list.all.length ? <Empty title="LOADING SPOOLS…" hint="Reading the spool list from Spoolman through Moonraker." />
          : list.error ? <Empty title="SPOOLMAN UNAVAILABLE" hint={String(list.error)} />
          : !rows.length ? <Empty title="NO MATCHING SPOOLS" hint={q || mat ? "Clear the search or the material filter." : "Spoolman returned no spools."} />
          : (
            <div style={S("flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; display:grid; grid-template-columns:1fr 1fr; gap:8px; align-content:start")}>
              {rows.map(sp => {
                const f = sp.filament || {};
                const fl = fillOf(sp);
                const inGate = gateIds.indexOf(sp.id);
                const mine = sp.id === curId;
                const tag = mine ? ["off", "THIS GATE"] : inGate >= 0 ? ["warn", `GATE ${inGate}`] : sp.id === activeId ? ["ok", "ACTIVE"] : null;
                return (
                  <Hv as="div" key={sp.id} onClick={() => onPick(sp)} active={`background:${C.line1}`}
                    style={`display:flex; align-items:center; gap:10px; height:56px; padding:0 12px; min-width:0; border-radius:${L.radiusSm}px; cursor:pointer; background:${mine ? C.selBg : C.panelHead}; border:1px solid ${mine ? C.accentLine : C.line3}`}>
                    <Swatch color={swatch(f.color_hex) || EMPTY_COLOR} size={26} />
                    <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:2px")}>
                      <span style={S(mono(F.label, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{spoolName(sp)}</span>
                      <span style={S(mono(F.micro, `color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                        {[f.material, f.vendor && f.vendor.name, "#" + sp.id].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {tag ? <span style={S(badgeStyle(tag[0]))}>{tag[1]}</span> : null}
                    <div style={S("flex:none; display:flex; flex-direction:column; align-items:flex-end; gap:2px")}>
                      <span style={S(mono(F.label, `color:${C.body}`))}>{grams(num(sp.remaining_weight))}</span>
                      <span style={S(mono(F.micro, `color:${fl !== null && fl <= LOW ? C.bed : C.faint}`))}>{fl === null ? "—" : Math.round(fl * 100) + "%"}</span>
                    </div>
                  </Hv>
                );
              })}
            </div>
          )}
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:${fabCol}px 1fr 1fr; gap:8px`)}>
        <span />
        <PanelBtn label="CANCEL" sub="KEEP THE CURRENT SPOOL" h={TAP.primary} onTap={onClose} />
        <PanelBtn label="RELOAD LIST" sub="READ SPOOLMAN AGAIN" h={TAP.primary} onTap={list.reload} />
      </div>
    </div>
  );
}
