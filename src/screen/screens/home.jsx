// ---------------------------------------------------------------------------
// HOME — reflowed from the 1280x800 export to the panel's real 1024x600.
//
// What changed and why:
//   left column   392px -> 300px   (392 is 30.6% of 1280; 300 is 30.0% of 1024)
//   screen pad     16px -> 12px  ·  inter-panel gap 14px -> 10px
//   tiles row      74px -> 66px  ·  FAB spacer 72px -> 64px (the FAB is 56px at inset 10)
//   all type raised to the 12px floor (see tokens.js: 10px on this 7" panel is ~6 arcmin)
//   gate sub-label kept, spool circle 42px -> 38px to pay for the taller type
// Colours, borders, radii, shadows and the filament-path geometry are the export's, verbatim.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel, panelHead } from "../tokens.js";
import { temps, mmu, job, badgeStyle, microLabel, toolGateLabel } from "../vm.js";
import { FilamentPath, gateColor } from "../parts.jsx";

function TempCard({ d, onGo }) {
  const heating = d.tgt > 0 && d.cur < d.tgt - 1.5;
  const status = !d.settable ? "SENSOR" : d.tgt <= 0 ? "IDLE" : heating ? "HEATING" : "AT TEMP";
  return (
    <Hv as="div" onClick={onGo} active="transform:translateY(1px)"
      style={`flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; background:${C.panel}; border:1px solid ${C.line2}; border-radius:${L.radius}px; padding:11px 15px; cursor:pointer; box-shadow:0 8px 20px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.02)`}>
      <div style={S("display:flex; align-items:center; gap:9px")}>
        <span style={S(`width:8px; height:8px; border-radius:50%; background:${d.col}${heating ? "; animation:ksPulse 1.1s ease-in-out infinite" : ""}`)} />
        <span style={S(microLabel())}>{d.label}</span>
        <span style={S(`margin-left:auto; ${mono(F.micro, `letter-spacing:.1em; color:${C.faint}`)}`)}>
          {d.settable ? (d.tgt > 0 ? `TGT ${d.tgt.toFixed(0)}°` : "OFF") : "—"}
        </span>
      </div>
      <div style={S("display:flex; align-items:flex-end; gap:8px; margin-top:6px")}>
        <span style={S(mono(F.hero, `line-height:1; color:${d.settable && d.tgt <= 0 ? C.mute : C.text}`))}>{d.cur.toFixed(1)}</span>
        <span style={S(mono(F.label, `color:${C.faint}; padding-bottom:5px`))}>°C</span>
        <span style={S(`margin-left:auto; ${mono(F.micro, `letter-spacing:.14em; color:${C.mute}; padding-bottom:5px`)}`)}>{status}</span>
      </div>
      <div style={S(`height:5px; border-radius:3px; background:${C.track}; overflow:hidden; margin-top:8px`)}>
        <div style={S(`height:100%; width:${Math.min(100, d.cur / d.max * 100)}%; background:${d.col}; transition:width .4s linear`)} />
      </div>
    </Hv>
  );
}

