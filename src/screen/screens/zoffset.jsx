// ---------------------------------------------------------------------------
// Z OFFSET — live babystepping, and the ways this printer can keep a babystep.
//
// What the printer actually has (read from it, 2026-09-23):
//
//   PROBE. [scanner] is a Cartographer (settings.scanner.sensor "cartographer", fw "CARTOGRAPHER 5.0.0") in
//   `mode: touch`, model "default". stepper_z homes on probe:z_virtual_endstop. The number Z_OFFSET_APPLY_PROBE
//   changes is scanner_touch_z_offset: printer.cfg's SAVE_CONFIG block already carries `[scanner]
//   scanner_touch_z_offset = 0.250`, i.e. a past SAVE_CONFIG wrote it under section "scanner". Klipper's own
//   docs on the printer say the command "subtract[s] the current Z Gcode offset from the probe's z_offset" and
//   "requires a SAVE_CONFIG to take effect". This screen never predicts the new number: it shows what Klipper
//   really staged (configfile.save_config_pending_items) once Klipper has staged it.
//   NB the field is save_config_pending_items. `pending_items` does not exist and reads back null. In it a
//   written section maps to {option: "string"} and a REMOVED section maps to null (configfile.remove_section),
//   so a staged `BED_MESH_PROFILE REMOVE=` is listed as a removal, not silently dropped.
//
//   COMMANDS. The catalogue (319 commands) has SET_GCODE_OFFSET, Z_OFFSET_APPLY_PROBE and SAVE_CONFIG.
//   It has NO PROBE_CALIBRATE and NO Z_ENDSTOP_CALIBRATE: touch mode measures the nozzle itself, so the
//   offset is tuned by babystepping a first layer, not with a paper test. The owner's own macros:
//     APPLY_MATERIAL_Z_OFFSET  PRINT_START / PRINT_READY run it: SET_GCODE_OFFSET Z=<_Z_OFFSET_VARS.table[mat]> MOVE=0.
//     CLEAR_MATERIAL_Z_OFFSET  PRINT_END runs it: SET_GCODE_OFFSET Z=0 MOVE=0. A babystep never carries over.
//     Z_OFFSET_LEARN           RESPOND only. Prints the value to paste into _Z_OFFSET_VARS. Changes nothing.
//     Z_OFFSET_SAVE_PERMANENT  Z_OFFSET_APPLY_PROBE followed by SAVE_CONFIG in one go. NOT offered here:
//                              it is the same two commands as the two buttons, but without the pause in
//                              between to see what was staged, and without the check that no print is running.
//   CARTOGRAPHER_TOUCH / _THRESHOLD_SCAN / _CALIBRATE exist too. They calibrate the probe, not the
//   offset, and they move hardware, so they belong with the bed mesh and not here.
//
//   MATERIAL TRIM. _Z_OFFSET_VARS has ten materials plus a fallback, and every one is 0.000 today. So the
//   table is summarised on one line while the values are all the same, and shown per material once they differ.
//
// WHEN A Z CHANGE IS REFUSED. Babystepping is allowed while printing, because that is what it is for. Two states
// lock it (and SET VALUE / RESET), the same two FINE TUNE locks:
//   PAUSED. PAUSE runs BASE_PAUSE (SAVE_GCODE_STATE NAME=PAUSE_STATE) and RESUME runs BASE_RESUME (RESTORE_GCODE_STATE
//   ... MOVE=1). The printer's Klipper docs say that state includes the SET_GCODE_OFFSET offset, so anything changed
//   while paused is silently undone on RESUME. APPLY TO PROBE still works while paused: the live offset is the print's.
//   HAPPY HARE BUSY. A toolchange is ONE command (T<n> -> MMU_CHANGE_TOOL) and Klipper runs one command at a time, so a
//   babystep sent mid-change does not happen mid-change: it waits, the 30 s rpc window can lapse ("timeout" while it
//   still runs), and repeated taps land together afterwards. HH v3.4.2 also wraps the change in SAVE_GCODE_STATE /
//   RESTORE_GCODE_STATE NAME=MMU_state (_save_toolhead_position_and_park / _restore_toolhead_position), whenever xyz is
//   homed, not only in a print. So every command on this screen waits for mmu.action == Idle.
//
// THE FLOOR. A MOVE=1 change that lowers the nozzle is refused when it would take gcode_move.position.z (the height
// above the bed model: g-code Z plus the offset, before the mesh transform) below 0. Klipper would allow it down to
// position_min (-2 here), i.e. 2 mm into the bed. The check counts taps already sent but not yet reported back (the
// status push is ~270 ms behind the ack), so a burst of -0.1 taps cannot slip under it. That rule, the ±5 mm limit
// and the 1 mm mid-print jump are lib/actions/toolhead.js zNudgePlan / zSetPlan / makeZFlight, the same code FINE
// TUNE and the dashboard's Z buttons run.
//
// SAVE_CONFIG restarts Klipper. It is refused while a print is running OR paused, since the restart ends a paused
// print as surely as a running one, and while Happy Hare is busy. It is also refused when nothing is pending,
// because it would still restart.
//
// Every tap re-reads the live state (a ref), so a value typed on the keypad or a confirm left open is checked
// against the printer as it is when the command goes, not as it was when the button was pressed.
//
// boot.js subscribes only configfile.save_config_pending, so the staged items, the trim table and the scanner
// model come from ONE read-only printer.objects.query. It runs when Klipper becomes ready, whenever the
// pending flag flips, and after APPLY. It never sends g-code.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono } from "../tokens.js";
import { mmu as mmuVm, badgeStyle, microLabel } from "../vm.js";
import { Chip, Panel, PanelBtn } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import {
  zNudgePlan, zSetPlan, makeZFlight, zOffsetOf, isHomed, isPaused, isPrinting, axisPosition, fmtNum, Z_OFFSET_LIMIT,
} from "../../lib/actions/toolhead.js";
import { fmtSignedMm } from "../../pages/dashboard/adapters/heightmap.js";

