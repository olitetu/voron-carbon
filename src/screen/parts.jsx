// Shared pieces used by more than one screen. Extracted from screens/home.jsx so
// the filament path is ONE implementation — the design export had three copies of
// it (home, job, mmu) and they had already drifted apart.
import React from "react";
import { S, Hv } from "../lib/ui.js";
import { travelFromPos, phaseFromAction } from "../lib/hh.js";
import { C, F, L, TAP, mono, panel, panelHead } from "./tokens.js";

/** Lift a dark filament colour so a route stroke stays visible. Gate 4 here is
 *  #000000, which would otherwise draw as nothing at all. The export's own ink(). */
export function ink(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return C.dim;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum > 0.28) return "#" + h;
  const k = 0.62, mix = v => Math.round(v + (208 - v) * k);
  return "#" + [mix(r), mix(g), mix(b)].map(v => v.toString(16).padStart(2, "0")).join("");
}

export function gateColor(g) { return g && g.hasColor ? g.color : C.line4; }

/**
 * The 8-branch converging filament path, driven by real `filament_pos`.
 *
 * Two things the export did that are not reproduced:
 *   - three <animateMotion> elements whose keyPoints were `travel;travel` — both
 *     endpoints identical, so they animated nothing at full SMIL cost;
 *   - ksBlade/ksFlash looping forever behind opacity:0, which Chromium does not
 *     stop. The cutter group is only mounted while a cut is actually running.
 */
export function FilamentPath({ m, showCutter = false, cutting = false }) {
  const n = Math.max(1, m.n);
  const sel = Number.isFinite(m.gate) && m.gate >= 0 ? m.gate : 0;
  const selCol = ink(m.gates[sel] && m.gates[sel].hasColor ? m.gates[sel].color : C.dim);
  const travel = Math.max(0, Math.min(1, travelFromPos(m.filamentPos)));
  const phase = phaseFromAction(m.action);
  const flowing = phase !== "idle";
  const period = flowing ? ".9s" : "3.6s";
  const paused = flowing ? "" : "; animation-play-state:paused";
  const gx = ((sel + 0.5) / n * 900).toFixed(1);
  const head = `M ${gx} 2 L ${gx} 28 C ${gx} 58 450 44 450 68 L 450 94`;
  return (
    <svg viewBox="0 0 900 96" preserveAspectRatio="none"
      style={S("position:absolute; inset:0; width:100%; height:100%; display:block")}>
      {m.gates.map(g => {
        const x = ((g.i + 0.5) / n * 900).toFixed(1);
        const on = g.i === sel;
        return <path key={g.i} d={`M ${x} 2 L ${x} 28 C ${x} 58 450 44 450 68`} fill="none"
          stroke={on ? selCol : g.empty ? C.line2 : "#22303e"} strokeWidth={on ? 3.2 : 1.6}
          strokeLinecap="round" vectorEffect="non-scaling-stroke"
          opacity={on ? 1 : g.empty ? 0.4 : 0.8} strokeDasharray={on ? "10 8" : "0"}
          style={S(on ? `animation:ksDash ${period} linear infinite${paused}` : "")} />;
      })}
      <path d={head} fill="none" stroke="#131a24" strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <path d={head} fill="none" stroke={selCol} strokeWidth="3.4" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        pathLength="1" strokeDasharray={`${travel.toFixed(4)} 1`} style={S(travel === 0 ? "opacity:0" : "")} />
      <path d={head} fill="none" stroke={C.panel} strokeWidth="1.4" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        pathLength="1" strokeDasharray={travel > 0 ? "0.012 0.022" : "0 1"}
        style={S(`opacity:${travel > 0 && flowing ? 0.55 : 0}; animation:ksRoute ${period} linear infinite${paused}`)} />
      {showCutter && cutting ? (
        <g>
          <rect x="437" y="56" width="9" height="30" rx="2" fill="#151c25" stroke="#2c3746" strokeWidth="1" />
          <g style={S("animation:ksBlade 1.1s cubic-bezier(.3,0,.2,1) infinite")}>
            <polygon points="458,56 512,46 512,66 458,74" fill="#4a5563" />
            <polygon points="458,56 474,53 474,71 458,74" fill="#eef3f8" />
          </g>
        </g>
      ) : null}
    </svg>
  );
}

/** Tab strip that lives inside a panel header. */
export function Tabs({ tabs, active, onPick }) {
  return (
    <div style={S(`display:flex; gap:6px; margin-left:auto`)}>
      {tabs.map(([k, label]) => {
        const on = k === active;
        return (
          <Hv as="div" key={k} onClick={() => onPick(k)} active={`background:${C.line1}`}
            style={`display:flex; align-items:center; padding:0 12px; height:34px; border-radius:${L.radiusXs}px; cursor:pointer; ${mono(F.micro, `letter-spacing:.14em`)}; ${on
              ? `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent};`
              : `background:${C.panelSunk}; border:1px solid ${C.line3}; color:${C.mute};`}`}>
            {label}
          </Hv>
        );
      })}
    </div>
  );
}

