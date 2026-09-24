// ---------------------------------------------------------------------------
// TTG — Happy Hare's tool-to-gate map. Which physical gate a T-number loads.
//
// Tool first, then gate: a T-number is what the slicer, the print and every other label on this panel speak
// (the status bar's and JOB's "T5 · G5" from vm.js toolGateLabel, RECOVER's "T5 FROM"), and the gate is the physical choice made
// to satisfy it. The two rows are drawn with the lines between them, so identity reads as eight verticals and
// a remap as a crossing line at a glance — and a remap is ALSO spelled out in a banner, because the moment the
// map is not identity every T-label elsewhere names a tool, not the gate it loads.
//
// Verified against Happy Hare v3.4.2 (cmd_MMU_TTG_MAP, _remap_tool, _reset_ttg_map, _ensure_ttg_match) and the
// live printer (voron.local, read-only) on 2026-09-23:
//
//   · cmd_MMU_TTG_MAP reads QUIET, RESET, DETAIL, MAP, GATE, TOOL and AVAILABLE — nothing else. MMU_REMAP_TTG is
//     a registered alias (both are in this printer's command catalogue). This screen sends TOOL+GATE and RESET.
//
//   · THE AVAILABLE TRAP. AVAILABLE defaults to GATE_UNKNOWN (-1), and the handler does
//         if not available == UNKNOWN or (available == UNKNOWN and status == EMPTY): status = available
//     so remapping a tool onto an EMPTY gate with AVAILABLE omitted silently turns that gate UNKNOWN. A map edit
//     should change the map and nothing else, so an EMPTY target gets AVAILABLE=0 (keeps it EMPTY). Every other
//     state is preserved by OMITTING it — AVAILABLE's maxval is 1, so it cannot even express BUFFER (2).
//
//   · _remap_tool persists to mmu_vars and then runs _ensure_ttg_match — and so does RESET=1. That REWRITES HH's
//     current tool: selector on UNKNOWN/BYPASS -> tool := that; otherwise the tools now mapped to the selected
//     gate are looked up, none -> tool UNKNOWN (-1), current tool not among them -> the first of them. toolAfter()
//     below is that function, so the screen knows before the tap. Mid-print (not paused) any edit that would
//     change the current tool is refused, and the printing tool itself is locked outright; paused (RECOVER's
//     "T5 FROM" case) it is allowed. Every confirm that changes HH's current tool says so, idle included (idle
//     with T5 loaded, remapping T5 away leaves gate 5 loaded with the tool UNKNOWN). Remapping any other tool
//     mid-print is allowed with a confirm: it changes what the job's next change to that tool loads, which is
//     exactly why someone would do it.
//
//   · RESET=1 restores default_ttg_map = [mmu] tool_to_gate_map, or identity when that is empty. Here it is
//     `tool_to_gate_map = []`, so RESET=1 IS identity. If the config ever carries a non-identity default, the
//     identity button sets the changed tools one by one instead — never MAP=…, whose path skips
//     _ensure_ttg_match and can leave HH's current tool pointing at a gate it no longer maps to.
//
//   · Lifetime on THIS printer (configfile, and the live macro variables agree):
//       [mmu] startup_reset_ttg_map = 0            -> a remap SURVIVES a Klipper restart
//       _MMU_SOFTWARE_VARS reset_ttg = True        -> PRINT_END -> MMU_END -> MMU_TTG_MAP RESET=1: cleared when a
//                                                     print finishes normally
//       _MMU_CLIENT_VARS reset_ttg_on_cancel=False -> a CANCELLED print keeps it
//       _MMU_SOFTWARE_VARS automap_strategy="none" -> nothing remaps at print start (when set, HH's _automap_gate
//                                                     issues MMU_TTG_MAP TOOL= GATE= itself)
//     Read from st.config, not hard-coded, and shown on the screen — "how long does this last" is the question
//     after "what does it do". (Static configfile values: a runtime SET_GCODE_VARIABLE shows after a reload.)
//
//   · slicer_tool_map.tools ({color, material, temp, name, in_use} per tool, cmd_MMU_SLICER_TOOL_MAP) is cleared
//     only by _on_print_start / MMU_START_SETUP's `MMU_SLICER_TOOL_MAP RESET=1` at the NEXT print start (and on a
//     Klipper restart), never at print end — between prints it still holds the last job's wishes. So the
//     WANTS / slicer-colour stripe is shown only while a job is active.
//
//   · Live map at the time of writing: identity [0..7]. Gates 0, 1 and 6 are EMPTY (no material; their 200 °C is
//     HH's default_extruder_temp placeholder), 2/3/4/7 feed from the buffer, 5 from a spool, all ABS at 250 °C,
//     spoolman_support = push. Gate identity (material, colour, name) is Spoolman's, reflected through HH's gate
//     map — this screen only displays it; spool assignment lives on GATE MAP.
//
// Nothing is sent on render. Every edit is one tap on a tool, one on a gate, and a confirm; the confirm re-checks
// the guards at the moment it is accepted, because the MMU may have started moving in between, and sends nothing
// if the command rebuilt from live state is no longer the one it displayed.
//
// Embedded contract (MMU screen, TTG tab): pass `embedded` and the screen drops its own outer padding and fills
// the tab slot (flex:1; min-height:0). The bottom row still reserves the nav FAB's corner either way.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { mmu as mmuVm, badgeStyle } from "../vm.js";
import { Panel, PanelBtn, Chip, Empty, gateColor, ink } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { GATE, gateState } from "../../lib/hh.js";
import { swatch } from "../../lib/spools.js";

