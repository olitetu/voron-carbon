// Klipper config — a STATEFUL StreamLanguage tokenizer for CodeMirror 6.
//
// Why not a per-line regex: these files interleave INI with Jinja, and Jinja spans lines. A `{% if %}`
// opened on one line and closed three lines later, or a `{ printer... }` expression broken across a
// continuation line, only tokenizes correctly when the state (inside Jinja? inside a gcode: body?)
// carries from one line to the next — which is exactly what a StreamParser's state does.
//
// Grammar, from Klipper itself (klippy/configfile.py, klippy/extras/gcode_macro.py):
//   - configparser with inline_comment_prefixes=(';', '#'): `#` or `;` starts a comment at line start,
//     or anywhere when PRECEDED BY WHITESPACE ("#ff0000" glued to a quote is not a comment). Inside a
//     G-code body a bare `;` is a comment regardless — Klipper's gcode parser strips it.
//   - Jinja is Environment('{%', '%}', '{', '}'): expressions are SINGLE braces `{ printer.x }`,
//     statements `{% %}`, comments `{# #}`. A `{{` is just a nested brace pair, so depth is counted.
//   - Any key named `gcode` or `*_gcode` (press_gcode, resume_gcode…) opens a G-code body: the indented
//     lines that follow are G-code words + Jinja until the next top-level key or [section].
// Every other `.cfg` / `.conf` in the config root (moonraker.conf, crowsnest.conf, KlipperScreen.conf)
// is plain INI, which is the same grammar minus the gcode bodies — one mode covers them all.
import { tags as t } from "@lezer/highlight";

const GCODE_KEY = /^(gcode|[A-Za-z0-9_]*_gcode)$/i;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
const STRING = /^(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)/;      // unterminated runs to EOL, never across lines
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const KEY = /^[A-Za-z_][\w.\-]*(?=\s*[:=])/;

const CONTROL = new Set(["if", "elif", "else", "endif", "for", "endfor", "in", "set", "endset", "macro", "endmacro",
  "raw", "endraw", "block", "endblock", "with", "endwith", "call", "endcall", "filter", "endfilter", "include", "import", "from", "as", "break", "continue"]);
const KEYWORD = new Set(["and", "or", "not", "is", "recursive", "loop", "namespace", "range", "printer", "params", "rawparams"]);
const ATOM = /^(?:True|False|None|true|false|none)\b/;

/** `#`/`;` here only counts as a comment when whitespace precedes it (configparser's inline rule). */
function isComment(stream) {
  const ch = stream.peek();
  if (ch !== "#" && ch !== ";") return false;
  const prev = stream.pos > 0 ? stream.string.charAt(stream.pos - 1) : " ";
  return /\s/.test(prev);
}

function jinja(stream, state) {
  if (state.jinja === "comment") {
    if (stream.skipTo("#}")) { stream.match("#}"); state.jinja = null; } else stream.skipToEnd();
    return "comment";
  }
  // Config-level comments are stripped before Jinja ever sees the text, so they cut a block's line too;
  // the block itself stays open onto the next line.
  if (isComment(stream)) { stream.skipToEnd(); return "comment"; }
  if (state.jinja === "stmt") {
    if (stream.match(/^-?%}/)) { state.jinja = null; state.word = false; return "jinjaDelim"; }
  } else if (state.jinja === "expr") {
    if (stream.eat("{")) { state.depth++; return "bracket"; }
    if (stream.eat("}")) {
      if (--state.depth <= 0) { state.jinja = null; state.depth = 0; return "jinjaDelim"; }
      return "bracket";
    }
  }
  if (stream.match(STRING)) return "string";
  if (stream.match(NUMBER)) return "number";
  if (stream.match(ATOM)) return "atom";
  const id = stream.match(IDENT);
  if (id) {
    const w = id[0];
    if (state.filter) { state.filter = false; return "filter"; }
    if (CONTROL.has(w)) return "controlKeyword";
    if (KEYWORD.has(w)) return "keyword";
    return "variableName";
  }
  if (stream.eat("|")) { state.filter = true; return "operator"; }
  if (stream.match(/^(?:==|!=|<=|>=|\/\/|\*\*|[-+*/%<>=~])/)) return "operator";
  if (stream.match(/^[()[\]{},.:]/)) return "punctuation";
  stream.next();
  return null;
}

