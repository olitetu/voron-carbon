// ---------------------------------------------------------------------------
// Carbon Screen — the shell: persistent status bar, nav, toast, confirm.
//
// Two deliberate departures from the design export:
//
// 1. The status bar is PERSISTENT. The export shows it only while printing
//    (`<sc-if value="{{ printing }}">`). But it is the only always-visible
//    surface, and this UI replaces KlipperScreen, which keeps an emergency stop
//    in its action bar at all times (and this printer sets confirm_estop = True).
//    Shipping a panel with no reachable estop is not an option, so the bar stays
//    up and carries it, plus the klippy-not-ready and save-config-pending states
//    the export has nowhere to put.
//
// 2. Eight rail items, not nine. 9 x 130px + 64px corner = 1234px, which
//    overflows the real 1024px panel by 192px — two items sit off-screen in the
//    export as drawn. 8 x 120 + 64 = 1024 exactly. FANS & LEDS moves to MORE.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../lib/ui.js";
import { C, F, L, TAP, PANEL, mono } from "./tokens.js";
import { health, job, temps, mmu, badges, badgeStyle, toolGateLabel } from "./vm.js";

/** Rail order. MORE holds everything that is not one of these seven jobs. */
export const RAIL = [
  ["job", "JOB", "▶"], ["move", "MOVE", "✥"], ["extrude", "EXTRUDE", "⇅"],
  ["temp", "TEMP", "≋"], ["mmu", "MMU", "⬢"], ["files", "FILES", "▤"],
  ["macros", "MACROS", "⌘"], ["more", "MORE", "⋯"],
];
const RAIL_KEYS = new Set(RAIL.map(r => r[0]));
export const TITLES = {
  home: "HOME", job: "JOB STATUS", move: "MOVE", extrude: "EXTRUDE", temp: "TEMPERATURE",
  mmu: "ERCF · MMU", files: "FILES", macros: "MACROS", more: "MORE", recover: "FILAMENT RECOVERY",
  fans: "FANS & LEDS", console: "CONSOLE", camera: "CAMERA", spoolman: "SPOOLMAN", bedmesh: "BED MESH",
  zoffset: "Z OFFSET", finetune: "FINE TUNE", limits: "LIMITS", gatemap: "GATE MAP", ttg: "TOOL → GATE",
  mmustats: "MMU STATISTICS", history: "HISTORY", updates: "UPDATES", notifications: "NOTIFICATIONS",
  network: "NETWORK", system: "SYSTEM",
};

// ---------------------------------------------------------------------------
function EStop({ st, onEstop, onFirmwareRestart }) {
  const h = health(st);
  const down = h.level === "down" && st.connected;   // klippy shut down but moonraker is up

  // With Moonraker unreachable the stop CANNOT be sent. Rendering a live-looking
  // stop button that silently does nothing is the worst thing this panel could do,
  // so say so instead: greyed, labelled, and inert. The machine's physical stop is
  // the fallback, and the user needs to know that is where they have to reach.
  if (!st.connected) {
    return (
      <div style={S(`flex:none; width:96px; align-self:stretch; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; background:${C.offBg}; border-left:1px solid ${C.line3}; ${mono(F.micro, `letter-spacing:.14em; color:${C.ghost}; text-align:center; line-height:1.2; white-space:pre-line`)}`)}
           title="Moonraker is unreachable — use the printer's physical stop">
        <span style={S(`font-size:15px; line-height:1; color:${C.ghost}`)}>⏻</span>
        <span>{"NO\nLINK"}</span>
      </div>
    );
  }

  const label = down ? "RESTART\nFIRMWARE" : "STOP";
  return (
    <Hv as="div" onClick={down ? onFirmwareRestart : onEstop}
      style={`flex:none; width:96px; align-self:stretch; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; cursor:pointer; background:${C.accentBg2}; border-left:1px solid ${C.accentLine}; ${mono(down ? F.micro : F.chip, `letter-spacing:.16em; color:${C.accent}; text-align:center; line-height:1.15; white-space:pre-line`)}`}
      active={`background:${C.accent}; color:${C.void_}`}>
      {!down && <span style={S("font-size:15px; line-height:1")}>⏻</span>}
      <span>{label}</span>
    </Hv>
  );
}

