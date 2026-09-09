#!/usr/bin/env python3
"""Post-process the GENERATED Template.jsx: turn the design's hard-coded sample text into live bindings.

The design mockup baked real-looking values into the markup (filename, ETA, progress ring, layer counter,
Klipper version, uptime...). dc2jsx.py converts the markup mechanically, so those stay literals. This script
replaces each one with the V.* key an adapter provides.

Run after the converter:
    python3 tools/dc2jsx.py design-src/template_body.html src/pages/dashboard/Template.jsx
    python3 tools/patch_template.py

Idempotent, and it FAILS LOUDLY: every patch must apply exactly the expected number of times, so a design
re-export that changes this text can never silently leave a dead literal on screen.
"""
import re, sys, pathlib

T = pathlib.Path(__file__).resolve().parent.parent / "src/pages/dashboard/Template.jsx"
src = T.read_text(encoding="utf-8")
orig = src
applied, failed = [], []

# (label, needle, replacement, expected occurrences)
PATCHES = [
    # ---- shell: scanline overlay OFF ----
    # The design laid a 1 px / 3 px repeating white line over the whole app with mix-blend-mode:overlay.
    # Owner: "the little white lines in the blue background make it a bit weird to look at".
    ("scanline overlay",
     '''<div style={S("position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:60")}><div style={S("position:absolute; inset:0; background:repeating-linear-gradient(to bottom, rgba(255,255,255,.014) 0px, rgba(255,255,255,.014) 1px, transparent 1px, transparent 3px); mix-blend-mode:overlay")}></div></div>''',
     "", 1),
    # ---- shell: no overflow on the outer flex row ----
    # position:sticky sticks to the nearest ancestor with any overflow other than visible. The design put
    # overflow-x:auto on the outer row (so the 1340 px main could scroll sideways), which made THAT the sticky
    # container — and it never scrolls vertically, so the rail scrolled off with the page. The body handles
    # both axes fine on its own.
    ("shell overflow",
     '''letter-spacing:.01em; position:relative; overflow-x:auto")''',
     '''letter-spacing:.01em; position:relative")''', 1),
    # ---- shell: the nav rail sticks to the top while the page scrolls ----
    ("sticky nav rail",
     '''border-right:1px solid #161d27; display:flex; flex-direction:column; position:relative; z-index:5")''',
     '''border-right:1px solid #161d27; display:flex; flex-direction:column; position:sticky; top:0; height:100vh; overflow-y:auto; align-self:flex-start; z-index:5")''', 1),
    # ---- CURRENT JOB tiles: columns may shrink, so a long value clips instead of widening its column ----
    ("stat tile grid columns",
     '''<div style={S("flex:1; min-width:0; display:grid; grid-template-columns:1fr 1fr; gap:7px 10px")}>{(V.jobStats || []).map(''',
     '''<div style={S("flex:1; min-width:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:7px 10px")}>{(V.jobStats || []).map(''', 1),

    # ---- spool card name: keep the full name reachable once it is ellipsised ----
    ("spool card name title",
     '<div style={S(sp.nameStyle)}>{sp.name}</div>',
     '<div title={sp.name} style={S(sp.nameStyle)}>{sp.name}</div>', 1),

    # ---- CURRENT JOB stat tiles: unit as a smaller span ----
    # The tile is 77 px and the value is 13 px JetBrains Mono (7.8 px/char), so anything past 10 characters
    # WRAPS to a second line and breaks the row. "12.4 mm\u00b3/s" is exactly 78 px — and flow reaches double
    # digits precisely when speed goes above ~100 mm/s, which is when this shows up. Rendering the unit in
    # 9 px dim mono is the design's own idiom (the progress ring already does it for "%") and buys ~30 px:
    # "123.4" + " mm\u00b3/s" measures 71 px against the old 86 px.
    ("stat tile unit",
     '''<div style={S("font-family:\'JetBrains Mono\',monospace; font-size:13px; color:#e8eef6")}>{s.v}</div>''',
     '''<div style={S(s.vStyle || "font-family:\'JetBrains Mono\',monospace; font-size:13px; color:#e8eef6; white-space:nowrap")}>{s.v}{s.u ? <span style={S("font-size:9px; color:#6b7789; margin-left:2px")}>{s.u}</span> : null}</div>''', 1),

    # ---- sub-page slot ----
    # The design's only artboard is the dashboard, so the converter emits a "page under construction"
    # placeholder for every non-dashboard route. logic.jsx puts the real page element on V.page; without
    # this patch that value is assigned and never rendered, and all 8 sub-pages are invisible.
    # `V.page || <placeholder>` keeps the placeholder as the fallback for a route with no component.
    ("sub-page slot",   '{(V.isStub) ? (<>',                        "{(V.isStub) ? (V.page || <>", 1),

    # ---- sidebar identity + footer (adapter: shell) ----
    ("hostname",        '{"voron.local"}',                          "{V.hostname}", 1),
    ("klipper version", '<span style={S("color:#3ddcc4")}>{"v0.12.0"}</span>',
                        '<span style={S(V.klipperVersionStyle)}>{V.klipperVersion}</span>', 1),
    ("uptime",          '{"6d 04h"}',                               "{V.uptime}", 1),
    ("footer cpu label",'{"LOAD"}',                                 '{"CPU"}', 1),
    ("footer cpu value",'<span style={S("color:#8b98aa")}>{"0.42"}</span>',
                        '<span style={S(V.hostCpuStyle)}>{V.hostCpu}</span>', 1),
    # ---- top bar (adapters: job, shell) ----
    ("top bar filename",'{"Lightbox_Draft_ABS_9h28m.gcode"}',       "{V.topFile}", 1),
    ("save config",     '{"SAVE CONFIG"}',                          "{V.saveConfigLabel}", 1),
    # ---- top bar: UPLOAD & PRINT between SAVE CONFIG and EMERGENCY STOP (adapter: shell; state: logic.jsx) ----
    # The button doubles as the progress readout: a filling bar span sits behind the label (position:absolute,
    # no z-index), so the label / sub spans carry position:relative; z-index:1. Anchored on the two Hv that
    # flank it, which the "save config" patch above must already have bound.
    ("upload & print button",
     '''{V.saveConfigLabel}</Hv><Hv as="div" hover="background:#2a1109"''',
     '''{V.saveConfigLabel}</Hv><Hv as="div" hover={V.uploadHover} active="transform:translateY(1px)" onClick={V.uploadClick} title={V.uploadTitle} style={S(V.uploadStyle)}><span style={S(V.uploadBarStyle)}></span><span style={S(V.uploadLabelStyle)}>{V.uploadLabel}</span>{V.uploadSub ? <span style={S(V.uploadSubStyle)}>{V.uploadSub}</span> : null}</Hv><Hv as="div" hover="background:#2a1109"''', 1),
    # ---- drop-anywhere overlay + the hidden picker: first children of the shell root, so they exist on every route ----
    # The overlay is pointer-events:none — drops fall through to whatever is underneath and logic.jsx's window
    # listeners take them, so the overlay appearing under the cursor never churns dragenter/dragleave. Anchored on
    # the root style the "shell overflow" patch above produces.
    ("upload input + drop overlay",
     '''letter-spacing:.01em; position:relative")}><aside style={S("width:196px;''',
     '''letter-spacing:.01em; position:relative")}><input ref={V.uploadInputRef} type="file" accept=".gcode,.g,.gco" multiple onChange={V.uploadInputChange} style={S("display:none")} />{V.dropVisible ? <div style={S(V.dropOverlayStyle)}><div style={S(V.dropFrameStyle)}><div style={S(V.dropGlyphStyle)}>{V.dropGlyph}</div><div style={S(V.dropTitleStyle)}>{V.dropTitle}</div><div style={S(V.dropSubStyle)}>{V.dropSub}</div></div></div> : null}<aside style={S("width:196px;''', 1),
    # ---- CURRENT JOB panel (adapter: job) ----
    ("job eta",         '{"ETA 01:32"}',                            "{V.jobEta}", 1),
    ("job title",       '{"LIGHTBOX_DRAFT.3MF_ID_0_COPY_0"}',       "{V.jobTitle}", 1),
    ("job subline",     '{"TOTAL 5:04:30 \\u00b7 SLICER 4:43:13"}', "{V.jobSubline}", 1),
    ("job layer",       '{"LAYER 8/150"}',                          "{V.jobLayerShort}", 1),
    ("ring dash",       'strokeDasharray="270"',                    "strokeDasharray={V.jobRingDash}", 1),
    ("ring offset",     'strokeDashoffset="135"',                   "strokeDashoffset={V.jobRingOffset}", 1),
    ("progress bar",    'style={S("width:50%; height:100%; background:linear-gradient(90deg,#ff5a33,#ffa07f)")}',
                        "style={S(V.jobBarStyle)}", 1),

    # ---- SAVE CONFIG: bind the button's STYLE, not just its label (adapter: job) ----
    # adapters/job.js has always computed saveConfigStyle — amber + vGlow while Klipper has a config save
    # pending, amber while the two-step confirm is armed — but nothing bound it, so the button kept the
    # design's flat grey in all three states. A pending SAVE_CONFIG was invisible, and "CONFIRM
    # SAVE_CONFIG?" (one click away from restarting Klipper) looked exactly like the idle button.
    ("save config style",
     '''onClick={V.saveConfig} style={S("display:flex; align-items:center; gap:7px; padding:6px 12px; border:1px solid #1c2430; border-radius:4px; font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.1em; color:#8b98aa; cursor:pointer")}>{V.saveConfigLabel}''',
     '''onClick={V.saveConfig} style={S(V.saveConfigStyle)}>{V.saveConfigLabel}''', 1),

    # ---- MMU header status: colour + dot follow the state, not just the text (adapter: mmu) ----
    # The label was bound but its wrapper kept `color:#3ddcc4` and the dot kept an unconditional
    # `animation:vPulse …`, so "PAUSED · MMU ERROR" / "SHUTDOWN" / "MMU DISABLED" all rendered in the same
    # calm teal, and the dot pulsed forever on an idle machine. mmuStatusStyle / mmuStatusDotStyle exist
    # for exactly this (red when paused or shut down, grey when disabled, pulse only while something runs).
    ("mmu status style",
     '''<span style={S("display:flex; align-items:center; gap:6px; flex:none; white-space:nowrap; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.1em; color:#3ddcc4")}><span style={S("width:5px; height:5px; border-radius:50%; background:#3ddcc4; animation:vPulse 1.6s ease-in-out infinite")}></span>{V.mmuStatusLabel}''',
     '''<span style={S(V.mmuStatusStyle)}><span style={S(V.mmuStatusDotStyle)}></span>{V.mmuStatusLabel}''', 1),

    # ---- EXCLUDE OBJECTS: an empty state (adapter: job) ----
    # OBJECTS is clickable whatever the printer is doing, and exclude_object.objects is empty unless a job
    # that labels its objects is running — the modal then opened as a blank bed square beside a blank list.
    # (the needle swallows the start of the objects loop so the rule cannot match its own output — the
    #  header div alone would be re-found on every run and insert another copy)
    ("objects empty state",
     '{"OBJECTS ON PLATE"}</div>{(V.objects || []).map(',
     '{"OBJECTS ON PLATE"}</div>{V.objectsEmpty ? <div style={S(V.objectsEmptyStyle)}>{V.objectsEmpty}</div> : null}{(V.objects || []).map(', 1),

    # ---- TOOL & EXTRUDER footer: the design's mockup numbers (adapter: extruder) ----
    # "~1914 mm @ 24.1 mm³/s · ⌀ 0.4 mm" was a literal sitting under RETRACT / EXTRUDE, describing a move
    # nobody had picked and never changing with the LENGTH / FEEDRATE steppers right above it.
    ("extrude summary",
     '{"~1914 mm @ 24.1 mm\\u00b3/s \\u00b7 \\u2300 0.4 mm"}',
     "{V.extrudeSummary}", 1),

    # ---- top-bar alerts button (adapter: shell) ----
    # Shipped with a hard-coded accent "9+" badge and no onClick: every printer permanently claimed nine-plus
    # unread alerts, and the button that would show them did nothing. Now counts Moonraker's real
    # server_info warnings / failed components / missing Klippy requirements (+ Klipper not ready), hides the
    # badge when there is nothing to report, lists them in the title and opens MACHINE.
    ("alerts badge",
     '''<Hv as="div" hover="border-color:#2c3746" style={S("position:relative; width:28px; height:28px; border-radius:4px; border:1px solid #1c2430; display:flex; align-items:center; justify-content:center; font-size:12px; color:#8b98aa; cursor:pointer")}><span style={S("font-family:'JetBrains Mono',monospace; font-size:10px")}>{"!"}</span><span style={S("position:absolute; top:-5px; right:-5px; min-width:15px; height:15px; padding:0 3px; border-radius:8px; background:#ff5a33; color:#0a0c10; font-family:'JetBrains Mono',monospace; font-size:9px; font-weight:700; display:flex; align-items:center; justify-content:center")}>{"9+"}</span></Hv>''',
     '''<Hv as="div" hover="border-color:#2c3746" onClick={V.alertClick} title={V.alertTitle} style={S("position:relative; width:28px; height:28px; border-radius:4px; border:1px solid #1c2430; display:flex; align-items:center; justify-content:center; font-size:12px; color:#8b98aa; cursor:pointer")}><span style={S("font-family:'JetBrains Mono',monospace; font-size:10px")}>{"!"}</span><span style={S(V.alertBadgeStyle)}>{V.alertCount}</span></Hv>''', 1),
]

