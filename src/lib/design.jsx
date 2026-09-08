// Shared design primitives — the dashboard's visual vocabulary as components, so every page matches.
import React from "react";
import { S, Hv } from "./ui.js";
export const T = {
  bg: "#06080b", panel: "#0d121a", panel2: "#161d27", panel3: "#141b25", line: "#1c2430", line2: "#2c3746",
  text: "#e8eef6", body: "#c9d3e0", dim: "#8b98aa", mute: "#6b7789", faint: "#4d5a6b", ghost: "#3d4859",
  accent: "#ff5a33", ok: "#3ddcc4", warn: "#f0b429", info: "#5b7fd8", err: "#ff5a33",
  mono: "'JetBrains Mono',monospace", sans: "Barlow, system-ui, sans-serif",
};
export const mono = (size = 10, extra = "") => `font-family:${T.mono}; font-size:${size}px; ${extra}`;

/** Panel with the design's header: 3×11 accent bar + mono uppercase label + optional right-side slot. */
export function Panel({ title, accent = T.accent, right, children, style, bodyStyle, flat }) {
  return (
    <section style={S(`background:${T.panel}; border:1px solid ${T.line}; border-radius:6px; display:flex; flex-direction:column; min-width:0; min-height:0; ${style || ""}`)}>
      <header style={S(`display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid ${T.line}; flex:none`)}>
        <div style={S(`width:3px; height:11px; background:${accent}; border-radius:1px`)} />
        <div style={S(`${mono(10, `letter-spacing:.16em; color:${T.dim}`)}`)}>{title}</div>
        <div style={S("margin-left:auto; display:flex; align-items:center; gap:8px; min-width:0")}>{right}</div>
      </header>
      <div style={S(`flex:1; min-height:0; ${flat ? "" : "padding:10px 12px;"} ${bodyStyle || ""}`)}>{children}</div>
    </section>
  );
}
/** Mono button. kind: default | accent | ok | warn | danger | ghost */
export function Btn({ children, onClick, kind = "default", small, disabled, style, title }) {
  const k = { default: [T.line, T.panel, T.dim], accent: ["#4a2318", "#1a0e09", T.accent], ok: ["#1c3d37", "#0f2320", T.ok], warn: ["#3a2f14", "#14100a", T.warn], danger: ["#4a1d13", "#1a0c08", T.err], ghost: ["transparent", "transparent", T.mute] }[kind];
  return (
    <Hv as="button" title={title} disabled={disabled} onClick={disabled ? undefined : onClick}
      style={`padding:${small ? "4px 8px" : "6px 11px"}; border:1px solid ${k[0]}; background:${k[1]}; border-radius:4px; ${mono(small ? 9 : 9.5, `letter-spacing:.1em; color:${k[2]}`)}; cursor:${disabled ? "not-allowed" : "pointer"}; opacity:${disabled ? .45 : 1}; transition:.12s; white-space:nowrap; ${style || ""}`}
      hover={disabled ? "" : `border-color:${T.line2}; color:${T.text}`} active="transform:translateY(1px)">{children}</Hv>
  );
}
export function Chip({ children, color = T.dim, bg, border, pulse, style }) {
  return <span style={S(`display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:3px; border:1px solid ${border || T.line}; background:${bg || T.panel}; ${mono(9, `letter-spacing:.08em; color:${color}`)}; white-space:nowrap; ${style || ""}`)}>
    {pulse !== undefined && <span style={S(`width:5px; height:5px; border-radius:50%; background:${color}${pulse ? "; animation:vPulse 1.4s ease-in-out infinite" : ""}`)} />}{children}</span>;
}
// T.faint (#4d5a6b) on T.panel measures 2.67:1 — under the 3:1 floor for non-decorative text, and Label is
// EVERY mono micro-label in the app. T.mute (#6b7789) clears it at 3.6:1 and is still visibly a sub-label.
export function Label({ children, style }) { return <div style={S(`${mono(9, `letter-spacing:.14em; color:${T.mute}`)}; ${style || ""}`)}>{children}</div>; }
export function Val({ children, size = 12, color = T.text, style }) { return <span style={S(`${mono(size, `color:${color}`)}; ${style || ""}`)}>{children}</span>; }
export function Row({ children, gap = 8, style, align = "center" }) { return <div style={S(`display:flex; align-items:${align}; gap:${gap}px; min-width:0; ${style || ""}`)}>{children}</div>; }
export function Divider() { return <div style={S(`height:1px; background:${T.line}; margin:8px 0`)} />; }
export function Input({ value, onChange, onEnter, placeholder, style, mono: m = true, type = "text", ...rest }) {
  return <input type={type} value={value} placeholder={placeholder} onChange={onChange} {...rest}
    onKeyDown={e => { if (e.key === "Enter" && onEnter) onEnter(e); rest.onKeyDown && rest.onKeyDown(e); }}
    style={S(`background:${T.panel}; border:1px solid ${T.line}; border-radius:3px; padding:5px 8px; outline:none; color:${T.body}; ${m ? mono(11) : `font-family:${T.sans}; font-size:12px`}; ${style || ""}`)} />;
}
export function Toggle({ on, onClick }) {
  return <div onClick={onClick} style={S(`width:26px; height:14px; border-radius:8px; cursor:pointer; background:${on ? "rgba(61,220,196,.25)" : T.panel2}; border:1px solid ${on ? "#2d6b60" : T.line}; display:flex; align-items:center; padding:1px; justify-content:${on ? "flex-end" : "flex-start"}`)}>
    <div style={S(`width:10px; height:10px; border-radius:50%; background:${on ? T.ok : T.ghost}`)} /></div>;
}
/** Simple table: cols = [{k, label, w, align, render}] */
export function Table({ cols, rows, rowKey, onRow, empty = "—", rowStyle }) {
  const grid = cols.map(c => c.w || "1fr").join(" ");
  return (
    <div style={S("display:flex; flex-direction:column; min-width:0")}>
      <div style={S(`display:grid; grid-template-columns:${grid}; gap:8px; padding:4px 8px; border-bottom:1px solid ${T.line}`)}>
        {cols.map(c => <div key={c.k} style={S(`${mono(8.5, `letter-spacing:.12em; color:${T.mute}`)}; text-align:${c.align || "left"}`)}>{c.label}</div>)}
      </div>
      {rows.length === 0 && <div style={S(`padding:14px 8px; ${mono(10, `color:${T.ghost}`)}`)}>{empty}</div>}
      {rows.map((r, i) => (
        <Hv key={rowKey ? rowKey(r, i) : i} as="div" onClick={onRow ? () => onRow(r) : undefined}
          style={`display:grid; grid-template-columns:${grid}; gap:8px; padding:6px 8px; border-bottom:1px solid ${T.line}22; align-items:center; ${onRow ? "cursor:pointer;" : ""} ${rowStyle ? rowStyle(r) : ""}`}
          hover={onRow ? "background:#0f151d" : ""}>
          {cols.map(c => <div key={c.k} style={S(`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:${c.align || "left"}; ${c.mono !== false ? mono(10.5, `color:${T.body}`) : `font-size:12px; color:${T.body}`}`)}>{c.render ? c.render(r) : r[c.k]}</div>)}
        </Hv>))}
    </div>);
}
export function Menu({ open, items, onClose, style }) {
  if (!open) return null;
  return <div style={S(`position:absolute; right:0; top:26px; z-index:40; min-width:150px; padding:4px; border:1px solid ${T.line}; border-radius:5px; background:${T.panel}; box-shadow:0 10px 24px rgba(0,0,0,.65); display:flex; flex-direction:column; gap:1px; animation:vRise .14s ease both; ${style || ""}`)}>
    {items.map((it, i) => <Hv key={i} as="div" onClick={() => { it.go && it.go(); onClose && onClose(); }} style={`padding:5px 8px; border-radius:3px; cursor:pointer; ${mono(9.5, `color:${it.color || T.mute}`)}; white-space:nowrap`} hover={`background:${T.panel3}; color:${T.text}`}>{it.t}</Hv>)}
  </div>;
}
/** Confirm strip (design's exclude-object confirm pattern). */
export function Confirm({ text, onYes, onNo, yes = "CONFIRM", no = "CANCEL" }) {
  return <div style={S("flex:none; padding:12px 14px; border-top:1px solid #3a2f14; background:#14100a; display:flex; align-items:center; gap:14px; animation:vRise .16s ease both")}>
    <div style={S(`flex:1; font-size:12px; color:${T.body}`)}>{text}</div><Btn kind="warn" onClick={onYes}>{yes}</Btn><Btn onClick={onNo}>{no}</Btn></div>;
}
export const fmtDur = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
export const fmtBytes = b => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(2) + " GB";
export const fmtDate = t => { const d = new Date(t * 1000); return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