/** Babystep sizes, mm. Includes the dashboard's ±0.005 / ±0.025, so a step is the same size on either surface. */
const STEPS = [0.005, 0.01, 0.025, 0.05, 0.1];
/** Half-span of the gauge, mm. Real touch-mode trims live well inside it. A value past it pins to the end. */
const GAUGE = 0.2;

/** Finite number, or a numeric string (save_config_pending_items values are strings), else null. */
const numOr = v => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null);
/** Display only ("+0.062" / "−0.041" / "—"): the dashboard's formatter. Commands are built by lib/actions/toolhead.js. */
const signed = fmtSignedMm;

/** Which saved number Z_OFFSET_APPLY_PROBE folds the babystep into, from configfile.settings (st.config). */
function probeTarget(cfg, model) {
  const sc = cfg && cfg.scanner;
  const name = sc ? String(sc.sensor || "scanner") : "";
  if (sc && String(sc.mode) === "touch") {
    return { name, mode: "touch", section: "scanner", option: "scanner_touch_z_offset", saved: numOr(sc.scanner_touch_z_offset) };
  }
  if (sc) {
    const sec = `scanner model ${model || sc.default_model_name || "default"}`;
    return { name, mode: String(sc.mode || "scan"), section: sec, option: "model_offset", saved: numOr((cfg[sec] || {}).model_offset) };
  }
  if (cfg && cfg.probe) return { name: "probe", mode: "", section: "probe", option: "z_offset", saved: numOr(cfg.probe.z_offset) };
  return null;
}

/** A short form of a refusal reason for a button's sub-line. The full sentence goes in its `why`. */
function tagOf(why) {
  if (!why) return null;
  if (/not connected/i.test(why)) return "OFFLINE";
  if (/^Klipper is/i.test(why)) return why.replace(/^Klipper is /i, "KLIPPER ").toUpperCase();
  if (/has no/i.test(why)) return "NOT ON THIS PRINTER";
  if (/^Happy Hare is/i.test(why)) return "MMU BUSY";
  if (/paused/i.test(why)) return "PRINT PAUSED";
  if (/printing/i.test(why)) return "NOT WHILE PRINTING";
  return null;
}

