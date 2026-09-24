// ---------------------------------------------------------------------------
// FINE TUNE — KlipperScreen's fine_tune panel: speed factor (M220), flow / extrude
// factor (M221) and Z babystep, all usable WHILE printing, which is the point of it.
// Values are read live from gcode_move.speed_factor / extrude_factor / homing_origin[2];
// the commands are built by the dashboard's own pure builders (factorCommand in
// lib/actions/extruder.js, zNudgePlan / zSetPlan in lib/actions/toolhead.js)
// and sent through act.guarded, like every other screen.
//
// What this printer does to those three values behind the panel's back (verified
// 2026-09-23 from the live config, Happy Hare v3.4.2's source and Klipper's source):
//
//   PAUSED = LOCKED. The PAUSE macro runs _MMU_SAVE_POSITION then BASE_PAUSE (Klipper's
//   SAVE_GCODE_STATE NAME=PAUSE_STATE), and RESUME runs BASE_RESUME (RESTORE_GCODE_STATE
//   NAME=PAUSE_STATE MOVE=1), which puts back homing_position, speed_factor AND extrude_factor.
//   Anything changed while paused is silently undone on RESUME, so the panel refuses and says so.
//
//   HAPPY HARE BUSY = LOCKED. A toolchange is ONE command (T<n> -> MMU_CHANGE_TOOL), and Klipper's
//   gcode mutex runs one command at a time (gcode.py run_script holds it), so anything sent
//   mid-change is not applied mid-change: it is deferred until the change ends, and repeated taps
//   land together then. The change (and a load / unload) is wrapped in
//   _save_toolhead_position_and_park / _restore_toolhead_position (SAVE_GCODE_STATE and
//   RESTORE_GCODE_STATE NAME=MMU_state MOVE=1), and the restore injects the incoming tool's factors
//   from HH's per-tool table, so a deferred M220 / M221 lands on the incoming tool, and a deferred
//   babystep lands at the print height after the nozzle was checked at the parked one.
//
//   FACTORS ARE PER TOOL. HH keeps mmu.tool_speed_multipliers / tool_extrusion_multipliers
//   (8 entries, all 1.0 today). A change applies to the selected tool (mmu.tool), is recorded for
//   it at its next unload (_record_tool_override, from gcode_move), and the incoming tool gets ITS
//   saved value. The table is never reset at print start (only by MMU_TOOL_OVERRIDES or a Klipper
//   restart), so a 150 % left on T2 in one print comes back the next time T2 loads. Hence the
//   per-tool strip and RESET ALL TOOLS (MMU_TOOL_OVERRIDES RESET=1; the handler reads only
//   TOOL / M220 / M221 / RESET, and does nothing while HH is disabled).
//
//   HH'S ROUNDING DOES NOT STICK. _restore_tool_override() sends `M220 S%d`, a floor (Klipper
//   reports M220 S90 as 0.8999999999999999, so %d writes 89), and BLOBIFIER, HH's purge_macro here,
//   restores with `M220 S{(backup_feedrate * 100)|int}`, the same floor. Both run INSIDE the change,
//   and the change ENDS with the MMU_state restore above, which puts the table value back exactly.
//   Simulated for M220 S10..S300: every value survives the round trip. So the strip shows
//   Math.round and no drift is warned about. Two leftovers: a standalone BLOBIFIER outside a
//   toolchange does floor 90 to 89, and HH's own MMU_TOOL_OVERRIDES printout uses int(), so the
//   console can say 89 where the table holds 0.8999999999999999.
//
//   Z IS A ONE-PRINT TRIM. PRINT_START runs APPLY_MATERIAL_Z_OFFSET (an absolute
//   SET_GCODE_OFFSET Z=<_Z_OFFSET_VARS table> MOVE=0, every entry 0.000 today) and PRINT_END runs
//   CLEAR_MATERIAL_Z_OFFSET (Z=0 MOVE=0). A babystep therefore lasts until the print ends. Keeping
//   it is the Z OFFSET screen's job: Z_OFFSET_SAVE_PERMANENT here runs SAVE_CONFIG, which restarts
//   Klipper and would kill the print, so it is not offered. Probing is Cartographer in touch mode
//   (scanner_touch_z_offset 0.25, shown for reference).
//
//   THE FLOOR. MOVE=1 moves the nozzle now, and Klipper allows it down to position_min (-2 mm here).
//   A change that lowers the nozzle is refused when gcode_move.position.z (height above the bed
//   model, offset included) would go below 0, and a typed jump bigger than Z_STEP_LIMIT is refused
//   mid-print. These rules are lib/actions/toolhead.js zNudgePlan / zSetPlan / makeZFlight, the
//   same code the Z OFFSET screen and the dashboard's Z buttons run. They count changes already sent
//   but not yet reported (the status push is ~270 ms behind the ack), so a burst of taps cannot
//   slip past them.
//
// Steps are KlipperScreen fine_tune.py's own sets (speed 1/5/10/25, flow 1/2/5/10,
// Z 0.01/0.025/0.05/0.1), but the default is a middle one, not KlipperScreen's coarsest:
// a first tap of 0.1 mm on a first layer is a crash, not a tune.
//
// CONFIRMS. Each step tap is bounded (<= 25 % speed, <= 10 % flow, <= 0.1 mm Z) and reversible
// with the opposite tap, so it runs at once, exactly as KlipperScreen's does. A confirm on every
// 0.025 mm babystep would make babystepping impossible. The unbounded jumps confirm first: a typed
// Z offset and RESET Z (both move the nozzle by any amount now) and RESET ALL TOOLS (it discards
// eight tools' saved values). A typed speed/flow is sent on the keyboard's OK, as the status bar's
// typed temperatures are. A keypad answer or a confirm is re-checked against the printer as it is
// when the command goes (a ref to the latest render), not as it was when the button was pressed.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono } from "../tokens.js";
import { mmu as mmuVm, badgeStyle, microLabel } from "../vm.js";
import { Chip, PanelBtn, Panel, Bar } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { factorCommand, FACTOR_MIN, FACTOR_MAX } from "../../lib/actions/extruder.js";
import {
  zNudgePlan, zSetPlan, makeZFlight, zOffsetOf, isHomed, isPaused, isPrinting, Z_OFFSET_LIMIT, Z_PENDING_MS } from "../../lib/actions/toolhead.js";