for label, needle, repl, want in PATCHES:
    n = src.count(needle)
    if n == want:
        src = src.replace(needle, repl, want)
        applied.append(f"{label} ({want}x)")
    elif repl in src and n == 0:
        applied.append(f"{label} (already patched)")
    else:
        failed.append(f"{label}: found {n} occurrence(s) of {needle!r}, expected {want}")

# ---- temperature chart: axis labels for the shared y-axis ----
if "V.gridLabels" not in src:
    m = re.search(r'(<svg viewBox="0 0 620 132")', src)
    if m:
        labels = ('{(V.gridLabels || []).map((g, _gi) => ('
                  '<span key={_gi} style={S(g.style)}>{g.label}</span>))}')
        src = src[:m.start(1)] + labels + src[m.start(1):]
        applied.append("temp axis labels (1x)")
    else:
        failed.append("temp axis labels: could not find the 620x132 chart svg")
else:
    applied.append("temp axis labels (already patched)")

# ---- cutter blade: bind the four keyframe styles so they can be PAUSED while the cutter is open ----
for _name, _key, _lit in [
    ("vStub",  "V.stubAnim",  'animation:vStub 1.1s cubic-bezier(.3,0,.2,1) infinite'),
    ("vShear", "V.shearAnim", 'animation:vShear 1.1s cubic-bezier(.3,0,.2,1) infinite'),
    ("vBlade", "V.bladeAnim", 'animation:vBlade 1.1s cubic-bezier(.3,0,.2,1) infinite'),
    ("vFlash", "V.flashAnim", 'animation:vFlash 1.1s linear infinite'),
]:
    _needle = 'style={S("' + _lit + '")}'
    if _needle in src:
        src = src.replace(_needle, 'style={S(' + _key + ')}', 1)
        applied.append("cutter " + _name + " (1x)")
    elif 'S(' + _key + ')' in src:
        applied.append("cutter " + _name + " (already patched)")
    else:
        failed.append("cutter " + _name + ": literal not found -> " + _lit)

