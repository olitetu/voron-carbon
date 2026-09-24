// ---------------------------------------------------------------------------
// On-screen keyboard.
//
// The design export contains ZERO text inputs across all 1678 lines, which makes
// a wifi password, a console command, a macro parameter and any arbitrary
// temperature impossible. KlipperScreen offers a keypad on temperature, fan,
// z-offset and speed; this is the replacement for that, plus the QWERTY the wifi
// panel needs and KlipperScreen also had.
//
// Two decisions worth stating:
//
//   THE VALUE LIVES IN THE KEYBOARD, not in the field behind it. A docked keyboard
//   on a 600px-tall panel will cover something, and chasing the caret around is
//   worse than simply showing what is being typed inside the keyboard itself. The
//   caller's field can be completely hidden and nothing is lost.
//
//   TEXT DEFAULTS TO UPPERCASE. Everything typed here that is not a password is
//   g-code or a macro name, and those are uppercase by convention -- so the common
//   case needs no shift. `password` mode starts lowercase, where case matters.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../lib/ui.js";
import { C, F, L, TAP, mono } from "./tokens.js";
import { microLabel } from "./vm.js";

const LETTERS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];
// Two symbol pages. The first holds what a Klipper user needs most: digits, parameter syntax and paths.
// The second holds the rest of printable ASCII, because a WPA2 passphrase is 8-63 characters from ANY of
// 0x20-0x7E, and a passphrase this panel cannot type is a network it cannot join. Between the letters, the
// two pages and SPACE, all 95 printable ASCII characters are reachable; the second page repeats a few
// common ones so a passphrase does not need a page flip for every character.
const SYMBOLS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "_", "=", "+", ".", ",", ":", ";", "/"],
  ["!", "@", "#", "$", "%", "&", "*", "?"],
];
const SYMBOLS2 = [
  ["(", ")", "[", "]", "{", "}", "<", ">", "^", "~"],
  ["'", "\"", "`", "\\", "|", ".", ",", "?", "!"],
  ["-", "_", "=", "+", "/", ":", ";"],
];
const PAGES = { letters: LETTERS, symbols: SYMBOLS, symbols2: SYMBOLS2 };

const KEY_H = 56;          // 8.4 mm — comfortably over the 48px floor
const GAP = 6;

function Key({ label, onTap, flex = 1, wide, tone, disabled }) {
  const bg = tone === "accent" ? C.accentBg : tone === "dim" ? C.panelSunk : C.panelHead;
  const bd = tone === "accent" ? C.accentLine : C.line3;
  const fg = tone === "accent" ? C.accent : tone === "dim" ? C.mute : C.body;
  return (
    <Hv as="div" onClick={disabled ? undefined : onTap}
      style={`flex:${wide ? wide : flex}; min-width:0; height:${KEY_H}px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; border-radius:${L.radiusSm}px; background:${bg}; border:1px solid ${bd}; ${mono(F.val, `color:${fg}`)}; cursor:${disabled ? "default" : "pointer"}; opacity:${disabled ? 0.4 : 1}; user-select:none`}
      active={disabled ? "" : `background:${C.accent}; color:${C.void_}; border-color:${C.accent}`}>
      <span>{label}</span>
    </Hv>
  );
}

function Row({ children }) {
  return <div style={S(`display:flex; gap:${GAP}px`)}>{children}</div>;
}

/**
 * @param req {mode:'numeric'|'text'|'password', label, value, unit, min, max, hint, allowNegative}
 */