function Row({ k, note, v, color = C.body }) {
  return (
    <div style={S("flex:none; display:flex; align-items:baseline; gap:8px; min-width:0")}>
      <span style={S(`${microLabel(C.faint)}; flex:none; width:64px`)}>{k}</span>
      {note ? <span style={S(mono(F.micro, `color:${C.ghost}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>{note}</span> : null}
      <span style={S(`margin-left:auto; flex:none; ${mono(F.val, `color:${color}; white-space:nowrap`)}`)}>{v}</span>
    </div>
  );
}

/** Where the live offset sits: − is the nozzle closer to the bed, + farther. The real value, never smoothed. */
function Gauge({ v }) {
  const known = Number.isFinite(v);
  const out = known && Math.abs(v) > GAUGE;
  const pct = 50 + Math.max(-1, Math.min(1, known ? v / GAUGE : 0)) * 50;
  const lab = mono(F.micro, `letter-spacing:.12em; color:${C.faint}; position:absolute; top:0; white-space:nowrap`);
  return (
    <div style={S("flex:none; display:flex; flex-direction:column; gap:6px")}>
      <div style={S(`position:relative; height:12px; border-radius:6px; background:${C.track}; border:1px solid ${C.line3}`)}>
        {[-GAUGE / 2, 0, GAUGE / 2].map(t => (
          <span key={t} style={S(`position:absolute; top:-4px; bottom:-4px; width:1px; left:${50 + t / GAUGE * 50}%; background:${t === 0 ? C.line5 : C.line4}`)} />
        ))}
        {known ? (
          <span style={S(`position:absolute; top:50%; left:${pct}%; width:16px; height:16px; margin:-8px 0 0 -8px; border-radius:50%; background:${out ? C.bed : C.cool}; box-shadow:0 0 0 3px ${C.panel}; transition:left .25s ease`)} />
        ) : null}
      </div>
      <div style={S("position:relative; height:16px")}>
        <span style={S(`${lab}; left:0`)}>&larr; CLOSER &minus;{GAUGE}</span>
        <span style={S(`${lab}; left:50%; transform:translateX(-50%)`)}>0</span>
        <span style={S(`${lab}; right:0`)}>+{GAUGE} FARTHER &rarr;</span>
      </div>
    </div>
  );
}

export default function Zoffset({ st, api, act, askInput }) {
  const [confirm, setConfirm] = React.useState(null);
  const [learnAt, setLearnAt] = React.useState(0);
  const [rev, setRev] = React.useState(0);
  const [side, setSide] = React.useState(null);   // { items, table, fallback, model } | { error }
  // What the changes sent from here should produce, until the status push catches up. Guards only; never displayed.
  const [flight] = React.useState(makeZFlight);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const raw = st.raw || {};
  const cf = raw.configfile || {};
  const pendingFlag = !!cf.save_config_pending;
  const ready = !!st.connected && st.klippy === "ready";

  // The ONE read-only query (see header). It runs when Klipper becomes ready, when the pending flag flips, and
  // after APPLY TO PROBE. Unknown objects come back as {}, so a printer without the macro or scanner is fine.
  React.useEffect(() => {
    if (!ready || !api || typeof api.query !== "function") return undefined;
    let alive = true;
    api.query({ configfile: ["save_config_pending_items"], "gcode_macro _Z_OFFSET_VARS": null, scanner: ["model"] })
      .then(r => {
        if (!alive) return;
        const s = (r && r.status) || {};
        const zv = s["gcode_macro _Z_OFFSET_VARS"] || {};
        setSide({
          items: (s.configfile || {}).save_config_pending_items || {},
          table: zv.table && typeof zv.table === "object" ? zv.table : null,
          fallback: numOr(zv.fallback),
          model: (s.scanner || {}).model || null,
        });
      })
      .catch(e => { if (alive) setSide({ error: (e && e.message) || String(e) }); });
    return () => { alive = false; };
  }, [ready, pendingFlag, rev, api]);

  // ---- live state ------------------------------------------------------------------------------------
  const zoff = zOffsetOf(raw);
  const zHomed = isHomed(raw, "Z");
  const thZ = axisPosition(raw, "Z");
  const paused = isPaused(raw);
  const printing = isPrinting(raw);
  const m = mmuVm(st);
  const gate = m.present && m.gate >= 0 ? m.gates[m.gate] : null;
  const mat = gate && gate.material && gate.material !== "—" ? String(gate.material).toUpperCase().trim() : "";

  const probe = probeTarget(st.config, side && side.model);
  // Prefer a live subscription if the integrator adds one. Otherwise use the query.
  const items = cf.save_config_pending_items !== undefined ? cf.save_config_pending_items || {} : (side && side.items) || null;
  const pendingList = items ? Object.entries(items).flatMap(([sec, opts]) =>
    opts === null
      ? [{ key: sec, sec, k: null, v: "" }]   // a removed section (configfile.remove_section)
      : Object.entries(opts || {}).map(([k, v]) => {
        const lines = String(v).split("\n").map(x => x.trim()).filter(Boolean);
        return { key: `${sec}.${k}`, sec, k, v: (lines[0] || "") + (lines.length > 1 ? `  (+${lines.length - 1} lines)` : "") };
      })) : [];
  const staged = probe && items && items[probe.section] ? numOr(items[probe.section][probe.option]) : null;

  const table = side && side.table;
  const trims = table ? Object.entries(table).map(([k, v]) => [String(k).toUpperCase(), numOr(v)]) : [];
  const fallback = side ? side.fallback : null;
  const trimNow = table && mat ? (trims.find(([k]) => k === mat) || [null, fallback])[1] : null;
  const allSame = trims.length > 0 && trims.every(([, v]) => v === trims[0][1]) && (fallback === null || fallback === trims[0][1]);

  // ---- guards ----------------------------------------------------------------------------------------
  const hhWhy = m.present && m.busy
    ? `Happy Hare is ${String(m.action).toLowerCase()} — Klipper holds commands until it finishes; wait for Idle` : null;
  const connWhy = act.blocked({}, "SET_GCODE_OFFSET");
  const babyWhy = connWhy
    || (paused ? "a print is paused — RESUME restores the Z offset saved at PAUSE, undoing this" : null)
    || hhWhy;

  const applyWhy = act.blocked({}, "Z_OFFSET_APPLY_PROBE") || hhWhy
    || (!probe ? (st.config ? "there is no probe section in printer.cfg" : "printer.cfg settings not read yet") : null)
    || (zoff === null ? "the Z offset has not been reported yet" : Math.abs(zoff) < 0.0005 ? "the live offset is 0.000 — babystep first" : null);
  const applyTag = tagOf(applyWhy) || (applyWhy && /0\.000/.test(applyWhy) ? "OFFSET IS 0.000" : applyWhy ? "UNAVAILABLE" : null);

  const saveWhy = act.blocked({ whilePrinting: false }, "SAVE_CONFIG")
    || (paused ? "a print is paused — the restart would end it" : null)
    || hhWhy
    || (!pendingFlag ? "nothing is pending — it would only restart Klipper" : null);
  const saveTag = tagOf(saveWhy) || (saveWhy ? "NOTHING PENDING" : null);

  const learnWhy = act.blocked({}, "Z_OFFSET_LEARN") || hhWhy;

  // Everything a tap, a keypad answer or a confirm needs, as of the latest render (see header).
  const latest = React.useRef(null);
  latest.current = { raw, zoff, babyWhy, applyWhy, saveWhy, learnWhy };

  const send = p => {
    const settle = flight.begin(p);
    return Promise.resolve(act.guarded(p.cmd, {})).then(r => { settle(r); return r; });
  };

  // ---- commands --------------------------------------------------------------------------------------
  // zNudgePlan / zSetPlan apply the limit, THE FLOOR and the mid-print jump rule, counting what is still in flight.
  const nudge = d => {
    const lv = latest.current;
    if (lv.babyWhy) return act.refuse("SET_GCODE_OFFSET", lv.babyWhy);
    const p = zNudgePlan(lv.raw, d, { pending: flight.pending() });   // drops MOVE=1 when Z is not homed
    if (p.error) return act.refuse("SET_GCODE_OFFSET", p.error);
    return send(p);
  };

  /** An absolute offset, checked against the state right now. { cmd, value, from, delta, move, to } or { error }. */
  const planSet = (value, lv) => (lv.babyWhy ? { error: lv.babyWhy } : zSetPlan(lv.raw, value, { pending: flight.pending() }));

  const askSet = value => {
    const p = planSet(value, latest.current);
    if (p.error) return act.refuse("SET_GCODE_OFFSET", p.error);
    const where = p.move && p.to !== null ? `, to ${p.to.toFixed(3)} mm above the bed.` : ".";
    setConfirm({
      label: p.value === 0 ? "RESET Z OFFSET" : "SET Z OFFSET", cmd: p.cmd,
      confirm: `Change the live Z offset from ${signed(p.from)} to ${signed(p.value)} mm?`
        + (p.delta !== null ? ` The nozzle moves ${p.delta < 0 ? "DOWN, closer to the bed," : "UP, away from the bed,"} by ${Math.abs(p.delta).toFixed(3)} mm ${p.move ? "now" + where : "on the next move (Z is not homed)."}` : ""),
      run: () => {
        const q = planSet(p.value, latest.current);
        if (q.error) return act.refuse("SET_GCODE_OFFSET", q.error);
        // What was confirmed must be what goes: the same move, from the same offset.
        if (q.cmd !== p.cmd || q.delta !== p.delta) {
          return act.refuse("SET_GCODE_OFFSET", `the printer changed while the confirm was open (offset now ${signed(q.from)} mm, Z ${q.move ? "homed" : "not homed"}) — check it again`);
        }
        return send(q);
      },
    });
    return null;
  };

  const setValue = async () => {
    const lv = latest.current;
    if (lv.babyWhy) return act.refuse("SET_GCODE_OFFSET", lv.babyWhy);
    const v = await askInput({
      mode: "numeric", label: "Z OFFSET", value: lv.zoff !== null ? lv.zoff.toFixed(3) : "0", unit: "mm",
      min: -Z_OFFSET_LIMIT, max: Z_OFFSET_LIMIT, allowNegative: true, hint: "+ IS FARTHER FROM THE BED",
    });
    if (v === null || !mounted.current) return null;
    return askSet(Number(v));   // re-checked against the state now, not when the keypad opened
  };

  const askApply = () => {
    const lv = latest.current;
    if (lv.applyWhy) return act.refuse("Z_OFFSET_APPLY_PROBE", lv.applyWhy);
    const from = lv.zoff;
    setConfirm({
      label: "APPLY TO PROBE", cmd: "Z_OFFSET_APPLY_PROBE",
      confirm: `Fold the live ${signed(from)} mm into ${probe.option} (${probe.saved !== null ? probe.saved.toFixed(3) + " mm" : "value unknown"} in printer.cfg)? `
        + "Klipper only stages it. Nothing changes until SAVE CONFIG restarts Klipper, and then it applies to every material."
        + (staged !== null ? ` ${staged.toFixed(3)} mm is already staged for it: check STAGED again before SAVE CONFIG.` : "")
        + ((printing || paused) && trimNow ? ` If PRINT_START applied the ${mat} trim (${signed(trimNow)} mm in _Z_OFFSET_VARS), it is part of the live offset and would be baked in too.` : ""),
      run: () => {
        const now = latest.current;
        if (now.applyWhy) return act.refuse("Z_OFFSET_APPLY_PROBE", now.applyWhy);
        if (now.zoff === null || Math.abs(now.zoff - from) >= 0.0005) {
          return act.refuse("Z_OFFSET_APPLY_PROBE", `the live offset changed to ${signed(now.zoff)} mm while the confirm was open — check it again`);
        }
        return Promise.resolve(act.guarded("Z_OFFSET_APPLY_PROBE", {})).then(r => { if (mounted.current) setRev(n => n + 1); return r; });
      },
    });
    return null;
  };

  const askSave = () => {
    const lv = latest.current;
    if (lv.saveWhy) return act.refuse("SAVE_CONFIG", lv.saveWhy);
    setConfirm({
      label: "SAVE CONFIG", cmd: "SAVE_CONFIG",
      confirm: `Write ${pendingList.length ? pendingList.length + " staged change" + (pendingList.length > 1 ? "s" : "") : "the staged changes"} to printer.cfg and restart Klipper? `
        + "It writes everything staged, not only the Z offset. The heaters turn off, the printer has to be homed again, and the live Z offset goes back to 0.",
      run: () => {
        const why = latest.current.saveWhy;
        if (why) return act.refuse("SAVE_CONFIG", why);
        return act.guarded("SAVE_CONFIG", { whilePrinting: false });
      },
    });
    return null;
  };

  const learn = () => {
    const why = latest.current.learnWhy;
    if (why) return act.refuse("Z_OFFSET_LEARN", why);
    setLearnAt(Date.now() / 1000);
    return act.guarded("Z_OFFSET_LEARN", {});
  };
  // Z_OFFSET_LEARN answers with RESPOND lines. Show the latest one that arrived after the tap, from the shared console log.
  const learnReply = learnAt ? ((st.log || []).find(l => l && Number(l.time) >= learnAt - 2 && /variable_table|live Z offset/i.test(String(l.message))) || null) : null;
  const clean = s => String(s || "").replace(/^(echo:|\/\/|!!)\s*/i, "").replace(/\s+/g, " ").trim();

  // ---- what a babystep does right now ----------------------------------------------------------------
  const notice = connWhy
    ? { kind: "warn", head: connWhy.toUpperCase(), text: "Babystepping comes back as soon as Klipper answers." }
    : paused
      ? { kind: "warn", head: "PRINT PAUSED · LOCKED", text: "RESUME puts back the g-code state saved at PAUSE, and that includes the Z offset, so a change made now would be undone. Babystep after resuming. APPLY TO PROBE still works." }
      : hhWhy
        ? { kind: "warn", head: `MMU ${String(m.action).toUpperCase()} · LOCKED`, text: "Klipper runs one command at a time, so a babystep sent now would wait for this change to finish, and repeated taps would land together. Babystep once Happy Hare is Idle." }
        : !zHomed
          ? { kind: "warn", head: "Z NOT HOMED", text: "The offset is recorded now and takes effect on the next Z move. MOVE=1 needs a homed Z, so it is left off." }
          : printing
            ? { kind: "ok", head: "BABYSTEPPING LIVE", text: "Each tap moves the nozzle at once. PRINT_END sets the offset back to 0. To keep it, APPLY TO PROBE before the print ends, or LEARN it for this material." }
            : { kind: "off", head: "WHERE THIS VALUE COMES FROM", text: "PRINT_START sets it from the material trim table (APPLY_MATERIAL_Z_OFFSET) and PRINT_END sets it back to 0 (CLEAR_MATERIAL_Z_OFFSET). A babystep only lasts if you APPLY it to the probe or LEARN it into the table." };
  const noticeCol = { ok: C.cool, warn: C.bed, off: C.dim }[notice.kind];

  const waiting = !ready ? (st.connected ? `Klipper is ${st.klippy || "not ready"}` : "Moonraker is not connected") : null;

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:minmax(0,1fr) 392px; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      {/* ---- LIVE OFFSET ---------------------------------------------------------------------------- */}
      <Panel title="LIVE Z OFFSET · SET_GCODE_OFFSET"
        right={<span style={S(badgeStyle(zHomed ? "ok" : "warn"))}>{zHomed ? "APPLIES NOW" : "ON NEXT MOVE"}</span>}
        bodyStyle={`padding:12px; gap:${L.gap}px`}>

        <div style={S("flex:none; display:flex; align-items:flex-end; gap:10px")}>
          <span style={S(mono(F.giant, `line-height:1; color:${zoff ? C.text : C.dim}`))}>{signed(zoff)}</span>
          <span style={S(mono(F.val, `color:${C.faint}; padding-bottom:5px`))}>mm</span>
          <div style={S("margin-left:auto; display:flex; flex-direction:column; align-items:flex-end; gap:4px")}>
            <span style={S(microLabel(C.faint))}>TOOLHEAD Z</span>
            <span style={S(mono(F.num2, `color:${zHomed ? C.body : C.mute}`))}>{thZ !== null && zHomed ? thZ.toFixed(2) : "—"}</span>
          </div>
        </div>

        <Gauge v={zoff} />

        {[["LOWER", "closer", -1, C.hot], ["RAISE", "farther", 1, C.cool]].map(([label, sub, dir, col]) => (
          <div key={label} style={S("flex:none; display:flex; align-items:center; gap:8px")}>
            <div style={S("flex:none; width:80px; display:flex; flex-direction:column; gap:3px")}>
              <span style={S(mono(F.label, `letter-spacing:.16em; color:${col}`))}>{label}</span>
              <span style={S(mono(F.micro, `color:${C.faint}`))}>{sub}</span>
            </div>
            {STEPS.map(s => (
              <Chip key={s} label={`${dir < 0 ? "−" : "+"}${fmtNum(s)}`} h={TAP.primary} fs={F.chip}
                disabled={!!babyWhy} onTap={() => nudge(dir * s)} />
            ))}
          </div>
        ))}

        {/* The reason the chips above are disabled lives here: a chip has no `why` of its own. */}
        <div style={S(`flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column; gap:6px; padding:10px 12px; border-radius:7px; border:1px solid ${C.line3}; background:${C.panelSunk}`)}>
          <span style={S(mono(F.micro, `letter-spacing:.16em; color:${noticeCol}`))}>{notice.head}</span>
          <span style={S(`font-size:${F.body}px; color:${C.faint}; line-height:1.45; text-wrap:pretty`)}>{notice.text}</span>
        </div>

        <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 1fr 1fr; gap:8px`)}>
          <span />
          <PanelBtn label="SET VALUE" sub={tagOf(babyWhy) || "KEYPAD · ±" + Z_OFFSET_LIMIT + " mm"} h={TAP.primary}
            disabled={!!babyWhy} why={babyWhy} onTap={setValue} />
          <PanelBtn label="RESET TO 0" sub={tagOf(babyWhy) || (zoff === 0 ? "ALREADY 0" : "SET_GCODE_OFFSET Z=0")} h={TAP.primary}
            disabled={!!babyWhy || zoff === 0} why={babyWhy || (zoff === 0 ? "the offset is already 0.000" : undefined)}
            onTap={() => askSet(0)} />
        </div>
      </Panel>

      {/* ---- KEEPING IT ----------------------------------------------------------------------------- */}
      <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>

        <Panel title="PROBE OFFSET"
          right={<span style={S(badgeStyle(pendingFlag ? "warn" : "off"))}>{pendingFlag ? "SAVE_CONFIG PENDING" : "NOTHING PENDING"}</span>}
          style="flex:1; min-height:0" bodyStyle="padding:10px 12px; gap:9px">
          <Row k="PROBE" note={probe && side && side.model ? `model ${side.model}` : null}
            v={probe ? [probe.name, probe.mode].filter(Boolean).join(" ") : st.config ? "none" : "…"}
            color={probe ? C.body : C.mute} />
          <Row k="SAVED" note={probe ? probe.option : null} v={probe && probe.saved !== null ? `${probe.saved.toFixed(3)} mm` : "—"} />
          <Row k="STAGED" note={staged !== null ? "restart to apply" : null} v={staged !== null ? `${staged.toFixed(3)} mm` : "—"}
            color={staged !== null ? C.bed : C.mute} />

          <div style={S(`flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:5px; padding:9px 11px; border-radius:7px; border:1px solid ${C.line3}; background:${C.panelSunk}`)}>
            <span style={S(microLabel(C.faint))}>SAVE_CONFIG WILL WRITE</span>
            {pendingList.length ? pendingList.map(p => (
              <span key={p.key} style={S(mono(F.label, `flex:none; color:${C.body}; word-break:break-all`))}>
                <span style={S(`color:${C.mute}`)}>[{p.sec}]</span>{" "}
                {p.k === null ? <span style={S(`color:${C.bed}`)}>section removed</span>
                  : <>{p.k} = <span style={S(`color:${C.bed}`)}>{p.v}</span></>}
              </span>
            )) : (
              <span style={S(mono(F.label, `color:${C.ghost}`))}>
                {side && side.error ? `could not read the staged items: ${side.error}`
                  : pendingFlag ? (items ? "a change is pending, but Klipper lists no items for it" : waiting || "reading…")
                  : "nothing is staged"}
              </span>
            )}
          </div>

          <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:8px")}>
            <PanelBtn label="APPLY TO PROBE" sub={applyTag || "Z_OFFSET_APPLY_PROBE"} h={TAP.primary}
              disabled={!!applyWhy} why={applyWhy} onTap={askApply} />
            <PanelBtn label="SAVE CONFIG" sub={saveTag || "RESTARTS KLIPPER"} tone={saveWhy ? undefined : "accent"} h={TAP.primary}
              disabled={!!saveWhy} why={saveWhy} onTap={askSave} />
          </div>
        </Panel>

        <Panel title="MATERIAL TRIM"
          right={mat ? <span style={S(badgeStyle("off"))}>{`GATE ${m.gate} · ${mat}`}</span> : null}
          style="flex:none" bodyStyle="padding:10px 12px; gap:8px">
          {!table ? (
            <span style={S(mono(F.label, `color:${C.ghost}`))}>
              {side && side.error ? `could not read the table: ${side.error}` : side ? "no _Z_OFFSET_VARS macro on this printer" : waiting || "reading…"}
            </span>
          ) : allSame ? (
            <span style={S(`font-size:${F.body}px; color:${C.faint}; line-height:1.45; text-wrap:pretty`)}>
              All {trims.length} materials in _Z_OFFSET_VARS{fallback !== null ? " and its fallback" : ""} are
              <span style={S(mono(F.label, `color:${C.body}`))}> {signed(trims[0][1])} mm</span>
              {trims[0][1] ? ", so PRINT_START applies that to every print." : ", so PRINT_START adds nothing today."}
            </span>
          ) : (
            // Two rows, scrolling, with the loaded material first. Three rows squeezed SAVE_CONFIG WILL WRITE to one line.
            <div style={S("flex:none; max-height:65px; overflow-y:auto; display:grid; grid-template-columns:repeat(3,1fr); gap:5px")}>
              {trims.filter(([k]) => k === mat).concat(trims.filter(([k]) => k !== mat), fallback !== null ? [["OTHER", fallback]] : []).map(([k, v]) => (
                <div key={k} style={S(`display:flex; align-items:center; gap:6px; height:30px; padding:0 8px; border-radius:5px; background:${C.panelSunk}; border:1px solid ${k === mat ? C.accentLine : C.line3}`)}>
                  <span style={S(mono(F.micro, `letter-spacing:.06em; color:${k === mat ? C.accent : C.dim}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>{k}</span>
                  <span style={S(`margin-left:auto; ${mono(F.micro, `color:${v ? C.body : C.mute}`)}`)}>{signed(v)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={S("flex:none; display:grid; grid-template-columns:132px minmax(0,1fr); gap:10px; align-items:center")}>
            <PanelBtn label="LEARN" sub={tagOf(learnWhy) || (mat ? `FOR ${mat}` : "FOR THE GATE")} h={TAP.min}
              disabled={!!learnWhy} why={learnWhy} onTap={learn} />
            <span style={S(mono(F.micro, `color:${learnReply ? C.body : C.faint}; line-height:1.3; max-height:47px; overflow:hidden`))}>
              {learnReply ? clean(learnReply.message) : "Prints the value to paste into _Z_OFFSET_VARS, then RESTART. It changes nothing itself."}
            </span>
          </div>
        </Panel>
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); if (c && c.run) c.run(); }} />
      ) : null}
    </div>
  );
}
