// ---------------------------------------------------------------------------
// LIMITS — the live toolhead limits against printer.cfg, with keypad entry and
// reset-to-config. KlipperScreen's limits panel, minus the sliders.
//
// Nothing here is new logic. The rows, their units and formatting are the
// dashboard adapter's LIMIT_ROWS (pages/dashboard/adapters/limits.js); the gcode
// is lib/actions/limits.js limitCommand(), which sends ONE parameter per line —
// never a combined SET_VELOCITY_LIMIT (that contract is the lib's). The adapter's
// Z OFFSET row is dropped here: Z offset has its own screen.
//
// Verified on this printer (read-only, 2026-09-23):
//   toolhead            max_velocity 1000, max_accel 7000, square_corner_velocity 12,
//                       minimum_cruise_ratio 0.5 — identical to configfile.settings.printer.
//   printer.cfg         sets max_velocity 1000, max_accel 7000, square_corner_velocity 12.0.
//                       minimum_cruise_ratio is NOT in it (configfile.config has no such key);
//                       the 0.5 that settings reports is Klipper's default. The row still reads
//                       "PRINTER.CFG" because settings is what a Klipper restart restores.
//   Klipper             v0.13.0-745-gf0892d82-dirty. Its toolhead status carries `extra_axes`,
//                       added upstream 2025-11-06, so it is past 2025-08-11, when ACCEL_TO_DECEL
//                       was removed from SET_VELOCITY_LIMIT (docs/Config_Changes.md). Upstream
//                       cmd_SET_VELOCITY_LIMIT reads VELOCITY (>0), ACCEL (>0), SQUARE_CORNER_VELOCITY
//                       (>=0) and MINIMUM_CRUISE_RATIO ([0,1)), and since 2021-04-30 may go ABOVE the
//                       configured values. That is why raising one past printer.cfg asks first.
//   The slicer          All four OrcaSlicer 2.4.2 files checked re-send limits at every feature
//                       change: `SET_VELOCITY_LIMIT ACCEL=n ACCEL_TO_DECEL=n [SQUARE_CORNER_VELOCITY=n]`,
//                       608 lines in a 59 min job, 80,428 in an 8 h 53 m one. None of them sends
//                       VELOCITY=, and this Klipper ignores ACCEL_TO_DECEL. So mid-print, ACCEL and SCV
//                       hold only until the next feature, while VELOCITY and the cruise ratio stay.
//                       The screen says this instead of letting a change quietly vanish.
//   Happy Hare v3.4.2   _save_toolhead_position_and_park() stores max_accel and minimum_cruise_ratio, sets
//                       macro_toolhead_max_accel (7000 here) + macro_toolhead_min_cruise_ratio (0.6
//                       here) for the operation, and _restore_toolhead_position() puts the stored values
//                       back afterwards. It runs for toolchange, load, unload, runout, complete, cancel —
//                       and PAUSE: HH wraps PAUSE (cmd_PAUSE → _save_…("pause")), so for the whole of a
//                       paused print the live ACCEL/CRUISE are HH's, and RESUME restores the pre-pause
//                       ones. The signal is mmu.operation (= saved_toolhead_operation, "" when nothing is
//                       held; verified "" live at idle). mmu.action alone misses the pause case.
//                       mmu/addons/blobifier.cfg does the same around its brush and shake moves.
//                       So a change made while either is running can be undone when it finishes.
//   Keypad timing       The slicer changes ACCEL/SCV every few seconds mid-print (608 lines / 60 min), so a
//                       value typed on the keypad is compared against the limits as they are when OK is
//                       tapped (derive() on the latest store state), never the render the keypad opened in.
//
// Allowed while printing (runtime only, nothing is persisted). Guards are therefore {}:
// act.guarded still refuses when Moonraker/Klipper are down or the command is missing.
// Nothing is sent on mount. Every command comes from a tap:
//   SET → keypad → one line;  RESET → one line;  RESET ALL → confirm → one line per changed limit.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { limitCommand, LIMIT_DEFS } from "../../lib/actions/limits.js";
import { LIMIT_ROWS } from "../../pages/dashboard/adapters/limits.js";

