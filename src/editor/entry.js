// CONFIG EDITOR bundle — CodeMirror 6, built by build.mjs into dist/editor.js as an IIFE.
//
// Loaded lazily by the Config page (<script src="editor.js"> on mount), never by app.js: it is ~130 KB
// gzipped against the app's ~60 KB and one page out of nine uses it. Exposes ONE global:
//
//   window.CarbonEditor.create(container, { doc, readOnly, filename, onChange })
//     -> { getValue(), setValue(s), setReadOnly(b), setLanguage(filename), focus(), destroy(), view }
//
// This file cannot import src/lib/design.jsx (that pulls React, which this bundle does not alias), so
// the palette below is a copy of T — keep it in step with design.jsx if the tokens ever change.
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment, Annotation } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { StreamLanguage, HighlightStyle, syntaxHighlighting, foldService, indentUnit } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { klipper } from "./klipper-mode.js";

const T = {
  bg: "#06080b", panel: "#0d121a", panel2: "#161d27", panel3: "#141b25", line: "#1c2430", line2: "#2c3746",
  text: "#e8eef6", body: "#c9d3e0", dim: "#8b98aa", mute: "#6b7789", faint: "#4d5a6b", ghost: "#3d4859",
  accent: "#ff5a33", ok: "#3ddcc4", warn: "#f0b429", info: "#5b7fd8", err: "#ff5a33",
  activeLine: "#10161f",
};
const MONO = "'JetBrains Mono', monospace";