import { fmtSignedMm as signed } from "../../pages/dashboard/adapters/heightmap.js";

/** The two factors. Keys are factorCommand's canonical kinds. */
const FACTORS = {
  speed: {
    title: "SPEED FACTOR", code: "M220", field: "speed_factor", table: "tool_speed_multipliers",
    steps: [1, 5, 10, 25], dflt: 10,
  },
  extrusion: {
    title: "FLOW FACTOR", code: "M221", field: "extrude_factor", table: "tool_extrusion_multipliers",
    steps: [1, 2, 5, 10], dflt: 2,
  },
};
const Z_STEPS = [0.01, 0.025, 0.05, 0.1];
const Z_DFLT = 0.025;
const RESET_ALL = "MMU_TOOL_OVERRIDES RESET=1";

/** Moonraker's confirming status push lags the ack by ~270 ms (see Store.predict). A second
 *  +5 tapped inside that window must build on the first tap, not on the stale value. */
// Same window, same reason as the Z babystep (status push ~270 ms behind the ack): one constant, in toolhead.js.
const PENDING_MS = Z_PENDING_MS;

const fin = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const zLabel = s => String(s).replace(/^0/, "");

/** A big ± button. Disabled ones stay tappable so the tap can say WHY (a tooltip never shows on glass). */
function Nudge({ label, sub, onTap, why, onWhy }) {
  return (
    <Hv as="div" onClick={why ? onWhy : onTap} title={why || undefined}
      active={why ? "" : `background:${C.line1}; transform:translateY(1px)`}
      style={`flex:1; min-width:0; min-height:${TAP.primary}px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; border-radius:${L.radiusSm}px; background:${C.panelHead}; border:1px solid ${why ? C.line3 : C.line5}; color:${why ? C.ghost : C.body}; cursor:pointer; opacity:${why ? 0.42 : 1}; transition:background .14s`}>
      <span style={S(mono(F.num1, "line-height:1"))}>{label}</span>
      {sub ? <span style={S(mono(F.micro, `letter-spacing:.14em; color:${C.mute}`))}>{sub}</span> : null}
    </Hv>
  );
}

