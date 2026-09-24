// SETTINGS — the popover behind the top-bar cog. Edits Carbon's shared prefs (lib/prefs.js): jog steps and
// speeds, extrude presets and the printer's display name. Saved to Moonraker's database, so the Orca dashboard
// and the touchscreen read the same values.
//
// Mounted at the ROOT of the dashboard, beside the popover scrim rather than inside the header: the header is its
// own stacking context at z-index 5, under the scrim's 30, so a panel inside it would have every click land on the
// scrim and close it. Outside-click / Escape close it like every other popover (logic.jsx POPS: settingsOpen).
import React from "react";
import { Btn, Label, Row, Input, T, mono } from "../../lib/design.jsx";
import { S } from "../../lib/ui.js";
import { CONTROL_DEFAULTS, GENERAL_DEFAULTS, LIMITS, controlPrefs, generalPrefs, savePrefSlices } from "../../lib/prefs.js";

const toDraft = (c, g) => ({
  printerName: g.printerName,
  stepsXY: c.stepsXY.map(String), stepsZ: c.stepsZ.map(String),
  feedXY: String(c.feedXY), feedZ: String(c.feedZ),
  extrudeLengths: c.extrudeLengths.map(String), extrudeRates: c.extrudeRates.map(String),
});

const num = s => { const v = parseFloat(String(s).replace(",", ".")); return isFinite(v) ? v : NaN; };
const bad = (s, [lo, hi]) => { const v = num(s); return !(v >= lo && v <= hi); };

/** Parse + validate a draft. Returns { control, general, errors } — errors keyed by field. */
function parse(d) {
  const errors = {};
  const vec = (key, lim) => {
    if (d[key].some(s => bad(s, lim))) errors[key] = `each ${lim[0]}–${lim[1]}`;
    return d[key].map(num);
  };
  // Jog steps are drawn coarse → fine on both sides of the axis cell, so they are stored in that order.
  const stepsXY = vec("stepsXY", LIMITS.step).sort((a, b) => b - a);
  const stepsZ = vec("stepsZ", LIMITS.step).sort((a, b) => b - a);
  if (bad(d.feedXY, LIMITS.feedXY)) errors.feedXY = `${LIMITS.feedXY[0]}–${LIMITS.feedXY[1]} mm/s`;
  if (bad(d.feedZ, LIMITS.feedZ)) errors.feedZ = `${LIMITS.feedZ[0]}–${LIMITS.feedZ[1]} mm/s`;
  const extrudeLengths = vec("extrudeLengths", LIMITS.extrudeLength);
  const extrudeRates = vec("extrudeRates", LIMITS.extrudeRate);
  const name = String(d.printerName || "").trim();
  if (!name) errors.printerName = "required";
  if (name.length > 24) errors.printerName = "24 characters max";
  return {
    control: { stepsXY, stepsZ, feedXY: num(d.feedXY), feedZ: num(d.feedZ), extrudeLengths, extrudeRates },
    general: { printerName: name },
    errors,
  };
}

function Field({ label, error, children, hint }) {
  return (
    <div style={S("display:flex; flex-direction:column; gap:5px; min-width:0")}>
      <Row gap={8}>
        <Label>{label}</Label>
        {error ? <span style={S(mono(8.5, `letter-spacing:.06em; color:${T.err}`))}>{error}</span>
          : hint ? <span style={S(mono(8.5, `letter-spacing:.06em; color:${T.ghost}`))}>{hint}</span> : null}
      </Row>
      <Row gap={5}>{children}</Row>
    </div>
  );
}

const box = err => `width:100%; min-width:0; text-align:center; padding:5px 4px${err ? `; border-color:${T.err}` : ""}`;