// ---- theme: hairlines, no shadows, the design's greys; JetBrains Mono 12px ------------------
const theme = EditorView.theme({
  "&": { backgroundColor: T.panel, color: T.body, fontSize: "12px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { caretColor: T.accent, padding: "8px 0" },
  ".cm-line": { padding: "0 12px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: T.accent, borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: T.line },
  ".cm-activeLine": { backgroundColor: T.activeLine },
  ".cm-gutters": { backgroundColor: T.panel, color: T.faint, border: "none", borderRight: `1px solid ${T.line}`, fontSize: "11px" },
  ".cm-activeLineGutter": { backgroundColor: T.activeLine, color: T.dim },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px", minWidth: "40px" },
  // T.ghost measured 2.03:1 against the gutter — below AA for a control the user has to find and
  // click. T.mute clears 3:1 and still sits behind the line numbers; hover pulls it forward.
  ".cm-foldGutter .cm-gutterElement": { color: T.mute, padding: "0 4px" },
  ".cm-foldGutter .cm-gutterElement:hover": { color: T.text },
  ".cm-foldPlaceholder": { backgroundColor: T.panel2, border: `1px solid ${T.line2}`, color: T.dim, borderRadius: "3px", padding: "0 6px", margin: "0 4px" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: T.panel2, outline: `1px solid ${T.line2}` },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": { backgroundColor: "#1a0e09", outline: `1px solid #4a2318` },
  ".cm-selectionMatch": { backgroundColor: T.panel2 },
  ".cm-searchMatch": { backgroundColor: "#14100a", outline: `1px solid #3a2f14` },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#3a2f14" },
  ".cm-specialChar": { color: T.warn },
  // search / goto panels
  ".cm-panels": { backgroundColor: T.panel3, color: T.body, fontFamily: MONO, fontSize: "10.5px" },
  ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${T.line}` },
  ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${T.line}` },
  ".cm-panel.cm-search": { padding: "6px 10px" },
  ".cm-panel.cm-search label": { color: T.dim, fontSize: "10px", letterSpacing: ".06em" },
  ".cm-textfield": { backgroundColor: T.panel, border: `1px solid ${T.line}`, color: T.body, fontFamily: MONO, fontSize: "11px", borderRadius: "3px", padding: "3px 6px" },
  ".cm-textfield:focus": { outline: "none", borderColor: T.line2 },
  ".cm-button": { backgroundImage: "none", backgroundColor: T.panel, border: `1px solid ${T.line}`, color: T.dim, fontFamily: MONO, fontSize: "9.5px", letterSpacing: ".1em", textTransform: "uppercase", borderRadius: "4px", padding: "4px 8px", cursor: "pointer" },
  ".cm-button:active": { backgroundImage: "none", backgroundColor: T.panel2 },
  ".cm-button:hover": { borderColor: T.line2, color: T.text },
  ".cm-panel button[name=close]": { color: T.mute, fontSize: "14px", padding: "0 6px" },
  // autocomplete / tooltips
  ".cm-tooltip": { backgroundColor: T.panel, border: `1px solid ${T.line}`, color: T.body, fontFamily: MONO, fontSize: "11px", borderRadius: "4px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: T.panel2, color: T.text },
  ".cm-completionLabel": { color: T.body },
  ".cm-completionMatchedText": { color: T.accent, textDecoration: "none" },
  ".cm-completionDetail": { color: T.mute, fontStyle: "normal" },
}, { dark: true });

// ---- highlight: section=accent, key=info, jinja=warn, gcode=ok, comment=mute, number=body -------
const highlight = HighlightStyle.define([
  { tag: t.heading, color: T.accent, fontWeight: "600" },
  { tag: t.propertyName, color: T.info },
  { tag: t.processingInstruction, color: T.warn },                         // {% %} { } delimiters
  { tag: [t.keyword, t.controlKeyword], color: T.warn },
  { tag: t.function(t.variableName), color: T.warn, fontStyle: "italic" }, // |filters
  { tag: t.macroName, color: T.ok },                                       // G1 / M104 / SET_LED / _MMU_*
  { tag: t.attributeName, color: T.dim },                                  // PARAM= and the X in X10
  { tag: t.number, color: T.body },
  { tag: t.string, color: T.body },
  { tag: t.atom, color: T.text },
  { tag: t.variableName, color: T.text },
  { tag: t.comment, color: T.mute },
  { tag: t.operator, color: T.dim },
  { tag: [t.punctuation, t.bracket], color: T.dim },
  { tag: t.invalid, color: T.err, textDecoration: "underline dotted" },
  // fallbacks for the plain-INI files and anything a mode names generically
  { tag: t.definition(t.variableName), color: T.info },
  { tag: t.typeName, color: T.info },
  { tag: t.tagName, color: T.accent },
]);

// ---- folding: a [section] folds to the next header, a key folds its indented body ----------------
const klipperFold = foldService.of((state, from) => {
  const doc = state.doc;
  const line = doc.lineAt(from);
  const text = line.text;
  const header = /^\[/.test(text);
  if (!header && !/^[A-Za-z_][\w.\-]*\s*[:=]/.test(text)) return null;
  let last = line.number;
  for (let n = line.number + 1; n <= doc.lines; n++) {
    const l = doc.line(n).text;
    if (!l.trim()) continue;                                    // blank lines belong to whatever encloses them
    if (header ? /^\[/.test(l) : !/^\s/.test(l)) break;
    last = n;
  }
  if (last <= line.number) return null;
  return { from: line.to, to: doc.line(last).to };
});

// ---- language by file name ------------------------------------------------------------------
const klipperLang = StreamLanguage.define(klipper);
/** Klipper/INI for everything the config root actually holds; plain text only for what is clearly not config. */
function languageFor(filename) {
  const n = String(filename || "").toLowerCase();
  if (/\.(md|txt|log|json|js|css|html|py|sh|ya?ml)$/.test(n)) return [];
  return [klipperLang, klipperFold];
}

/** Transactions carrying this annotation came from setValue(), not the user — onChange stays quiet. */
const External = Annotation.define();

function readOnlyExt(ro) { return [EditorState.readOnly.of(!!ro), EditorView.editable.of(!ro)]; }

function create(container, opts) {
  const o = opts || {};
  const roComp = new Compartment(), langComp = new Compartment();
  const onChange = typeof o.onChange === "function" ? o.onChange : null;
  const state = EditorState.create({
    doc: String(o.doc == null ? "" : o.doc),
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),          // Klipper indents every gcode: body — Tab must indent, not leave the editor
      indentUnit.of("  "),
      theme,
      syntaxHighlighting(highlight),
      langComp.of(languageFor(o.filename)),
      roComp.of(readOnlyExt(o.readOnly)),
      EditorView.updateListener.of(u => {
        if (!u.docChanged || !onChange) return;
        if (u.transactions.some(tr => tr.annotation(External))) return;
        try { onChange(u.state.doc.toString()); } catch (e) { console.warn("[editor] onChange", e); }
      }),
    ],
  });
  const view = new EditorView({ state, parent: container });
  return {
    view,
    getValue() { return view.state.doc.toString(); },
    setValue(s) {
      const next = String(s == null ? "" : s);
      if (next === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, annotations: External.of(true), selection: { anchor: 0 }, scrollIntoView: true });
    },
    setReadOnly(b) { view.dispatch({ effects: roComp.reconfigure(readOnlyExt(b)) }); },
    setLanguage(filename) { view.dispatch({ effects: langComp.reconfigure(languageFor(filename)) }); },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}

if (typeof window !== "undefined") {
  window.CarbonEditor = { create, version: "cm6", languageFor: name => (languageFor(name).length ? "klipper" : "plain") };
}
