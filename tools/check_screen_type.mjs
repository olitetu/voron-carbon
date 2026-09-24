#!/usr/bin/env node
// Guards the one contract the whole 1024x600 layout rests on: NOTHING below 12px.
//
// JetBrains Mono's cap height is 0.73em; on this 7" 1024x600 panel (0.1498 mm/px)
// 12px is ~1.31 mm of cap, about 10 arcminutes at arm's length -- roughly what
// KlipperScreen's own 22.2px GTK text achieves here. Below that it stops being
// readable on the glass, and the failure is invisible from a laptop.
//
// Run by `npm run build`. Exits non-zero on a violation.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src/screen";
const FLOOR = 12;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(p)) files.push(p);
  }
})(ROOT);

const bad = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    if (/check_screen_type|FLOOR|F_FLOOR/.test(line)) return;
    for (const m of line.matchAll(/mono\(\s*([0-9]+(?:\.[0-9]+)?)\s*[,)]/g)) {
      if (parseFloat(m[1]) < FLOOR) bad.push({ f, line: i + 1, what: m[0], size: m[1] });
    }
    for (const m of line.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)) {
      if (parseFloat(m[1]) < FLOOR) bad.push({ f, line: i + 1, what: m[0], size: m[1] });
    }
  });
}

if (bad.length) {
  console.error(`\n[check_screen_type] ${bad.length} font size(s) below the ${FLOOR}px floor:\n`);
  for (const b of bad) console.error(`  ${relative(".", b.f)}:${b.line}  ${b.what}  (${b.size}px)`);
  console.error(`\nUse the F scale from src/screen/tokens.js. If a size genuinely must be`);
  console.error(`smaller, it is decoration and should not be text.\n`);
  process.exit(1);
}
console.log(`[check_screen_type] ok — ${files.length} files, nothing below ${FLOOR}px`);