function gcode(stream, state) {
  if (stream.match("{#")) { state.jinja = "comment"; return "comment"; }
  if (stream.match("{%")) { state.jinja = "stmt"; state.filter = false; return "jinjaDelim"; }
  if (stream.eat("{")) { state.jinja = "expr"; state.depth = 1; state.filter = false; return "jinjaDelim"; }
  if (stream.peek() === ";" || isComment(stream)) { stream.skipToEnd(); return "comment"; }
  if (stream.match(STRING)) return "string";
  if (!state.word) {
    // The first word on a G-code line is the command: G1, M104, T0, SET_LED, _MMU_STEP_LOAD_GATE…
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_.\-]*/)) { state.word = true; return "macroName"; }
  } else {
    // Then parameters: PARAM=value, or the classic letter+number word (X10, E-1.5, F3000).
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*(?==)/)) return "attributeName";
    if (stream.eat("=")) return "punctuation";
    if (stream.match(/^[A-Za-z](?=[-+.\d])/)) return "attributeName";
    if (stream.match(NUMBER)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_.\-]*/)) return null;      // bare word value: FAN=Chamber
  }
  if (stream.match(NUMBER)) return "number";
  stream.next();
  return null;
}

/** A non-gcode value (or the tail of a header line). Braces are Python dict literals here, not Jinja. */
function value(stream, state) {
  if (stream.match("{#")) { state.jinja = "comment"; return "comment"; }
  if (stream.match("{%")) { state.jinja = "stmt"; state.filter = false; return "jinjaDelim"; }
  if (isComment(stream)) { stream.skipToEnd(); return "comment"; }
  if (stream.match(STRING)) return "string";
  if (stream.match(NUMBER)) return "number";
  if (stream.match(ATOM)) return "atom";
  if (stream.match(/^[A-Za-z_][A-Za-z0-9_.\-/~]*/)) return null;
  if (stream.match(/^[()[\]{},:]/)) return "punctuation";
  stream.next();
  return null;
}

export const klipper = {
  name: "klipper",
  startState() {
    return {
      jinja: null,     // null | "stmt" | "expr" | "comment" — carried across lines, the whole point
      depth: 0,        // brace depth inside an "expr" (single-brace expressions, so nesting is counted)
      filter: false,   // the identifier after a `|` is a Jinja filter
      gcode: false,    // inside a gcode: body — indented lines are G-code + Jinja
      line: null,      // what the rest of THIS line is: "value" | "gcode" | null
      key: false,      // a key was just read: the next `:`/`=` is its separator
      word: false,     // the command word of this G-code line has been seen; the rest are parameters
    };
  },
  token(stream, state) {
    if (stream.sol()) {
      state.key = false; state.word = false;
      const indented = stream.eatSpace();
      if (stream.eol()) return null;
      if (state.jinja || indented) {
        // Continuation: an indented line, or any line while a Jinja block is still open.
        state.line = state.gcode ? "gcode" : "value";
      } else {
        state.line = null;
        const ch = stream.peek();
        if (ch === "#" || ch === ";") { stream.skipToEnd(); return "comment"; }
        if (ch === "[") {
          state.gcode = false; state.line = "value";                  // the tail may carry `; a comment`
          if (!stream.skipTo("]")) { stream.skipToEnd(); return "heading"; }
          stream.eat("]");
          return "heading";
        }
        const m = stream.match(KEY);
        if (m) {
          state.key = true;
          state.gcode = GCODE_KEY.test(m[0]);
          state.line = state.gcode ? "gcode" : "value";
          return "propertyName";
        }
        // A top-level line that is neither header, key nor comment: Klipper rejects the file on it.
        state.gcode = false; state.line = "value";
        stream.skipToEnd();
        return "invalid";
      }
    }
    if (stream.eatSpace()) return null;
    if (stream.eol()) return null;
    if (state.jinja) return jinja(stream, state);
    if (state.key) { state.key = false; if (stream.eat(/[:=]/)) return "punctuation"; }
    if (state.line === "gcode") return gcode(stream, state);
    return value(stream, state);
  },
  // Blank lines are part of whatever encloses them (configparser: empty_lines_in_values), so the
  // state is deliberately left alone — a gcode body with a blank line in it is still a gcode body.
  blankLine() {},
  languageData: { commentTokens: { line: "#" } },
  tokenTable: {
    heading: t.heading, propertyName: t.propertyName, jinjaDelim: t.processingInstruction,
    keyword: t.keyword, controlKeyword: t.controlKeyword, filter: t.function(t.variableName),
    macroName: t.macroName, attributeName: t.attributeName, number: t.number, string: t.string,
    atom: t.atom, comment: t.comment, variableName: t.variableName, operator: t.operator,
    punctuation: t.punctuation, bracket: t.bracket, invalid: t.invalid,
  },
};

export default klipper;
