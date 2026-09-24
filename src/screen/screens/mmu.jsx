// ---------------------------------------------------------------------------
// MMU — reflowed from 1280x800 to 1024x600.
//
// This was the worst overflow in the export: it wanted 614px of content in a
// 540px box, and what fell off the bottom was the entire six-button action bar.
// Measured deficit -74px.
//
// The fix is not compression, it is a TAB STRIP. The export's single screen tried
// to be four things at once: live status, a gate-map editor, a sequence log and a
// telemetry readout. Splitting them is what makes STATUS fit at native size, and
// it also gives the gate map and the stats the room they always needed.
//
//   STATUS (here)  gates + selector + filament path + the action bar
//   GATE MAP       per-gate material/colour/spool/temp editing
//   TTG            tool -> gate remapping
//   STATS          MMU_STATS DETAIL=1, per-gate slippage and failures
//
// The three telemetry values that used to occupy a 250px column now sit in the
// header, where they are read more often and cost nothing.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { mmu as mmuVm, badgeStyle, microLabel } from "../vm.js";
import { FilamentPath, Tabs, Stat, gateColor } from "../parts.jsx";
import { ICONS } from "../icons.js";
import { mmuHomeCommand } from "../../lib/hh.js";
import { ConfirmBox } from "./move.jsx";
import GateMap from "./gatemap.jsx";
import Ttg from "./ttg.jsx";
import MmuStats from "./mmustats.jsx";

const TABS = [["status", "STATUS"], ["gatemap", "GATE MAP"], ["ttg", "TTG"], ["mmustats", "STATS"]];

function Glyph({ name, size = 20, color = "currentColor" }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color}
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={S("display:block; flex:none")}>
      <path d={ICONS[name] || ICONS.info} />
    </svg>
  );
}

