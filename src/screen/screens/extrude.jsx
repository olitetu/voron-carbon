// ---------------------------------------------------------------------------
// EXTRUDE — ported from the export, reflowed to 1024x600.
//
// The export hard-coded the cold-extrude threshold as `s.n < 170`. The real limit
// is configfile.settings.extruder.min_extrude_temp, and Klipper enforces it
// itself via extruder.can_extrude -- so the banner reads the live flag and quotes
// the configured number rather than inventing one.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { controlPrefs } from "../../lib/prefs.js";
import { temps as tempsVm, mmu as mmuVm, microLabel } from "../vm.js";
import { Chip, PanelBtn, Panel, Bar, FilamentPath } from "../parts.jsx";


export default function Extrude({ st, act, askInput }) {
  // Presets are shared with the dashboard (lib/prefs.js); the owner's defaults are 10/25/50/100 mm at 5/10/20/25 mm/s.
  const { extrudeLengths: LENGTHS, extrudeRates: RATES } = controlPrefs(st);
  const [pickLen, setLen] = React.useState(25);
  const [pickRate, setRate] = React.useState(5);
  // A preset edited in the settings panel can drop the picked value; fall back rather than extrude an unlisted amount.
  const len = LENGTHS.includes(pickLen) ? pickLen : LENGTHS[1];
  const rate = RATES.includes(pickRate) ? pickRate : RATES[0];
  const t = tempsVm(st);
  const m = mmuVm(st);

  const e = st.raw.extruder || {};
  const minTemp = ((st.config || {}).extruder || {}).min_extrude_temp;
  const cold = !e.can_extrude;
  const guards = { needsHot: true };
  const why = act.blocked(guards);

  const move = dir => act.guarded(`M83\nG1 E${dir > 0 ? "" : "-"}${len} F${rate * 60}`, guards);

  const setNozzle = async () => {
    const v = await askInput({
      mode: "numeric", label: "NOZZLE TARGET", value: Math.round(t.nozzle.tgt),
      unit: "°C", min: 0, max: 300, allowNegative: false, hint: "0 turns it off",
    });
    if (v !== null) act.guarded(`M104 S${Math.round(Number(v))}`, {});
  };

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>

      {/* cold guard. Klipper decides this, not us. */}
      <div style={S(`flex:none; display:flex; align-items:center; gap:12px; padding:11px 14px; border-radius:${L.radius}px; ${cold
        ? `background:${C.warnBg}; border:1px solid ${C.warnLine}; color:${C.bed};`
        : `background:${C.okBg}; border:1px solid ${C.okLine}; color:${C.cool};`}`)}>
        <span style={S(`width:8px; height:8px; border-radius:50%; background:currentColor${cold ? "; animation:ksPulse 1.2s ease-in-out infinite" : ""}`)} />
        <span style={S(mono(F.label, "letter-spacing:.1em"))}>
          {cold
            ? `HOTEND AT ${t.nozzle.cur.toFixed(1)} °C — EXTRUSION LOCKED${minTemp ? ` BELOW ${minTemp} °C` : ""}`
            : `HOTEND AT ${t.nozzle.cur.toFixed(1)} °C — READY TO EXTRUDE`}
        </span>
        {cold ? (
          <div onClick={() => act.guarded("M104 S240", {})}
            style={S(`margin-left:auto; flex:none; padding:0 16px; height:${TAP.min}px; display:flex; align-items:center; border-radius:5px; border:1px solid currentColor; ${mono(F.label, "letter-spacing:.14em")}; cursor:pointer`)}>
            HEAT TO 240
          </div>
        ) : null}
      </div>

      {/* the filament path, so an extrude is visibly the same path the MMU uses */}
      {m.present ? (
        <div style={S(panel("flex:none; height:92px; padding:10px 12px"))}>
          <div style={S("flex:none; display:flex; align-items:center; gap:10px; margin-bottom:4px")}>
            <span style={S(microLabel(C.faint))}>PATH</span>
            <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.dim}`)}`)}>
              {m.active && m.active.material
                ? `${m.active.material}${m.active.filament_name ? " · " + m.active.filament_name.toUpperCase() : ""} · ${String(m.filament).toUpperCase()}`
                : String(m.filament).toUpperCase()}
            </span>
          </div>
          <div style={S("flex:1; min-height:0; position:relative")}><FilamentPath m={m} /></div>
        </div>
      ) : null}

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:${L.gap}px`)}>

        <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
          <Panel style="flex:none; padding:11px 12px" bodyStyle="gap:9px">
            <div style={S("display:flex; align-items:center; gap:10px")}>
              <span style={S(microLabel(C.faint))}>LENGTH</span>
              <span style={S(`margin-left:auto; ${mono(F.num2, `color:${C.text}`)}`)}>{len} mm</span>
            </div>
            <div style={S("display:flex; gap:7px")}>
              {LENGTHS.map(v => <Chip key={v} label={v} on={len === v} onTap={() => setLen(v)} h={TAP.min} />)}
            </div>
          </Panel>
          <Panel style="flex:none; padding:11px 12px" bodyStyle="gap:9px">
            <div style={S("display:flex; align-items:center; gap:10px")}>
              <span style={S(microLabel(C.faint))}>FEEDRATE</span>
              <span style={S(`margin-left:auto; ${mono(F.num2, `color:${C.text}`)}`)}>{rate} mm/s</span>
            </div>
            <div style={S("display:flex; gap:7px")}>
              {RATES.map(v => <Chip key={v} label={`${v} mm/s`} on={rate === v} onTap={() => setRate(v)} h={TAP.min} />)}
            </div>
          </Panel>
          <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:1fr 1fr; gap:${L.gap}px`)}>
            <div onClick={why ? undefined : () => move(1)} title={why || undefined}
              style={S(`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; border-radius:${L.radius}px; cursor:${why ? "default" : "pointer"}; opacity:${why ? 0.42 : 1}; ${why
                ? `background:${C.panelHead}; border:1px solid ${C.line3}; color:${C.ghost};`
                : `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent};`}`)}>
              <span style={S("font-size:26px; line-height:1")}>&darr;</span>
              <span style={S(mono(F.chip, "letter-spacing:.22em"))}>EXTRUDE</span>
            </div>
            <div onClick={why ? undefined : () => move(-1)} title={why || undefined}
              style={S(`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; border-radius:${L.radius}px; background:${C.panelHead}; border:1px solid ${why ? C.line3 : C.line5}; color:${why ? C.ghost : C.body}; cursor:${why ? "default" : "pointer"}; opacity:${why ? 0.42 : 1}`)}>
              <span style={S("font-size:26px; line-height:1")}>&uarr;</span>
              <span style={S(mono(F.chip, "letter-spacing:.22em"))}>RETRACT</span>
            </div>
          </div>
        </div>

        <Panel title="HOTEND" bodyStyle="padding:14px; gap:10px">
          <div onClick={setNozzle} style={S("flex:none; display:flex; align-items:flex-end; gap:8px; cursor:pointer")}>
            <span style={S(mono(F.hero, `line-height:1; color:${C.hot}`))}>{t.nozzle.cur.toFixed(1)}</span>
            <span style={S(mono(F.val, `color:${C.faint}; padding-bottom:5px`))}>/ {t.nozzle.tgt.toFixed(0)} &deg;C</span>
          </div>
          <Bar pct={t.nozzle.cur / 300 * 100} color={C.hot} h={6} />
          {/* One row of four, and the quick actions on two rows rather than three:
              the 2x2 presets plus a 3-high stack overran this panel by ~83px and
              pushed BLOBIFIER CLEAN off the bottom of the screen entirely. */}
          <div style={S("flex:none; display:grid; grid-template-columns:repeat(4,1fr); gap:6px")}>
            {[["PLA", 195], ["PETG", 240], ["ABS", 220], ["OFF", 0]].map(([l, v]) => (
              <Chip key={l} label={l} sub={v ? `${v}°` : "off"} h={TAP.primary} fs={F.label}
                on={Math.round(t.nozzle.tgt) === v} onTap={() => act.guarded(`M104 S${v}`, {})} />
            ))}
          </div>
          {(() => {
            const A = [
              { label: "LOAD", cmd: "MMU_LOAD", guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false } },
              { label: "UNLOAD", cmd: "MMU_UNLOAD", guards: { needsMmu: true, needsMmuIdle: true, whilePrinting: false } },
              // The export said CLEAN_NOZZLE. This printer has no such command --
              // the wipe here is the Blobifier's. Capability-gated either way.
              { label: "BLOBIFIER CLEAN", cmd: "BLOBIFIER_CLEAN", guards: { needsHomed: true, whilePrinting: false } },
            ].map(a => Object.assign({}, a, { why: act.blocked(a.guards, a.cmd) }));
            return (
              <div style={S("margin-top:auto; display:flex; flex-direction:column; gap:7px")}>
                <div style={S("display:grid; grid-template-columns:1fr 1fr; gap:7px")}>
                  {A.slice(0, 2).map(a => (
                    <PanelBtn key={a.label} label={a.label} h={TAP.min} disabled={!!a.why} why={a.why}
                      onTap={() => act.guarded(a.cmd, a.guards)} />
                  ))}
                </div>
                <PanelBtn label={A[2].label} h={TAP.min} disabled={!!A[2].why} why={A[2].why}
                  onTap={() => act.guarded(A[2].cmd, A[2].guards)} />
              </div>
            );
          })()}
        </Panel>
      </div>
    </div>
  );
}
