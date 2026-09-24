// ---------------------------------------------------------------------------
// TEMPERATURE — ported from the export, reflowed to 1024x600.
//
// Two corrections to the export, both forced by this printer:
//
//   CHAMBER HAS NO HEATER. heaters.available_heaters is ["heater_bed","extruder"],
//   M141 is absent from the 368-command catalogue, and temperature_store carries
//   no targets/powers series for CHAMBER. The export gave it a settable target,
//   presets OFF/WARM/ABS/MAX, a heater bar and a place in COOL DOWN ALL. All of
//   that is fiction, so chamber is a read-out with a soak hint instead.
//
//   THE PRESETS ARE THE REAL ONES. The export invented PLA 215 / PETG 240 /
//   ABS 255. KlipperScreen on this machine is configured PLA 195/40, ABS 220/90,
//   PETG 240/80, FLEX 210/0 -- nozzle AND bed -- so those are what appear.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { temps as tempsVm, microLabel } from "../vm.js";
import { Chip, PanelBtn, Panel, Bar } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";

/** KlipperScreen's configured preheat set on this printer: [label, nozzle, bed]. */
const PRESETS = [["PLA", 195, 40], ["PETG", 240, 80], ["ABS", 220, 90], ["FLEX", 210, 0]];
const WINDOW = 300;   // "HISTORY · 5 MIN" — temperature_store is 1 Hz