/** Wraps a PanelBtn so a disabled one still answers a tap with its reason. */
function WhyTap({ why, onWhy, children, grow }) {
  return <div onClick={why ? onWhy : undefined} style={S(`flex:${grow ? 1 : "none"}; min-width:0; display:flex; flex-direction:column`)}>{children}</div>;
}

/** Inner width of a Value box: a third of the usable row, less the panel border, body padding and its own. */
const VALUE_ROOM = (L.usableW - 2 * L.gap) / 3 - 2 - 24 - 22;
/** JetBrains Mono advances 0.6 em per glyph. The headline shrinks to fit rather than truncate: a clipped
 *  "−0.0…" would be a wrong number, and at the XL type scale F.giant no longer fits "−0.035" beside its unit. */
function fitSize(text, unit) {
  const room = VALUE_ROOM - F.val * 0.6 * unit.length - F.micro * 0.74 * 4 - 16;
  return Math.max(F.num1, Math.min(F.giant, Math.floor(room / (0.6 * Math.max(1, String(text).length)))));
}

/** The tappable headline value; tapping opens the on-screen keypad. */
function Value({ text, unit, color, onTap, why, onWhy }) {
  return (
    <Hv as="div" onClick={why ? onWhy : onTap} active={why ? "" : `background:${C.line1}`}
      style={`flex:none; min-width:0; height:${TAP.primary + 4}px; display:flex; align-items:center; gap:8px; padding:0 10px; border-radius:${L.radiusSm}px; border:1px solid ${C.line2}; background:${C.panelSunk}; cursor:pointer`}>
      <span style={S(mono(fitSize(text, unit), `line-height:1; color:${color}; white-space:nowrap`))}>{text}</span>
      <span style={S(mono(F.val, `flex:none; color:${C.faint}; align-self:flex-end; padding-bottom:8px`))}>{unit}</span>
      <span style={S(`margin-left:auto; flex:none; ${mono(F.micro, `letter-spacing:.14em; color:${why ? C.ghost : C.mute}`)}`)}>TYPE</span>
    </Hv>
  );
}

/** Step chips. Unlabelled, as in KlipperScreen: the chosen chip is the number on the ± buttons below it
 *  (and a "STEP" label does not fit beside four chips at the LARGE / XL type scales). */
function StepRow({ steps, value, onPick, fmt }) {
  return (
    <div style={S("flex:none; display:flex; align-items:center; gap:6px")}>
      {steps.map(v => <Chip key={v} label={fmt(v)} on={value === v} onTap={() => onPick(v)} h={TAP.min} fs={F.label} />)}
    </div>
  );
}

