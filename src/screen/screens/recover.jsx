// ---------------------------------------------------------------------------
// RECOVER — the screen for a print Happy Hare has paused. Opens by itself when the MMU pauses a job
// (main.jsx), and from JOB's MMU · RECOVER button while it is paused.
//
// Built from what actually stops prints on this machine. Five days of mmu.log (Sep 19–22) hold six pauses and
// every one was filament:
//   · "Load sequence failed … Failed to load filament passed the extruder entrance (sync-feedback buffer didn't
//     detect neutral tension). Occured when changing tool: > T5"                        (T4, T5; HH auto-retries)
//   · "Runout detected on Encoder. No alternative gates available … EndlessSpool Group F" (T5)
//   · "Required Tool T0 on gate 0 marked EMPTY" / "Gate 5 marked EMPTY"                  (T0, T5)
// So the screen leads with WHY (the reason, classified, with the next step in words), puts the nozzle beside
// the filament — two of those pauses happened with the hotend at 0 °C and HH later reheated to its 200 °C
// default while these ABS gates want 250 — and offers exactly the moves each case needs.
//
// Every command goes through act.guarded, so a refusal says why (MMU busy retrying, hotend cold, command
// missing on this printer). Nothing here is a new code path for the printer: they are the same MMU_* commands
// the MMU screen sends, aimed at the tool and gate the pause is about.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { mmu as mmuVm, temps as tempsVm, badgeStyle } from "../vm.js";
import { Panel, PanelBtn, Chip } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { controlPrefs } from "../../lib/prefs.js";

const MMU_MOVE = { needsMmu: true, needsMmuIdle: true };
const HOT_MOVE = { needsHot: true, needsMmuIdle: true };

/** Classify Happy Hare's reason_for_pause into the three failures this printer actually has. */
export function classify(reason) {
  const r = String(reason || "");
  if (/load sequence failed|failed to load/i.test(r)) return {
    kind: "load", title: "LOAD FAILED",
    next: "Filament did not get past the extruder entrance. Check it is caught in the extruder gears, then LOAD again — or UNLOAD and start over.",
  };
  if (/runout/i.test(r)) return {
    kind: "runout", title: "RUNOUT · NO SPARE SPOOL",
    next: "The spool ran out and EndlessSpool had no spare. EJECT the tail and PRELOAD a new spool into this gate — or pick a spare in the FROM row below.",
  };
  if (/marked empty|is empty|gate.*empty/i.test(r)) return {
    kind: "empty", title: "GATE MARKED EMPTY",
    next: "Happy Hare thinks this gate has no filament. Load it, then CHECK GATE (or MARK AVAILABLE if you can see it is there).",
  };
  return { kind: "other", title: "MMU ERROR", next: "Read the reason below, fix it, then RESUME." };
}

/** The tool and gate a pause is about: from the reason text first, then Happy Hare's current selection. */
export function subjectOf(reason, raw) {
  const m = raw.mmu || {};
  const r = String(reason || "");
  const t = r.match(/\bT(\d+)\b/);
  const g = r.match(/\bgate (\d+)/i);
  const tool = t ? Number(t[1]) : Number.isInteger(m.tool) && m.tool >= 0 ? m.tool : null;
  const ttg = Array.isArray(m.ttg_map) ? m.ttg_map : null;
  const gate = g ? Number(g[1]) : tool !== null && ttg && Number.isInteger(ttg[tool]) ? ttg[tool]
    : Number.isInteger(m.gate) && m.gate >= 0 ? m.gate : null;
  return { tool, gate };
}