export default function Temp({ st, act, askInput }) {
  const [sel, setSel] = React.useState("nozzle");
  const [confirm, setConfirm] = React.useState(null);
  const t = tempsVm(st);
  const d = t[sel];

  const setTarget = async () => {
    if (!d.settable) {
      act.refuse(d.label, "there is no chamber heater on this printer");
      return;
    }
    const v = await askInput({
      mode: "numeric", label: `${d.label} TARGET`, value: Math.round(d.tgt),
      unit: "°C", min: 0, max: d.max, allowNegative: false, hint: "0 turns it off",
    });
    if (v === null) return;
    const n = Math.round(Number(v));
    act.guarded(sel === "nozzle" ? `M104 S${n}` : `M140 S${n}`, {});
  };

  const applyPreset = ([label, nozzle, bed]) => {
    // Preheat is a pair on this printer, as KlipperScreen has it — setting one
    // half and leaving the other is how you get a cold bed and a hot nozzle.
    act.guarded(`M104 S${nozzle}\nM140 S${bed}`, {});
  };

  const series = name => {
    const h = (st.tempHistory || {})[name];
    return h && h.temperatures ? h.temperatures.slice(-WINDOW) : [];
  };
  const sN = series("extruder"), sB = series("heater_bed"), sC = series("temperature_sensor CHAMBER");
  const all = sN.concat(sB, sC);
  let lo = all.length ? Math.min(...all) : 0;
  let hi = all.length ? Math.max(...all) : 100;
  const pad = Math.max(6, (hi - lo) * 0.1);
  lo = Math.max(0, Math.floor((lo - pad) / 5) * 5);
  hi = Math.ceil((hi + pad) / 5) * 5;
  const span = hi - lo || 1;
  const pts = arr => arr.length < 2 ? "" : arr.map((v, i) =>
    `${(i / (arr.length - 1) * 160).toFixed(1)},${(100 - (v - lo) / span * 100).toFixed(1)}`).join(" ");

  const dev = k => {
    const x = t[k], on = sel === k;
    return (
      <div key={k} onClick={() => setSel(k)}
        style={S(`display:flex; align-items:center; gap:10px; padding:0 14px; height:56px; border-radius:${L.radius}px; cursor:pointer; ${mono(F.label)}; ${on
          ? `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent};`
          : `background:${C.panel}; border:1px solid ${C.line2}; color:${C.dim};`}`)}>
        <span style={S(`width:8px; height:8px; border-radius:50%; background:${x.col}`)} />
        <span style={S("letter-spacing:.18em")}>{x.label}</span>
        <span style={S(`margin-left:auto; ${mono(F.num2)}`)}>{x.cur.toFixed(0)}&deg;</span>
      </div>
    );
  };

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>
      <div style={S(`flex:none; display:grid; grid-template-columns:repeat(3,1fr); gap:${L.gap}px`)}>
        {["nozzle", "bed", "chamber"].map(dev)}
      </div>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:360px minmax(0,1fr); gap:${L.gap}px`)}>

        <Panel style="padding:14px" bodyStyle="gap:11px">
          <div onClick={setTarget}
            style={S(`flex:none; display:flex; align-items:flex-end; gap:10px; cursor:${d.settable ? "pointer" : "default"}`)}>
            <span style={S(mono(F.giant, `line-height:1; color:${d.settable && d.tgt <= 0 ? C.mute : d.col}`))}>{d.cur.toFixed(1)}</span>
            <span style={S(mono(F.val, `color:${C.faint}; padding-bottom:6px`))}>
              {d.settable ? `/ ${d.tgt.toFixed(0)} °C` : "°C"}
            </span>
          </div>
          <Bar pct={d.cur / d.max * 100} color={d.col} h={8} />

          {d.settable ? (
            <>
              <div style={S("flex:none; display:grid; grid-template-columns:repeat(4,1fr); gap:7px")}>
                {[-10, -1, 1, 10].map(v => (
                  <Chip key={v} label={(v > 0 ? "+" : "") + v} h={TAP.min} fs={F.val}
                    onTap={() => act.guarded(`${sel === "nozzle" ? "M104 S" : "M140 S"}${Math.max(0, Math.min(d.max, Math.round(d.tgt + v)))}`, {})} />
                ))}
              </div>
              {/* One row of four, not 2x2. The 2x2 arrangement cost 67px and left the
                  heater box 16px short of its own content, clipping DEVIATION -- an
                  internal clip, so a frame-overflow check does not catch it. */}
              <div style={S("flex:none; display:grid; grid-template-columns:repeat(4,1fr); gap:6px")}>
                {PRESETS.map(p => (
                  <Chip key={p[0]} label={p[0]} sub={`${p[1]}/${p[2]}`} h={TAP.primary} fs={F.label}
                    on={Math.round(t.nozzle.tgt) === p[1] && Math.round(t.bed.tgt) === p[2]}
                    onTap={() => applyPreset(p)} />
                ))}
              </div>
              <div style={S(`flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; border:1px solid ${C.line3}; border-radius:7px; background:${C.panelSunk}; padding:11px 12px`)}>
                <div style={S("display:flex; align-items:center; gap:10px")}>
                  <span style={S(microLabel(C.faint))}>HEATER POWER</span>
                  <span style={S(`margin-left:auto; ${mono(F.val, `color:${C.text}`)}`)}>{Math.round(d.power * 100)}%</span>
                </div>
                <Bar pct={d.power * 100} color={d.col} h={6} />
                <div style={S("display:flex; align-items:center; gap:10px")}>
                  <span style={S(microLabel(C.faint))}>LIMIT</span>
                  <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.body}`)}`)}>0 &ndash; {d.max} &deg;C</span>
                </div>
                <div style={S("display:flex; align-items:center; gap:10px")}>
                  <span style={S(microLabel(C.faint))}>DEVIATION</span>
                  <span style={S(`margin-left:auto; ${mono(F.label, `color:${d.tgt > 0 && Math.abs(d.cur - d.tgt) > 2 ? C.bed : C.cool}`)}`)}>
                    {d.tgt > 0 ? `${(d.cur - d.tgt >= 0 ? "+" : "")}${(d.cur - d.tgt).toFixed(1)} °C` : "—"}
                  </span>
                </div>
              </div>
              <PanelBtn label="COOL DOWN ALL" h={TAP.primary}
                onTap={() => setConfirm({ label: "COOL DOWN ALL", cmd: "TURN_OFF_HEATERS", guards: {},
                  confirm: "Turn off the extruder and bed heaters?" })} />
            </>
          ) : (
            <div style={S(`flex:1; min-height:0; display:flex; flex-direction:column; gap:10px; border:1px solid ${C.line3}; border-radius:7px; background:${C.panelSunk}; padding:12px`)}>
              <span style={S(microLabel(C.faint))}>NO CHAMBER HEATER</span>
              <span style={S(`font-size:${F.body}px; color:${C.faint}; line-height:1.5; text-wrap:pretty`)}>
                CHAMBER is a temperature sensor. There is no heater and no
                <span style={S(mono(F.label, `color:${C.hot}`))}> M141</span>, so it cannot be given a target.
              </span>
              <span style={S(`font-size:${F.body}px; color:${C.faint}; line-height:1.5; text-wrap:pretty`)}>
                Chamber temperature comes from the bed plus the Chamber and Exhaust fans &mdash;
                a soak, set on the FANS screen.
              </span>
              <div style={S("margin-top:auto; display:flex; align-items:center; gap:10px")}>
                <span style={S(microLabel(C.faint))}>MEASURED</span>
                <span style={S(`margin-left:auto; ${mono(F.num2, `color:${C.cool}`)}`)}>{d.cur.toFixed(1)} &deg;C</span>
              </div>
            </div>
          )}
        </Panel>

        <Panel title="HISTORY &middot; 5 MIN"
          right={<>
            {[["NOZZLE", C.hot], ["BED", C.bed], ["CHAMBER", C.cool]].map(([l, c]) => (
              <span key={l} style={S(`display:flex; align-items:center; gap:6px; ${mono(F.micro, `color:${c}`)}`)}>
                <span style={S(`width:10px; height:2px; background:${c}`)} />{l}
              </span>
            ))}
          </>}
          bodyStyle="padding:12px 12px 12px 52px; position:relative">
          <div style={S(`position:absolute; inset:12px 12px 12px 52px; background-image:linear-gradient(${C.line1} 1px,transparent 1px); background-size:100% 25%`)} />
          <div style={S("position:absolute; left:10px; top:12px; bottom:12px; width:38px; display:flex; flex-direction:column; justify-content:space-between; align-items:flex-end")}>
            {[0, 1, 2, 3, 4].map(i => (
              <span key={i} style={S(mono(F.micro, `color:${C.ghost}; line-height:1`))}>{Math.round(hi - span * i / 4)}&deg;</span>
            ))}
          </div>
          {all.length < 2 ? (
            <div style={S(`position:relative; flex:1; display:flex; align-items:center; justify-content:center; ${mono(F.label, `letter-spacing:.16em; color:${C.ghost}`)}`)}>
              WAITING FOR TEMPERATURE HISTORY
            </div>
          ) : (
            <svg viewBox="0 0 160 100" preserveAspectRatio="none" style={S("position:relative; width:100%; height:100%; display:block")}>
              <polyline fill="none" stroke={C.cool} strokeWidth="0.9" points={pts(sC)} />
              <polyline fill="none" stroke={C.bed} strokeWidth="0.9" points={pts(sB)} />
              <polyline fill="none" stroke={C.hot} strokeWidth="1.2" points={pts(sN)} />
            </svg>
          )}
        </Panel>
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); act.guarded(c.cmd, c.guards); }} />
      ) : null}
    </div>
  );
}
