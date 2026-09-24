// ---------------------------------------------------------------------------
// FILES — ported from the export, reflowed to 1024x600.
//
// The export drew eight invented rows. This printer has 214 real files, so:
//
//   ONE FETCH, NOT 214. /server/files/directory?extended=true returns full
//   metadata for every file in ~270 KB / 0.18 s, so there is no skeleton state and
//   no per-row metadata request -- rows are complete the moment they appear.
//
//   REAL THUMBNAILS. Moonraker exposes 32/48/300px PNGs at
//   .thumbs/<name>-<w>x<h>.png. They come back ordered SMALLEST first, which is
//   the opposite of what you would guess, so the 48px one is picked by size rather
//   than by position.
//
//   WINDOWED. 214 rows x 6 nodes would be 1284 DOM nodes on a Pi. Only the visible
//   slice is rendered.
// ---------------------------------------------------------------------------
import React from "react";
import { S, Hv } from "../../lib/ui.js";
import { C, F, L, TAP, mono, panel } from "../tokens.js";
import { microLabel } from "../vm.js";
import { Chip, Panel, Empty, Thumb } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { fmtMaterials } from "../../lib/history.js";

const ROW_H = 66;
const SORTS = [["date", "DATE"], ["name", "NAME"], ["size", "SIZE"], ["time", "TIME"]];