/** The four SET_VELOCITY_LIMIT rows, in the adapter's order. */
const KEYS = ["velocity", "accel", "scv", "cruise"];
const ROWS = LIMIT_ROWS.filter(r => KEYS.includes(r.key));

/** One line of plain meaning per limit. The wording follows Klipper's [printer] reference. */
const MEANING = {
  velocity: "top toolhead speed",
  accel: "toolhead acceleration",
  scv: "max speed through a 90° corner",
  cruise: "share of a move kept at cruise",
};

/** Re-sent by this printer's slicer output at every feature change (see header). */
const SLICER_SETS = new Set(["accel", "scv"]);
/** Saved and restored by Happy Hare / Blobifier around their own moves (see header). */
const HH_HOLDS = new Set(["accel", "cruise"]);
/** Going past printer.cfg on these makes the machine more aggressive than it was tuned for.
 *  A higher cruise ratio only slows short moves, so that one never asks. */
const RAISE_ASKS = new Set(["velocity", "accel", "scv"]);

const CMD = "SET_VELOCITY_LIMIT";

function Note({ title, hot, children }) {
  return (
    <div style={S(`flex:none; display:flex; flex-direction:column; gap:6px; padding:10px 11px; border-radius:7px; ${hot
      ? `background:${C.warnBg}; border:1px solid ${C.warnLine};`
      : `background:${C.panelSunk}; border:1px solid ${C.line3};`}`)}>
      <span style={S(microLabel(hot ? C.bed : C.faint))}>{title}</span>
      <span style={S(`font-size:${F.label}px; line-height:1.45; color:${hot ? C.body : C.dim}; text-wrap:pretty`)}>{children}</span>
    </div>
  );
}

/** Badge for a row: how the live value stands against printer.cfg. */
function standing(r, live, cfgRead) {
  if (r.cur == null) return ["off", "NO DATA"];
  if (!live) return ["off", "LAST KNOWN"];
  // Settings read but this key absent (an older Klipper without minimum_cruise_ratio) is not "unread".
  if (r.cfg == null) return ["off", cfgRead ? "NO CFG VALUE" : "CFG UNREAD"];
  if (r.same) return ["ok", "AT CONFIG"];
  const above = r.cur > r.cfg;
  const pct = r.cfg > 0 ? Math.round(r.cur / r.cfg * 100) : null;
  // The cruise ratio is already a percentage, so "60% OF CONFIG" would read as a value. Say the direction.
  // Four digits ("1429% OF CONFIG") no longer fits the 150px config column, so that says the direction too.
  if (r.key === "cruise" || pct === null || pct === 100 || pct >= 1000) return ["warn", above ? "ABOVE CONFIG" : "BELOW CONFIG"];
  return [above ? "err" : "warn", `${pct}% OF CONFIG`];
}

/**
 * Everything the screen reads from the store, as a pure function of it. Render uses it, and so does a
 * handler that has just awaited the keypad — against the LATEST state, not the render it started in.
 */
function derive(st) {
  const raw = st.raw || {};
  const th = raw.toolhead || null;
  const gm = raw.gcode_move || {};
  const cfgP = (st.config || {}).printer || null;
  const ps = raw.print_stats || {};
  const paused = ps.state === "paused" || !!(raw.pause_resume || {}).is_paused;
  const inJob = ps.state === "printing" || paused;
  const mmu = raw.mmu || null;
  // mmu.operation is HH's saved_toolhead_operation: non-empty exactly while it holds saved ACCEL/CRUISE it
  // will put back (see header). mmu.action is kept as a hedge for a busy HH that has not saved (unhomed).
  const hhOp = mmu && mmu.operation ? String(mmu.operation) : "";
  const hhAction = mmu ? String(mmu.action || "Idle") : "Idle";
  const hhHolds = !!mmu && (hhOp !== "" || hhAction !== "Idle");
  const rows = ROWS.map(r => {
    const def = LIMIT_DEFS[r.key];
    // Klipper's [printer] settings use the same field names as the toolhead status, so the
    // adapter's reader works on both — including the ratio -> percent conversion.
    const cur = th ? r.read(th, gm) : null;
    const cfg = cfgP ? r.read(cfgP, gm) : null;
    const same = cur != null && cfg != null && r.fmt(cur) === r.fmt(cfg);
    const reset = cfg != null ? limitCommand(r.key, cfg) : null;
    const resetBad = !reset || !!reset.error || cfg < def.min || cfg > def.max;
    return Object.assign({}, r, { def, cur, cfg, same, reset, resetBad, label: r.k.toUpperCase() });
  });
  return { th, cfgP, inJob, paused, mmu, hhOp, hhAction, hhHolds, rows };
}