# ---- webcam panel: live label + inject the <img> into the design's placeholder frame ----
# The panel appears twice in the template (narrow and wide layouts), so both get patched.
n = src.count('{"LIVE \\u00b7 19 FPS\\n                "}')
if n:
    src = src.replace('{"LIVE \\u00b7 19 FPS\\n                "}', "{V.camLabel}")
    # make the surrounding span carry the live style + a title with the real numbers
    src = re.sub(r'<span style=\{S\("margin-left:auto; display:flex; align-items:center; gap:6px; font-family:\'JetBrains Mono\',monospace; font-size:9px; color:#ff5a33"\)\}>',
                 '<span title={V.camTitle} style={S(V.camLabelStyle)}>', src)
    src = re.sub(r'<span style=\{S\("width:5px; height:5px; border-radius:50%; background:#ff5a33; animation:vPulse 1\.4s ease-in-out infinite"\)\}></span>(?=\{V\.camLabel\})',
                 '<span style={S(V.camDotStyle)}></span>', src)
    applied.append(f"webcam label ({n}x)")
elif "{V.camLabel}" in src:
    applied.append("webcam label (already patched)")
else:
    failed.append("webcam label: LIVE · 19 FPS literal not found")

if "V.camSrc" not in src:
    hits = list(re.finditer(r'(<div style=\{S\("position:relative; aspect-ratio:4/3;[^"]*"\)\}>)', src))
    if hits:
        img = '<img src={V.camSrc} alt="" style={S(V.camImgStyle)} />'
        for m in reversed(hits):
            src = src[:m.end(1)] + img + src[m.end(1):]
        applied.append(f"webcam img ({len(hits)}x)")
    else:
        failed.append("webcam img: aspect-ratio:4/3 frame not found")