function fmtSize(b) {
  if (!b) return "—";
  return b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " kB";
}
function fmtDur(s) {
  if (!s || !Number.isFinite(s)) return "—";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
/**
 * The two file endpoints disagree about the name field: server.files.list returns
 * `path`, server.files.get_directory returns `filename`. Reading the wrong one
 * throws on the first row, so go through here rather than picking one and hoping.
 */
const fname = f => f.filename || f.path || "";

/**
 * filament_type has one entry per TOOL of the slicer profile (8 on this MMU), not per file, stored as a JSON
 * array or a ';'-joined string depending on when the file was sliced. Only the file's referenced_tools count:
 * 'ABS;ABS;PLA;ABS;ABS;ABS;ABS;ABS' for a print that uses T3 alone is ABS, not ABS+PLA (106 of this printer's
 * 230 files read wrong that way, 2026-09-23). The parsing and the tool restriction are lib/history.js
 * fmtMaterials, shared with both HISTORY views; this only compacts its "ABS + PLA" for the row: "ABS+PLA",
 * or "ABS+2" past two.
 */
function materials(f) {
  const s = fmtMaterials(f.filament_type, f.referenced_tools);
  if (!s) return null;
  const set = s.split(" + ");
  return set.length > 2 ? `${set[0]}+${set.length - 1}` : set.join("+");
}

/** Moonraker returns thumbnails smallest-first; pick by size, not by index. */
function thumbUrl(api, f, want = 48) {
  const t = (f.thumbnails || []).slice().sort((a, b) => Math.abs(a.width - want) - Math.abs(b.width - want))[0];
  if (!t || !t.relative_path) return null;
  const n = fname(f);
  const dir = n.includes("/") ? n.slice(0, n.lastIndexOf("/") + 1) : "";
  return api.fileUrl ? api.fileUrl("gcodes", dir + t.relative_path)
                     : `${api.base}/server/files/gcodes/${encodeURI(dir + t.relative_path)}`;
}

export default function Files({ st, api, act, say }) {
  const [sort, setSort] = React.useState("date");
  const [confirm, setConfirm] = React.useState(null);
  const [rows, setRows] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [scroll, setScroll] = React.useState(0);
  const boxRef = React.useRef(null);

  React.useEffect(() => {
    if (!st.connected || st.klippy !== "ready") return;
    let alive = true;
    api.dirInfo("gcodes", true)
      .then(d => { if (alive) setRows((d && d.files) || []); })
      .catch(e => { if (alive) setErr(e.message || String(e)); });
    return () => { alive = false; };
  }, [st.connected, st.klippy, st.filesVersion]);

  const sorted = React.useMemo(() => {
    const list = (rows || []).slice();
    const by = {
      date: (a, b) => (b.modified || 0) - (a.modified || 0),
      name: (a, b) => fname(a).localeCompare(fname(b)),
      size: (a, b) => (b.size || 0) - (a.size || 0),
      time: (a, b) => (b.estimated_time || 0) - (a.estimated_time || 0),
    }[sort];
    return list.sort(by);
  }, [rows, sort]);

  const current = String((st.raw.print_stats || {}).filename || "");
  const printing = (st.raw.print_stats || {}).state === "printing";

  // window: render the visible slice plus a little either side
  const viewH = 420;
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 3);
  const count = Math.ceil(viewH / ROW_H) + 6;
  const slice = sorted.slice(first, first + count);

  const startPrint = f => setConfirm({
    label: "START PRINT", cmd: `SDCARD_PRINT_FILE ${fname(f)}`, guards: { whilePrinting: false },
    confirm: `Print ${fname(f).replace(/\.gcode$/i, "")}? ${fmtDur(f.estimated_time)} estimated, ${f.filament_weight_total ? Math.round(f.filament_weight_total) + " g" : "unknown filament"}.`,
    run: () => api.startPrint(fname(f)).then(() => say("printing " + fname(f))).catch(e => act.refuse("START PRINT", e.message)),
  });

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; animation:ksFade .18s ease both`)}>
      <div style={S("flex:none; display:flex; align-items:center; gap:8px")}>
        <span style={S(`${microLabel(C.faint)}; margin-right:2px`)}>SORT</span>
        {SORTS.map(([k, label]) => (
          <Chip key={k} label={label} on={sort === k} onTap={() => setSort(k)} h={TAP.min} fs={F.label} flex={0} minW={110} />
        ))}
        <span style={S(`margin-left:auto; ${mono(F.label, `color:${C.faint}`)}`)}>
          {rows ? `${sorted.length} FILES` : err ? "ERROR" : "LOADING…"}
        </span>
      </div>

      <div style={S(panel(`flex:1; min-height:0; overflow:hidden; margin-bottom:${L.fab + L.fabInset - L.pad}px`))}>
        {err ? (
          <Empty title="COULD NOT LIST FILES" hint={err} />
        ) : !rows ? (
          <Empty title="LOADING" hint="Reading the g-code directory." />
        ) : !sorted.length ? (
          <Empty title="NO GCODE FILES" hint="Upload from Mainsail, or slice straight to the printer from OrcaSlicer." />
        ) : (
          <div ref={boxRef} className="scroll" onScroll={e => setScroll(e.target.scrollTop)}
            style={S("flex:1; min-height:0; overflow-y:auto")}>
            <div style={S(`height:${sorted.length * ROW_H}px; position:relative`)}>
              {slice.map((f, i) => {
                const idx = first + i;
                const cur = fname(f) === current;
                const url = thumbUrl(api, f);
                const mat = materials(f);
                return (
                  <div key={fname(f)} style={S(`position:absolute; top:${idx * ROW_H}px; left:0; right:0; height:${ROW_H}px; display:flex; align-items:center; gap:13px; padding:0 14px; border-bottom:1px solid ${C.line0}; background:${cur ? C.rowOn : "transparent"}`)}>
                    <Thumb url={url} size={46} />
                    <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:3px")}>
                      <span style={S(mono(F.body, `color:${cur ? C.accent : C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                        {fname(f).replace(/\.gcode$/i, "")}
                      </span>
                      <span style={S(mono(F.micro, `letter-spacing:.06em; color:${C.faint}`))}>
                        {[fmtSize(f.size), fmtDur(f.estimated_time), f.layer_count ? `${f.layer_count} layers` : null,
                          f.filament_weight_total ? `${Math.round(f.filament_weight_total)} g` : null]
                          .filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {mat ? <span style={S(`flex:none; ${mono(F.micro, `letter-spacing:.12em; color:${C.dim}`)}; padding:5px 9px; border:1px solid ${C.line3}; border-radius:4px`)}>{mat}</span> : null}
                    <Hv as="div" onClick={cur && printing ? undefined : () => startPrint(f)}
                      active={cur && printing ? "" : "transform:translateY(1px)"}
                      style={`flex:none; display:flex; align-items:center; justify-content:center; width:104px; height:${TAP.min}px; border-radius:${L.radiusSm}px; ${mono(F.label, "letter-spacing:.16em")}; cursor:${cur && printing ? "default" : "pointer"}; ${cur && printing
                        ? `background:${C.panelHead}; border:1px solid ${C.line3}; color:${C.faint};`
                        : `background:${C.accentBg}; border:1px solid ${C.accentLine}; color:${C.accent};`}`}>
                      {cur && printing ? "ACTIVE" : "PRINT"}
                    </Hv>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {confirm ? (
        <ConfirmBox a={confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); const why = act.blocked(c.guards); if (why) act.refuse("START PRINT", why); else c.run(); }} />
      ) : null}
    </div>
  );
}