export default function SettingsPanel({ store, api, log, act, onClose }) {
  const st = store.state;
  const saved = React.useMemo(() => toDraft(controlPrefs(st), generalPrefs(st)), [st.prefs]);
  const [d, setD] = React.useState(saved);
  const [busy, setBusy] = React.useState(false);
  const [armMacros, setArmMacros] = React.useState(false);
  const { control, general, errors } = parse(d);
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const valid = !Object.keys(errors).length;

  const setOne = key => e => setD(Object.assign({}, d, { [key]: e.target.value }));
  const setAt = (key, i) => e => { const next = d[key].slice(); next[i] = e.target.value; setD(Object.assign({}, d, { [key]: next })); };
  const vecInputs = (key, unit) => d[key].map((v, i) => (
    <Input key={i} value={v} onChange={setAt(key, i)} inputMode="decimal" title={unit} style={box(errors[key])} />
  ));

  const save = async () => {
    if (!valid || !dirty || busy) return;
    setBusy(true);
    const ok = await savePrefSlices({ api, store, log }, { control, general });
    setBusy(false);
    if (ok) { log("Settings saved — shared with the touchscreen", "ok"); onClose(); }
  };
  const defaults = () => setD(toDraft(CONTROL_DEFAULTS, GENERAL_DEFAULTS));
  const resetMacros = () => {
    if (!armMacros) { setArmMacros(true); setTimeout(() => setArmMacros(false), 6000); return; }
    setArmMacros(false);
    if (act && typeof act.resetMacroPrefs === "function") act.resetMacroPrefs();
  };

  const section = t => <div style={S(`${mono(9, `letter-spacing:.16em; color:${T.dim}`)}; padding-top:4px; border-top:1px solid ${T.line}; margin-top:2px`)}>{t}</div>;

  return (
    <div onKeyDown={e => { if (e.key === "Enter") save(); }}
      style={S(`position:fixed; top:60px; right:18px; z-index:31; width:400px; max-width:calc(100vw - 36px); max-height:calc(100vh - 80px); overflow-y:auto; background:#0b0f15; border:1px solid ${T.line2}; border-radius:6px; box-shadow:0 18px 40px rgba(0,0,0,.6); animation:vRise .16s ease both`)}>
      <div style={S(`display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid ${T.line}; background:${T.panel}`)}>
        <span style={S(`width:3px; height:11px; background:${T.accent}; border-radius:1px`)} />
        <span style={S(mono(10, `letter-spacing:.16em; color:${T.dim}`))}>SETTINGS</span>
        <span style={S(`margin-left:auto; ${mono(8.5, `letter-spacing:.08em; color:${T.ghost}`)}`)}>SAVED ON THE PRINTER · SHARED WITH THE TOUCHSCREEN</span>
      </div>
      <div style={S("padding:12px; display:flex; flex-direction:column; gap:12px")}>
        <Field label="PRINTER NAME" error={errors.printerName}>
          <Input value={d.printerName} onChange={setOne("printerName")} mono={false} style={box(errors.printerName) + "; text-align:left"} />
        </Field>

        {section("JOGGING")}
        <Field label="XY STEPS · mm" error={errors.stepsXY} hint="coarse → fine">{vecInputs("stepsXY", "mm")}</Field>
        <Field label="Z STEPS · mm" error={errors.stepsZ} hint="coarse → fine">{vecInputs("stepsZ", "mm")}</Field>
        <div style={S("display:grid; grid-template-columns:1fr 1fr; gap:10px")}>
          <Field label="XY SPEED · mm/s" error={errors.feedXY}><Input value={d.feedXY} onChange={setOne("feedXY")} inputMode="decimal" style={box(errors.feedXY)} /></Field>
          <Field label="Z SPEED · mm/s" error={errors.feedZ}><Input value={d.feedZ} onChange={setOne("feedZ")} inputMode="decimal" style={box(errors.feedZ)} /></Field>
        </div>

        {section("EXTRUSION")}
        <Field label="LENGTHS · mm" error={errors.extrudeLengths}>{vecInputs("extrudeLengths", "mm")}</Field>
        <Field label="SPEEDS · mm/s" error={errors.extrudeRates}>{vecInputs("extrudeRates", "mm/s")}</Field>

        {section("MACROS")}
        <Row gap={8}>
          <Btn small kind={armMacros ? "warn" : "default"} onClick={resetMacros}
            title="Forget which macro tiles are shown and their custom icons and labels">{armMacros ? "CONFIRM RESET?" : "RESET MACRO TILES"}</Btn>
          <span style={S(mono(8.5, `color:${T.ghost}`))}>back to the default tiles</span>
        </Row>
      </div>
      <div style={S(`display:flex; align-items:center; gap:6px; padding:9px 12px; border-top:1px solid ${T.line}; background:${T.panel}`)}>
        <Btn small kind="ghost" onClick={defaults} title="Fill in Carbon's defaults (not saved until you SAVE)">DEFAULTS</Btn>
        <span style={S("margin-left:auto")} />
        <Btn small onClick={onClose}>CLOSE</Btn>
        <Btn small kind="ok" disabled={!valid || !dirty || busy} onClick={save}
          title={!valid ? "Fix the fields in red first" : !dirty ? "Nothing changed" : "Save to the printer"}>{busy ? "SAVING…" : "SAVE"}</Btn>
      </div>
    </div>
  );
}
