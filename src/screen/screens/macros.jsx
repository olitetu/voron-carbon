// ---------------------------------------------------------------------------
// MACROS — ported from the export, reflowed to 1024x600.
//
// The export hand-authored 38 macros with 38 hand-drawn icons, and several of them
// do not exist on this printer (Z_TILT_ADJUST, SCREWS_TILT_CALCULATE, PARK_TOOLHEAD,
// SET_LED, CLEAN_NOZZLE). This is data-driven off the live list instead -- 72 public
// gcode_macro names -- with icons assigned by name pattern and a fallback glyph, so
// it cannot drift from the machine and cannot offer a command that isn't there.
//
// KlipperScreen shows 64 of the 72: it drops leading-underscore names (so do we,
// they are internal), LOAD_FILAMENT/UNLOAD_FILAMENT, and anything with
// rename_existing. We keep the rest and let the category chips do the filtering.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { Chip, Empty } from "../parts.jsx";
import { ICONS } from "../icons.js";
import { ConfirmBox } from "./move.jsx";

/** [category, test, icon] — first match wins, so order matters. */
const RULES = [
  ["MMU", /^MMU|^EREC|^T\d+$/, "mmu"],
  ["PURGE", /^BLOBIFIER|PURGE|SCRUB|^LINE_|^VORON_/, "purge"],
  ["CALIBRATE", /CALIBRATE|^G32$|QUAD_GANTRY|BED_MESH|Z_OFFSET|SHAPER|PID|PROBE|CARTOGRAPHER/, "calibrate"],
  ["MOTION", /^G2[89]$|^CG28$|^SMART_HOME$|^M84$|PARK|^HOME/, "move"],
  ["PRINT", /^PRINT_|^PAUSE$|^RESUME$|^CANCEL|SET_PAUSE|SET_PRINT|^M486$|EXCLUDE/, "print"],
  ["TIMELAPSE", /TIMELAPSE|HYPERLAPSE|STREAM/, "camera"],
  ["MATERIAL", /MATERIAL|SPOOL|FILAMENT/, "spool"],
];
const CAT_ORDER = ["ALL", "MMU", "PRINT", "MOTION", "CALIBRATE", "PURGE", "MATERIAL", "TIMELAPSE", "OTHER"];

/** Macros that move hardware enough to deserve a confirm before running blind. */
const NEEDS_CONFIRM = /^MMU_(HOME|RESET|EJECT|CHECK|CALIBRATE|SOAKTEST)|^M84$|CALIBRATE|^G32$|QUAD_GANTRY|^PRINT_(START|END)|^CANCEL|^BLOBIFIER$|COLD_PULL|^Z_OFFSET_SAVE/;

function classify(name) {
  const n = String(name).toUpperCase();
  for (const [cat, re, icon] of RULES) if (re.test(n)) return { cat, icon };
  return { cat: "OTHER", icon: "macro" };
}

export default function Macros({ st, act }) {
  const [cat, setCat] = React.useState("ALL");
  const [confirm, setConfirm] = React.useState(null);

  const all = React.useMemo(() => (st.macros || [])
    .filter(n => !n.startsWith("_") && !/^(LOAD|UNLOAD)_FILAMENT$/.test(n))
    .map(n => Object.assign({ name: n }, classify(n)))
    .sort((a, b) => a.name.localeCompare(b.name)), [st.macros]);

  const cats = React.useMemo(() => {
    const present = new Set(all.map(m => m.cat));
    return CAT_ORDER.filter(c => c === "ALL" || present.has(c));
  }, [all]);

  const list = cat === "ALL" ? all : all.filter(m => m.cat === cat);

  const fire = m => {
    if (NEEDS_CONFIRM.test(m.name)) {
      setConfirm({ label: m.name, cmd: m.name, guards: { whilePrinting: false },
        confirm: `Run ${m.name}? It moves the machine.` });
      return;
    }
    act.guarded(m.name, {});
  };

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>
      <div style={S("flex:none; display:flex; align-items:center; gap:7px; overflow:hidden")}>
        {cats.map(c => (
          <Chip key={c} label={c} on={cat === c} onTap={() => setCat(c)} h={TAP.min} fs={F.label} flex={0} minW={86} />
        ))}
        <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.faint}`)}; white-space:nowrap`)}>{list.length} MACROS</span>
      </div>

      {!list.length ? (
        <div style={S(panel("flex:1; min-height:0"))}>
          <Empty title="NO MACROS" hint={st.macros ? "Nothing in this category." : "Waiting for the macro list from Klipper."} />
        </div>
      ) : (
        <div className="scroll" style={S(`flex:1; min-height:0; overflow-y:auto; margin-bottom:${L.fab + L.fabInset - L.pad}px`)}>
          <div style={S("display:grid; grid-template-columns:repeat(5,1fr); gap:8px")}>
            {list.map(m => (
              <Hv as="div" key={m.name} onClick={() => fire(m)} hover={`border-color:${C.line5}`} active="transform:translateY(2px)"
                style={`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; height:96px; padding:0 8px; border-radius:${L.radius}px; background:${C.panel}; border:1px solid ${C.line2}; cursor:pointer; transition:border-color .16s`}>
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke={C.accent} strokeWidth="1.5"
                  strokeLinecap="round" strokeLinejoin="round" style={S("display:block; flex:none")}>
                  <path d={ICONS[m.icon] || ICONS.macro} />
                </svg>
                <span style={S(mono(F.micro, `letter-spacing:.02em; color:${C.text}; text-align:center; word-break:break-word; line-height:1.3`))}>{m.name}</span>
              </Hv>
            ))}
          </div>
        </div>
      )}

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); act.guarded(c.cmd, c.guards); }} />
      ) : null}
    </div>
  );
}
