#!/usr/bin/env python3
"""Patch gcode-preview's dist bundle for two measured allocation defects in its tubes path.

Runs from `npm install` (package.json "postinstall") and is safe to run again: every patch applies exactly
once, an already-patched file is reported as such, and a MISSING ANCHOR FAILS LOUDLY (exit 1). A
gcode-preview bump therefore has to be re-verified against this file — it can never silently ship the
unpatched allocator. No gcode-preview installed at all is not an error: build.mjs then skips dist/viewer.js.

Verified against gcode-preview 3.0.0-alpha.5 + three 0.185.1 (BatchedMesh.addGeometry copies attribute
data and CLONES the bounds — it keeps no reference to the source geometry, which is what makes (1) safe).

  (1) Double-resident tube geometry.
      renderPathsAsTubes() pushes every per-path BufferGeometry onto `disposables`, then createBatchMesh()
      copies it into a BatchedMesh with addGeometry(). The per-path copy is dead the moment addGeometry
      returns, yet `disposables` pinned it until the next reset(): two copies of every tube stayed resident.
      Fix: do not register the per-path geometry; dispose() it right after addGeometry().

  (2) maxVertexCount passed as a float count.
      createBatchMesh() summed position.count * 3 for BatchedMesh's maxVertexCount. That parameter is a
      VERTEX count — three multiplies by itemSize itself — so every attribute buffer was allocated 3x too
      large, and the default maxIndexCount (= 2 * maxVertexCount) 6x. Fix: pass position.count, AND size the
      index buffer explicitly from the summed index counts. That second half is not optional: ExtrusionGeometry
      emits 48 indices per segment against 9 vertices per ring (~5.3 indices per vertex), more than the 2x
      default, so the 3x over-allocation was the only thing keeping addGeometry() from throwing "Reserved
      space request exceeds the maximum buffer size".

Usage: python3 tools/patch_gcode_preview.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "node_modules/gcode-preview/dist"
# build.mjs bundles the ESM entry ("main" in gcode-preview's package.json); it is the one that MUST patch.
# The UMD sibling is patched too when its anchors line up (same minifier, same local names) so a stray
# consumer never gets the old allocator, but nothing in this repo reads it, so it may not fail the run.
TARGETS = [(DIST / "gcode-preview.es.js", True), (DIST / "gcode-preview.js", False)]

# (label, original regex, replacement (re.sub syntax), text proving the patch is already in place)
# The BatchedMesh reference (`mi` in the ESM build, `u.BatchedMesh` in the UMD) is captured, not assumed.
PATCHES = [
    ("(1a) stop pinning per-path tube geometry in disposables",
     re.escape("n&&(this.disposables.push(n),i.push(n))}),this.createBatchMesh(i,e)}"),
     "n&&i.push(n)}),this.createBatchMesh(i,e)}",
     "n&&i.push(n)}),this.createBatchMesh(i,e)}"),
    ("(1b) dispose each per-path geometry right after BatchedMesh.addGeometry copies it",
     re.escape("const r=s.addGeometry(n);s.addInstance?.(r)}),s}"),
     "const r=s.addGeometry(n);s.addInstance?.(r),n.dispose()}),s}",
     "s.addInstance?.(r),n.dispose()}),s}"),
    ("(2) maxVertexCount = sum(position.count); maxIndexCount = sum(index.count)",
     re.escape("createBatchMesh(t,e){const i=t.reduce((n,r)=>r.attributes.position.count*3+n,0),s=new ")
     + r"([\w$.]+)" + re.escape("(t.length,i,void 0,e);"),
     "createBatchMesh(t,e){const i=t.reduce((n,r)=>r.attributes.position.count+n,0),"
     "o=t.reduce((n,r)=>(r.index?r.index.count:0)+n,0),s=new \\1(t.length,i,o>0?o:void 0,e);",
     "r.attributes.position.count+n,0),o=t.reduce((n,r)=>(r.index?r.index.count:0)+n,0),s=new "),
]


def patch_file(path, required):
    if not path.exists():
        print(f"[patch_gcode_preview] {path.relative_to(ROOT)}: not present — nothing to patch")
        return True
    src = path.read_text(encoding="utf-8")
    out, applied, already, missing = src, [], [], []
    for label, pattern, repl, proof in PATCHES:
        hits = re.findall(pattern, out)
        if len(hits) == 1:
            out = re.sub(pattern, repl, out, count=1)
            applied.append(label)
        elif len(hits) == 0 and proof in out:
            already.append(label)
        else:
            missing.append(f"{label}: found {len(hits)} match(es), expected exactly 1")
    rel = path.relative_to(ROOT)
    for l in already: print(f"[patch_gcode_preview] {rel}: already  {l}")
    for l in missing: print(f"[patch_gcode_preview] {rel}: MISSING  {l}")
    if missing:
        # All-or-nothing per file: a half-patched allocator is harder to reason about than an unpatched one.
        for l in applied: print(f"[patch_gcode_preview] {rel}: matched but NOT written  {l}")
        if required:
            print(f"[patch_gcode_preview] FAILED: {rel} no longer matches the anchors this patcher was verified "
                  f"against. Re-read gcode-preview's createBatchMesh/renderPathsAsTubes and update tools/patch_gcode_preview.py.")
            return False
        print(f"[patch_gcode_preview] {rel}: optional target left untouched (build.mjs does not bundle it)")
        return True
    if out != src:
        path.write_text(out, encoding="utf-8")
    for l in applied: print(f"[patch_gcode_preview] {rel}: applied  {l}")
    return True


ok = all([patch_file(p, req) for p, req in TARGETS])
sys.exit(0 if ok else 1)
