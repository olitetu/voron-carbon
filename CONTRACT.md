# Voron Carbon — build contract (read fully before writing code)

> **Note on the examples.** This spec was written against one reference machine — a Voron 2.4 350 with an
> 8-gate Happy Hare ERCF, a Cartographer probe and Spoolman. Concrete hosts (`voron.local`), ports and object
> names below are that printer's; substitute your own. Carbon itself discovers what a printer has at runtime
> (`src/lib/caps.js` over `printer.gcode.commands`), so nothing here is compiled in.

A complete Klipper/Moonraker frontend in the "Voron Carbon" design language, replacing Mainsail page-for-page
while Mainsail stays installed. Printer: Voron 2.4 at `http://voron.local` (Moonraker, no auth). 8-gate ERCF with
Happy Hare v3.4.2, EREC **gate** cutter (no toolhead cutter), Blobifier, Cartographer probe (touch mode), Spoolman at
`http://voron.local:7912`, one webcam (`/webcam/?action=stream`, flip h+v), 4 neopixels (sb_leds, mmu_leds, caselight,
logo), fans: `fan` (part), `fan_generic Chamber`, `fan_generic Exhaust`, `heater_fan hotend_fan`, `controller_fan Controller`.

## ⚠ SAFETY when developing against a live printer

This section was written while a real 8-hour print was running, and the rules are worth keeping: a dev build
points at a REAL machine, so every button in it moves real hardware.
- During development you may ONLY make read-only calls: `printer.objects.query`, `objects.list`, `server.files.*` list/metadata,
  `server.history.list/totals`, `server.spoolman.proxy` GET, `machine.proc_stats`, `server.temperature_store`, `server.gcode_store`,
  `server.webcams.list`, `machine.update.status` (refresh=false), `machine.device_power.devices`, `server.database.get_item`.
- Do NOT call: `api.gcode(...)`, print start/pause/resume/cancel, emergency stop, restarts, file upload/delete/move, SET_LED/fan/temp,
  update/recover, reboot/shutdown, `dbSet`. Implement these actions fully — they will be exercised later in standby by the verify phase.