export default function FineTune({ st, go, say, act, askInput }) {
  const [steps, setSteps] = React.useState({ speed: FACTORS.speed.dflt, extrusion: FACTORS.extrusion.dflt, z: Z_DFLT });
  // The value a just-sent M220/M221 should produce, per factor, until the status push shows it. A ref, so a
  // second tap that lands before React re-renders still builds on the first; `bump` re-renders for display.
  const pend = React.useRef({});
  const [, bump] = React.useReducer(x => x + 1, 0);
  // { kind: "z", label, value, cmd, delta } (the plan the user saw) | { kind: "tools" }
  const [confirm, setConfirm] = React.useState(null);
  // What the Z changes sent from here should produce, until the status push lands. Guards only; never displayed.
  const [flight] = React.useState(makeZFlight);
  // The latest render's handlers, for code that runs after an await (see CONFIRMS in the header).
  const latest = React.useRef(null);

  const raw = st.raw || {};
  const gm = raw.gcode_move || {};
  const m = mmuVm(st);
  const mm = raw.mmu || {};
  const paused = isPaused(raw);
  const printing = isPrinting(raw);

  // ---- why nothing may be sent right now (beyond act.blocked's connection/catalogue checks)
  const lock = paused
    ? "paused — RESUME restores speed, flow and Z offset from the pause snapshot, undoing this"
    : m.present && m.busy
      ? `Happy Hare is ${String(m.action).toLowerCase()} — Klipper holds this until it finishes, and it would land after the change; wait for Idle`
      : null;
  const whyFor = (script, guards = {}) => act.blocked(guards, script) || lock;
  const tell = (what, why) => () => act.refuse(what, why);

  // ---- factors: live, and the value a just-sent command is expected to produce
  const liveRaw = k => fin(gm[FACTORS[k].field]);
  const livePct = k => (liveRaw(k) === null ? null : Math.round(liveRaw(k) * 100));
  /** What the factor is, or is about to be: the pending value until the push shows it (or PENDING_MS passes). */
  const eff = k => {
    const p = pend.current[k];
    return p && livePct(k) !== p.pct && Date.now() - p.at < PENDING_MS ? p.pct : livePct(k);
  };
  const setPend = (k, p) => { pend.current = Object.assign({}, pend.current, { [k]: p }); bump(); };

  const sendFactor = (k, pct) => {
    const f = FACTORS[k];
    const why = whyFor(f.code);
    if (why) return act.refuse(f.code, why);
    const c = factorCommand(k, pct);
    if (c.error) return act.refuse(f.code, c.error);
    if (c.clamped) say(`${f.code} clamped to ${FACTOR_MIN}–${FACTOR_MAX} %`);
    const mine = { pct: c.value, at: Date.now() };
    setPend(k, mine);
    return act.guarded(c.cmd, {}).then(r => {
      if (!r.ok && pend.current[k] === mine) setPend(k, null);
      return r;
    });
  };
  /** One ± tap, from the value as it is at the tap (a ref read), not as the last render saw it. */
  const stepFactor = (k, d) => {
    const v = eff(k);
    if (v === null) return act.refuse(FACTORS[k].code, "gcode_move has not reported this factor yet");
    return sendFactor(k, v + d);
  };

  /** A typed factor, checked against the latest render (the keypad may have been open through a toolchange). */
  const commitFactor = (k, v) => {
    const f = FACTORS[k];
    const c = factorCommand(k, v);
    if (c.error) return act.refuse(f.code, c.error);
    if (c.value === eff(k)) { say(`${f.code} already ${c.value} %`); return null; }
    return sendFactor(k, c.value);
  };

  const typeFactor = async k => {
    const f = FACTORS[k];
    const v = await askInput({
      mode: "numeric", label: f.title, value: eff(k) ?? 100, unit: "%",
      min: FACTOR_MIN, max: FACTOR_MAX, allowNegative: false, hint: `${FACTOR_MIN}–${FACTOR_MAX} · 100 = as sliced`,
    });
    if (v === null) return;
    latest.current.commitFactor(k, v);
  };

  // ---- Z
  const zOff = zOffsetOf(raw);
  const zHomed = isHomed(raw, "Z");
  const zWhy = whyFor("SET_GCODE_OFFSET") || (zOff === null ? "gcode_move has not reported a Z offset yet" : null);

  const zSend = p => {
    const settle = flight.begin(p);
    return act.guarded(p.cmd, {}).then(r => { settle(r); return r; });
  };

  // zNudgePlan / zSetPlan apply the ±limit, THE FLOOR and the mid-print jump rule (header), counting what is in flight.
  const nudgeZ = d => {
    if (zWhy) return act.refuse("SET_GCODE_OFFSET", zWhy);
    const p = zNudgePlan(raw, d, { pending: flight.pending() });   // drops MOVE=1 when Z is not homed
    if (p.error) return act.refuse("SET_GCODE_OFFSET", p.error);
    return zSend(p);
  };

  /** An absolute offset, checked against the state of THIS render. { cmd, value, from, delta, move, to } | { error } */
  const planZ = value => (zWhy ? { error: zWhy } : zSetPlan(raw, value, { pending: flight.pending() }));

  const askZ = (label, value) => {
    const p = planZ(value);
    if (p.error) return act.refuse("SET_GCODE_OFFSET", p.error);
    setConfirm({ kind: "z", label, value: p.value, cmd: p.cmd, delta: p.delta, confirm:
      `Set the live Z offset to ${signed(p.value)} mm (now ${signed(p.from)}). ` + (p.move
        ? `The nozzle moves ${Math.abs(p.delta).toFixed(3)} mm ${p.delta > 0 ? "UP (away from the bed)" : "DOWN (toward the bed)"} immediately`
          + (p.to !== null ? `, to ${p.to.toFixed(3)} mm above the bed.` : ".")
        : "Z is not homed, so it takes effect on the next Z move.")
      + (printing ? " It replaces the whole offset, including any material trim PRINT_START applied." : "") });
    return null;
  };

  const typeZ = async () => {
    const v = await askInput({
      mode: "numeric", label: "Z OFFSET", value: zOff === null ? "0" : zOff.toFixed(3), unit: "mm",
      min: -Z_OFFSET_LIMIT, max: Z_OFFSET_LIMIT, allowNegative: true, hint: "absolute · + raises the nozzle",
    });
    if (v === null) return;
    latest.current.askZ("SET Z OFFSET", Number(v));   // re-checked against the state now, not when the keypad opened
  };

  // ---- Happy Hare's per-tool table
  const loadedTool = m.present && m.filament === "Loaded" && Number.isInteger(m.tool) && m.tool >= 0 ? m.tool : null;
  const selTool = m.present && Number.isInteger(m.tool) && m.tool >= 0 ? m.tool : null;
  const tableOf = k => (Array.isArray(mm[FACTORS[k].table]) ? mm[FACTORS[k].table] : null);
  /** What each tool comes back with. The loaded tool's entry is only recorded at its next unload, so it shows the live value. */
  const toolPcts = k => {
    const t = tableOf(k);
    return t ? t.map((v, i) => (i === loadedTool && eff(k) !== null ? eff(k) : fin(v) === null ? null : Math.round(v * 100))) : null;
  };
  // RESET=1 sets every entry to 100/100 AND re-applies M220/M221 S100 for the SELECTED tool (loaded or not).
  const allDefault = ["speed", "extrusion"].every(k =>
    (toolPcts(k) || []).every(v => v === 100) && (selTool === null || eff(k) === null || eff(k) === 100));
  const resetAllWhy = act.blocked({ needsMmu: true }, RESET_ALL)
    || (paused ? "paused — RESUME puts the selected tool's speed and flow back from the pause snapshot" : lock)
    || (mm.enabled === false ? "Happy Hare is disabled (MMU ENABLE=1 first)" : null)
    || (!tableOf("speed") || !tableOf("extrusion") ? "Happy Hare does not report its per-tool table" : null)
    || (allDefault ? "every tool is already 100 / 100 in Happy Hare's table" : null);

  const onYes = () => {
    const c = confirm; setConfirm(null);
    if (!c) return;
    if (c.kind === "z") {
      const q = planZ(c.value);
      if (q.error) { act.refuse("SET_GCODE_OFFSET", q.error); return; }
      // What was confirmed must be what goes: the same command, the same move.
      if (q.cmd !== c.cmd || q.delta !== c.delta) {
        act.refuse("SET_GCODE_OFFSET", `the printer changed while the confirm was open (offset now ${signed(q.from)} mm) — check it again`);
        return;
      }
      zSend(q);
      return;
    }
    if (resetAllWhy) { act.refuse("MMU_TOOL_OVERRIDES", resetAllWhy); return; }
    act.guarded(RESET_ALL, { needsMmu: true });
  };

  latest.current = { commitFactor, askZ };

  // ---- one factor panel
  const factorPanel = k => {
    const f = FACTORS[k];
    const v = eff(k);
    const why = whyFor(f.code) || (v === null ? "gcode_move has not reported this factor yet" : null);
    const step = steps[k];
    const table = toolPcts(k);
    const downWhy = why || (v <= FACTOR_MIN ? `already at the ${FACTOR_MIN} % floor` : null);
    const upWhy = why || (v >= FACTOR_MAX ? `already at the ${FACTOR_MAX} % ceiling` : null);
    const resetWhy = why || (v === 100 ? "already 100 %" : null);
    return (
      <Panel key={k} title={f.title} style="min-height:0"
        right={<span style={S(badgeStyle(v === null ? "off" : v === 100 ? "ok" : "warn"))}>{f.code}</span>}
        bodyStyle="padding:12px; gap:8px">
        <Value text={v === null ? "—" : String(v)} unit="%" color={v === null ? C.mute : v === 100 ? C.text : C.hot}
          onTap={() => typeFactor(k)} why={why} onWhy={tell(f.code, why)} />
        <Bar pct={v === null ? 0 : v / 2} color={v === 100 ? C.cool : C.hot} h={6} />
        <span style={S(mono(F.micro, `letter-spacing:.08em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
          100 % = AS SLICED
        </span>
        <StepRow steps={f.steps} value={step} fmt={s => `${s}`} onPick={s => setSteps(p => Object.assign({}, p, { [k]: s }))} />
        <div style={S("flex:1; min-height:0; display:flex; gap:8px")}>
          <Nudge label={`−${step}`} sub="%" why={downWhy} onWhy={tell(f.code, downWhy)} onTap={() => stepFactor(k, -step)} />
          <Nudge label={`+${step}`} sub="%" why={upWhy} onWhy={tell(f.code, upWhy)} onTap={() => stepFactor(k, step)} />
        </div>
        {table ? (
          <div style={S("flex:none; display:flex; flex-direction:column; gap:4px")}>
            <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
              {loadedTool !== null ? `PER TOOL · APPLIES TO T${loadedTool}` : "PER TOOL · NOTHING LOADED"}
            </span>
            <div style={S("display:flex; gap:3px")}>
              {table.map((shown, i) => {
                const on = i === loadedTool;
                return (
                  <div key={i} style={S(`flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:1px; padding:3px 0; border-radius:${L.radiusXs}px; border:1px solid ${on ? C.accentLine : C.line2}; background:${on ? C.accentBg : C.panelSunk}`)}>
                    <span style={S(mono(F.micro, `color:${on ? C.accent : C.ghost}`))}>T{i}</span>
                    <span style={S(mono(F.micro, `color:${shown === 100 ? C.dim : C.bed}`))}>{shown === null ? "—" : shown}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <WhyTap why={resetWhy} onWhy={tell(f.code, resetWhy)}>
          <PanelBtn label="RESET 100 %" sub={`${f.code} S100`} h={TAP.min} disabled={!!resetWhy} why={resetWhy}
            onTap={() => sendFactor(k, 100)} />
        </WhyTap>
      </Panel>
    );
  };

  // ---- Z panel
  const zStep = steps.z;
  const probe = ((st.config || {}).scanner || {});
  const probeZ = fin(probe.scanner_touch_z_offset);
  const zResetWhy = zWhy || (zOff !== null && Math.abs(zOff) < 0.0005 ? "already 0.000 mm" : null);
  const savePending = !!(raw.configfile || {}).save_config_pending;

  const zPanel = (
    <Panel title="Z BABYSTEP" style="min-height:0"
      right={<span style={S(badgeStyle(zOff === null ? "off" : zHomed ? "ok" : "warn"))}>{zHomed ? "MOVE=1" : "UNHOMED"}</span>}
      bodyStyle="padding:12px; gap:8px">
      <Value text={zOff === null ? "—" : signed(zOff)} unit="mm" color={zOff === null ? C.mute : Math.abs(zOff) < 0.0005 ? C.text : C.cool}
        onTap={typeZ} why={zWhy} onWhy={tell("SET_GCODE_OFFSET", zWhy)} />
      <span style={S(mono(F.micro, `letter-spacing:.08em; color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
        {zHomed ? "EACH TAP MOVES THE NOZZLE" : "APPLIES ON THE NEXT Z MOVE"}
      </span>
      <StepRow steps={Z_STEPS} value={zStep} fmt={zLabel} onPick={s => setSteps(p => Object.assign({}, p, { z: s }))} />
      <div style={S("flex:1; min-height:0; display:flex; gap:8px")}>
        <Nudge label={`−${zLabel(zStep)}`} sub="LOWER · CLOSER" why={zWhy} onWhy={tell("SET_GCODE_OFFSET", zWhy)} onTap={() => nudgeZ(-zStep)} />
        <Nudge label={`+${zLabel(zStep)}`} sub="RAISE · FURTHER" why={zWhy} onWhy={tell("SET_GCODE_OFFSET", zWhy)} onTap={() => nudgeZ(zStep)} />
      </div>
      <div style={S(`flex:none; display:flex; flex-direction:column; gap:5px; padding:8px 10px; border-radius:${L.radiusSm}px; border:1px solid ${C.line2}; background:${C.panelSunk}`)}>
        <div style={S("display:flex; align-items:center; gap:8px; white-space:nowrap")}>
          <span style={S(microLabel(C.faint))}>SAVED PROBE</span>
          <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.body}`)}`)}>{probeZ === null ? "—" : `${probeZ.toFixed(3)} mm`}</span>
        </div>
        {/* configfile.settings is the config Klipper loaded; anything SAVE_CONFIG has staged is not in it yet. */}
        <span style={S(mono(F.micro, `letter-spacing:.06em; color:${savePending ? C.bed : C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
          {savePending ? "SAVE_CONFIG PENDING" : "BABYSTEP ENDS AT PRINT_END"}
        </span>
      </div>
      <div style={S("flex:none; display:flex; gap:8px")}>
        <WhyTap grow why={zResetWhy} onWhy={tell("SET_GCODE_OFFSET", zResetWhy)}>
          <PanelBtn label="RESET Z" sub="Z=0.000" h={TAP.min} disabled={!!zResetWhy} why={zResetWhy}
            onTap={() => askZ("RESET Z OFFSET", 0)} />
        </WhyTap>
        <div style={S("flex:1; min-width:0; display:flex; flex-direction:column")}>
          <PanelBtn label="Z OFFSET ›" sub="SAVE · LEARN" h={TAP.min} onTap={() => go("zoffset")} />
        </div>
      </div>
    </Panel>
  );

  // ---- bottom banner: the state that decides what the controls above will actually do
  const conn = act.blocked({});
  const banner = conn ? { kind: "err", tag: "OFFLINE", text: `Nothing can be sent: ${conn}.` }
    : paused ? { kind: "warn", tag: "PAUSED · LOCKED", text: "RESUME restores speed, flow and Z offset from the pause snapshot, so a change made now would be undone. Tune after resuming." }
    : m.present && m.busy ? { kind: "warn", tag: `HH ${String(m.action).toUpperCase()}`, text: "Klipper holds anything sent now until this change ends, and the change re-applies the incoming tool's own factors. Wait for Idle." }
    : printing ? { kind: "ok", tag: "PRINTING · LIVE", text: m.present
        ? "Changes apply now. Happy Hare keeps speed and flow per tool and swaps them at each toolchange. The Z babystep lasts until PRINT_END."
        : "Changes apply now. The Z babystep lasts until PRINT_END clears it." }
    : { kind: "off", tag: "NOT PRINTING", text: m.present
        ? "These apply now. Happy Hare records speed and flow for the loaded tool at unload; PRINT_START re-applies the material Z trim."
        : "These apply now. No macro here resets speed or flow, so they carry into the next print; PRINT_START re-applies the Z trim." };

  // The confirm, as the user will see it. RESET ALL TOOLS is described from the state of this render.
  const confirmView = !confirm ? null : confirm.kind === "z" ? confirm : {
    label: "RESET ALL TOOLS", cmd: RESET_ALL,
    confirm: `Set speed and flow back to 100 % for all ${m.n} tools in Happy Hare's per-tool table`
      + (selTool !== null ? `, and apply 100 % now for the selected tool T${selTool}` : "")
      + ". The values it saved per tool are discarded.",
  };

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>
      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:${L.gap}px`)}>
        {factorPanel("speed")}
        {factorPanel("extrusion")}
        {zPanel}
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px minmax(0,1fr)${m.present ? " 230px" : ""}; gap:${L.gap}px; height:${TAP.primary}px`)}>
        <span />
        <div style={S(`min-width:0; display:flex; align-items:center; gap:12px; padding:0 14px; border-radius:${L.radius}px; border:1px solid ${C.line2}; background:${C.panel}`)}>
          <span style={S(`${badgeStyle(banner.kind)}; flex:none`)}>{banner.tag}</span>
          <span style={S(`font-size:${F.label}px; line-height:1.35; color:${C.dim}; text-wrap:pretty; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical`)}>
            {banner.text}
          </span>
        </div>
        {m.present ? (
          <WhyTap why={resetAllWhy} onWhy={tell("MMU_TOOL_OVERRIDES", resetAllWhy)}>
            <PanelBtn label="RESET ALL TOOLS" sub={`100 / 100 · T0–T${Math.max(0, m.n - 1)}`} h={TAP.primary} disabled={!!resetAllWhy} why={resetAllWhy}
              onTap={() => setConfirm({ kind: "tools" })} />
          </WhyTap>
        ) : null}
      </div>

      {confirmView ? <ConfirmBox a={confirmView} onNo={() => setConfirm(null)} onYes={onYes} /> : null}
    </div>
  );
}