export default function Keyboard({ req, onCommit, onCancel }) {
  const [val, setVal] = React.useState(String(req.value ?? ""));
  const [shift, setShift] = React.useState(false);
  const [page, setPage] = React.useState("letters");
  const [reveal, setReveal] = React.useState(false);
  // The field opens seeded with the CURRENT value so the user can see what they are
  // changing. The first keypress must therefore REPLACE it, not append to it --
  // otherwise seeding 0 and typing 245 gives "0245", and seeding 60 gives "60245".
  // Calculator behaviour, and the reason this flag exists.
  const [touched, setTouched] = React.useState(false);

  // A fresh request must not inherit the last one's buffer.
  React.useEffect(() => {
    setVal(String(req.value ?? ""));
    setShift(false); setPage("letters"); setReveal(false); setTouched(false);
  }, [req]);

  const numeric = req.mode === "numeric";
  const secret = req.mode === "password";

  const num = numeric ? parseFloat(val) : NaN;
  const outOfRange = numeric && val !== "" && Number.isFinite(num) &&
    ((req.min != null && num < req.min) || (req.max != null && num > req.max));
  const invalid = numeric && val !== "" && !Number.isFinite(num);
  const canCommit = val !== "" && !outOfRange && !invalid;

  const push = ch => setVal(v => {
    const base = touched ? v : "";
    setTouched(true);
    // A bare "." parses as NaN, so seed the zero the user means -- on the NUMBER pad only. In text and
    // password mode "." is just a character: a passphrase or file name may start with one, and seeding
    // "0." there made that first character impossible to type (backspace to empty, "." gave "0." again).
    if (numeric && ch === "." && base === "") return "0.";
    return (base + ch).slice(0, 128);
  });
  const back = () => { setTouched(true); setVal(v => v.slice(0, -1)); };
  const clear = () => { setTouched(true); setVal(""); };
  const commit = () => { if (canCommit) onCommit(numeric ? String(num) : val); };

  const shown = secret && !reveal ? "•".repeat(val.length) : val;

  // --- the value bar. Deliberately the tallest, brightest thing here: it is the
  //     only feedback the user gets, since their field may be behind the keyboard.
  const head = (
    <div style={S(`flex:none; display:flex; align-items:center; gap:12px; padding:0 4px 10px`)}>
      <span style={S(microLabel(C.dim))}>{req.label || "VALUE"}</span>
      <div style={S(`flex:1; min-width:0; display:flex; align-items:baseline; gap:8px; justify-content:flex-end`)}>
        <span style={S(mono(F.hero, `line-height:1; color:${outOfRange || invalid ? C.accent : C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; direction:${secret ? "ltr" : "ltr"}`))}>
          {shown || <span style={S(`color:${C.ghost}`)}>&mdash;</span>}
        </span>
        {req.unit ? <span style={S(mono(F.val, `color:${C.faint}`))}>{req.unit}</span> : null}
      </div>
      {secret ? (
        <Hv as="div" onClick={() => setReveal(r => !r)} active={`background:${C.line1}`}
          style={`flex:none; padding:8px 12px; border-radius:${L.radiusXs}px; border:1px solid ${C.line3}; background:${C.panelHead}; ${mono(F.micro, `letter-spacing:.14em; color:${C.dim}`)}; cursor:pointer`}>
          {reveal ? "HIDE" : "SHOW"}
        </Hv>
      ) : null}
      <span style={S(mono(F.micro, `letter-spacing:.1em; color:${outOfRange ? C.bed : C.faint}; white-space:nowrap`))}>
        {outOfRange ? `RANGE ${req.min ?? "-"}–${req.max ?? "-"}`
          : invalid ? "NOT A NUMBER"
          : req.hint || (numeric && (req.min != null || req.max != null) ? `${req.min ?? "-"}–${req.max ?? "-"}` : "")}
      </span>
    </div>
  );

  const actions = (
    <Row>
      <Key label="CANCEL" tone="dim" onTap={onCancel} flex={1} />
      <Key label="OK" tone="accent" onTap={commit} flex={1} disabled={!canCommit} />
    </Row>
  );

  if (numeric) {
    const pad = [["7", "8", "9"], ["4", "5", "6"], ["1", "2", "3"]];
    return (
      <div style={S(wrapStyle())}>
        {head}
        <div style={S(`display:flex; gap:${GAP * 2}px; justify-content:center`)}>
          <div style={S(`display:flex; flex-direction:column; gap:${GAP}px; width:420px`)}>
            {pad.map(r => <Row key={r[0]}>{r.map(d => <Key key={d} label={d} onTap={() => push(d)} />)}</Row>)}
            <Row>
              <Key label="0" onTap={() => push("0")} />
              <Key label="." onTap={() => { if (!touched || !val.includes(".")) push("."); }} />
              <Key label={"±"} tone="dim"
                onTap={() => { setTouched(true); setVal(v => (v.startsWith("-") ? v.slice(1) : "-" + v)); }}
                disabled={req.allowNegative === false} />
            </Row>
          </div>
          <div style={S(`display:flex; flex-direction:column; gap:${GAP}px; width:190px`)}>
            <Key label={"⌫"} tone="dim" onTap={back} />
            <Key label="CLEAR" tone="dim" onTap={clear} />
            <Key label="CANCEL" tone="dim" onTap={onCancel} />
            <Key label="OK" tone="accent" onTap={commit} disabled={!canCommit} />
          </div>
        </div>
      </div>
    );
  }

  const rows = PAGES[page] || LETTERS;
  // Text starts UPPER and password starts lower (see the header); shift flips whichever it is. The first
  // version had the test inverted, so text typed lowercase and a password opened in capitals.
  const upper = (req.mode === "text") !== shift;
  const cap = ch => (page === "letters" ? (upper ? ch.toUpperCase() : ch.toLowerCase()) : ch);

  return (
    <div style={S(wrapStyle())}>
      {head}
      <div style={S(`display:flex; flex-direction:column; gap:${GAP}px`)}>
        {rows.map((r, i) => (
          <Row key={i}>
            {i === 2 && page === "letters"
              ? <Key label={"⇧"} tone={shift ? "accent" : "dim"} onTap={() => setShift(s => !s)} flex={1.6} />
              : null}
            {/* Where shift sits on the letters page, the symbol pages flip between each other. */}
            {i === 2 && page !== "letters"
              ? <Key label={page === "symbols" ? "#+=" : "123"} tone="dim"
                  onTap={() => setPage(p => (p === "symbols" ? "symbols2" : "symbols"))} flex={1.6} />
              : null}
            {r.map(ch => <Key key={ch} label={cap(ch)} onTap={() => push(cap(ch))} />)}
            {i === 2 ? <Key label={"⌫"} tone="dim" onTap={back} flex={1.6} /> : null}
          </Row>
        ))}
        <Row>
          <Key label={page === "letters" ? "?123" : "ABC"} tone="dim"
            onTap={() => setPage(p => (p === "letters" ? "symbols" : "letters"))} flex={1.4} />
          <Key label="SPACE" onTap={() => push(" ")} flex={4} />
          <Key label="CLEAR" tone="dim" onTap={clear} flex={1.4} />
          <Key label="CANCEL" tone="dim" onTap={onCancel} flex={1.4} />
          <Key label="OK" tone="accent" onTap={commit} flex={1.6} disabled={!canCommit} />
        </Row>
      </div>
    </div>
  );
}

function wrapStyle() {
  return `position:absolute; left:0; right:0; bottom:0; z-index:70; padding:${L.pad}px; background:${C.raised}; border-top:1px solid ${C.line4}; box-shadow:0 -18px 40px rgba(0,0,0,.6); display:flex; flex-direction:column; animation:ksRise .16s ease both`;
}
