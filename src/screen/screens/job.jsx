// ---------------------------------------------------------------------------
// JOB — ported from the export, reflowed to 1024x600.
//
// The export modelled only printing / not-printing. This printer spends most of
// its life in neither: print_stats.state is complete, cancelled or error, and the
// KlipperScreen fork deliberately sets job_complete/error/cancelled timeouts to 0
// so the outcome STAYS on screen until dismissed. So there are three states here,
// not two, and the finished one carries print_stats.message (only populated on
// error) plus a reprint.
//
// Layout: preview column 300 -> 260, ring 154 -> 128, pad 16 -> 12, gap 14 -> 10.
// LAYER comes from metadata + Z, because print_stats.info.current_layer and
// total_layer are BOTH null on this machine -- OrcaSlicer never calls
// SET_PRINT_STATS_INFO.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { job as jobVm, mmu as mmuVm, temps as tempsVm, badgeStyle, microLabel, fmtHM, toolGateLabel } from "../vm.js";
import { FilamentPath, Panel, PanelBtn, Empty, Stat } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { usedTools } from "../../lib/history.js";

function thumbUrl(api, meta, path, want = 300) {
  const t = ((meta || {}).thumbnails || []).slice()
    .sort((a, b) => Math.abs(a.width - want) - Math.abs(b.width - want))[0];
  if (!t || !t.relative_path) return null;
  const dir = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return api.fileUrl("gcodes", dir + t.relative_path);
}