- Never `npm run build` into `dist/` (that is the integrator's). Validate YOUR file compiles with:
  `npx esbuild <your-entry.jsx> --bundle --alias:react=./src/lib/react-shim.js --alias:react-dom=./src/lib/react-dom-shim.js --alias:react-dom/client=./src/lib/react-dom-shim.js --jsx=transform --jsx-factory=React.createElement --jsx-fragment=React.Fragment --outfile=/tmp/carbon-check-$RANDOM.js --log-level=error`
- Live data for your bindings: `curl -s 'http://voron.local/printer/objects/query?<object>'` etc. The running dev build is at
  `http://127.0.0.1:8766/` (it talks to the live printer) — you may open it read-only in the in-app browser to inspect `window.__carbon.store.state`.

## Stack & rules
- React 18 UMD, vendored (`import React from "react"` → window.React via esbuild alias). **No other dependencies. No runtime internet.**
  No CSS frameworks; styles are inline via `S("css text")` from `src/lib/ui.js` (memoized css→object) or the primitives in `src/lib/design.jsx`.
- Fonts: Barlow (UI) + JetBrains Mono (ALL numerics/labels) — vendored. Palette/typography in `src/lib/design.jsx` (`T`, `mono()`).
- FIDELITY: the dashboard is a port of a finished design. Copy style strings VERBATIM from `src/pages/dashboard/logic.jsx`
  (`renderVals()`); change only where data comes from. Do not "improve" the design. New pages must look like they belong:
  same panel headers (`<Panel>`), mono uppercase micro-labels, hairline borders, 3–6px radii, no shadows except menus.
- `src/pages/dashboard/Template.jsx` is GENERATED (tools/dc2jsx.py) — never hand-edit it.
- Own only your files. Adapters: `src/pages/dashboard/adapters/<panel>.js`. Actions: `src/lib/actions/<panel>.js`. Pages: `src/pages/<page>/index.jsx`
  (+ optional `src/pages/<page>/*.jsx` helpers). Shared libs (`src/lib/*`) are read-only for builders — if you need a shared helper, put it in your own file and say so in your report.

## Runtime objects
- `api` — `src/lib/moonraker.js` `Moonraker`: `rpc(method, params)`, `query(objects)`, `gcode(script)`, `subscribe()`, print control
  (`startPrint/pausePrint/resumePrint/cancelPrint`), `emergencyStop/firmwareRestart/printerRestart`, files (`dirInfo(path, extended)`,
  `fileMeta`, `fileMetascan`, `fileDelete(root,path)`, `fileMove`, `fileCopy`, `dirCreate`, `dirDelete`, `fileUpload(file, root, path, onProgress)`,
  `fileUrl(root,path)`, `fileText`), history (`historyList({limit,start,order,since,before})`, `historyTotals`, `historyDelete(uid)`, `historyDeleteAll`),
  spoolman (`spoolman(path, method, body)` via Moonraker proxy → e.g. `spoolman('/spool')`, `spoolman('/spool/35')`, `spoolmanActive()`, `spoolmanSetActive(id)`),
  machine (`serviceRestart/Stop/Start(name)`, `reboot`, `shutdown`, `updateStatus(refresh)`, `updateRefresh`, `updateClient(name)`, `updateKlipper/Moonraker/System/Full`,
  `updateRecover(name, hard)`, `powerDevices`, `powerSet(device, action)`, `systemInfo`, `procStats`, `printerInfo`, `serverInfo`),
  `temperatureStore()`, `gcodeStore(n)`, `webcams()`, `objectsList()`, prefs `dbGet(key)/dbSet(key,value)/dbDel` (Moonraker DB namespace `carbon`).
  Events: `api.on('status'|'gcode_response'|'klippy'|'filelist'|'history'|'update_refreshed'|'service_state'|'proc_stats'|'webcams'|'active_spool', fn)`.
  Base URL: `api.base` ('' when hosted on the printer, 'http://voron.local' in dev). Webcam stream: `api.base + cam.stream_url`.
- `store` — `src/lib/store.js`. React: `const st = useStore(store)` (or `useStore(store, s => s.raw.toolhead)`). Shape (`store.state`):
  - `connected, klippy ('ready'|'shutdown'|'disconnected'|'startup'), serverInfo, printerInfo {software_version, hostname, state}`
  - `raw` — Moonraker printer objects, deep-merged live. Examples (real values seen):
    `raw.print_stats {state:'printing', filename, print_duration, total_duration, filament_used(mm), info:{current_layer,total_layer} (null on this slicer)}`
    `raw.virtual_sdcard {progress, file_position, is_active}` · `raw.display_status {progress, message}` · `raw.pause_resume {is_paused}` · `raw.idle_timeout {state}`
    `raw.toolhead {position[x,y,z,e], homed_axes:'xyz', max_velocity, max_accel, square_corner_velocity, minimum_cruise_ratio, extruder}`
    `raw.gcode_move {speed_factor, extrude_factor, speed, homing_origin[x,y,z,e], position, absolute_coordinates}` · `raw.motion_report {live_velocity, live_extruder_velocity, live_position}`
    `raw.extruder {temperature, target, power, pressure_advance, smooth_time, can_extrude}` · `raw.heater_bed {temperature, target, power}`
    `raw.fan {speed 0..1, rpm}` · `raw['fan_generic Chamber'] {speed}` · `raw['fan_generic Exhaust'] {speed, rpm}` · `raw['heater_fan hotend_fan'] {speed}` · `raw['controller_fan Controller'] {speed}`
    `raw['neopixel sb_leds'] {color_data:[[r,g,b,w] 0..1 …]}` (also mmu_leds, caselight, logo)
    `raw['temperature_sensor X'] {temperature}` for X in: Cartographer, cartographer_coil, CHAMBER, 'RASPBERRY PI', OCTOPUS, 'EBB 2209', MMU
    `raw['filament_switch_sensor filament_tension_sensor'|'…compression_sensor'] {filament_detected, enabled}`
    `raw.mcu / raw['mcu mmu'] / raw['mcu can0'] (=EBB toolhead) / raw['mcu scanner'] {last_stats:{mcu_awake (0..1 ≈ load), freq, …}, mcu_version}`
    `raw.bed_mesh {profile_name, mesh_min[x,y], mesh_max, probed_matrix (50×50 here), mesh_matrix, profiles{name:{…}}}`
    `raw.exclude_object {objects:[{name, center, polygon}], excluded_objects:[names], current_object}`
    `raw.quad_gantry_level {applied}` · `raw.configfile {save_config_pending}` · `raw.webhooks {state, state_message}`
    `raw.mmu` (Happy Hare): `gate, tool, num_gates, filament ('Loaded'|'Unloaded'|'Unknown'), filament_pos 0..10, action ('Idle'|'Loading'|'Unloading'|'Forming Tip'|'Cutting Tip'|'Heating'|'Checking'|'Homing'|'Selecting'|…), print_state, servo ('Up'|'Down'|'Move'), ttg_map[8], endless_spool_groups[8], gate_status[8] (0 empty,1 available,2 from buffer,-1 unknown), gate_color[8] hex, gate_color_rgb, gate_material[8], gate_spool_id[8], gate_temperature[8], gate_filament_name[8]?, sync_drive (bool), sync_feedback_state ('tension'|'compressed'|'neutral'|…), clog_detection (0/1/2), is_locked, encoder_pos, extruder_filament_remaining, toolchange_purge_volume, filament_direction, is_paused, reason_for_pause, slicer_tool_map {tools:{'n':{material,color,temp,name}}, initial_tool, referenced_tools, purge_volumes}`
  - `objects` (printer.objects.list), `macros` (public gcode_macro names, 71), `procStats` (`{system_cpu_usage:{cpu,cpu0..}, system_memory:{total,available,used} kB, system_uptime s, cpu_temp, throttled_state, moonraker_stats}`),
    `tempHistory` (`{ '<sensor>': {temperatures:[1200], targets?, powers?, speeds?} }`, 1 sample/s, live-appended), `log` (newest first `{time, message, type}`; `!!`=error, `//`=response), `webcams` (`[{name, service, stream_url, snapshot_url, flip_horizontal, flip_vertical, rotation}]`),
    `spools` (`{ [id]: spoolman spool {id, remaining_weight, initial_weight, used_weight, remaining_length, filament:{name, material, color_hex, vendor:{name}, weight}} }`), `activeSpool`, `prefs` (persisted UI prefs object; write via `api.dbSet('prefs', {...})` — NOT during dev).
- Helpers: `src/lib/hh.js` (`travelFromPos`, `phaseFromAction`, `gateName`, `gateHex`, `gateFill`, `GATE`), `src/lib/design.jsx`
  (`T` palette, `mono()`, `Panel, Btn, Chip, Label, Val, Row, Divider, Input, Toggle, Table, Menu, Confirm, fmtDur, fmtBytes, fmtDate`), `src/lib/router.js` (`navigate(path, query)`, `useRoute()`, `ROUTES`).

## Dashboard adapters (per-panel view-model modules)
`renderVals()` in `logic.jsx` currently returns ~150 keys from FAKE state. Each adapter re-implements one panel's keys from live data,
copying the style logic verbatim. Signature:
```js
// src/pages/dashboard/adapters/<panel>.js
export function <panel>Vals(ctx) { /* return ONLY this panel's keys */ }
// ctx = { st: store.state, ui: logic.state (UI-only state: menus/edits/hoverIdx/consoleExpanded/macroEdits/iconPickFor/excludeOpen/confirmId/ledPicker/soakMenuOpen/servoMenuOpen/mmuMenuOpen/macroPickerOpen/mapOpen/extrudeLen/extrudeRate/narrow/guardsInline/clock/tphase),
//         set: (patchOrFn) => logic.setState(...), field: logic.field.bind(logic)  (the design's edit-field helper), barPick: logic.barPick.bind(logic),
//         act: actions object (from src/lib/actions/*.js, all merged), log: (msg, kind) => void  (adds a UI line to the console panel), A: accent hex, api, store,
//         common: commonVals(ctx) (see below) }
```
`adapters/common.js` (shared derived values, owned by the MMU agent): `{ A, press, spoolDefs, gateInfo, loaded, loadedColor, pathGate, gate (loaded gate or null),
selector, servo ('up'|'down'), phase, travel, moving, reversing, flowing, extruding, printing, activeFeed, dashPeriod, dashCycle, flowSuffix, reverseSuffix, feed, pxPerSec }` —
computed from `st.raw.mmu`, `st.spools`, `st.raw.print_stats`, `st.raw.motion_report`, `ui.extrudeRate`, `hh.js`. Others import it via `ctx.common`.
The design's `travel` (0..1 along the route) comes from `travelFromPos(mmu.filament_pos)`; `phase` from `phaseFromAction(mmu.action)`. Keep `animateTravel`-style smoothness
by easing `travel` toward the target over ~600ms in the logic's tick if you like, but the source of truth is filament_pos.

## Exact gcode per action (design intent → real command). Put these in `src/lib/actions/<panel>.js` as `make<Panel>Actions({ api, store, log })`.
- jog(axis, d): `G91\nG1 ${axis}${d} F${(axis==='Z'?600:6000)}\nG90` (clamp to 0..350 X/Y, 0..310 Z; refuse if axis not in homed_axes) · home: HOME→`G28`, XY→`G28 X Y`, QGL→`QUAD_GANTRY_LEVEL`, MESH→`BED_MESH_CALIBRATE`
- nudgeZ(d): `SET_GCODE_OFFSET Z_ADJUST=${d} MOVE=1` · setZ(v): `SET_GCODE_OFFSET Z=${v} MOVE=1` · saveZ: `Z_OFFSET_APPLY_PROBE` then the UI must show "SAVE_CONFIG pending" (Cartographer touch mode; SAVE_CONFIG is a separate explicit button) 
- setTarget: Extruder→`M104 S${n}` (0..300), Heater Bed→`M140 S${n}` (0..120) · setFactor: speed→`M220 S${v}`, extrusion→`M221 S${v}` · cooldown: `TURN_OFF_HEATERS`
- setFan: Part Fan→`M106 S${Math.round(v*2.55)}`; Chamber/Exhaust→`SET_FAN_SPEED FAN=${Chamber|Exhaust} SPEED=${(v/100).toFixed(2)}`; Hotend Fan & Controller are NOT settable (heater_fan/controller_fan) — render read-only bars, no click.
- setLed(k,{color,pct,on}): design name → object: 'SB Leds'→sb_leds, 'Caselight'→caselight, 'MMU Leds'→mmu_leds, 'Logo'→logo. `SET_LED LED=${name} RED=${r} GREEN=${g} BLUE=${b} WHITE=0 TRANSMIT=1` with rgb = hex×(pct/100) (0..1, 3 decimals); off → all 0. Read state from `color_data[0]` → hex (normalized by max channel), pct = max channel×100, on = pct>0.
- print: PAUSE→`api.pausePrint()`, RESUME→`api.resumePrint()`, CANCEL→confirm then `api.cancelPrint()`. estop: `api.emergencyStop()`; when klippy is 'shutdown' the button becomes RESTART FIRMWARE → `api.firmwareRestart()`. saveConfig → confirm → `SAVE_CONFIG`.
- MMU: selectTool(i)→`T${i}` · selectGate(g)→`MMU_SELECT GATE=${g}` · bypass→`MMU_SELECT_BYPASS` · checkGate→`MMU_CHECK_GATE` · LOAD→`MMU_LOAD` · UNLOAD→`MMU_UNLOAD` · EJECT→`MMU_EJECT` · PRELOAD→`MMU_PRELOAD` · RECOVER→`MMU_RECOVER` · CUT→ `EREC_CUTTER_ACTION` — the cutter is at the MMU (EREC gate cutter), NOT at the toolhead, so CUT and tip-forming are two DIFFERENT operations and both buttons exist: CUT→`EREC_CUTTER_ACTION`, TIP→`MMU_FORM_TIP`. Do not animate the cut on a timer: the macro narrates itself with `RESPOND "EREC Cutter open"`/`"closed"` and `boot.js` drives the blade off those events · servo→`MMU_SERVO POS=${up|down}` · mmu menu: Recover→`MMU_RECOVER`, Reset→`MMU_RESET`, Edit gate map→navigate to Mainsail `http://voron.local/#/dashboard` (Mainsail's MMU panel has the editor) — or open the MMU_GATE_MAP dialog if you build one, Calibrate gates→`MMU_CHECK_GATES`, Filament stats→`MMU_STATS DETAIL=1`, MMU settings→`MMU_TEST_CONFIG`.
  setEndless(gate, next): HH uses GROUPS (gates sharing a group are fallbacks): `MMU_ENDLESS_SPOOL GROUPS=${groups.join(',')}` — put `gate` into `next`'s group (or its own if null); read from `endless_spool_groups`. Also ensure `MMU_ENDLESS_SPOOL ENABLE=1` when a link is set.
- extrudeMove(dir): `M83\nG1 E${dir>0?'':'-'}${len} F${rate*60}` (refuse if `!raw.extruder.can_extrude` → log "Extrude below minimum temp").
- excludeObject(name): `EXCLUDE_OBJECT NAME=${name}` · includeObject(name): `EXCLUDE_OBJECT RESET=1 NAME=${name}`.
- runMacro(k): `api.gcode(k)` (real macro name) · sendConsole(text): `api.gcode(text)`.
- heatSoak(p): `M140 S${p.bed}\nSET_FAN_SPEED FAN=Chamber SPEED=0.40\nSET_FAN_SPEED FAN=Exhaust SPEED=${(p.exhaust/100).toFixed(2)}`.
- limits: `SET_VELOCITY_LIMIT VELOCITY=… ACCEL=… SQUARE_CORNER_VELOCITY=… MINIMUM_CRUISE_RATIO=…` (only the changed key).
Every action: `log(<the command or a short intent line>, 'info'|'ok'|'warn'|'err')`, await `api.gcode`, catch → `log(err.message,'err')`.

## Live data mapping notes (dashboard)
- Job: filename `print_stats.filename` (strip `.gcode`); progress `virtual_sdcard.progress` (0..1); SPEED `motion_report.live_velocity` mm/s; FLOW `live_extruder_velocity × π×(1.75/2)²` mm³/s;
  FILAMENT `filament_used/1000` m; time: `print_duration` elapsed; ESTIMATE (remaining) = progress>0 ? print_duration/progress − print_duration : —; SLICER = `metadata.estimated_time − print_duration` (metadata via `api.fileMeta(filename)`, cache it per filename);
  TOTAL `total_duration`; ETA = now + remaining as HH:MM AM/PM. LAYER: `print_stats.info.current_layer/total_layer` when present; else from metadata (`layer_height`, `first_layer_height`, `object_height`) + `gcode_move.position[2]` → layer = max(1, round((z − first)/lh)+1), total = round((objH − first)/lh)+1.
  Status label: `print_stats.state` (standby/printing/paused/complete/cancelled/error) or SHUTDOWN if klippy!=='ready'. Objects: `exclude_object.objects` polygons → bounding boxes over 350×350 for the map; `excluded_objects`; `current_object`.
- Toolhead: `toolhead.position`, `homed_axes`, zOffset `gcode_move.homing_origin[2]`. Fans/LEDs as above (exhaust rpm from `raw['fan_generic Exhaust'].rpm`).
- Temps table rows (name, device, max): Extruder/'Rapido HF'/300 (editable), Heater Bed/'Keenovo'/120 (editable), Cartographer/'Cartographer 3D'/105, Carto Coil(`cartographer_coil`)/'probe coil'/100, Chamber(`CHAMBER`)/'enclosure'/60,
  EBB(`EBB 2209`)/'EBB36 toolhead'/85 (cpu = `raw['mcu can0'].last_stats.mcu_awake×100`, mem —), MMU/'MMB'/85 (cpu from `raw['mcu mmu']`), Octopus(`OCTOPUS`)/'Octopus board'/85 (cpu from `raw.mcu`), Raspberry(`RASPBERRY PI`)/'Raspberry Pi'/80 (cpu `procStats.system_cpu_usage.cpu`, mem `used/total×100`). `state` column = heater power % for heaters else '—'.
  Graph: the design draws 4 stylized sparklines around fixed baselines (y 22/56/84/108, amp 3–5) — keep that look: for each of Extruder, Cartographer, Heater Bed, Chamber take the last 61 samples from `tempHistory`, normalize that window's min..max to ±amp around its baseline; tooltip shows the REAL °C at the hovered sample; tipTime = −(60−i) s.
- Heightmap: `bed_mesh.probed_matrix` (50×50) → downsample by picking every k-th row/col to ≤13×13 (keep corners), reuse the isometric quad renderer with real z; meshName = `${profile_name} · ${rows}×${cols}`; min/max/range/std-dev from the full matrix; title on hover = real z.
- Limits: `toolhead.max_velocity/max_accel/square_corner_velocity`, `minimum_cruise_ratio×100 %`, Z offset `homing_origin[2]` — editable (field → SET_VELOCITY_LIMIT / SET_GCODE_OFFSET).
- Guards: FLOWRATE = `raw.mmu.flowrate ?? '—'`%, CLOG GUARD = clog_detection>0 ? 'ACTIVE':'OFF', MOTOR SYNC = sync_drive ? 'SYNCED':'OFF'; extra chip text from `sync_feedback_state`.
- Spools: gate g → color `gateHex`, name = spool.filament.name || material || '—', mat = gate_material, fill = `gateFill` (Spoolman remaining/initial), low = fill<0.15, empty = gate_status===0; active = loaded gate (filament==='Loaded' ? mmu.gate : null); selected = mmu.gate; Bypass card → `MMU_SELECT_BYPASS`.
  identMeta = `@${gate} · ${vendor.toUpperCase()} · ${material} · ${gate_temperature}°C`; toolChipLabel = `T${tool} · ${extruder.temperature.toFixed(1)}°C`.
  Filament use per gate this print: integrate `filament_used` deltas attributed to the currently loaded gate while the page is open (persist per filename in localStorage `carbon.fuse.<filename>`); show `filamentTotal` from `filament_used`. Label honestly ("since page open") if the job started before.
- Console: `st.log` newest first; kind: type==='error'||message.startsWith('!!') → 'err'; message.startsWith('//') → 'info'; commands → plain; colorize `ok` for lines containing 'complete'|'success'|'ready'. Time from `time` (epoch s) → HH:MM. Strip the `// ` / `!! ` prefixes and HTML tags (Happy Hare emits `<span>`).
- Macros: catalog = `st.macros` (real names) → default glyph by keyword (HOME→⌂, QGL→✳, MESH→▦, CALIBRATE→⌖, PARK→⇱, M84/MOTOR→⌁, POWER→⏻, RESTART→⟳, CHANGE_TOOL→⇄, PURGE/BLOBIFIER→◍, CUT→✂, UNLOAD/EJECT→⇲, LOAD→⇮, MMU_HOME→⊙, RESET/RECOVER→⚑, HEAT/PREHEAT/SOAK→♨, COOL→❄, CLEAN→⌾, FAN→⬒, FILTER/NEVERMORE→✱, else ◆); label = name shortened (strip `MMU__`/`_`→space, max 10 chars). `macroKeys` (which tiles show) + per-macro glyph/label overrides live in `st.prefs.macros` (`{ keys:[…], meta:{[name]:{g,t}} }`); default keys = the 20 most useful (HOME-ish, QGL, MESH, CALIBRATE_CARTOGRAPHER, BLOBIFIER*, MMU__*, SMART_HOME…). Save via `api.dbSet('prefs', {...st.prefs, macros})` (implemented, not exercised).

## Pages (Mainsail feature parity — each page is `export default function Page({ store, api, route, navigate })`, renders INSIDE the dashboard chrome, fills the main area)
Common: use `<Panel>`; a page is a grid of panels sized to fill the viewport (the chrome leaves ~1230px height at 2000×1302); no page scroll where avoidable, internal scroll inside long lists.
- **webcam** `/webcam`: all webcams from `st.webcams` (MJPEG `<img src=api.base+stream_url>`; apply `flip_horizontal/vertical` (scaleX/Y) + `rotation`; snapshot button (open snapshot_url); fullscreen toggle; FPS badge (count img loads); when only one cam, fill the page.
- **console** `/console`: full log (all `st.log`, virtualized or capped ~2000, auto-scroll with pause-on-scroll-up), filters (hide temperature/`B:`/`T:` noise toggle, hide `//` responses, errors only), search box, command input with ↑/↓ history (localStorage `carbon.console.history`), autocomplete from `st.macros` + `printer.gcode.help` (`api.rpc('printer.gcode.help')`), clear, copy line. Colorize kinds like the dashboard console.
- **spoolman** `/spoolman`: EMBED Spoolman itself: `<iframe src="http://voron.local:7912/">` (use `api.base ? api.base.replace(/:\d+$/,'') : location.origin` host + `:7912`; fill the page) inside a `<Panel title="SPOOLMAN">`; header shows the active spool (`st.activeSpool` → `st.spools[id]` name/material/remaining) + "SET ACTIVE" quick picker (native list via `api.spoolman('/spool')`, `api.spoolmanSetActive(id)`), open-in-new-tab, reload. Also a compact native strip: gate→spool assignment from `raw.mmu.gate_spool_id` (read-only).
- **heightmap** `/heightmap`: large isometric 3D of `raw.bed_mesh` (full 50×50 or every-2nd), hover z, color scale legend, min/max/range/std-dev/variance, wireframe/flat toggle, z-scale slider, profiles list from `bed_mesh.profiles` with LOAD (`BED_MESH_PROFILE LOAD=name`), SAVE (`BED_MESH_PROFILE SAVE=name` + note SAVE_CONFIG), REMOVE (`BED_MESH_PROFILE REMOVE=name`), CLEAR (`BED_MESH_CLEAR`), CALIBRATE (`BED_MESH_CALIBRATE`, confirm), and the Cartographer button (`CALIBRATE_CARTOGRAPHER`, confirm). Show `profile_name` and `save_config_pending` hint.
- **files** `/files`: `api.dirInfo('gcodes/<path>', true)` browser: breadcrumbs, folders, files with metadata (size, modified, estimated time, filament, layer height, slicer, thumbnail via `api.fileUrl('gcodes', thumb.relative_path)`), sort (name/date/size/time), search, actions: PRINT (`api.startPrint(path)` — confirm; disabled while printing), preview thumbnail, rename/move (`fileMove`), duplicate, delete (confirm), new folder, upload (drag-drop + button, progress), "print" of a folder's file, open in G-code viewer (navigate `/viewer?file=`), refresh on `api.on('filelist')`. Also a `config` root switcher is NOT needed here (Machine page owns config).
- **viewer** `/viewer`: Mainsail's WebGL viewer is a large dependency; achieve parity by EMBEDDING Mainsail's viewer route in an iframe: `${mainsailBase}/viewer?filename=gcodes/${encodeURIComponent(file)}` where mainsailBase = api.base || location.origin (Mainsail is at the printer root). Wrap in `<Panel title="G-CODE VIEWER">` with a file picker (list `gcodes` via `api.dirInfo`) that reloads the iframe, "open in Mainsail" button, and show the currently printing file by default (`raw.print_stats.filename`). Verify Mainsail honours the `filename` query (read Mainsail source if unsure) — if it does not, fall back to embedding `#/viewer` plain and instruct the user; report what you found.
- **history** `/history`: `api.historyList({limit:200, order:'desc'})` table (filename, status chip, start, duration, filament, thumbnails via metadata), totals bar (`historyTotals`: jobs, time, filament, longest), filters by status, search, delete job (confirm), delete all (double confirm), reprint (`startPrint`, confirm), refresh on `api.on('history')`, simple bars chart of jobs per day (last 14 days) drawn in SVG in the design style.
- **machine** `/machine`: panels — SYSTEM (hostname, klipper/moonraker versions from `serverInfo/printerInfo/systemInfo`, uptime, CPU/mem/temp from `procStats`, MCUs from `raw.mcu*` with version + load; services from `systemInfo.service_state` with RESTART/STOP/START; REBOOT/SHUTDOWN with double confirm; KLIPPER RESTART / FIRMWARE RESTART / MOONRAKER RESTART), UPDATE MANAGER (`updateStatus` → list of components with version/remote_version/dirty/commits; REFRESH, UPDATE per component (confirm), UPDATE ALL, RECOVER (hard) for dirty), CONFIG FILES (`api.dirInfo('config')` browser with folders, open file → editor panel: textarea-based editor with line numbers + mono, SAVE (`fileUpload` a Blob to root config path — confirm) + "SAVE & RESTART" (then `printerRestart`), download, create/delete/rename), LOGS (klippy/moonraker log download links `api.fileUrl('logs', 'klippy.log')`, rollover), POWER (`powerDevices` list with ON/OFF), TIMELAPSE (if `st.objects` has timelapse → link to Mainsail settings). Parity with Mainsail's Machine page is the goal; iframe fallback is NOT acceptable here except for the Timelapse settings.


## Addendum 2026-09-04 (supersedes anything above that conflicts)

- **Serving**: Carbon runs on its OWN PORT (default 8767) via `tools/install.sh`, which generates an nginx server
  proxying `/printer /server /api /access /machine /debug /websocket /webcam` to Moonraker so the app stays
  same-origin. The `/carbon/` subpath is DEAD — Mainsail's root-scoped service worker shadows it. `Host $http_host`
  in that config is load-bearing: Tornado compares Origin's netloc to the request Host *with the port*, so `$host`
  403s every websocket. Dev builds go somewhere else entirely (`tools/deploy.py` → Moonraker's `config` root);
  never point `deploy.py` at a directory registered with `update_manager`, which makes it read-only to the file API.
- **Orca Slicer 2.4.2 embeds Carbon** in its Device tab (`print_host_webui`). Consequences for every page: no
  `target="_blank"` / `window.open` (ejects to the system browser), no service workers, the page is reloaded at
  the base URL on nearly every preset change → the route and every user selection persist in localStorage
  (`router.restoreRoute/persistRoute`, `usePersisted`).
- **Every page calls `useStore(store)` first** (pages are prop elements; React bails on re-render otherwise).
- **Capabilities**: `src/lib/caps.js` over the latched `printer.gcode.commands` catalogue (367 commands, natives
  and Happy Hare python commands included; `has()` → null means "not loaded yet" = treat as available).
- **Viewer deep link** into Mainsail is HISTORY-mode: `http://voron.local/viewer?filename=gcodes/<relpath>` — no
  `#`, `gcodes/` prefix required. Native 3D viewer = `dist/viewer.js` (gcode-preview + three, lazy), stream via
  `processGCodeStream`; do not window (gzip and Range are mutually exclusive here). Size policy: tubes ≤ 50 MB,
  flat lines ≤ 150 MB, refuse above (417 MB max file is not renderable in a tab).
- **CONFIG is its own page above MACHINE**: groups Main printer files / MMU (Happy Hare) / Backups & others, editor
  is CodeMirror 6 (`dist/editor.js`, lazy) with a stateful Klipper/Jinja StreamLanguage mode; the plain textarea
  is the fallback when the bundle is absent. MACHINE shows system + services + updates together, no tabs.
- **Upload & Print** lives in the dashboard top bar (between SAVE CONFIG and EMERGENCY STOP) with a drag-anywhere
  overlay; upload form field `print="true"` starts the print — never sent while a job is printing/paused
  (`queue_gcode_uploads` is false: Moonraker returns 201 and silently does not start). OrcaSlicer uploads arrive
  server-side and are surfaced via `api.on("filelist")`.
- **MMU actions**: PRELOAD · CUT (`EREC_CUTTER_ACTION`) · CHECK · RECOVER · UNLOAD · LOAD. EJECT removed by the owner.
- **Stat tiles** (CURRENT JOB): `stat(k, value, unit)` — unit is a 9 px span, value font is fitted to the 77 px tile.
- **Job filament split** uses the slicer plan (`filament_weights[]`, `referenced_tools`, via `mmu.ttg_map`) whenever
  live tracking is partial, and the label names its source.