else:
    applied.append("webcam img (already patched)")

# ---- MMU header: live status instead of the design's "PRINTING · 28 SWAPS" ----
n = src.count('{"PRINTING \\u00b7 28 SWAPS\\n              "}')
if n == 1:
    src = src.replace('{"PRINTING \\u00b7 28 SWAPS\\n              "}', "{V.mmuStatusLabel}", 1)
    applied.append("mmu status label (1x)")
elif "{V.mmuStatusLabel}" in src:
    applied.append("mmu status label (already patched)")
else:
    failed.append(f"mmu status label: found {n}, expected 1")

# ---- progress percentage: the bare {"50"} inside the ring svg ----
# Anchored on the ring's <text>/<div> neighbourhood so we never touch an unrelated "50".
m = re.search(r'(font-size:22px[^"]*"\)\}>)\{"50"\}', src, re.S)
if m:
    src = src[:m.start(0)] + m.group(1) + "{V.jobProgressPct}" + src[m.end(0):]
    applied.append("progress pct (1x)")
elif "{V.jobProgressPct}" in src:
    applied.append("progress pct (already patched)")
else:
    failed.append('progress pct: could not anchor {"50"} near the progress ring')

# ---- spool card material line: bind the style so the spool id is legible ----
# The design hardcoded 8px #4d5a6b here (2.67:1). The line now carries "ABS · #43" — an id you actually
# read — so the adapter owns the style.
if "sp.matStyle" not in src:
    needle = ('<div style={S("font-family:\'JetBrains Mono\',monospace; font-size:8px; color:#4d5a6b; '
              'text-align:center; letter-spacing:.05em")}>{sp.mat}</div>')
    n = src.count(needle)
    if n == 1:
        src = src.replace(needle, '<div style={S(sp.matStyle)}>{sp.mat}</div>', 1)
        applied.append("spool card material style (1x)")
    else:
        failed.append(f"spool card material style: found {n} occurrence(s), expected 1")
