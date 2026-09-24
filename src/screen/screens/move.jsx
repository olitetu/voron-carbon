// ---------------------------------------------------------------------------
// MOVE — ported from the 1280x800 export, reflowed to 1024x600.
//
// Reflow: jog cells 104 -> 116px (there was room, and a jog button is the most
// tapped control on the panel), Z column 200 -> 170, right column 300 -> 280,
// pad 16 -> 12, gap 14 -> 10.
//
// The export's HOME button sent G28. On a Voron 2.4 a bare G28 leaves the gantry
// unleveled, which is why this printer has SMART_HOME (QGL applied -> G28 Z, else
// CG28 + _CQGL) and why KlipperScreen's own menu calls that instead. So do we.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { jogFeed } from "../../lib/prefs.js";
import { microLabel } from "../vm.js";
import { Chip, PanelBtn, Panel } from "../parts.jsx";

const LIM = { X: [0, 350], Y: [0, 350], Z: [0, 310] };   // Voron 2.4 350, Z from CONTRACT
const STEPS = [0.1, 1, 5, 10, 25, 50];

export default function Move({ st, act, askInput, say }) {
  const [step, setStep] = React.useState(10);
  const [confirm, setConfirm] = React.useState(null);

  const th = st.raw.toolhead || {};
  const pos = th.position || [0, 0, 0, 0];
  const homedAxes = String(th.homed_axes || "");
  const homed = homedAxes === "xyz";
  const printing = (st.raw.print_stats || {}).state === "printing" && !(st.raw.pause_resume || {}).is_paused;

  const jogGuards = { needsHomed: true, whilePrinting: false };
  const jogWhy = act.blocked(jogGuards, "G1");

  const jog = (axis, dir) => {
    const i = { X: 0, Y: 1, Z: 2 }[axis];
    const [lo, hi] = LIM[axis];
    const target = (pos[i] || 0) + dir * step;
    if (target < lo || target > hi) {
      act.refuse(`${axis}${dir > 0 ? "+" : "-"}${step}`, `${axis} limit is ${lo}–${hi} mm`);
      return;
    }
    const feed = jogFeed(st, axis);   // shared with the dashboard (lib/prefs.js)
    act.guarded(`G91\nG1 ${axis}${dir > 0 ? "" : "-"}${step} F${feed}\nG90`, jogGuards);
  };

  const jogBtn = (label, axis, dir) => (
    <div onClick={jogWhy ? undefined : () => jog(axis, dir)}
      style={S(`display:flex; align-items:center; justify-content:center; border-radius:7px; background:${C.panelHead}; border:1px solid ${C.line3}; ${mono(F.num2, `letter-spacing:.06em; color:${C.body}`)}; cursor:${jogWhy ? "default" : "pointer"}; transition:background .14s; opacity:${jogWhy ? 0.4 : 1}`)}>
      {label}
    </div>
  );

  const ACTIONS = [
    { label: "QUAD GANTRY LEVEL", cmd: "QUAD_GANTRY_LEVEL", guards: { whilePrinting: false } },
    { label: "BED MESH CALIBRATE", cmd: "BED_MESH_CALIBRATE", guards: { whilePrinting: false } },
    { label: "PARK TOOLHEAD", cmd: "TOOLHEAD_PARK_PAUSE_CANCEL", guards: { needsHomed: true, whilePrinting: false } },
    { label: "MOTORS OFF", cmd: "M84", tone: "danger", guards: { whilePrinting: false },
      confirm: "Disable the stepper motors? On a 2.4 the gantry is held by the belts, so it will sag." },
  ];

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>

      <div style={S(`flex:none; display:grid; grid-template-columns:repeat(3,1fr) 210px; gap:${L.gap}px`)}>
        {["X", "Y", "Z"].map((axis, i) => (
          <div key={axis} style={S(`${panel("flex-direction:row; align-items:center; gap:12px; padding:9px 14px")}`)}>
            <span style={S(mono(F.val, `letter-spacing:.2em; color:${C.faint}`))}>{axis}</span>
            <span style={S(mono(26, `color:${homed ? C.text : C.mute}`))}>{(pos[i] || 0).toFixed(2)}</span>
            <span style={S(`margin-left:auto; ${mono(F.micro, `color:${C.ghost}`)}`)}>mm</span>
          </div>
        ))}
        <div style={S(`display:flex; align-items:center; gap:10px; padding:0 14px; border-radius:${L.radius}px; ${homed
          ? `background:${C.okBg}; border:1px solid ${C.okLine}; color:${C.cool};`
          : `background:${C.warnBg}; border:1px solid ${C.warnLine}; color:${C.bed};`}`)}>
          <span style={S(`width:8px; height:8px; border-radius:50%; background:currentColor${homed ? "" : "; animation:ksPulse 1.2s ease-in-out infinite"}`)} />
          <span style={S(mono(F.label, "letter-spacing:.14em"))}>
            {homed ? "HOMED XYZ" : homedAxes ? `HOMED ${homedAxes.toUpperCase()}` : "NOT HOMED"}
          </span>
        </div>
      </div>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 170px 280px; gap:${L.gap}px`)}>

        {/* jog pad */}
        <div style={S(panel("align-items:center; justify-content:center; padding:14px; position:relative; overflow:hidden"))}>
          <div style={S(`position:absolute; inset:0; background-image:linear-gradient(${C.line1} 1px,transparent 1px),linear-gradient(90deg,${C.line1} 1px,transparent 1px); background-size:34px 34px; opacity:.55`)} />
          <div style={S("position:relative; display:grid; grid-template-columns:repeat(3,116px); grid-template-rows:repeat(3,116px); gap:9px")}>
            <span />{jogBtn("Y+", "Y", 1)}<span />
            {jogBtn("X−", "X", -1)}
            <div onClick={() => act.guarded("SMART_HOME", { whilePrinting: false })}
              style={S(`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; border-radius:7px; background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent}; cursor:pointer`)}>
              <span style={S("font-size:24px; line-height:1")}>&#8962;</span>
              <span style={S(mono(F.micro, "letter-spacing:.16em"))}>HOME</span>
              <span style={S(mono(F.micro, `color:${C.mute}`))}>+ QGL</span>
            </div>
            {jogBtn("X+", "X", 1)}
            <span />{jogBtn("Y−", "Y", -1)}<span />
          </div>
          {jogWhy ? (
            <div style={S(`position:absolute; left:0; right:0; bottom:14px; text-align:center; ${mono(F.label, `letter-spacing:.16em; color:${C.bed}`)}`)}>
              {jogWhy.toUpperCase()}
            </div>
          ) : null}
        </div>

        {/* Z */}
        <Panel style="padding:14px" bodyStyle="gap:10px">
          <span style={S(`${microLabel(C.faint)}; text-align:center`)}>Z AXIS</span>
          <div onClick={jogWhy ? undefined : () => jog("Z", 1)}
            style={S(`flex:1; display:flex; align-items:center; justify-content:center; border-radius:7px; background:${C.panelHead}; border:1px solid ${C.line3}; ${mono(F.num2, `color:${C.body}`)}; cursor:${jogWhy ? "default" : "pointer"}; opacity:${jogWhy ? 0.4 : 1}`)}>Z+</div>
          <div style={S(`text-align:center; ${mono(26, `color:${homed ? C.text : C.mute}`)}`)}>{(pos[2] || 0).toFixed(2)}</div>
          <div onClick={jogWhy ? undefined : () => jog("Z", -1)}
            style={S(`flex:1; display:flex; align-items:center; justify-content:center; border-radius:7px; background:${C.panelHead}; border:1px solid ${C.line3}; ${mono(F.num2, `color:${C.body}`)}; cursor:${jogWhy ? "default" : "pointer"}; opacity:${jogWhy ? 0.4 : 1}`)}>Z&#8722;</div>
        </Panel>

        {/* step + actions */}
        <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
          <Panel style="flex:none; padding:11px 12px" bodyStyle="gap:8px">
            <span style={S(microLabel(C.faint))}>STEP SIZE &middot; mm</span>
            <div style={S("display:grid; grid-template-columns:repeat(3,1fr); gap:7px")}>
              {STEPS.map(v => (
                <Chip key={v} label={v} on={step === v} onTap={() => setStep(v)} h={TAP.min} fs={F.label} />
              ))}
            </div>
          </Panel>
          <Panel style="flex:1; min-height:0; padding:11px 12px" bodyStyle="gap:7px">
            <span style={S(microLabel(C.faint))}>ACTIONS</span>
            {ACTIONS.map(a => {
              const why = act.blocked(a.guards, a.cmd);
              return (
                <PanelBtn key={a.label} label={a.label} tone={a.tone} h={TAP.min} disabled={!!why} why={why}
                  onTap={() => (a.confirm ? setConfirm(a) : act.guarded(a.cmd, a.guards))} />
              );
            })}
          </Panel>
        </div>
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); act.guarded(c.cmd, c.guards); }} />
      ) : null}
    </div>
  );
}

/**
 * ms after a confirm appears during which its CONFIRM does nothing. At 1024x600 the box's CONFIRM
 * (x 517-775, y 333-401 for three lines of text) overlaps buttons that open it -- the bed mesh screen's
 * right-hand column starts at x 692 -- so the second tap of a double tap would otherwise confirm the
 * command the first tap only asked about. 400 ms covers a double tap and is shorter than anyone reads.
 */
const CONFIRM_ARM_MS = 400;

/** Shared confirm, same visuals as the shell's. */
export function ConfirmBox({ a, onNo, onYes }) {
  // Armed on mount, and again when the TITLE changes (a screen that swaps one ask for another without
  // closing the box). Not on the identity of `a`: system and network build `a` inline on every render, so
  // an identity check would re-arm on every status tick and never accept a tap. Kept in a ref, set during
  // render, so the very first tap after mount already sees it.
  const armed = React.useRef(null);
  if (!armed.current || armed.current.label !== a.label) armed.current = { label: a.label, at: Date.now() };
  const yes = e => { if (Date.now() - armed.current.at < CONFIRM_ARM_MS) return; onYes(e); };
  return (
    <div onClick={onNo} style={S("position:absolute; inset:0; z-index:60; background:rgba(4,6,9,.82); display:flex; align-items:center; justify-content:center; animation:ksFade .14s ease both")}>
      <div onClick={e => e.stopPropagation()}
        style={S(`width:560px; background:${C.panel}; border:1px solid ${C.line4}; border-radius:9px; overflow:hidden; animation:ksRise .18s ease both`)}>
        <div style={S(`display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid ${C.line2}; background:${C.panelHead}`)}>
          <span style={S(`width:3px; height:12px; background:${C.bed}; border-radius:1px`)} />
          <span style={S(mono(F.label, `letter-spacing:.18em; color:${C.text}`))}>{a.label}</span>
        </div>
        <div style={S("padding:18px 16px; display:flex; flex-direction:column; gap:8px")}>
          <span style={S(`font-size:${F.val}px; color:${C.text}; text-wrap:pretty`)}>{a.confirm}</span>
          <span style={S(mono(F.label, `color:${C.mute}`))}>{a.cmd}</span>
        </div>
        <div style={S("display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:0 16px 16px")}>
          <div onClick={onNo} style={S(`display:flex; align-items:center; justify-content:center; height:${TAP.danger}px; border:1px solid ${C.line3}; border-radius:7px; background:${C.panelHead}; ${mono(F.label, `letter-spacing:.18em; color:${C.dim}`)}; cursor:pointer`)}>CANCEL</div>
          <div onClick={yes} style={S(`display:flex; align-items:center; justify-content:center; height:${TAP.danger}px; border:1px solid ${C.accentLine}; border-radius:7px; background:${C.accentBg}; ${mono(F.label, `letter-spacing:.18em; color:${C.accent}`)}; cursor:pointer`)}>CONFIRM</div>
        </div>
      </div>
    </div>
  );
}