export default function Recover({ st, act, api, go, say, askInput }) {
  const [confirm, setConfirm] = React.useState(null);
  const m = mmuVm(st);
  const t = tempsVm(st);
  const raw = st.raw || {};
  const ps = raw.print_stats || {};
  const paused = ps.state === "paused" || !!(raw.pause_resume || {}).is_paused;
  const reason = m.reason || "";
  const cls = classify(reason);
  const { tool, gate } = subjectOf(reason, raw);
  const g = gate !== null ? m.gates[gate] : null;
  const e = raw.extruder || {};
  const hot = !!e.can_extrude;
  const gateTemp = g && g.temp ? Math.round(g.temp) : null;
  const locked = !!(raw.mmu || {}).is_locked;
  const retrying = m.busy;
  const cp = controlPrefs(st);
  const nudge = [cp.extrudeLengths[0], cp.extrudeLengths[1]];
  const rate = cp.extrudeRates[0];

  // A gate with no material set (an empty gate, typically) has no real temperature either: its 200 °C is Happy
  // Hare's placeholder default, so it is labelled as that and not offered as THE answer.
  const matKnown = !!(g && g.material && g.material !== "—");
  // Gates that could stand in for this tool: not this one, not empty, and the same material when this gate has
  // one. When it has none — "Required Tool T0 on gate 0 marked EMPTY" — any loaded gate is a candidate.
  const spares = g ? m.gates.filter(x => x.i !== g.i && !x.empty && (matKnown ? x.material === g.material : x.material !== "—")) : [];

  const cmd = (label, script, guards = MMU_MOVE, confirmText) => {
    const why = act.blocked(guards, script);
    return { label, why, run: () => (confirmText ? setConfirm({ label, cmd: script, guards, confirm: confirmText }) : act.guarded(script, guards)) };
  };
  const heatTo = v => act.guarded(`M104 S${Math.round(v)}`, {});
  const setTarget = async () => {
    const v = await askInput({ mode: "numeric", label: "NOZZLE TARGET", value: Math.round(e.target || gateTemp || 0), unit: "°C", min: 0, max: 300, allowNegative: false, hint: "0 turns it off" });
    if (v !== null) heatTo(Number(v));
  };

  if (!m.isPaused && !paused) {
    return (
      <div style={S(`height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px`)}>
        <div style={S(panel("height:100%; align-items:center; justify-content:center; gap:14px"))}>
          <span style={S(badgeStyle("ok"))}>NOTHING TO RECOVER</span>
          <span style={S(mono(F.label, `color:${C.faint}; text-align:center; max-width:560px`))}>
            This screen opens by itself when Happy Hare pauses a print, with the controls for that failure.
          </span>
          <div style={S("display:flex; gap:10px; margin-top:6px")}>
            <Chip label="JOB" onTap={() => go("job")} flex={0} minW={140} />
            <Chip label="MMU" onTap={() => go("mmu")} flex={0} minW={140} />
          </div>
        </div>
      </div>
    );
  }

  // The per-failure emphasis: the moves this kind of pause needs come first and lit.
  const LEAD = { load: ["load", "unload", "extrude"], runout: ["eject", "preload", "remap"], empty: ["check", "available", "preload"], other: [] }[cls.kind];
  const lit = k => LEAD.includes(k);
  const G = gate !== null ? gate : "?";
  const moves = [
    ["load", cmd("LOAD", "MMU_LOAD", MMU_MOVE)],
    ["unload", cmd("UNLOAD", "MMU_UNLOAD", MMU_MOVE)],
    ["eject", cmd("EJECT", "MMU_EJECT", MMU_MOVE, `Push the filament in gate ${G} fully out of the MMU so the spool can be changed?`)],
    ["check", cmd("CHECK GATE", gate !== null ? `MMU_CHECK_GATE GATE=${gate}` : "MMU_CHECK_GATE", MMU_MOVE)],
    ["preload", cmd("PRELOAD", gate !== null ? `MMU_PRELOAD GATE=${gate}` : "MMU_PRELOAD", MMU_MOVE)],
    ["available", {
      label: "MARK AVAILABLE",
      why: gate === null ? "no gate identified" : act.blocked({ needsMmu: true }, "MMU_GATE_MAP"),
      run: () => setConfirm({ label: "MARK AVAILABLE", cmd: `MMU_GATE_MAP GATE=${G} AVAILABLE=1 TEMP=${gateTemp || "…"}`, guards: { needsMmu: true },
        confirm: `Tell Happy Hare gate ${G} has filament? Nothing is checked — only do this if you can see it is loaded.`,
        exec: () => act.setGateMap(gate, { status: 1 }) }),
    }],
  ];

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      {/* WHY — the reason, classified, with the next step in words */}
      <div style={S(panel(`flex:none; flex-direction:row; gap:16px; padding:12px 16px; border-color:${C.accentLine}; background:${C.accentBg2}`))}>
        <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:6px")}>
          <div style={S("display:flex; align-items:center; gap:10px")}>
            <span style={S(badgeStyle("err"))}>PAUSED</span>
            <span style={S(mono(F.num2, `color:${C.text}; letter-spacing:.06em`))}>{cls.title}</span>
            {retrying ? <span style={S(badgeStyle("warn"))}>{`AUTO-RETRY · ${String(m.action).toUpperCase()}`}</span> : null}
            {locked ? <span style={S(badgeStyle("warn"))}>LOCKED</span> : null}
          </div>
          <span style={S(`font-size:${F.body}px; color:${C.body}; text-wrap:pretty`)}>{cls.next}</span>
          <span style={S(`${mono(F.micro, `color:${C.mute}`)}; white-space:pre-line; max-height:34px; overflow:hidden`)}>{reason || "No reason reported — check the console."}</span>
        </div>
        <div style={S(`flex:none; width:178px; display:flex; flex-direction:column; align-items:flex-end; justify-content:center; gap:5px; border-left:1px solid ${C.accentLine}; padding-left:14px`)}>
          <span style={S(mono(F.num1, `color:${C.text}`))}>{tool !== null ? `T${tool}` : "T?"}</span>
          <div style={S("display:flex; align-items:center; gap:7px")}>
            <span style={S(`width:12px; height:12px; border-radius:3px; background:${g ? g.color : C.line4}; border:1px solid ${C.line5}`)} />
            <span style={S(mono(F.label, `color:${C.dim}`))}>{gate !== null ? `GATE ${gate}` : "GATE ?"}</span>
          </div>
          <span style={S(mono(F.micro, `color:${C.mute}; text-align:right`))}>
            {g ? [g.material !== "—" ? g.material : null, g.spoolId ? `#${g.spoolId}` : null, gateTemp ? `${gateTemp}°C` : null].filter(Boolean).join(" · ") : "—"}
          </span>
        </div>
      </div>

      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:292px minmax(0,1fr); gap:${L.gap}px`)}>

        {/* NOZZLE — beside the filament, because a cold nozzle is half of these failures */}
        <Panel title="NOZZLE" right={<span style={S(badgeStyle(hot ? "ok" : "warn"))}>{hot ? "CAN EXTRUDE" : "TOO COLD"}</span>}
          bodyStyle="padding:10px 12px; gap:9px">
          <div onClick={setTarget} style={S("display:flex; align-items:baseline; gap:8px; cursor:pointer")}>
            <span style={S(mono(F.hero, `color:${hot ? C.text : C.bed}; line-height:1`))}>{t.nozzle.cur.toFixed(0)}</span>
            <span style={S(mono(F.label, `color:${C.mute}`))}>{`°C → ${Math.round(t.nozzle.tgt)}°C`}</span>
          </div>
          <div style={S("display:grid; grid-template-columns:1fr 1fr; gap:8px")}>
            <PanelBtn label="UNLOCK" sub="RESTORE TEMP" tone={locked ? "accent" : undefined}
              why={act.blocked({}, "MMU_UNLOCK") || undefined} disabled={!!act.blocked({}, "MMU_UNLOCK")}
              onTap={() => act.guarded("MMU_UNLOCK", {})} />
            <PanelBtn label={gateTemp ? `HEAT ${gateTemp}` : "HEAT"} sub={!gateTemp ? "NO GATE TEMP" : matKnown ? "GATE TEMP" : "HH DEFAULT"}
              tone={!hot && gateTemp && matKnown ? "accent" : undefined} disabled={!gateTemp} onTap={() => heatTo(gateTemp)} />
          </div>
          <div style={S("display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px")}>
            {[
              [`+${nudge[0]}`, `M83\nG1 E${nudge[0]} F${rate * 60}`],
              [`+${nudge[1]}`, `M83\nG1 E${nudge[1]} F${rate * 60}`],
              [`−${nudge[0]}`, `M83\nG1 E-${nudge[0]} F${rate * 60}`],
            ].map(([label, script]) => {
              const why = act.blocked(HOT_MOVE, script);
              return <PanelBtn key={label} label={label} sub="mm" tone={lit("extrude") && label.startsWith("+") ? "accent" : undefined}
                disabled={!!why} why={why} onTap={() => act.guarded(script, HOT_MOVE)} />;
            })}
          </div>
          <span style={S(mono(F.micro, `color:${C.faint}`))}>{`EXTRUDE AT ${rate} mm/s · TAP THE TEMPERATURE TO SET IT`}</span>
        </Panel>

        {/* FILAMENT — the moves this failure needs. Where the filament IS lives in the header badge: the path
            graphic cost the 58 px the tool-remap row needs at 1024x600. */}
        <Panel title={`FILAMENT · ${tool !== null ? "T" + tool : "T?"} / GATE ${G}`}
          right={<span style={S(badgeStyle(retrying ? "warn" : "off"))}>{retrying ? String(m.action).toUpperCase() : String(m.filament).toUpperCase()}</span>}
          bodyStyle="padding:10px 12px; gap:9px">
          <div style={S("display:grid; grid-template-columns:repeat(3,1fr); gap:8px")}>
            {moves.map(([k, a]) => (
              <PanelBtn key={k} label={a.label} tone={lit(k) ? "accent" : undefined} disabled={!!a.why} why={a.why} onTap={a.run} />
            ))}
          </div>
          <div style={S("display:flex; align-items:center; gap:8px")}>
            <span style={S(mono(F.micro, `letter-spacing:.14em; color:${C.faint}; flex:none; width:74px`))}>RECOVER</span>
            {[["DETECT", undefined, "MMU_RECOVER"], ["SET LOADED", true, "MMU_RECOVER LOADED=1"], ["SET UNLOADED", false, "MMU_RECOVER LOADED=0"]].map(([label, loaded, script]) => (
              <Chip key={label} label={label} h={TAP.min} fs={F.label} disabled={!!act.blocked({ needsMmu: true }, "MMU_RECOVER")}
                onTap={() => (loaded === undefined ? act.mmuRecover({})
                  : setConfirm({ label, cmd: script, guards: { needsMmu: true },
                      confirm: `Overwrite Happy Hare's state with "${loaded ? "filament at the nozzle" : "filament back at the gate"}"? Nothing is checked.`,
                      exec: () => act.mmuRecover({ loaded }) }))} />
            ))}
          </div>
          {tool !== null ? (
            <div style={S("display:flex; align-items:center; gap:8px")}>
              <span style={S(mono(F.micro, `letter-spacing:.14em; color:${lit("remap") ? C.accent : C.faint}; flex:none; width:74px; line-height:1.2`))}>{`T${tool} FROM`}</span>
              {spares.length ? spares.slice(0, 4).map(x => (
                <Chip key={x.i} label={`GATE ${x.i}`} sub={matKnown ? (x.name || x.material) : x.material} h={TAP.min} fs={F.label}
                  disabled={!!act.blocked(MMU_MOVE, "MMU_TTG_MAP")}
                  onTap={() => setConfirm({ label: `T${tool} → GATE ${x.i}`, cmd: `MMU_TTG_MAP TOOL=${tool} GATE=${x.i}`, guards: MMU_MOVE,
                    confirm: `Print the rest of this job's T${tool} from gate ${x.i} (${x.name || x.material})? The tool map stays changed until you reset it.` })} />
              )) : <span style={S(mono(F.micro, `color:${C.ghost}`))}>{matKnown ? `no other gate holds ${g.material}` : "no other gate is loaded"}</span>}
            </div>
          ) : null}
        </Panel>
      </div>

      {/* resolution */}
      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 2fr 1fr 1fr 1fr; gap:8px`)}>
        <span />
        <PanelBtn label="RESUME" sub={retrying ? "WAIT FOR THE RETRY" : "CONTINUE THE PRINT"} tone="accent" h={TAP.primary}
          disabled={retrying} why={retrying ? `MMU is ${m.action}` : undefined}
          onTap={() => api.resumePrint().then(() => say("resumed")).catch(e => act.refuse("RESUME", e.message))} />
        <PanelBtn label="CANCEL" sub="PRINT" tone="danger" h={TAP.primary}
          onTap={() => setConfirm({ label: "CANCEL PRINT", cmd: "CANCEL_PRINT", guards: {}, confirm: "Cancel the paused print? This cannot be undone.",
            exec: () => api.cancelPrint().then(() => say("cancelled")).catch(e => act.refuse("CANCEL", e.message)) })} />
        <PanelBtn label="MMU" sub="ALL CONTROLS" h={TAP.primary} onTap={() => go("mmu")} />
        <PanelBtn label="JOB" sub="PROGRESS" h={TAP.primary} onTap={() => go("job")} />
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => {
            const c = confirm; setConfirm(null);
            const why = act.blocked(c.guards || {}, c.exec ? null : c.cmd);
            if (why) return act.refuse(c.label, why);
            return c.exec ? c.exec() : act.guarded(c.cmd, c.guards || {});
          }} />
      ) : null}
    </div>
  );
}