export default function Job({ st, meta, api, act, go, say }) {
  const [confirm, setConfirm] = React.useState(null);
  const j = jobVm(st, meta);
  const m = mmuVm(st);
  const t = tempsVm(st);
  const ps = st.raw.print_stats || {};
  const state = ps.state || "standby";
  const finished = ["complete", "cancelled", "error"].includes(state);

  const url = thumbUrl(api, meta, j.rawFile);

  if (!j.active && !finished) {
    return (
      <div style={S(`height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px`)}>
        <div style={S(panel("height:100%"))}>
          <Empty title="NOTHING PRINTING"
            hint="Pick a file on the FILES screen. This screen shows progress, the filament path and the print controls while a job runs, and stays on the outcome afterwards." />
        </div>
      </div>
    );
  }

  if (finished) {
    const tone = state === "complete" ? "ok" : state === "cancelled" ? "warn" : "err";
    const col = state === "complete" ? C.cool : state === "cancelled" ? C.bed : C.accent;
    return (
      <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px; animation:ksFade .18s ease both`)}>
        <div style={S(panel("flex:1; min-height:0; padding:20px; align-items:center; justify-content:center; gap:16px"))}>
          <span style={S(badgeStyle(tone))}>{state.toUpperCase()}</span>
          <span style={S(mono(F.num1, `color:${C.text}; text-align:center; word-break:break-word; max-width:820px`))}>
            {j.file || "—"}
          </span>
          {ps.message ? (
            <span style={S(`${mono(F.body, `color:${col}; text-align:center; max-width:760px`)}; text-wrap:pretty`)}>{ps.message}</span>
          ) : null}
          <div style={S("display:flex; gap:34px; margin-top:4px")}>
            <Stat k="DURATION" v={fmtHM(ps.print_duration)} />
            <Stat k="TOTAL" v={fmtHM(ps.total_duration)} />
            <Stat k="FILAMENT" v={`${(Number(ps.filament_used || 0) / 1000).toFixed(2)} m`} />
            {meta && meta.filament_weight_total ? <Stat k="WEIGHT" v={`${Math.round(meta.filament_weight_total)} g`} /> : null}
          </div>
        </div>
        <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 1fr 1fr 1fr; gap:9px`)}>
          <span />
          <PanelBtn label="PRINT AGAIN" tone="accent" h={TAP.primary}
            disabled={!j.rawFile}
            onTap={() => setConfirm({ label: "PRINT AGAIN", cmd: j.rawFile, guards: { whilePrinting: false },
              confirm: `Start ${j.file} again?`,
              run: () => api.startPrint(j.rawFile).then(() => say("printing")).catch(e => act.refuse("PRINT AGAIN", e.message)) })} />
          <PanelBtn label="FILES" h={TAP.primary} onTap={() => go("files")} />
          <PanelBtn label="HOME" h={TAP.primary} onTap={() => go("home")} />
        </div>
        {confirm ? (
          <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
            onYes={() => { const c = confirm; setConfirm(null); const why = act.blocked(c.guards); if (why) act.refuse("PRINT AGAIN", why); else c.run(); }} />
        ) : null}
      </div>
    );
  }

  const circ = 2 * Math.PI * 52;
  const ACTIONS = [
    // While Happy Hare holds the print paused, RECOVER is the screen built for exactly that.
    { label: "MMU", sub: "RECOVER", onTap: () => go(m.isPaused ? "recover" : "mmu") },
    { label: "BLOBIFIER", sub: "PURGE", cmd: "BLOBIFIER", guards: {} },
    { label: "BLOBIFIER", sub: "CLEAN", cmd: "BLOBIFIER_CLEAN", guards: {} },
    { label: "TUNE", sub: "SPEED / FLOW", onTap: () => go("finetune") },
    { label: "CANCEL", sub: "PRINT", tone: "danger",
      confirm: `Cancel ${j.file} at ${j.pctLabel}? This cannot be undone.`, cmd: "CANCEL_PRINT", guards: {} },
  ];

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:260px minmax(0,1fr); gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>

      <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
        <div style={S(panel("flex:1; min-height:0; align-items:center; justify-content:center; overflow:hidden"))}>
          {url ? (
            <img src={url} alt="" style={S("width:100%; height:100%; object-fit:contain; display:block")} />
          ) : (
            <span style={S(mono(F.micro, `letter-spacing:.22em; color:${C.ghost}`))}>NO PREVIEW</span>
          )}
        </div>
        <div style={S(panel(`flex:none; padding:11px 13px; gap:6px; margin-bottom:${L.fab + L.fabInset - L.pad}px`))}>
          {[
            ["FILAMENT", `${j.filamentUsed.toFixed(2)} m`],
            ["NOZZLE", meta && meta.nozzle_diameter ? `${meta.nozzle_diameter} mm` : "—"],
            ["LAYER H", meta && meta.layer_height ? `${meta.layer_height} mm` : "—"],
            ["TOOLS", usedTools(meta).map(n => "T" + n).join(" ") || "—"],
            ["ELAPSED", fmtHM(ps.print_duration)],
          ].map(([k, v]) => (
            <div key={k} style={S(`display:flex; align-items:center; justify-content:space-between; ${mono(F.label)}`)}>
              <span style={S(`letter-spacing:.12em; color:${C.faint}`)}>{k}</span>
              <span style={S(`color:${C.body}`)}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0`)}>
        <div style={S(panel("flex:none; flex-direction:row; align-items:center; gap:28px; padding:12px 20px"))}>
          <div style={S("position:relative; width:128px; height:128px; flex:none")}>
            <svg viewBox="0 0 120 120" style={S("width:100%; height:100%; transform:rotate(-90deg)")}>
              <circle cx="60" cy="60" r="52" fill="none" stroke={C.line2} strokeWidth="9" />
              <circle cx="60" cy="60" r="52" fill="none" stroke={C.accent} strokeWidth="9" strokeLinecap="round"
                strokeDasharray={`${(circ * j.pct / 100).toFixed(2)} ${circ.toFixed(2)}`} />
            </svg>
            <div style={S("position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px")}>
              <span style={S(mono(28, `color:${C.text}; letter-spacing:-.02em`))}>{j.pctLabel}</span>
              <span style={S(mono(F.micro, `letter-spacing:.2em; color:${C.faint}`))}>{j.paused ? "PAUSED" : "PRINTING"}</span>
            </div>
          </div>
          <div style={S("flex:1; min-width:0; display:grid; grid-template-columns:1fr 1fr; gap:10px 24px")}>
            {[
              ["LAYER", j.layerCount ? `${j.layer} / ${j.layerCount}` : "—", C.text],
              ["REMAINING", j.etaLabel, C.text],
              ["ELAPSED", fmtHM(ps.print_duration), C.dim],
              // Tool and gate both: they differ under a TTG remap, and this used to print the TOOL under "ACTIVE GATE".
              ["TOOL · GATE", m.present ? `${toolGateLabel(m)}${m.active && m.active.filament_name ? " · " + m.active.filament_name.toUpperCase() : ""}` : "—", C.cool],
            ].map(([k, v, col]) => (
              <div key={k} style={S("display:flex; flex-direction:column; gap:2px; min-width:0")}>
                <span style={S(mono(F.micro, `letter-spacing:.2em; color:${C.faint}`))}>{k}</span>
                <span style={S(mono(F.num2, `color:${col}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {m.present ? (
          <Panel title={`${m.unitVendor || "MMU"} · FILAMENT PATH`}
            right={<span style={S(badgeStyle(m.isPaused ? "err" : m.busy ? "warn" : "ok"))}>
              {m.isPaused ? "PAUSED" : m.busy ? String(m.action).toUpperCase() : String(m.filament).toUpperCase()}
            </span>}
            style="flex:1; min-height:0" bodyStyle="padding:10px 12px">
            <div style={S("flex:1; min-height:60px; position:relative")}>
              <FilamentPath m={m} showCutter cutting={/cut/i.test(m.action)} />
            </div>
          </Panel>
        ) : <div style={S("flex:1; min-height:0")} />}

        <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px repeat(6,1fr); gap:8px`)}>
          <span />
          <PanelBtn label={j.paused ? "RESUME" : "PAUSE"} tone="accent" h={TAP.primary}
            onTap={() => (j.paused ? api.resumePrint() : api.pausePrint())
              .then(() => say(j.paused ? "resumed" : "paused"))
              .catch(e => act.refuse(j.paused ? "RESUME" : "PAUSE", e.message))} />
          {ACTIONS.map(a => {
            const why = a.cmd ? act.blocked(a.guards, a.cmd) : null;
            return (
              <PanelBtn key={a.label + a.sub} label={a.label} sub={a.sub} tone={a.tone} h={TAP.primary}
                disabled={!!why} why={why}
                onTap={() => {
                  if (a.onTap) return a.onTap();
                  if (a.confirm) return setConfirm(a);
                  act.guarded(a.cmd, a.guards);
                }} />
            );
          })}
        </div>
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => {
            const c = confirm; setConfirm(null);
            if (c.cmd === "CANCEL_PRINT") api.cancelPrint().then(() => say("cancelled")).catch(e => act.refuse("CANCEL", e.message));
            else act.guarded(c.cmd, c.guards);
          }} />
      ) : null}
    </div>
  );
}