function GateCard({ g, onTap, disabled }) {
  const on = g.selected;
  const col = gateColor(g);
  return (
    <Hv as="div" onClick={disabled ? undefined : onTap} active={disabled ? "" : "transform:translateY(1px)"}
      style={`position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; padding:9px 4px 7px; border-radius:7px; cursor:${disabled ? "default" : "pointer"}; transition:border-color .16s, background .16s; opacity:${disabled ? 0.55 : 1}; ${on
        ? `background:${C.selBg}; border:1px solid ${C.accentLine};`
        : `background:${C.panelSunk}; border:1px solid #151c26;`}`}>
      <span style={S(`position:absolute; top:5px; left:7px; ${mono(F.micro, `color:${on ? C.accent : C.ghost}`)}`)}>{g.i}</span>
      <span style={S(`width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:6px solid ${col}; ${g.empty ? "opacity:.3;" : on ? `box-shadow:0 0 15px ${col}66;` : ""}`)}>
        <span style={S(`width:10px; height:10px; border-radius:50%; background:${C.panelSunk}`)} />
      </span>
      <span style={S(mono(F.micro, `letter-spacing:.08em; color:${g.empty ? C.ghost : on ? C.text : C.dim}`))}>
        {g.empty ? "EMPTY" : g.unknown ? "?" : g.material}
      </span>
      <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%`))}>
        {g.empty ? "—" : (g.name || (g.fill != null ? Math.round(g.fill * 100) + "%" : "—"))}
      </span>
    </Hv>
  );
}

export default function Mmu({ st, go, act, askInput, api, say }) {
  const m = mmuVm(st);
  const [tab, setTab] = React.useState("status");
  const [confirm, setConfirm] = React.useState(null);

  if (!m.present) {
    return (
      <div style={S(`height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px`)}>
        <div style={S(panel("height:100%; align-items:center; justify-content:center"))}>
          <span style={S(mono(F.val, `letter-spacing:.2em; color:${C.ghost}`))}>NO MMU CONFIGURED</span>
        </div>
      </div>
    );
  }

  const busy = m.busy;
  const printing = (st.raw.print_stats || {}).state === "printing" && !(st.raw.pause_resume || {}).is_paused;

  // Every one of these moves filament. The guards come from the shared action
  // layer so a refusal states WHY rather than just failing.
  const ACTIONS = [
    { key: "load",     icon: "load",     label: "LOAD",   cmd: "MMU_LOAD",           guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false } },
    { key: "unload",   icon: "unload",   label: "UNLOAD", cmd: "MMU_UNLOAD",         guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false } },
    { key: "eject",    icon: "eject",    label: "EJECT",  cmd: "MMU_EJECT",          guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false }, confirm: "Eject the filament from the selected gate?" },
    // The cutter is at the GATE on this printer (EREC), not the toolhead, so CUT
    // and tip-forming are two different operations with two different commands.
    { key: "cut",      icon: "cutter",   label: "CUT",    cmd: "EREC_CUTTER_ACTION", guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false } },
    { key: "check",    icon: "checkGate", label: "CHECK", cmd: "MMU_CHECK_GATES",    guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false }, confirm: "Check every gate? This moves filament on all of them and takes a while." },
    { key: "home",     icon: "mmuHome",  label: "HOME",   cmd: mmuHomeCommand(st.raw.mmu), guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false }, confirm: "Home the MMU selector?" },
  ];

  const SELECT_GUARDS = { needsMmu: true, needsMmuIdle: true, whilePrinting: false };

  const fire = a => {
    // guarded() already logs the reason when it refuses, so a blocked action needs
    // no special case here beyond skipping the confirm nobody should have to answer.
    if (act.blocked(a.guards, a.cmd)) { act.guarded(a.cmd, a.guards); return; }
    if (a.confirm) { setConfirm(a); return; }
    act.guarded(a.cmd, a.guards);
  };

  const selectGate = i => {
    const g = m.gates[i];
    // Selecting an empty gate is almost always a mis-tap. Say so, rather than
    // sending a command that fails at the MMU a second later with less context.
    if (g.empty) { act.refuse(`GATE ${i}`, "that gate is empty"); return; }
    act.guarded(`MMU_SELECT GATE=${i}`, SELECT_GUARDS);
  };

  const stage = busy ? String(m.action).toUpperCase() : String(m.filament || "").toUpperCase();
  const pitch = 100 / m.n;

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>

      {/* header: identity, live stage, the telemetry that used to need a column, tabs */}
      <div style={S(`flex:none; display:flex; align-items:center; gap:12px`)}>
        <span style={S(`width:3px; height:15px; background:${C.accent}; border-radius:1px`)} />
        <span style={S(mono(F.label, `letter-spacing:.18em; color:${C.text}; white-space:nowrap; flex:none`))}>{m.title}</span>
        <span style={S(badgeStyle(m.isPaused ? "err" : busy ? "warn" : "ok"))}>
          {m.isPaused ? "PAUSED" : stage || "—"}
        </span>
        {m.isPaused && m.reason
          ? <span style={S(mono(F.micro, `color:${C.bed}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px`))}>{m.reason}</span>
          : null}
        {/* Telemetry does NOT belong here. Title + badge + five stats + four tabs
            overflowed 1000px and wrapped the title onto two lines. The three values
            that actually change during an operation moved to the path panel's own
            header; CLOG and SWAPS belong on the STATS tab, where there is room to
            say what they mean. */}
        <Tabs tabs={TABS} active={tab} onPick={setTab} />
      </div>

      {/* A tab is NOT navigation. The first version called go(tab) from render, which
          took you out of MMU entirely -- so "back" landed on MORE, not on the screen
          you were just looking at, and the tab strip you needed to return was gone.
          The other three tabs are the MORE screens of the same name, rendered in place
          with `embedded` (no outer padding, flex:1 in this column) so the strip stays.
          GATE MAP needs `api` for its spool picker and LOAD SPEED (makeMmuActions), and
          both GATE MAP and TTG report through `say`. */}
      {tab === "gatemap" ? (
        <GateMap embedded st={st} api={api} act={act} say={say} askInput={askInput} />
      ) : tab === "ttg" ? (
        <Ttg embedded st={st} act={act} say={say} />
      ) : tab === "mmustats" ? (
        <MmuStats embedded st={st} act={act} />
      ) : (
      <>
      {/* gates + selector */}
      <div style={S(panel(`flex:none; padding:11px 12px 8px`))}>
        <div style={S(`display:grid; grid-template-columns:repeat(${m.n},1fr); gap:8px`)}>
          {m.gates.map(g => (
            <GateCard key={g.i} g={g} disabled={busy || printing} onTap={() => selectGate(g.i)} />
          ))}
        </div>
        {/* The selector carriage, positioned from the live gate.
            When the selector is NOT homed its position is unknown, so drawing a
            carriage somewhere would be a lie -- say so in words instead. */}
        <div style={S("position:relative; height:22px; margin-top:7px")}>
          {m.isHomed ? (
            <div style={S(`position:absolute; top:0; left:calc(${m.gate * pitch + pitch / 2}% - 23px); width:46px; height:22px; display:flex; align-items:center; justify-content:center; border-radius:4px; background:${C.accent}; transition:left .55s cubic-bezier(.4,1.3,.5,1)`)}>
              <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.void_}`))}>SEL</span>
            </div>
          ) : (
            <span style={S(`position:absolute; top:4px; left:2px; ${mono(F.micro, `letter-spacing:.14em; color:${C.bed}`)}`)}>
              SELECTOR NOT HOMED
            </span>
          )}
        </div>
      </div>

      {/* filament path */}
      <div style={S(panel("flex:1; min-height:0; padding:12px"))}>
        <div style={S("flex:none; display:flex; align-items:center; gap:18px; margin-bottom:8px")}>
          <span style={S(microLabel(C.faint))}>FILAMENT PATH</span>
          {/* The export animated an encoder readout upward. This encoder is DISABLED
              on this machine (encoder.enabled === false), so it says so instead. */}
          <Stat k="ENC" v={m.encoderEnabled ? `${m.encoderPos.toFixed(1)} mm` : "OFF"}
            color={m.encoderEnabled ? C.body : C.ghost} />
          <Stat k="SERVO" v={m.servo ? m.servo.toUpperCase() : "—"} />
          <Stat k="SYNC" v={m.syncDrive ? "DRIVE" : (m.syncState || "off").toUpperCase()}
            color={m.syncDrive ? C.cool : C.body} />
          <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.dim}`)}`)}>
            {busy ? `${String(m.action).toUpperCase()} · GATE ${m.gate}`
                  : m.active && m.active.material
                    ? `${m.active.material}${m.active.filament_name ? " · " + m.active.filament_name.toUpperCase() : ""} · ${stage}`
                    : stage}
          </span>
        </div>
        <div style={S("flex:1; min-height:64px; position:relative")}>
          <FilamentPath m={m} showCutter cutting={/cut/i.test(m.action)} />
        </div>
        <div style={S(`flex:none; display:flex; justify-content:center; gap:26px; margin-top:6px`)}>
          {["GATE", "BUFFER", "ENCODER", "EXTRUDER", "NOZZLE"].map((label, i, arr) => {
            const reached = m.filamentPos >= (i / (arr.length - 1)) * 10 - 0.5;
            return (
              <div key={label} style={S("display:flex; align-items:center; gap:7px")}>
                <span style={S(`width:8px; height:8px; border-radius:50%; background:${reached ? C.accent : C.line3}${reached && busy ? "; animation:ksPulse 1s ease-in-out infinite" : ""}`)} />
                <span style={S(mono(F.micro, `letter-spacing:.12em; color:${reached ? C.dim : C.ghost}`))}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* the action bar the export lost off the bottom of the screen */}
      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px repeat(6,1fr); gap:9px`)}>
        <span />
        {ACTIONS.map(a => {
          const why = act.blocked(a.guards, a.cmd);
          const off = !!why || busy;
          const running = busy && new RegExp(a.key, "i").test(m.action);
          return (
            <Hv as="div" key={a.key} onClick={() => fire(a)} active={off ? "" : "transform:translateY(2px)"}
              title={why || a.cmd}
              style={`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; height:${TAP.primary}px; border-radius:${L.radius}px; cursor:${off ? "default" : "pointer"}; transition:background .14s; opacity:${off ? 0.45 : 1}; ${running
                ? `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent};`
                : `background:${C.panelHead}; border:1px solid ${C.line3}; color:${C.body};`}`}>
              <Glyph name={a.icon} size={19} />
              <span style={S(mono(F.micro, `letter-spacing:.14em`))}>{a.label}</span>
            </Hv>
          );
        })}
      </div>

      </>
      )}

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); act.guarded(c.cmd, c.guards); }} />
      ) : null}
    </div>
  );
}
