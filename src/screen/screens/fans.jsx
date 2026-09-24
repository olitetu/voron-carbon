// ---------------------------------------------------------------------------
// FANS & LEDS — ported from the export, reflowed to 1024x600.
//
// The export drew three fan rows: PART COOLING, "TOOLHEAD AUX", CHAMBER EXHAUST,
// all three with the full chip set, and one CHAMBER LIGHT toggle.
//
// This printer has FIVE fans and FOUR LED strips:
//   fan                       part cooling      settable   M106
//   fan_generic Chamber       circulation       settable   SET_FAN_SPEED
//   fan_generic Exhaust       exhaust           settable   SET_FAN_SPEED   (the only real tacho)
//   heater_fan hotend_fan     hotend            READ-ONLY  Klipper owns it
//   controller_fan Controller electronics       READ-ONLY  Klipper owns it
// There is no "toolhead aux" fan. And `fan.rpm` is null on this machine, so the
// export's fabricated RPM is a dash instead.
//
// LEDs are caselight / sb_leds / logo / mmu_leds. mmu_leds is driven with MMU_LED,
// NOT raw SET_LED -- Happy Hare owns it and its 18 led_effects would overwrite us.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { microLabel } from "../vm.js";
import { Chip, Panel, Bar } from "../parts.jsx";

const STEPS = [0, 25, 50, 75, 100];

const FANS = [
  { obj: "fan", label: "PART COOLING", set: v => `M106 S${Math.round(v * 2.55)}` },
  { obj: "fan_generic Chamber", label: "CHAMBER", set: v => `SET_FAN_SPEED FAN=Chamber SPEED=${(v / 100).toFixed(2)}` },
  { obj: "fan_generic Exhaust", label: "EXHAUST", set: v => `SET_FAN_SPEED FAN=Exhaust SPEED=${(v / 100).toFixed(2)}` },
  { obj: "heater_fan hotend_fan", label: "HOTEND", ro: "heater_fan — Klipper controls this from the hotend temperature" },
  { obj: "controller_fan Controller", label: "CONTROLLER", ro: "controller_fan — Klipper controls this from stepper activity" },
];

const STRIPS = [
  { obj: "neopixel caselight", name: "caselight", label: "CASELIGHT" },
  { obj: "neopixel sb_leds", name: "sb_leds", label: "STEALTHBURNER" },
  { obj: "neopixel logo", name: "logo", label: "LOGO" },
  { obj: "neopixel mmu_leds", name: "mmu_leds", label: "MMU", hh: true },
];
const SWATCHES = ["#ff5a33", "#3ddcc4", "#f0b429", "#e8eef6", "#6b8cff"];

const hex2rgb = h => {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
};