else:
    applied.append("spool card material style (already patched)")

# ---- FANS rows: typed % entry for the fans Klipper lets us set ----
# A 3 px bar cannot express "37 %". Settable fans (Part Fan / Chamber / Exhaust) get an input bound to
# ctx.field, exactly as the LED rows already did; heater_fan / controller_fan have no pctField and keep
# the plain text, because Klipper owns their speed.
# The needle includes the {f.k} label span on purpose: the bare value span is IDENTICAL in the V.factors
# rows further down the file (also mapped as `f`), and a blind replace silently rewrote those too.
if "f.pctField" not in src:
    needle = ('<span style={S("font-size:11.5px; color:#8b98aa")}>{f.k}</span>'
              '<span style={S("font-family:\'JetBrains Mono\',monospace; font-size:10.5px; color:#e8eef6")}>{f.v}</span>')
    n = src.count(needle)
    if n == 1:
        repl = ('<span style={S("font-size:11.5px; color:#8b98aa")}>{f.k}</span>'
                '{f.pctField ? (<span style={S("display:flex; align-items:center; gap:5px")}>'
                '{f.rpmLabel ? <span style={S(f.rpmStyle)}>{f.rpmLabel}</span> : null}'
                '<input type="text" value={f.pctField.value} onChange={f.pctField.onChange} '
                'onBlur={f.pctField.onBlur} onKeyDown={f.pctField.onKeyDown} style={S(f.pctInputStyle)} />'
                '<span style={S(f.pctSuffixStyle)}>{"%"}</span></span>) : ('
                '<span style={S("font-family:\'JetBrains Mono\',monospace; font-size:10.5px; color:#e8eef6")}>{f.v}</span>)}')
        src = src.replace(needle, repl, 1)
        applied.append("fan typed % entry (1x)")
    else:
        failed.append(f"fan typed % entry: found {n} occurrence(s) of the fan label+value pair, expected 1")
else:
    applied.append("fan typed % entry (already patched)")

# ---- FILAMENT USED: the bar becomes a print-length timeline ----
# The design's bar was a proportion chart — segments summing to 100% of what had been used so far, so it
# looked identical at 5% and 95% into a job. Owner wants a loading bar for the PRINT, coloured in the
# order the filaments were actually laid down. So it now maps V.filamentSeq, whose widths are absolute
# fractions of metadata.filament_total: the segments sum to the fraction consumed, and the track showing
# through behind them is the filament still to come. Each segment carries a hover title (gate + metres),
# and the scale is stated underneath, because a bar that no longer fills to 100% needs to say what full
# would mean.
if "V.filamentSeq" not in src:
    needle = ('<div style={S("display:flex; height:7px; border-radius:4px; overflow:hidden; background:#131a24")}>'
              '{(V.filamentUse || []).map((u, _i9) => (<React.Fragment key={_i9}>'
              '<div style={S(u.barStyle)}></div></React.Fragment>))}</div>')
    n = src.count(needle)
    if n == 1:
        repl = ('<div style={S("display:flex; height:9px; border-radius:5px; overflow:hidden; background:#131a24; '
                'border:1px solid #1c2430")}>'
                '{(V.filamentSeq || []).map((u, _i9) => (<React.Fragment key={_i9}>'
                '<div title={u.title} style={S(u.barStyle)}></div></React.Fragment>))}</div>'
                '<div style={S("display:flex; align-items:baseline; gap:8px; margin-top:1px")}>'
                '<span style={S("font-family:\'JetBrains Mono\',monospace; font-size:8.5px; letter-spacing:.1em; color:#6b7789")}>'
                '{V.filamentSeqLabel}</span></div>')
        src = src.replace(needle, repl, 1)
        applied.append("filament timeline bar (1x)")
    else:
        failed.append(f"filament timeline bar: found {n} occurrence(s) of the stacked bar, expected 1")