/** The persistent bar. Printing => job readout; otherwise machine state + live badges. */
export function StatusBar({ st, meta, clock, onEstop, onFirmwareRestart, go, onTemp }) {
  const h = health(st);
  const j = job(st, meta);
  const t = temps(st);
  const m = mmu(st);
  const bs = badges(st);
  const dotCol = h.level !== "ok" ? C.accent : j.paused ? C.bed : j.active ? C.cool : C.dim;

  return (
    <div style={S(`height:${L.bar}px; flex:none; display:flex; align-items:stretch; background:${C.barBg}; border-bottom:1px solid ${C.line2}; position:relative; z-index:5`)}>
      <div style={S(`flex:1; min-width:0; display:flex; align-items:center; gap:14px; padding:0 14px`)}>
        <span style={S(`width:9px; height:9px; border-radius:50%; flex:none; background:${dotCol}${j.active && !j.paused ? "; animation:ksPulse 1.6s ease-in-out infinite" : ""}`)} />

        {h.level !== "ok" ? (
          <div style={S("min-width:0; display:flex; flex-direction:column; gap:2px")}>
            <div style={S(mono(F.label, `letter-spacing:.14em; color:${C.accent}`))}>{h.label}</div>
            {h.detail ? <div style={S(mono(F.micro, `color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:520px`))}>{h.detail}</div> : null}
          </div>
        ) : j.active ? (
          <>
            <div onClick={() => go("job")} style={S("min-width:0; display:flex; flex-direction:column; gap:2px; cursor:pointer")}>
              <div style={S(mono(F.label, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:250px`))}>{j.file || "—"}</div>
              <div style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}`))}>{j.layerLabel}</div>
            </div>
            <div style={S(`flex:1; min-width:40px; height:8px; border-radius:4px; background:${C.track}; border:1px solid ${C.line3}; overflow:hidden`)}>
              <div style={S(`height:100%; width:${Math.max(0, Math.min(100, j.pct))}%; background:linear-gradient(90deg,${C.accent},${C.hot}); transition:width .4s linear`)} />
            </div>
            <div style={S(mono(F.num2, `color:${C.accent}; letter-spacing:.04em`))}>{j.pctLabel}</div>
          </>
        ) : (
          <>
            <div style={S(mono(F.label, `letter-spacing:.16em; color:${C.cool}`))}>READY</div>
            <div style={S(mono(F.val, `color:${C.text}`))}>{clock}</div>
            <div style={S("flex:1; min-width:0; display:flex; align-items:center; gap:8px; overflow:hidden")}>
              {bs.map(b => <span key={b.text} style={S(badgeStyle(b.kind))}>{b.text}</span>)}
            </div>
          </>
        )}

        <div style={S(`width:1px; align-self:stretch; margin:13px 0; background:${C.line3}`)} />
        <div style={S(`display:flex; gap:8px; flex:none; white-space:nowrap; ${mono(F.label)}`)}>
          {/* Tappable, as KlipperScreen's titlebar was. 44px x 56px inside a 52px bar
              is 6.6 x 8.4 mm -- under the 48px floor, which a 52px bar cannot reach,
              so these stay SECONDARY: every one of them is also reachable at full
              size on the TEMP screen. They are a shortcut, never the only route. */}
          <Hv as="span" onClick={onTemp ? () => onTemp("nozzle") : undefined}
            style={`display:flex; align-items:center; justify-content:center; gap:5px; height:44px; min-width:56px; padding:0 10px; border-radius:5px; color:${C.dim}; cursor:${onTemp ? "pointer" : "default"}`}
            active={`background:${C.line1}`}>N <span style={S(`color:${C.hot}`)}>{t.nozzle.cur.toFixed(0)}</span></Hv>
          <Hv as="span" onClick={onTemp ? () => onTemp("bed") : undefined}
            style={`display:flex; align-items:center; justify-content:center; gap:5px; height:44px; min-width:56px; padding:0 10px; border-radius:5px; color:${C.dim}; cursor:${onTemp ? "pointer" : "default"}`}
            active={`background:${C.line1}`}>B <span style={S(`color:${C.bed}`)}>{t.bed.cur.toFixed(0)}</span></Hv>
          {/* Chamber is a sensor on this printer -- no heater, so nothing to tap. */}
          <span style={S(`padding:6px 4px; color:${C.dim}`)}>C <span style={S(`color:${C.cool}`)}>{t.chamber.cur.toFixed(0)}</span></span>
          {/* Tool AND gate: under an MMU_TTG_MAP remap T5 may feed from gate 2, and the old "G T5" put a tool
              number under a gate label. */}
          {m.present ? <span style={S(`padding:6px 4px; color:${C.cool}`)}>{toolGateLabel(m)}</span> : null}
        </div>
        {j.active ? (
          <>
            <div style={S(`width:1px; align-self:stretch; margin:13px 0; background:${C.line3}`)} />
            <div style={S(mono(F.label, `color:${C.dim}`))}>ETA <span style={S(`color:${C.text}`)}>{j.etaLabel}</span></div>
          </>
        ) : null}
      </div>
      <EStop st={st} onEstop={onEstop} onFirmwareRestart={onFirmwareRestart} />
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Corner button + rail. Three FAB states so a 3-tier tree needs only this one control. */
export function Nav({ screen, open, setOpen, go, parent }) {
  const atHome = screen === "home";
  const inMore = !atHome && !RAIL_KEYS.has(screen);
  const glyph = atHome ? (open ? "✕" : "☰") : inMore ? "‹" : "⌂";
  const corner = () => {
    if (atHome) { setOpen(!open); return; }
    if (inMore && parent) { go(parent); return; }
    go("home");
  };
  return (
    <nav style={S(`position:absolute; z-index:30; display:flex; align-items:stretch; ${open
      ? `left:0; right:0; bottom:0; height:${L.nav}px; background:${C.barBg}; border-top:1px solid ${C.line2};`
      : `left:${L.fabInset}px; bottom:${L.fabInset}px; width:${L.fab}px; height:${L.fab}px;`}`)}>
      <Hv as="div" onClick={corner}
        style={`flex:none; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:background .14s; ${open
          ? `width:${L.navCorner}px; background:transparent; border-right:1px solid ${C.line1};`
          : `width:${L.fab}px; background:${C.panelHead}; border:1px solid ${C.line4}; border-radius:12px; box-shadow:0 10px 26px rgba(0,0,0,.6);`}`}
        active={`background:${C.line1}`}>
        <span style={S(mono(22, `line-height:1; color:${open || !atHome ? C.accent : C.dim}`))}>{glyph}</span>
      </Hv>
      <div style={S(`flex:1; min-width:0; display:flex; overflow:hidden; pointer-events:${open ? "auto" : "none"}`)}>
        {RAIL.map(([k, label, g], i) => {
          const on = screen === k || (k === "more" && inMore);
          return (
            <Hv as="div" key={k} onClick={() => { go(k); setOpen(false); }}
              style={`position:relative; flex:none; width:${L.navItem}px; display:flex; align-items:center; justify-content:center; gap:9px; border-right:1px solid ${C.line1}; cursor:pointer; background:${on ? C.navOn : "transparent"}; opacity:${open ? 1 : 0}; transform:translateX(${open ? "0" : "-18px"}); transition:opacity .2s ease ${i * 26}ms, transform .24s cubic-bezier(.3,1.1,.5,1) ${i * 26}ms, background .14s`}
              active={`background:${C.line1}`}>
              <span style={S(mono(17, `line-height:1; color:${on ? C.accent : C.mute}`))}>{g}</span>
              <span style={S(mono(F.label, `letter-spacing:.14em; color:${on ? C.text : C.mute}`))}>{label}</span>
              <span style={S(`position:absolute; top:0; left:0; right:0; height:2px; background:${on ? C.accent : "transparent"}`)} />
            </Hv>
          );
        })}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
export function Toast({ text }) {
  if (!text) return null;
  return (
    <div style={S(`position:absolute; left:50%; bottom:${L.nav + 56}px; z-index:40; display:flex; align-items:center; gap:11px; padding:13px 20px; border-radius:7px; background:${C.raised}; border:1px solid ${C.line4}; box-shadow:0 18px 40px rgba(0,0,0,.6); animation:ksToast 2.6s ease forwards`)}>
      <span style={S(`width:7px; height:7px; border-radius:50%; background:${C.accent}`)} />
      <span style={S(mono(F.label, `letter-spacing:.08em; color:${C.text}; white-space:nowrap`))}>{text}</span>
    </div>
  );
}

/** The export's confirm modal, with a 68px destructive button (10.2 mm). */
export function Confirm({ ask, onYes, onNo }) {
  if (!ask) return null;
  return (
    <div onClick={onNo} style={S("position:absolute; inset:0; z-index:60; background:rgba(4,6,9,.82); display:flex; align-items:center; justify-content:center; animation:ksFade .14s ease both")}>
      <div onClick={e => e.stopPropagation()} style={S(`width:560px; background:${C.panel}; border:1px solid ${C.line4}; border-radius:9px; box-shadow:0 30px 70px rgba(0,0,0,.7); overflow:hidden; animation:ksRise .18s ease both`)}>
        <div style={S(`display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid ${C.line2}; background:${C.panelHead}`)}>
          <span style={S(`width:3px; height:12px; background:${ask.danger ? C.accent : C.bed}; border-radius:1px`)} />
          <span style={S(mono(F.label, `letter-spacing:.18em; color:${C.text}`))}>{ask.title}</span>
        </div>
        <div style={S("padding:18px 16px; display:flex; flex-direction:column; gap:8px")}>
          <span style={S(`font-size:${F.val}px; color:${C.text}; text-wrap:pretty`)}>{ask.text}</span>
          {ask.cmd ? <span style={S(mono(F.label, `color:${C.mute}`))}>{ask.cmd}</span> : null}
        </div>
        <div style={S("display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:0 16px 16px")}>
          <Hv as="div" onClick={onNo} active="transform:translateY(1px)"
            style={`display:flex; align-items:center; justify-content:center; height:${TAP.danger}px; border:1px solid ${C.line3}; border-radius:7px; background:${C.panelHead}; ${mono(F.label, `letter-spacing:.18em; color:${C.dim}`)}; cursor:pointer`}>CANCEL</Hv>
          <Hv as="div" onClick={onYes} active="transform:translateY(1px)"
            style={`display:flex; align-items:center; justify-content:center; height:${TAP.danger}px; border:1px solid ${C.accentLine}; border-radius:7px; background:${C.accentBg}; ${mono(F.label, `letter-spacing:.18em; color:${C.accent}`)}; cursor:pointer`}>CONFIRM</Hv>
        </div>
      </div>
    </div>
  );
}

/** The 1024x600 frame. Fixed size: this is a kiosk on one known panel. */
export function Frame({ children }) {
  return (
    <div style={S(`width:${PANEL.w}px; height:${PANEL.h}px; position:relative; overflow:hidden; background:${C.bg}; color:${C.body}; font-family:${C.sans}; font-size:${F.body}px; display:flex; flex-direction:column; user-select:none; touch-action:manipulation`)}>
      <div style={S("position:absolute; inset:0; pointer-events:none; z-index:1; background:radial-gradient(1200px 600px at 50% -10%, rgba(255,90,51,.05), transparent 70%)")} />
      {children}
    </div>
  );
}