/** What a row, or the toast after a send, says while Happy Hare holds a saved copy of ACCEL / CRUISE. */
const hhRowNote = d => d.hhOp === "pause" ? "HH PUTS THIS BACK ON RESUME"
  : d.hhOp ? `HH PUTS THIS BACK AFTER ${d.hhOp.toUpperCase()}` : "HAPPY HARE BUSY · MAY RESTORE THIS";
const hhWhen = d => d.hhOp === "pause" ? "on resume" : d.hhOp ? `after its ${d.hhOp}` : "when it finishes";

export default function Limits({ st, act, askInput, say }) {
  const [confirm, setConfirm] = React.useState(null);
  // The latest store state, for handlers that resume after the keypad; and whether the screen is still up.
  const stRef = React.useRef(st);
  stRef.current = st;
  const mounted = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const d = derive(st);
  const { th, cfgP, inJob, paused, mmu, hhOp, hhAction, hhHolds, rows } = d;
  const hhCfg = (st.config || {}).mmu || {};

  const why = act.blocked({}, CMD);
  // With Klipper down the toolhead numbers are the last ones it reported, not live ones. Grey them.
  const live = !!st.connected && st.klippy === "ready";
  const inflight = (st.busy || []).includes(CMD);

  const changed = rows.filter(r => r.cur != null && r.cfg != null && !r.same && !r.resetBad);

  /** Send, then say so if Happy Hare or the slicer is going to put the value straight back. */
  const send = (script, keys) =>
    act.guarded(script, {}).then(res => {
      if (!res || !res.ok) return;
      const now = derive(stRef.current);
      if (now.hhHolds && keys.some(k => HH_HOLDS.has(k))) say(`sent — Happy Hare puts ACCEL / CRUISE back ${hhWhen(now)}`);
      else if (now.inJob && keys.some(k => SLICER_SETS.has(k))) say("sent — the slicer re-sends ACCEL / SCV at its next feature");
    });

  const setLimit = async r0 => {
    if (why) { act.refuse(r0.label, why); return; }
    const v = await askInput({
      mode: "numeric", label: r0.label, value: r0.cur != null ? r0.fmt(r0.cur) : "", unit: r0.u,
      min: r0.def.min, max: r0.def.max, allowNegative: false,
      hint: r0.cfg != null ? `CONFIG ${r0.fmt(r0.cfg)} · ${r0.def.min}–${r0.def.max}` : `${r0.def.min}–${r0.def.max}`,
    });
    if (v === null) return;
    // The raise confirm below needs this screen; a value the user can no longer see answered for is not sent.
    if (!mounted.current) { act.refuse(r0.label, "the LIMITS screen closed before OK"); return; }
    // The keypad may have been open for a while, and mid-print the slicer changes ACCEL / SCV every few
    // seconds. Judge "unchanged" and "above config" against the limit as it is now.
    const r = derive(stRef.current).rows.find(x => x.key === r0.key) || r0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < r.def.min || n > r.def.max) {
      act.refuse(r.label, `outside ${r.def.min}–${r.def.max} ${r.def.unit}`);
      return;
    }
    const c = limitCommand(r.key, n);
    if (c.error) { act.refuse(r.label, c.error); return; }
    // Same no-op rule as the dashboard adapter: an unchanged value sends nothing.
    if (r.cur != null && r.fmt(c.value) === r.fmt(r.cur)) { say(`${r.label} unchanged`); return; }
    const ceiling = r.cfg != null ? r.cfg : r.cur;
    if (RAISE_ASKS.has(r.key) && ceiling != null && c.value > ceiling && r.fmt(c.value) !== r.fmt(ceiling)) {
      setConfirm({
        label: `RAISE ${r.label}`, cmd: c.cmd, script: c.cmd, keys: [r.key],
        confirm: r.cfg != null
          ? `Set ${r.label} to ${r.fmt(c.value)} ${r.u}, above printer.cfg's ${r.fmt(r.cfg)}? Klipper allows it and does not cap it at the config value. It holds until a restart or the next change.`
          : `Set ${r.label} to ${r.fmt(c.value)} ${r.u}, above the current ${r.fmt(r.cur)}? printer.cfg has not been read yet, so the configured limit is unknown.`,
      });
      return;
    }
    send(c.cmd, [r.key]);
  };

  const resetOne = r => {
    if (why) { act.refuse(r.label, why); return; }
    if (r.resetBad) { act.refuse(r.label, "no usable printer.cfg value"); return; }
    send(r.reset.cmd, [r.key]);
  };

  const resetAll = () => setConfirm({
    label: "RESET ALL LIMITS",
    confirm: `Put ${changed.length === 1 ? "this limit" : `these ${changed.length} limits`} back to printer.cfg: ${changed.map(r => `${r.label} ${r.fmt(r.cfg)} ${r.u}`).join(", ")}?`
      + (hhHolds && changed.some(r => HH_HOLDS.has(r.key)) ? ` Happy Hare puts ACCEL / CRUISE back ${hhWhen(d)}.` : ""),
    // One line per limit, as the action lib requires. The dialog shows them joined.
    cmd: changed.map(r => r.reset.cmd).join("  ·  "),
    script: changed.map(r => r.reset.cmd).join("\n"),
    keys: changed.map(r => r.key),
  });

  const allWhy = why || (!cfgP ? "printer.cfg not read yet" : inflight ? "sending…" : !changed.length ? "all at printer.cfg" : null);
  const [sumKind, sumText] = !th ? ["off", "NO DATA"] : !live ? ["off", "NOT LIVE"] : !cfgP ? ["off", "CFG UNREAD"]
    : changed.length ? ["warn", `${changed.length} CHANGED`] : ["ok", "ALL AT CONFIG"];

  const hhAccel = Number.isFinite(hhCfg.macro_toolhead_max_accel) ? Math.round(hhCfg.macro_toolhead_max_accel) : null;
  const hhCruise = Number.isFinite(hhCfg.macro_toolhead_min_cruise_ratio) ? Math.round(hhCfg.macro_toolhead_min_cruise_ratio * 100) : null;

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      {/* The rows stop above the nav FAB, which sits in this column's bottom-left corner. */}
      <div style={S(`display:flex; flex-direction:column; gap:8px; min-height:0; padding-bottom:${L.fab + L.fabInset - L.pad}px`)}>
        {!th ? (
          <div style={S(panel("flex:1; min-height:0"))}>
            <Empty title="NO TOOLHEAD DATA"
              hint={`${!st.connected ? "Moonraker is not connected" : `Klipper is ${st.klippy || "unknown"}`}. The live limits appear once the toolhead object reports; nothing is guessed until then.`} />
          </div>
        ) : rows.map(r => {
          const [kind, text] = standing(r, live, !!cfgP);
          const setWhy = why || (r.cur == null ? "the toolhead does not report this limit" : inflight ? "sending…" : null);
          const resetWhy = why || (r.cfg == null ? (cfgP ? "printer.cfg has no value for this" : "printer.cfg not read yet")
            : r.resetBad ? "printer.cfg value is out of range"
            : r.same ? "already at printer.cfg" : inflight ? "sending…" : null);
          const note = hhHolds && HH_HOLDS.has(r.key) ? [hhRowNote(d), C.bed]
            : inJob && SLICER_SETS.has(r.key) ? ["SLICER RE-SENDS THIS EACH FEATURE", C.bed]
            : [MEANING[r.key], C.faint];
          return (
            <div key={r.key} style={S(panel("flex:1; min-height:0; flex-direction:row; align-items:center; gap:12px; padding:0 14px"))}>
              <div onClick={setWhy ? undefined : () => setLimit(r)}
                style={S(`flex:1; min-width:0; align-self:stretch; display:flex; flex-direction:column; justify-content:center; gap:5px; cursor:${setWhy ? "default" : "pointer"}`)}>
                <span style={S(microLabel(C.dim))}>{r.label}</span>
                <div style={S("display:flex; align-items:baseline; gap:8px; min-width:0")}>
                  <span style={S(mono(F.hero, `line-height:1; color:${r.cur == null || !live ? C.mute : r.same || r.cfg == null ? C.text : C.bed}; white-space:nowrap`))}>
                    {r.cur == null ? "—" : r.fmt(r.cur)}
                  </span>
                  <span style={S(mono(F.val, `color:${C.faint}`))}>{r.u}</span>
                </div>
                <span style={S(mono(F.micro, `letter-spacing:.06em; color:${note[1]}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{note[0]}</span>
              </div>

              <div style={S("flex:none; width:150px; display:flex; flex-direction:column; align-items:flex-start; gap:6px")}>
                <span style={S(microLabel(C.faint))}>PRINTER.CFG</span>
                <span style={S(mono(F.num2, `color:${r.cfg == null ? C.mute : C.body}; white-space:nowrap`))}>
                  {r.cfg == null ? "—" : r.fmt(r.cfg)} <span style={S(mono(F.micro, `color:${C.faint}`))}>{r.u}</span>
                </span>
                <span style={S(badgeStyle(kind))}>{text}</span>
              </div>

              <div style={S("flex:none; width:96px")}>
                <PanelBtn label="SET" sub={why ? "BLOCKED" : setWhy ? (r.cur == null ? "NO DATA" : "WAIT") : "KEYPAD"} h={TAP.primary}
                  disabled={!!setWhy} why={setWhy} onTap={() => setLimit(r)} />
              </div>
              <div style={S("flex:none; width:96px")}>
                <PanelBtn label="RESET" h={TAP.primary}
                  sub={r.same ? "AT CONFIG" : r.cfg == null ? "NO CFG" : `→ ${r.fmt(r.cfg)}`}
                  disabled={!!resetWhy} why={resetWhy} onTap={() => resetOne(r)} />
              </div>
            </div>
          );
        })}
      </div>

      <Panel title="RUNTIME ONLY" right={<span style={S(badgeStyle(sumKind))}>{sumText}</span>} bodyStyle="padding:12px; gap:10px">
        {why ? (
          <div style={S(`flex:none; padding:10px 11px; border-radius:7px; background:${C.accentBg2}; border:1px solid ${C.accentLine}; ${mono(F.label, `letter-spacing:.08em; color:${C.accent}`)}`)}>
            CANNOT SEND · {why.toUpperCase()}
          </div>
        ) : null}
        <div style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:10px")}>
          <Note title="NOT SAVED">
            Live toolhead only. printer.cfg is untouched: a Klipper restart restores it, and
            SAVE_CONFIG does not keep these.
          </Note>
          <Note title={!inJob ? "DURING A PRINT" : paused ? "PRINT PAUSED" : "PRINTING NOW"} hot={inJob}>
            OrcaSlicer files here re-send ACCEL and SQUARE CORNER VELOCITY at every feature change,
            so those two last until the next one. VELOCITY and CRUISE RATIO hold.
          </Note>
          {mmu ? (
            <Note title={hhHolds ? `HAPPY HARE · ${(hhOp || hhAction).toUpperCase()}` : "HAPPY HARE"} hot={hhHolds}>
              {hhAccel != null && hhCruise != null
                ? `Toolchanges and pauses run at ACCEL ${hhAccel} · CRUISE ${hhCruise}%`
                : "Toolchanges and pauses run at Happy Hare's own ACCEL and CRUISE"}, then put back what they found.
              Blobifier does the same.
            </Note>
          ) : null}
        </div>
        <PanelBtn label="RESET ALL" sub={allWhy ? allWhy.toUpperCase() : "TO PRINTER.CFG"} tone="accent" h={TAP.primary}
          disabled={!!allWhy} why={allWhy} onTap={resetAll} />
      </Panel>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); send(c.script, c.keys); }} />
      ) : null}
    </div>
  );
}