else:
    applied.append("filament timeline bar (already patched)")

# ---- chain node values: expose the hover title ----
# The ENCODER node shows SIGNED movement (see trackEncoder in adapters/mmu.js); the lifetime odometer it
# is derived from stays reachable as a tooltip rather than being lost. Two occurrences: preNodes and
# postNodes, both built by the same chainNode().
# GUARDED, and the needle is not a substring of the replacement's own needle position, but the guard is
# cheaper to reason about than a count that changes as soon as it applies.
if "n.title" not in src:
    needle = "<div style={S(n.valStyle)}>{n.val}</div>"
    n = src.count(needle)
    if n == 2:
        src = src.replace(needle, '<div title={n.title} style={S(n.valStyle)}>{n.val}</div>', 2)
        applied.append("chain node title (2x)")
    else:
        failed.append(f"chain node title: found {n} occurrence(s) of the node value div, expected 2")
else:
    applied.append("chain node title (already patched)")

# ---- spool card: "change filament" button ----
# The gate's filament is edited in lib/GateEditor.jsx (Spoolman-authoritative). The design had no
# affordance for it: the gate map was only reachable by opening Mainsail's MMU panel in a new tab, which
# is inert inside Orca's webview and a dependency on the very app Carbon replaces.
# sp.edit stops propagation — the whole card is one onClick that SELECTS the gate.
# GUARDED, not a PATCHES entry: the replacement contains the needle, so a count-based rule would
# re-inject on every run (it did exactly that once).
if "sp.edit" not in src:
    needle = "onClick={sp.go} style={S(sp.cardStyle)}>"
    n = src.count(needle)
    if n == 1:
        btn = ('{sp.edit ? <Hv as="div" onClick={sp.edit} title={sp.editTitle} style={sp.editStyle} '
               'hover="background:#1d2734; color:#e8eef6; border-color:#4a5666">{"\u270e"}</Hv> : null}')
        src = src.replace(needle, needle + btn, 1)
        applied.append("spool card edit button (1x)")
    else:
        failed.append(f"spool card edit button: found {n} occurrence(s) of the card onClick, expected 1")
else:
    applied.append("spool card edit button (already patched)")

# ---- job thumbnail: inject an <img> into the GCODE THUMBNAIL placeholder box ----
if "V.jobThumb" not in src:
    m = re.search(r'(<div style=\{S\("[^"]*")(\)\}>)((?:(?!</div>).){0,160}?\{"GCODE THUMBNAIL"\})', src, re.S)
    if m:
        img = '<img src={V.jobThumb} alt="" style={S(V.jobThumbStyle)} />'
        src = src[:m.end(2)] + img + src[m.end(2):]
        applied.append("job thumbnail img (1x)")
    else:
        failed.append('job thumbnail: could not find the {"GCODE THUMBNAIL"} placeholder box')
else:
    applied.append("job thumbnail img (already patched)")

if failed:
    print("PATCH FAILURES — Template.jsx left untouched:", file=sys.stderr)
    for f in failed:
        print("  ✗ " + f, file=sys.stderr)
    print("\nThe design export probably changed this text. Update tools/patch_template.py to match.", file=sys.stderr)
    sys.exit(1)

if src != orig:
    header = "// Bindings applied by tools/patch_template.py (design literals -> live V.* keys).\n"
    if not src.startswith("// Bindings applied"):
        src = src.replace("// GENERATED by tools/dc2jsx.py", header + "// GENERATED by tools/dc2jsx.py", 1)
    T.write_text(src, encoding="utf-8")

print(f"patched {T.name}: {len(applied)} binding(s)")
for a in applied:
    print("  ✓ " + a)