function GateCard({ g }) {
  const on = g.selected;
  const col = gateColor(g);
  return (
    <div style={S(`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:8px 4px; border-radius:7px; border:1px solid ${on ? C.accentLine : "#151c26"}; background:${on ? C.selBg : C.panelSunk}`)}>
      <span style={S(mono(F.micro, `letter-spacing:.1em; color:${on ? C.accent : C.ghost}`))}>{"T" + g.i}</span>
      <span style={S(`width:38px; height:38px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:6px solid ${col}; ${g.empty ? "opacity:.3;" : on ? `box-shadow:0 0 15px ${col}66,` : ""} inset 0 0 0 1px rgba(255,255,255,.18)`)}>
        <span style={S(`width:10px; height:10px; border-radius:50%; background:${C.panelSunk}`)} />
      </span>
      <span style={S(mono(F.micro, `letter-spacing:.06em; color:${g.empty ? C.ghost : on ? C.text : C.dim}`))}>{g.empty ? "—" : g.material}</span>
      <span style={S(`width:100%; height:4px; border-radius:2px; background:${C.track}; overflow:hidden; display:block`)}>
        <span style={S(`display:block; height:100%; width:${g.fill == null ? 0 : g.fill * 100}%; background:${g.fill != null && g.fill < 0.15 ? C.bed : col}; box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)`)} />
      </span>
    </div>
  );
}
export default function Home({ st, meta, go }) {
  const t = temps(st);
  const m = mmu(st);
  const j = job(st, meta);
  const devs = [t.nozzle, t.bed, t.chamber];
  const tiles = [
    ["MOVE", "✥", `Z ${Number((st.raw.toolhead || {}).position ? (st.raw.toolhead.position[2] || 0) : 0).toFixed(2)} mm`, "move"],
    ["EXTRUDE", "⇅", (st.raw.extruder || {}).can_extrude ? "ready" : "below min temp", "extrude"],
    ["TEMP", "≋", `${t.nozzle.tgt.toFixed(0)} / ${t.bed.tgt.toFixed(0)} °C`, "temp"],
    ["MMU", "⬢", m.present ? `GATE ${m.gate} · ${String(m.filament).toUpperCase()}` : "not present", "mmu"],
    ["FILES", "▤", `${st.filesCount != null ? st.filesCount : "…"} on disk`, "files"],
    ["MACROS", "⌘", `${(st.macros || []).length} available`, "macros"],
  ];
  const stage = m.busy ? String(m.action).toUpperCase() : String(m.filament || "").toUpperCase();

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>
      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:300px minmax(0,1fr); gap:${L.gap}px`)}>
        <div style={S("display:flex; flex-direction:column; gap:8px; min-height:0")}>
          {devs.map(d => <TempCard key={d.label} d={d} onGo={() => go("temp", { dev: d.label.toLowerCase() })} />)}
        </div>

        <Hv as="div" onClick={() => go("mmu")} active="transform:translateY(1px)"
          style={`${panel("cursor:pointer; box-shadow:0 10px 26px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.02); overflow:hidden")}`}>
          <div style={S(panelHead())}>
            <span style={S(`width:3px; height:12px; background:${C.accent}; border-radius:1px`)} />
            <span style={S(microLabel())}>{m.present ? m.title : "MMU"}</span>
            {m.present ? <span style={S(`margin-left:auto; ${badgeStyle(m.busy ? "warn" : m.isPaused ? "err" : "ok")}`)}>{m.isPaused ? "PAUSED" : stage || "—"}</span> : null}
          </div>
          {!m.present ? (
            <div style={S(`flex:1; display:flex; align-items:center; justify-content:center; ${mono(F.label, `letter-spacing:.2em; color:${C.ghost}`)}`)}>NO MMU CONFIGURED</div>
          ) : (
            <div style={S(`flex:1; min-height:0; padding:12px; display:flex; flex-direction:column; gap:${L.gap}px`)}>
              <div style={S(`flex:1; min-height:132px; display:grid; grid-template-columns:repeat(${m.n},1fr); gap:8px`)}>
                {m.gates.map(g => <GateCard key={g.i} g={g} />)}
              </div>
              <div style={S(`flex:none; display:flex; align-items:center; gap:12px; padding:9px 12px; border:1px solid ${C.line3}; border-radius:${L.radiusSm}px; background:${C.panelSunk}`)}>
                {(() => {
                  const a = m.active || {};
                  const col = a.color ? "#" + String(a.color).replace(/^#/, "") : C.line4;
                  return <>
                    <span style={S(`width:30px; height:30px; border-radius:50%; flex:none; border:4px solid ${col}; box-shadow:0 0 14px ${col}55`)} />
                    <div style={S("display:flex; flex-direction:column; gap:2px; min-width:0")}>
                      <span style={S(mono(F.val, `color:${C.text}; letter-spacing:.06em`))}>
                        {a.material ? `${a.material}${a.filament_name ? " · " + a.filament_name.toUpperCase() : ""}` : "NO FILAMENT"}
                      </span>
                      <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}`))}>
                        {m.encoderEnabled ? `ENCODER ${m.encoderPos.toFixed(1)} mm` : "ENCODER OFF"}
                        {m.syncDrive ? " · SYNCED" : ""}
                      </span>
                    </div>
                    <span style={S(`margin-left:auto; ${mono(22, `color:${C.accent}`)}`)}>{toolGateLabel(m)}</span>
                  </>;
                })()}
              </div>
              <div style={S("flex:1; min-height:96px; position:relative")}><FilamentPath m={m} /></div>
            </div>
          )}
        </Hv>
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:64px repeat(6,1fr); gap:${L.gap}px`)}>
        <span />
        {tiles.map(([label, glyph, sub, k]) => (
          <Hv as="div" key={k} onClick={() => go(k)} hover={`border-color:${C.line5}`} active="transform:translateY(2px)"
            style={`display:flex; align-items:center; justify-content:center; gap:10px; height:66px; padding:0 10px; background:${C.panel}; border:1px solid ${C.line2}; border-radius:${L.radius}px; cursor:pointer; transition:border-color .16s, background .16s; box-shadow:0 8px 20px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.02)`}>
            <span style={S(mono(20, `line-height:1; color:${C.accent}; flex:none`))}>{glyph}</span>
            <div style={S("display:flex; flex-direction:column; gap:2px; min-width:0")}>
              <span style={S(mono(F.label, `letter-spacing:.14em; color:${C.text}`))}>{label}</span>
              <span style={S(mono(F.micro, `letter-spacing:.04em; color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{sub}</span>
            </div>
          </Hv>
        ))}
      </div>
    </div>
  );
}