/** A labelled value in the mono micro idiom. */
export function Stat({ k, v, color = C.body }) {
  return (
    <div style={S("display:flex; align-items:center; gap:7px; min-width:0")}>
      <span style={S(mono(F.micro, `letter-spacing:.12em; color:${C.faint}`))}>{k}</span>
      <span style={S(mono(F.label, `color:${color}; white-space:nowrap`))}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The design export's two workhorse controls, as components. Its `chip()` and
// `panelBtn()` built style strings by hand in every *Vals() function; these are
// the same visuals with the touch floor enforced in one place.
// ---------------------------------------------------------------------------

/** Selectable chip. The export's chip(): column layout, optional sub-label. */
export function Chip({ label, sub, on, onTap, h = TAP.min, fs = F.chip, flex = 1, minW = 0, disabled }) {
  return (
    <Hv as="div" onClick={disabled ? undefined : onTap}
      active={disabled ? "" : "transform:translateY(1px)"}
      style={`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; flex:${flex}; min-width:${minW}px; height:${h}px; padding:0 10px; border-radius:${L.radiusSm}px; ${mono(fs, "letter-spacing:.1em")}; cursor:${disabled ? "default" : "pointer"}; transition:background .14s, border-color .14s, color .14s; white-space:nowrap; opacity:${disabled ? 0.4 : 1}; ${on
        ? `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent}; box-shadow:inset 0 0 0 1px rgba(255,90,51,.18);`
        : `background:${C.panelHead}; border:1px solid ${C.line3}; color:${C.dim};`}`}>
      <span>{label}</span>
      {sub ? <span style={S(mono(F.micro, `color:${C.mute}; letter-spacing:.08em`))}>{sub}</span> : null}
    </Hv>
  );
}

/** Wide action button. tone: undefined | 'accent' | 'danger' */
export function PanelBtn({ label, sub, onTap, tone, h = TAP.min, disabled, why, glyph }) {
  const skin = tone === "accent" ? [C.accentBg, C.accentLine, C.accent]
    : tone === "danger" ? [C.accentBg2, C.accentLine, C.accent]
    : [C.panelHead, C.line3, C.dim];
  return (
    <Hv as="div" onClick={disabled ? undefined : onTap} title={why || undefined}
      active={disabled ? "" : "transform:translateY(1px)"}
      style={`display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; height:${h}px; border-radius:${L.radiusSm}px; background:${skin[0]}; border:1px solid ${skin[1]}; color:${skin[2]}; ${mono(F.label, "letter-spacing:.16em")}; cursor:${disabled ? "default" : "pointer"}; transition:background .14s; opacity:${disabled ? 0.42 : 1}; white-space:nowrap`}>
      {glyph ? <span style={S(mono(18, "line-height:1"))}>{glyph}</span> : null}
      <span>{label}</span>
      {sub ? <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.mute}`))}>{sub}</span> : null}
    </Hv>
  );
}

/** Panel with the design's header: 3px accent bar + letterspaced mono caps label. */
export function Panel({ title, right, children, style, bodyStyle, accent = C.accent }) {
  return (
    <div style={S(panel(style || ""))}>
      {title ? (
        <div style={S(panelHead())}>
          <span style={S(`width:3px; height:12px; background:${accent}; border-radius:1px`)} />
          <span style={S(mono(F.micro, `letter-spacing:.18em; color:${C.dim}`))}>{title}</span>
          {right ? <div style={S("margin-left:auto; display:flex; align-items:center; gap:10px; min-width:0")}>{right}</div> : null}
        </div>
      ) : null}
      <div style={S(`flex:1; min-height:0; display:flex; flex-direction:column; ${bodyStyle || ""}`)}>{children}</div>
    </div>
  );
}

/** A bar. Used for temperatures, fans, spool fill. */
export function Bar({ pct, color = C.accent, h = 6, track = C.track }) {
  return (
    <div style={S(`height:${h}px; border-radius:${Math.ceil(h / 2)}px; background:${track}; overflow:hidden; flex:none`)}>
      <div style={S(`height:100%; width:${Math.max(0, Math.min(100, pct))}%; background:${color}; transition:width .4s linear`)} />
    </div>
  );
}

/** An honest empty state: says what is absent and what to do about it. */
export function Empty({ title, hint }) {
  return (
    <div style={S("flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:24px")}>
      <span style={S(mono(F.val, `letter-spacing:.2em; color:${C.mute}`))}>{title}</span>
      {hint ? <span style={S(mono(F.label, `color:${C.faint}; text-align:center; max-width:520px`))}>{hint}</span> : null}
    </div>
  );
}

/**
 * A g-code thumbnail box: the image OR the placeholder label, never both. Moonraker's .thumbs/ PNGs are
 * transparent, so a label mounted BEHIND the image (the first files-screen version) showed through every
 * real thumbnail. `failed` remembers which url 404'd -- plenty of older files here have none -- so the
 * label replaces that one, and a new url is tried afresh.
 */
export function Thumb({ url, size = 46, label = "GC" }) {
  const [failed, setFailed] = React.useState("");
  const show = !!url && failed !== url;
  return (
    <div style={S(`width:${size}px; height:${size}px; flex:none; border-radius:5px; border:1px solid ${C.line3}; background:${C.panelSunk}; overflow:hidden; display:flex; align-items:center; justify-content:center`)}>
      {show ? (
        <img key={url} src={url} alt="" loading="lazy" onError={() => setFailed(url)}
          style={S("width:100%; height:100%; object-fit:contain; display:block")} />
      ) : (
        <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.ghost}`))}>{label}</span>
      )}
    </div>
  );
}