export default function Fans({ st, act }) {
  const [strip, setStrip] = React.useState("caselight");
  const raw = st.raw || {};

  const sel = STRIPS.find(s => s.name === strip) || STRIPS[0];
  const data = ((raw[sel.obj] || {}).color_data || [[0, 0, 0, 0]])[0] || [0, 0, 0, 0];
  const level = Math.round(Math.max(data[0], data[1], data[2]) * 100);

  const setStripColor = (hexOrNull, pct) => {
    if (sel.hh) {
      // Happy Hare owns mmu_leds through its own effects. Raw SET_LED would be
      // overwritten on the next MMU state change, so drive it HH's way.
      act.guarded(pct === 0 ? "MMU_LED ENABLE=0" : "MMU_LED ENABLE=1", { needsMmu: true });
      return;
    }
    const [r, g, b] = hexOrNull ? hex2rgb(hexOrNull) : [data[0], data[1], data[2]];
    const k = pct == null ? 1 : pct / 100;
    const mx = Math.max(r, g, b) || 1;
    const n = v => (v / mx * k).toFixed(3);
    act.guarded(`SET_LED LED=${sel.name} RED=${n(r)} GREEN=${n(g)} BLUE=${n(b)} WHITE=0 TRANSMIT=1`, {});
  };

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>

      <div style={S(`display:flex; flex-direction:column; gap:8px; min-height:0; padding-bottom:${L.fab + L.fabInset - L.pad}px`)}>
        {/* Three settable rows, then BOTH read-only fans on one shared row.
            Five full rows wanted 570px in a 524px column and clipped the last one
            -- and clipped it INTERNALLY, which a frame-overflow check does not see.
            The passive readouts do not each deserve a full row anyway. */}
        {FANS.filter(f => !f.ro).map(f => {
          const o = raw[f.obj];
          const pct = Math.round((o && o.speed ? o.speed : 0) * 100);
          const rpm = o && o.rpm != null ? Math.round(o.rpm) : null;
          const on = pct > 0;
          return (
            <div key={f.obj} style={S(panel("flex:none; padding:10px 14px; justify-content:center; gap:8px"))}>
              <div style={S("display:flex; align-items:center; gap:11px")}>
                <span style={S(`${mono(F.val, `color:${on ? C.cool : C.ghost}`)}${on ? "; animation:ksSpin 2s linear infinite; will-change:transform" : ""}`)}>&#10035;</span>
                <span style={S(microLabel(C.dim))}>{f.label}</span>
                <span style={S(`margin-left:auto; ${mono(24, `color:${C.text}`)}`)}>{pct}%</span>
                <span style={S(mono(F.label, `color:${rpm != null ? C.cool : C.ghost}; width:82px; text-align:right`))}>
                  {rpm != null ? `${rpm} RPM` : "no tacho"}
                </span>
              </div>
              <Bar pct={pct} color={on ? C.cool : C.line3} h={7} />
              <div style={S("display:flex; gap:6px")}>
                {STEPS.map(v => (
                  <Chip key={v} label={`${v}%`} on={pct === v} h={TAP.min} fs={F.label} onTap={() => act.guarded(f.set(v), {})} />
                ))}
                <Chip label="&minus;5" h={TAP.min} fs={F.label} onTap={() => act.guarded(f.set(Math.max(0, pct - 5)), {})} />
                <Chip label="+5" h={TAP.min} fs={F.label} onTap={() => act.guarded(f.set(Math.min(100, pct + 5)), {})} />
              </div>
            </div>
          );
        })}

        <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:8px")}>
          {FANS.filter(f => f.ro).map(f => {
            const o = raw[f.obj];
            const pct = Math.round((o && o.speed ? o.speed : 0) * 100);
            const rpm = o && o.rpm != null ? Math.round(o.rpm) : null;
            const on = pct > 0;
            return (
              <div key={f.obj} style={S(panel("padding:9px 12px; gap:6px"))} title={f.ro}>
                <div style={S("display:flex; align-items:center; gap:9px")}>
                  <span style={S(mono(F.label, `color:${on ? C.cool : C.ghost}`))}>&#10035;</span>
                  <span style={S(microLabel(C.dim))}>{f.label}</span>
                  <span style={S(`margin-left:auto; ${mono(F.num2, `color:${on ? C.text : C.mute}`)}`)}>{pct}%</span>
                </div>
                <Bar pct={pct} color={on ? C.cool : C.line3} h={5} />
                <div style={S("display:flex; align-items:center; gap:8px")}>
                  <span style={S(`${mono(F.micro, `letter-spacing:.1em; color:${C.ghost}`)}; padding:2px 6px; border:1px solid ${C.line3}; border-radius:3px`)}>KLIPPER</span>
                  <span style={S(`margin-left:auto; ${mono(F.micro, `color:${rpm != null ? C.cool : C.ghost}`)}`)}>
                    {rpm != null ? `${rpm} RPM` : "no tacho"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Panel title="LIGHTING" bodyStyle="padding:12px; gap:12px">
        <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:6px")}>
          {STRIPS.map(s => {
            const d = ((raw[s.obj] || {}).color_data || [[0, 0, 0, 0]])[0] || [0, 0, 0, 0];
            const lit = Math.max(d[0], d[1], d[2]) > 0.01;
            return (
              <Chip key={s.name} label={s.label} sub={raw[s.obj] ? (lit ? "on" : "off") : "absent"}
                on={strip === s.name} h={TAP.primary} fs={F.micro}
                disabled={!raw[s.obj]} onTap={() => setStrip(s.name)} />
            );
          })}
        </div>

        {sel.hh ? (
          <div style={S(`flex:1; min-height:0; display:flex; flex-direction:column; gap:10px; border:1px solid ${C.line3}; border-radius:7px; background:${C.panelSunk}; padding:12px`)}>
            <span style={S(microLabel(C.faint))}>HAPPY HARE OWNS THIS STRIP</span>
            <span style={S(`font-size:${F.body}px; color:${C.faint}; line-height:1.5; text-wrap:pretty`)}>
              mmu_leds is driven by Happy Hare&rsquo;s own effects &mdash; 18 of them, picked by MMU state.
              A raw <span style={S(mono(F.label, `color:${C.hot}`))}>SET_LED</span> here would be
              overwritten on the next gate change, so this only switches the effects on and off.
            </span>
            <div style={S("margin-top:auto; display:grid; grid-template-columns:1fr 1fr; gap:7px")}>
              <Chip label="EFFECTS ON" h={TAP.primary} on={level > 0} onTap={() => setStripColor(null, 100)} />
              <Chip label="OFF" h={TAP.primary} on={level === 0} onTap={() => setStripColor(null, 0)} />
            </div>
          </div>
        ) : (
          <>
            <div style={S("flex:none")}>
              <div style={S("display:flex; align-items:center; gap:10px; margin-bottom:8px")}>
                <span style={S(microLabel(C.faint))}>BRIGHTNESS</span>
                <span style={S(`margin-left:auto; ${mono(F.val, `color:${C.text}`)}`)}>{level}%</span>
              </div>
              <div style={S("display:flex; gap:6px")}>
                {STEPS.map(v => (
                  <Chip key={v} label={`${v}%`} on={level === v} h={TAP.min} fs={F.label}
                    onTap={() => setStripColor(null, v)} />
                ))}
              </div>
            </div>
            <div style={S("flex:none")}>
              <div style={S(`${microLabel(C.faint)}; margin-bottom:8px`)}>COLOUR</div>
              <div style={S("display:flex; gap:8px")}>
                {SWATCHES.map(c => (
                  <div key={c} onClick={() => setStripColor(c, level || 100)}
                    style={S(`flex:1; height:${TAP.min}px; border-radius:6px; cursor:pointer; background:${c}; border:2px solid transparent; opacity:.85`)} />
                ))}
              </div>
            </div>
            <div style={S(`margin-top:auto; flex:none; height:84px; border-radius:7px; border:1px solid ${C.line3}; background:${C.panelSunk}; position:relative; overflow:hidden; display:flex; align-items:center; justify-content:center`)}>
              <div style={S(`position:absolute; inset:0; background:radial-gradient(closest-side, rgb(${Math.round(data[0] * 255)},${Math.round(data[1] * 255)},${Math.round(data[2] * 255)}), transparent 78%); opacity:${Math.min(1, level / 90)}`)} />
              <span style={S(`position:relative; ${mono(F.micro, `letter-spacing:.2em; color:${C.faint}`)}`)}>LIVE</span>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