/** Remapping moves nothing, but HH refuses mid-operation and _ensure_ttg_match races a tool change. */
const TTG_GUARDS = { needsMmu: true, needsMmuIdle: true };
/**
 * A gate's status tag in Happy Hare's own words (lib/hh.js GATE_STATES, from _gate_map_to_string). UNKNOWN is
 * drawn "?", as HH's own _get_filament_char draws it, which keeps the 8-across card's top row to G-number + tag.
 */
const statusTag = s => (s === GATE.UNKNOWN ? "?" : (gateState(s) || { word: "?" }).word);

const identity = n => Array.from({ length: n }, (_, i) => i);
const isIdentity = map => map.every((g, i) => g === i);
const unquote = v => String(v == null ? "" : v).trim().replace(/^['"]|['"]$/g, "").trim();
// configfile.settings carries gcode_macro variables as their raw strings ('True', '"none"'), [mmu] as parsed ints.
const truthy = v => v === true || v === 1 || /^(true|1)$/i.test(unquote(v));
/** HH's tool_selected in words: -1 TOOL_GATE_UNKNOWN, -2 TOOL_GATE_BYPASS. */
const toolWord = t => (t === -1 ? "UNKNOWN" : t === -2 ? "BYPASS" : `T${t}`);

/**
 * Happy Hare's _ensure_ttg_match, which runs after EVERY MMU_TTG_MAP edit and RESET=1: the tool HH will call
 * "current" once `map` is in force. Returns toolSel unchanged when the printer did not report gate/tool.
 */
function toolAfter(map, gateSel, toolSel) {
  if (!Number.isInteger(gateSel) || !Number.isInteger(toolSel)) return toolSel;
  if (gateSel < 0) return gateSel;                               // UNKNOWN / BYPASS: tool := gate
  const possible = map.map((g, t) => (g === gateSel ? t : null)).filter(t => t !== null);
  if (!possible.length) return -1;                               // no tool reaches the selected gate
  return possible.includes(toolSel) ? toolSel : possible[0];
}

/** HH's ttg_map, validated. An entry that is not a gate on this unit reads as null — shown as "?", never guessed. */
function readMap(mmuRaw, n) {
  const t = mmuRaw && mmuRaw.ttg_map;
  if (!Array.isArray(t)) return null;
  return identity(n).map(i => (Number.isInteger(t[i]) && t[i] >= 0 && t[i] < n ? t[i] : null));
}

/** What RESET=1 restores (HH __init__): [mmu] tool_to_gate_map, identity when empty. null = config not read yet. */
function defaultMap(cfg, n) {
  if (!cfg || !cfg.mmu) return null;
  const d = cfg.mmu.tool_to_gate_map;
  return Array.isArray(d) && d.length === n && d.every(Number.isInteger) ? d.slice() : identity(n);
}

/** How long a remap lasts on this printer, from its own config. Each fact is omitted when it cannot be read. */
function lifetime(cfg) {
  if (!cfg) return { text: "", sentence: "" };
  const sw = cfg["gcode_macro _mmu_software_vars"] || {};
  const cl = cfg["gcode_macro _mmu_client_vars"] || {};
  const mm = cfg.mmu || {};
  const out = [];
  const flag = v => (v !== undefined ? truthy(v) : null);
  const atEnd = flag(sw.variable_reset_ttg), onCancel = flag(cl.variable_reset_ttg_on_cancel), onRestart = flag(mm.startup_reset_ttg_map);
  if (atEnd !== null) out.push(atEnd ? "RESET AT PRINT END" : "KEPT AFTER PRINT END");
  if (onCancel !== null) out.push(onCancel ? "RESET ON CANCEL" : "KEPT ON CANCEL");
  if (onRestart !== null) out.push(onRestart ? "RESET ON RESTART" : "KEPT ACROSS RESTARTS");
  const strat = unquote(sw.variable_automap_strategy).toLowerCase();
  if (strat && strat !== "none") out.push(`AUTOMAP (${strat.toUpperCase()}) REMAPS AT PRINT START`);
  // The confirm's one-line version. Only facts that were read: an unread setting is not claimed either way.
  const until = [atEnd ? "a normal print end" : null, onCancel ? "a cancel" : null, onRestart ? "a Klipper restart" : null].filter(Boolean);
  const sentence = atEnd === null && onCancel === null && onRestart === null ? ""
    : `Kept until reset${until.length ? " or " + until.join(" or ") : ""}.`;
  return { text: out.join(" · "), sentence };
}

/** One tool. AVAILABLE=0 only when the target is EMPTY — see THE AVAILABLE TRAP above. */
const remapCmd = (tool, gate, status) => `MMU_TTG_MAP TOOL=${tool} GATE=${gate}${status === GATE.EMPTY ? ` AVAILABLE=${GATE.EMPTY}` : ""}`;

/** "gate 5 (Bambu Green · ABS)" — what a person recognises a gate by. */
function gateDesc(g) {
  if (!g) return "an unknown gate";
  const what = [g.name, g.material !== "—" ? g.material : null].filter(Boolean).join(" · ");
  return `gate ${g.i} (${g.empty ? "EMPTY" : what || "no filament set"})`;
}

// ---------------------------------------------------------------------------
function ToolCard({ i, gate, g, picked, current, locked, slicer, onTap }) {
  const moved = gate !== null && gate !== i;
  const col = (g && g.hasColor && !g.empty && swatch(g.color)) || C.line4;
  const want = slicer && slicer.in_use !== false ? slicer : null;
  const wantCol = want ? swatch(want.color) : null;
  const wantMat = want ? unquote(want.material).toUpperCase() : "";
  const mismatch = !!(wantMat && wantMat !== "UNKNOWN" && g && !g.empty && g.material !== "—" && wantMat !== String(g.material).toUpperCase());
  return (
    <Hv as="div" onClick={onTap} active={locked ? "" : "transform:translateY(1px)"}
      style={`position:relative; overflow:hidden; display:flex; flex-direction:column; justify-content:center; gap:3px; min-height:78px; padding:4px 9px; border-radius:7px; cursor:pointer; transition:border-color .14s, background .14s; opacity:${locked ? 0.5 : 1}; ${picked
        ? `background:${C.accentBg}; border:1px solid ${C.accent};`
        : moved ? `background:${C.warnBg}; border:1px solid ${C.warnLine};`
        : `background:${C.panelSunk}; border:1px solid ${C.line3};`}`}>
      {/* what the loaded print's slicer wants from this tool, when Happy Hare has been told */}
      {wantCol ? <span style={S(`position:absolute; top:0; left:0; right:0; height:4px; background:${wantCol}`)} /> : null}
      {/* wraps (the card grows) rather than clipping CURRENT at the LARGE/XL type scales */}
      <div style={S("display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 6px")}>
        <span style={S(mono(F.num2, `line-height:1; color:${picked ? C.accent : C.text}`))}>{`T${i}`}</span>
        {current ? <span style={S(mono(F.micro, `margin-left:auto; letter-spacing:.1em; color:${C.cool}`))}>CURRENT</span> : null}
      </div>
      <span style={S(mono(F.label, `letter-spacing:.08em; color:${gate === null ? C.accent : moved ? C.bed : C.dim}`))}>
        {`→ G${gate === null ? "?" : gate}`}
      </span>
      <div style={S("display:flex; align-items:center; gap:6px; min-width:0")}>
        <span style={S(`flex:none; width:10px; height:10px; border-radius:2px; background:${col}; border:1px solid ${C.line5}`)} />
        <span style={S(mono(F.micro, `letter-spacing:.06em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:${mismatch ? C.bed : g && g.empty ? C.bed : C.mute}`))}>
          {mismatch ? `WANTS ${wantMat}` : !g ? "—" : g.empty ? "EMPTY" : g.material}
        </span>
      </div>
    </Hv>
  );
}

function GateCard({ g, tools, target, from, onTap }) {
  // swatch() lifts pure black (gate 4 here is #000000) off the panel ground, as GATE MAP draws it.
  const col = (g.hasColor && swatch(g.color)) || gateColor(g);
  const moved = tools.some(t => t !== g.i);
  return (
    <Hv as="div" onClick={onTap} active="transform:translateY(1px)"
      style={`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; min-height:112px; padding:4px 6px; border-radius:7px; cursor:pointer; transition:border-color .14s, background .14s; ${from
        ? `background:${C.selBg}; border:1px solid ${C.accentLine};`
        : target ? `background:${C.panelHead}; border:1px dashed ${C.accentLine};`
        : `background:${C.panelSunk}; border:1px solid ${C.line2};`}`}>
      <div style={S("align-self:stretch; display:flex; align-items:center; justify-content:space-between; gap:4px")}>
        <span style={S(mono(F.label, `color:${C.text}`))}>{`G${g.i}`}</span>
        <span style={S(mono(F.micro, `letter-spacing:.06em; color:${g.empty ? C.bed : g.unknown ? C.mute : C.faint}`))}>
          {statusTag(g.status)}
        </span>
      </div>
      <span style={S(`flex:none; width:26px; height:26px; border-radius:50%; border:5px solid ${col}; ${g.empty ? "opacity:.3;" : ""}`)} />
      <span style={S(mono(F.micro, `letter-spacing:.08em; color:${g.empty ? C.ghost : C.dim}`))}>{g.empty ? "EMPTY" : g.material}</span>
      <span style={S(mono(F.micro, `color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%`))}>
        {g.empty ? "—" : g.name || (g.spoolId ? `#${g.spoolId}` : "—")}
      </span>
      {/* which tools load this gate — "NO TOOL" means no T-command can reach it */}
      <span style={S(mono(F.micro, `letter-spacing:.06em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; color:${!tools.length || moved ? C.bed : C.cool}`))}>
        {!tools.length ? "NO TOOL" : tools.length > 4 ? `${tools.length} TOOLS` : tools.map(t => `T${t}`).join("+")}
      </span>
    </Hv>
  );
}

// ---------------------------------------------------------------------------
export default function Ttg({ st, act, say, embedded = false }) {
  const [sel, setSel] = React.useState(null);        // the tool picked, waiting for its gate
  const [confirm, setConfirm] = React.useState(null);
  // A hint, not a refusal. Without `say` (a host that does not pass it) it still reaches the toast through the
  // action layer's warn log, rather than a tap that silently does nothing.
  const tell = (what, msg) => (typeof say === "function" ? say(msg) : act.refuse(what, msg));

  const m = mmuVm(st);
  const raw = st.raw || {};
  const mr = raw.mmu || {};
  const n = m.n;
  const map = m.present && n > 0 ? readMap(mr, n) : null;

  const root = embedded
    ? `flex:1; min-height:0; display:flex; flex-direction:column; gap:${L.gap}px`
    : `height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`;

  if (!m.present || !map) {
    const empty = (
      <div style={S(panel("flex:1; min-height:0"))}>
        {!m.present
          ? <Empty title="NO MMU CONFIGURED" hint="There is no Happy Hare mmu object on this printer, so there are no tools to map." />
          : n > 0 ? <Empty title="NO TTG MAP REPORTED" hint="Happy Hare's mmu object has no ttg_map. This screen reads the map from the printer and will not guess one." />
          : <Empty title="NO GATE COUNT REPORTED" hint="Happy Hare's mmu object reports no num_gates yet, so there are no tools or gates to draw." />}
      </div>
    );
    return embedded
      ? <div style={S("flex:1; min-height:0; display:flex; flex-direction:column")}>{empty}</div>
      : <div style={S(`height:100%; display:flex; flex-direction:column; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px`)}>{empty}</div>;
  }

  const ps = raw.print_stats || {};
  const paused = !!(raw.pause_resume || {}).is_paused;
  const printingNow = ps.state === "printing" && !paused;
  const inJob = ps.state === "printing" || ps.state === "paused" || paused;
  const curTool = Number.isInteger(mr.tool) && mr.tool >= 0 ? mr.tool : null;
  // HH's raw selector state for _ensure_ttg_match (tool/gate may be -1 UNKNOWN or -2 BYPASS).
  const selGate = Number.isInteger(mr.gate) ? mr.gate : null;
  const selTool = Number.isInteger(mr.tool) ? mr.tool : null;

  const ident = isIdentity(map);
  const remapped = map.map((g, i) => (g === i ? null : i)).filter(i => i !== null);
  const toolsOf = g => map.map((x, t) => (x === g ? t : null)).filter(t => t !== null);
  // Between prints this still holds the LAST job's wishes (cleared only at the next print start) — job only.
  const slicerTools = inJob ? ((mr.slicer_tool_map || {}).tools) || {} : {};
  const life = lifetime(st.config);
  const def = defaultMap(st.config, n);

  /** What _ensure_ttg_match does to HH's current tool across a sequence of maps (one per command). */
  const toolThrough = maps => maps.reduce((acc, mp) => {
    const t = toolAfter(mp, selGate, acc.t);
    return { t, touched: acc.touched || t !== selTool };
  }, { t: selTool, touched: false });
  const toolNote = r => (r.t !== selTool
    ? `Gate ${selGate} is selected, so Happy Hare's current tool changes from ${toolWord(selTool)} to ${toolWord(r.t)}.` : "");

  // One reason for everything, then the per-tool rule, then the per-edit rule (see _ensure_ttg_match above).
  const baseWhy = act.blocked(TTG_GUARDS, "MMU_TTG_MAP")
    || (mr.enabled === false ? "Happy Hare is disabled (MMU ENABLE=0)" : null);
  const whyTool = i => baseWhy || (printingNow && i === curTool ? `T${i} is the tool printing — pause first` : null);
  const withTool = (i, gi) => { const nx = map.slice(); nx[i] = gi; return nx; };
  const whyEdit = (i, gi) => whyTool(i)
    || (printingNow && toolThrough([withTool(i, gi)]).touched
      ? `this would change Happy Hare's current tool mid-print (gate ${selGate} selected) — pause first` : null);

  // ---- remap one tool --------------------------------------------------------------------------------------
  const tapTool = i => {
    const why = whyTool(i);
    if (why) { act.refuse(`T${i}`, why); return; }
    setSel(sel === i ? null : i);
  };

  const tapGate = gi => {
    if (sel === null) { tell(`G${gi}`, "tap a tool first, then the gate it should print from"); return; }
    const i = sel;
    if (map[i] === gi) { tell(`T${i} → G${gi}`, `T${i} already loads gate ${gi}`); setSel(null); return; }
    const why = whyEdit(i, gi);
    if (why) { setSel(null); act.refuse(`T${i} → G${gi}`, why); return; }
    const to = m.gates[gi];
    const from = map[i] !== null ? m.gates[map[i]] : null;
    const sl = slicerTools[String(i)];
    const slMat = sl && sl.in_use !== false ? unquote(sl.material).toUpperCase() : "";
    const text = [
      `T${i} will load ${gateDesc(to)} instead of ${from ? gateDesc(from) : "an unknown gate"}.`,
      to.empty ? `Gate ${gi} is marked EMPTY, so the next T${i} stops for filament — it stays EMPTY (AVAILABLE=0) rather than Happy Hare quietly flipping it to unknown.` : "",
      from && !from.empty && !to.empty && from.material !== "—" && to.material !== "—" && from.material !== to.material
        ? `Material changes ${from.material} → ${to.material}.` : "",
      slMat && slMat !== "UNKNOWN" && !to.empty && to.material !== "—" && slMat !== String(to.material).toUpperCase()
        ? `The loaded print expects ${slMat} for T${i}.` : "",
      toolNote(toolThrough([withTool(i, gi)])),
      inJob ? `This job's next T${i} loads gate ${gi}.` : "",
      life.sentence,
    ].filter(Boolean).join(" ");
    setConfirm({ kind: "tool", tool: i, gate: gi, label: `T${i} → GATE ${gi}`, cmd: remapCmd(i, gi, to.status), confirm: text });
  };

  // ---- back to identity ------------------------------------------------------------------------------------
  const defIsIdentity = !def || isIdentity(def);
  const resetCmd = defIsIdentity
    ? "MMU_TTG_MAP RESET=1"
    // configured default is NOT identity, so RESET=1 would restore that instead: set the changed tools one by one
    : remapped.map(i => remapCmd(i, i, (m.gates[i] || {}).status)).join("\n");
  // The map after each command the reset sends, so _ensure_ttg_match can be followed through every step.
  const resetMaps = defIsIdentity ? [identity(n)]
    : remapped.reduce((acc, i) => { const nx = (acc[acc.length - 1] || map).slice(); nx[i] = i; return acc.concat([nx]); }, []);
  const resetTool = toolThrough(resetMaps);
  const printingMoves = printingNow && ((curTool !== null && map[curTool] !== curTool) || resetTool.touched);
  const resetWhy = baseWhy
    || (ident ? "the map is already identity" : null)
    || (printingMoves ? `${toolWord(selTool)} is printing from gate ${selGate} and the reset would change it — pause first` : null);
  const resetSub = baseWhy ? "LOCKED" : ident ? "ALREADY IDENTITY" : printingMoves ? "PAUSE THE PRINT FIRST"
    : defIsIdentity ? "MMU_TTG_MAP RESET=1" : `${remapped.length} TOOL COMMAND${remapped.length === 1 ? "" : "S"}`;
  const askReset = () => {
    if (resetWhy) { act.refuse("RESET TTG", resetWhy); return; }
    setSel(null);
    setConfirm({
      kind: "reset", label: "RESET TO IDENTITY", cmd: resetCmd.replace(/\n/g, " ; "),
      confirm: [
        `Point every tool back at its own gate (T0 → gate 0 … T${n - 1} → gate ${n - 1})? Changes ${remapped.map(i => `T${i} (now gate ${map[i] === null ? "?" : map[i]})`).join(", ")}.`,
        !def ? "Printer config not read yet: RESET=1 restores [mmu] tool_to_gate_map, which is identity unless it is set." : "",
        !defIsIdentity ? "This printer's configured default map is not identity, so each tool is set individually." : "",
        toolNote(resetTool),
        inJob ? "The running job's next tool changes follow the new map." : "",
      ].filter(Boolean).join(" "),
    });
  };

  // ---- render ----------------------------------------------------------------------------------------------
  const lines = map.map((g, i) => ({ g, i })).filter(x => x.g !== null)
    // identity underneath, remaps over it, the picked tool on top
    .sort((a, b) => (a.i === sel) - (b.i === sel) || (a.g !== a.i) - (b.g !== b.i));
  const x = i => ((i + 0.5) / n * 1000).toFixed(1);
  const example = remapped[0];

  const line1 = baseWhy
    ? { t: `EDITING LOCKED — ${baseWhy.toUpperCase()}`, c: C.bed }
    : sel !== null ? { t: `T${sel} → ?  TAP THE GATE IT SHOULD LOAD`, c: C.accent }
    // the dimmed card's reason, said without a tap: the printing tool cannot be remapped until paused
    : printingNow && curTool !== null ? { t: `T${curTool} IS PRINTING — PAUSE TO REMAP IT`, c: C.bed }
    : { t: "TAP A TOOL, THEN THE GATE IT SHOULD LOAD", c: C.dim };

  return (
    <div style={S(root)}>

      {/* The warning the owner asked for: visible whenever the map is not identity. */}
      {!ident ? (
        <div style={S(`flex:none; display:flex; align-items:center; gap:14px; padding:8px 14px; border-radius:${L.radius}px; background:${C.warnBg}; border:1px solid ${C.warnLine}`)}>
          <span style={S(badgeStyle("warn"))}>REMAPPED</span>
          <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:3px")}>
            <span style={S(mono(F.label, `letter-spacing:.08em; color:${C.bed}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
              {remapped.map(i => `T${i} → G${map[i] === null ? "?" : map[i]}`).join("   ·   ")}
            </span>
            <span style={S(`font-size:${F.label}px; color:${C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}>
              {`T-numbers elsewhere — status bar, JOB, RECOVER, the slicer, the console — are tools: T${example} loads gate ${map[example] === null ? "?" : map[example]}, not gate ${example}.`}
            </span>
          </div>
        </div>
      ) : null}

      <Panel title={"TOOL → GATE"}
        right={<span style={S(badgeStyle(ident ? "ok" : "warn"))}>{ident ? "IDENTITY" : `${remapped.length} REMAPPED`}</span>}
        style="flex:1; min-height:0" bodyStyle="padding:10px 8px 10px">
        {/* Columns carry their spacing as padding, not grid gap, so column centres sit exactly at (i+.5)/n and the
            connector lines below land on the cards they join. Each cell is a grid so its card stretches to the
            row: at the LARGE/XL type scales one card can wrap and grow, and the row stays even. */}
        <div style={S(`flex:none; display:grid; grid-template-columns:repeat(${n},minmax(0,1fr))`)}>
          {map.map((g, i) => (
            <div key={i} style={S("padding:0 4px; min-width:0; display:grid")}>
              <ToolCard i={i} gate={g} g={g !== null ? m.gates[g] : null} picked={sel === i} current={curTool === i}
                locked={!!whyTool(i)} slicer={slicerTools[String(i)]} onTap={() => tapTool(i)} />
            </div>
          ))}
        </div>
        <div style={S("flex:1; min-height:28px; position:relative; margin:2px 0")}>
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none"
            style={S("position:absolute; inset:0; width:100%; height:100%; display:block")}>
            {lines.map(({ g, i }) => {
              const on = sel === i, moved = g !== i;
              const gate = m.gates[g];
              const col = on ? C.accent : gate && gate.hasColor && !gate.empty ? ink(gate.color) : C.line5;
              return (
                <path key={i} d={`M ${x(i)} 0 C ${x(i)} 55 ${x(g)} 45 ${x(g)} 100`} fill="none" stroke={col}
                  strokeWidth={on ? 3.2 : moved ? 2.6 : 1.4} opacity={on || moved ? 1 : 0.5}
                  strokeDasharray={on ? "8 6" : "0"} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              );
            })}
          </svg>
        </div>
        <div style={S(`flex:none; display:grid; grid-template-columns:repeat(${n},minmax(0,1fr))`)}>
          {m.gates.map(g => (
            <div key={g.i} style={S("padding:0 4px; min-width:0; display:grid")}>
              <GateCard g={g} tools={toolsOf(g.i)} target={sel !== null} from={sel !== null && map[sel] === g.i}
                onTap={() => tapGate(g.i)} />
            </div>
          ))}
        </div>
      </Panel>

      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px minmax(0,1fr) 250px; gap:8px`)}>
        <span />
        <div style={S(panel(`flex-direction:row; align-items:center; gap:12px; height:${TAP.primary}px; padding:0 8px 0 14px`))}>
          <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:4px")}>
            <span style={S(mono(F.label, `letter-spacing:.1em; color:${line1.c}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{line1.t}</span>
            <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
              {life.text || "MMU_TTG_MAP · SAVED IN MMU_VARS"}
            </span>
          </div>
          {sel !== null ? <Chip label="CANCEL" onTap={() => setSel(null)} flex={0} minW={112} /> : null}
        </div>
        <PanelBtn label="RESET TO IDENTITY" sub={resetSub} tone={resetWhy ? undefined : "accent"} h={TAP.primary}
          disabled={!!resetWhy} why={resetWhy} onTap={askReset} />
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => {
            // Re-decided from THIS render, not the one that opened the dialog: the MMU may have started a tool
            // change, the print may have resumed, or the target gate's state may have changed meanwhile. The
            // command is rebuilt from live state, and if it is no longer the one the dialog showed (AVAILABLE=0
            // depends on the gate being EMPTY right now) nothing is sent — a confirm covers what it displayed.
            const c = confirm; setConfirm(null); setSel(null);
            if (c.kind === "tool") {
              const why = whyEdit(c.tool, c.gate);
              if (why) return act.refuse(c.label, why);
              const cmd = remapCmd(c.tool, c.gate, (m.gates[c.gate] || {}).status);
              if (cmd !== c.cmd) return act.refuse(c.label, `gate ${c.gate} changed while the dialog was open — tap it again`);
              return act.guarded(cmd, TTG_GUARDS);
            }
            if (resetWhy) return act.refuse(c.label, resetWhy);
            if (resetCmd.replace(/\n/g, " ; ") !== c.cmd) return act.refuse(c.label, "the map changed while the dialog was open — tap RESET again");
            return act.guarded(resetCmd, TTG_GUARDS);
          }} />
      ) : null}
    </div>
  );
}
