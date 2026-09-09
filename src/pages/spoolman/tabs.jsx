// Native SPOOLMAN tabs — spools, filaments and vendors rendered in Carbon's own vocabulary instead of
// an iframe that cannot be themed. All traffic goes through lib/spoolmanApi.js (Moonraker's proxy).
//
// Every save is a PARTIAL patch of whitelisted keys. That is not stylistic: each spool carries Happy
// Hare's `extra.mmu_gate_map` and `extra.printer_name`, so a full-object PUT would wipe the gate map.
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Divider, Input, Toggle, Table, Modal, Confirm, T, mono, fmtDate } from "../../lib/design.jsx";
import { S, Hv } from "../../lib/ui.js";
import { useAsync } from "../../lib/useStore.js";
import { num, swatch, grams, metres, whenSeconds, spoolName, fillOf, materialsOf, EMPTY_COLOR, LOW } from "../../lib/spools.js";
import { fromExternal } from "../../lib/spoolmanApi.js";

const when = iso => { const t = whenSeconds(iso); return t === null ? "—" : fmtDate(t); };
const money = v => (num(v) === null ? "—" : num(v).toFixed(2));
/** Happy Hare stores the gate on the spool as a custom field; -1 / missing means "no gate". */
export const gateOf = sp => { const g = num(sp && sp.extra && JSON.parse(sp.extra.mmu_gate_map ?? "null")); return g === null || g < 0 ? null : g; };

// ---- a tiny form kit -------------------------------------------------------------------------------
// 30-odd fields across three entities; without this the file is mostly duplicated markup.
function useForm(initial) {
  const [v, setV] = React.useState(initial || {});
  React.useEffect(() => setV(initial || {}), [initial]);
  return {
    v,
    set: (k, x) => setV(p => Object.assign({}, p, { [k]: x })),
    /** Only the keys that actually changed — keeps every write a minimal partial. */
    diff: () => {
      const out = {};
      for (const k of Object.keys(v)) {
        const a = v[k], b = (initial || {})[k];
        if (a !== b && !(a === "" && (b === null || b === undefined))) out[k] = a;
      }
      return out;
    }
  };
}
function F({ label, children, hint, w }) {
  return <div style={S(`min-width:0; ${w ? "width:" + w + "px; flex:none" : "flex:1 1 140px"}`)}>
    <Label>{label}</Label>
    <div style={S("margin-top:3px")}>{children}</div>
    {hint ? <div style={S(`${mono(8.5, `color:${T.faint}`)}; margin-top:3px`)}>{hint}</div> : null}
  </div>;
}
const Txt = ({ f, k, type = "text", ph }) => <Input type={type} value={f.v[k] === null || f.v[k] === undefined ? "" : String(f.v[k])}
  placeholder={ph} onChange={e => f.set(k, type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} style="width:100%" />;
const Sel = ({ f, k, options, blank = "—" }) => <select value={f.v[k] === null || f.v[k] === undefined ? "" : String(f.v[k])}
  onChange={e => f.set(k, e.target.value === "" ? null : (typeof options[0] === "object" ? Number(e.target.value) : e.target.value))}
  style={S(`width:100%; background:${T.panel}; border:1px solid ${T.line}; border-radius:3px; padding:5px 6px; outline:none; color:${T.body}; ${mono(11)}`)}>
  <option value="">{blank}</option>
  {options.map(o => (typeof o === "object"
    ? <option key={o.id} value={o.id}>{o.label}</option>
    : <option key={o} value={o}>{o}</option>))}
</select>;

/** Shared save/err plumbing: every tab does the same await → reload → report dance. */
function useSave(reload, say) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  return {
    busy, err, clearErr: () => setErr(null), fail: m => setErr(m),
    run: async (label, fn) => {
      setBusy(true); setErr(null);
      try { await fn(); reload && reload(); say && say(label, "ok"); return true; }
      catch (e) { const m = (e && e.message) || String(e); setErr(m); say && say(label + " — " + m, "err"); return false; }
      finally { setBusy(false); }
    }
  };
}

// ---- SPOOLS ----------------------------------------------------------------------------------------
// `connected` is in every fetch's deps on purpose: a call made before Moonraker's websocket is up
// fails with "not connected", and without the dep useAsync never retries — the tab stayed permanently
// empty behind a RETRY button even though the connection came up a second later.
export function SpoolsTab({ sm, say, activeId, onSetActive, printing, connected }) {
  const [q, setQ] = React.useState("");
  const [mat, setMat] = React.useState(null);
  const [loc, setLoc] = React.useState(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [edit, setEdit] = React.useState(null);        // spool object, or {} for a new one
  const [confirmDel, setConfirmDel] = React.useState(null);

  const spools = useAsync(() => sm.listSpools({ archived: showArchived }), [showArchived, connected]);
  const filaments = useAsync(() => sm.listFilaments(), [connected]);
  const locations = useAsync(() => sm.locations(), [connected]);
  const all = Array.isArray(spools.data) ? spools.data : [];
  const fils = Array.isArray(filaments.data) ? filaments.data : [];
  const locs = Array.isArray(locations.data) ? locations.data : [];
  const save = useSave(() => spools.reload(), say);

  const facets = React.useMemo(() => materialsOf(all.map(s2 => ({ filament: s2.filament }))), [all]);
  const needle = q.trim().toLowerCase();
  const rows = React.useMemo(() => all.filter(sp => {
    const f = sp.filament || {};
    if (mat && String(f.material || "").toUpperCase() !== mat) return false;
    if (loc && String(sp.location || "") !== loc) return false;
    if (!needle) return true;
    return `${sp.id} ${f.name || ""} ${f.material || ""} ${(f.vendor || {}).name || ""} ${sp.location || ""} ${sp.lot_nr || ""}`
      .toLowerCase().includes(needle);
  }).sort((a, b) => a.id - b.id), [all, needle, mat, loc]);

  const cols = [
    { k: "id", label: "ID", w: "50px", render: r => <span style={S(`color:${r.id === activeId ? T.ok : T.mute}`)}>{"#" + r.id}</span> },
    { k: "name", label: "FILAMENT", w: "minmax(0,2fr)", render: r => <Row gap={7}>
        <span style={S(`width:9px; height:9px; flex:none; border-radius:2px; border:1px solid ${T.line2}; background:${swatch((r.filament || {}).color_hex) || EMPTY_COLOR}`)} />
        <span style={S("min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")}>{spoolName(r)}</span>
        {r.archived ? <Chip color={T.faint}>ARCHIVED</Chip> : null}
      </Row> },
    { k: "mat", label: "MATERIAL", w: "minmax(0,1fr)", render: r => (r.filament || {}).material || "—" },
    { k: "gate", label: "GATE", w: "60px", render: r => { const g = gateOf(r); return g === null ? <span style={S(`color:${T.ghost}`)}>—</span> : <Chip color={T.accent}>{"G" + g}</Chip>; } },
    { k: "left", label: "REMAINING", w: "minmax(0,1.3fr)", align: "right", render: r => {
        const f = fillOf(r);
        return <span style={S(`color:${f !== null && f < LOW ? T.warn : T.body}`)}>
          {grams(num(r.remaining_weight)) + " · " + metres(num(r.remaining_length))}</span>; } },
    { k: "pct", label: "%", w: "52px", align: "right", render: r => { const f = fillOf(r); return f === null ? "—" : Math.round(f * 100) + "%"; } },
    { k: "loc", label: "LOCATION", w: "minmax(0,1fr)", render: r => r.location || "—" },
  ];

  return <>
    <Row gap={8} style="flex-wrap:wrap">
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="name · material · vendor · location · lot · id" style="flex:1 1 240px" />
      <Sel f={{ v: { loc }, set: (_k, x) => setLoc(x) }} k="loc" options={locs} blank="ALL LOCATIONS" />
      <Row gap={6}><Label>ARCHIVED</Label><Toggle on={showArchived} onClick={() => setShowArchived(v => !v)} /></Row>
      <Btn small kind="accent" onClick={() => setEdit({})}>NEW SPOOL</Btn>
      <Btn small onClick={() => { spools.reload(); filaments.reload(); }}>REFRESH</Btn>
    </Row>
    {facets.length > 1 ? <Row gap={4} style="margin-top:7px; flex-wrap:wrap">
      {[{ material: null, count: all.length }].concat(facets).map(f => {
        const on = (f.material || null) === mat;
        return <Hv key={f.material || "ALL"} as="div" onClick={() => setMat(f.material || null)}
          style={`padding:2px 7px; border-radius:3px; cursor:pointer; border:1px solid ${on ? T.accent : T.line2}; background:${on ? "rgba(255,90,51,.14)" : "transparent"}; ${mono(9, `letter-spacing:.08em; color:${on ? T.text : T.dim}`)}`}
          hover={on ? "" : `border-color:#4a5666; color:${T.text}`}>{(f.material || "ALL") + " " + f.count}</Hv>;
      })}
    </Row> : null}
    <div style={S("margin-top:8px; flex:1; min-height:0; overflow:auto")}>
      {spools.loading && !all.length ? <div style={S(`padding:14px 8px; ${mono(10, `color:${T.ghost}`)}`)}>LOADING SPOOLS …</div>
        : spools.error ? <Row gap={10} style="padding:12px 8px"><Val size={10.5} color={T.err}>{spools.error}</Val><Btn small onClick={() => spools.reload()}>RETRY</Btn></Row>
          : <Table cols={cols} rows={rows} rowKey={r => r.id} onRow={r => setEdit(r)}
              empty={needle || mat || loc ? "NO SPOOL MATCHES" : "SPOOLMAN HAS NO SPOOLS"}
              rowStyle={r => (r.id === activeId ? "background:#101821" : r.archived ? "opacity:.55" : "")} />}
    </div>
    <Row gap={10} style="margin-top:6px">
      <Val size={9.5} color={T.faint}>{rows.length + " / " + all.length + (showArchived ? " (incl. archived)" : "")}</Val>
      {activeId ? <Val size={9.5} color={T.ok}>{"ACTIVE #" + activeId}</Val> : null}
    </Row>

    {edit ? <SpoolForm sm={sm} sp={edit} fils={fils} locs={locs} save={save} printing={printing}
      activeId={activeId} onSetActive={onSetActive}
      onClose={() => setEdit(null)} onDelete={() => setConfirmDel(edit)} /> : null}

    {confirmDel ? <Modal open title={"DELETE SPOOL #" + confirmDel.id} onClose={() => setConfirmDel(null)} width={430}>
      <Confirm yes="DELETE PERMANENTLY" no="CANCEL"
        text={"Delete spool #" + confirmDel.id + " (" + spoolName(confirmDel) + ")? Archiving keeps it for history; deleting does not. If Happy Hare has it mapped to a gate, that mapping goes too."}
        onYes={async () => { const ok = await save.run("Deleted spool #" + confirmDel.id, () => sm.deleteSpool(confirmDel.id)); setConfirmDel(null); if (ok) setEdit(null); }}
        onNo={() => setConfirmDel(null)} />
    </Modal> : null}
  </>;
}

function SpoolForm({ sm, sp, fils, locs, save, onClose, onDelete, printing, activeId, onSetActive }) {
  const isNew = !sp.id;
  const initial = React.useMemo(() => ({
    filament_id: (sp.filament || {}).id ?? null,
    initial_weight: num(sp.initial_weight), spool_weight: num(sp.spool_weight),
    price: num(sp.price), location: sp.location || "", lot_nr: sp.lot_nr || "",
    comment: sp.comment || "", archived: !!sp.archived,
  }), [sp.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const f = useForm(initial);
  const [useAmt, setUseAmt] = React.useState("");
  const [measure, setMeasure] = React.useState("");
  const gate = gateOf(sp);

  const filOptions = fils.map(x => ({ id: x.id, label: "#" + x.id + " · " + (x.name || x.material || "—") + ((x.vendor || {}).name ? " · " + x.vendor.name : "") }));

  const footer = <>
    {save.err ? <Val size={9.5} color={T.err} style="flex:1; overflow:hidden; text-overflow:ellipsis">{save.err}</Val>
      : <Val size={9.5} color={T.faint} style="flex:1">{isNew ? "SPOOLMAN ASSIGNS THE ID" : "PARTIAL SAVE — UNTOUCHED FIELDS ARE LEFT ALONE"}</Val>}
    {!isNew ? <Btn small kind="ghost" onClick={onDelete}>DELETE</Btn> : null}
    <Btn small kind="accent" disabled={save.busy} onClick={async () => {
      const body = f.diff();
      if (isNew) {
        if (!f.v.filament_id) { save.fail("A spool needs a filament — pick one above"); return; }
        const ok = await save.run("Created spool", () => sm.createSpool(Object.assign({ filament_id: f.v.filament_id }, body)));
        if (ok) onClose();
      } else {
        if (!Object.keys(body).length) { onClose(); return; }
        const ok = await save.run("Saved spool #" + sp.id, () => sm.updateSpool(sp.id, body));
        if (ok) onClose();
      }
    }}>{save.busy ? "SAVING…" : isNew ? "CREATE" : "SAVE"}</Btn>
  </>;

  return <Modal open width={520} onClose={onClose} footer={footer}
    title={isNew ? "NEW SPOOL" : "SPOOL #" + sp.id + " · " + spoolName(sp)}>

    {!isNew ? <Row gap={8} style="margin-bottom:12px; flex-wrap:wrap">
      <Chip color={T.dim}>{(sp.filament || {}).material || "—"}</Chip>
      {gate !== null ? <Chip color={T.accent}>{"GATE " + gate}</Chip> : null}
      {sp.id === activeId ? <Chip color={T.ok}>ACTIVE</Chip> : null}
      {sp.archived ? <Chip color={T.faint}>ARCHIVED</Chip> : null}
      <Val size={9.5} color={T.faint} style="margin-left:auto">{"FIRST USED " + when(sp.first_used) + " · LAST " + when(sp.last_used)}</Val>
    </Row> : null}

    <Row gap={10} style="flex-wrap:wrap">
      <F label="FILAMENT" hint={isNew ? "required" : "changing this re-points the spool"}><Sel f={f} k="filament_id" options={filOptions} blank="— pick a filament —" /></F>
    </Row>
    <Row gap={10} style="margin-top:10px; flex-wrap:wrap">
      <F label="INITIAL WEIGHT (g)" w={120}><Txt f={f} k="initial_weight" type="number" /></F>
      <F label="EMPTY SPOOL (g)" w={120}><Txt f={f} k="spool_weight" type="number" /></F>
      <F label="PRICE" w={90}><Txt f={f} k="price" type="number" /></F>
    </Row>
    <Row gap={10} style="margin-top:10px; flex-wrap:wrap">
      <F label="LOCATION"><Sel f={f} k="location" options={locs} blank="—" /></F>
      <F label="LOT NUMBER"><Txt f={f} k="lot_nr" /></F>
    </Row>
    <Row gap={10} style="margin-top:10px">
      <F label="COMMENT"><Txt f={f} k="comment" /></F>
    </Row>

    {!isNew ? <>
      <Divider />
      <Row gap={16} style="flex-wrap:wrap">
        <div><Label>REMAINING</Label><Val size={11.5}>{grams(num(sp.remaining_weight)) + " · " + metres(num(sp.remaining_length))}</Val></div>
        <div><Label>USED</Label><Val size={11.5} color={T.body}>{grams(num(sp.used_weight))}</Val></div>
        <div><Label>PRICE</Label><Val size={11.5} color={T.dim}>{money(sp.price)}</Val></div>
      </Row>

      <Row gap={10} style="margin-top:12px; flex-wrap:wrap; align-items:flex-end">
        <F label="RECORD USE (g)" w={120} hint="subtracts from remaining"><Input type="number" value={useAmt} onChange={e => setUseAmt(e.target.value)} style="width:100%" /></F>
        <Btn small disabled={save.busy || !useAmt} onClick={async () => {
          await save.run("Recorded " + useAmt + " g used on #" + sp.id, () => sm.useSpool(sp.id, { use_weight: Number(useAmt) }));
          setUseAmt("");
        }}>RECORD</Btn>
        <F label="MEASURED TOTAL (g)" w={140} hint="scale reading INCLUDING the empty spool"><Input type="number" value={measure} onChange={e => setMeasure(e.target.value)} style="width:100%" /></F>
        <Btn small disabled={save.busy || !measure} onClick={async () => {
          await save.run("Set #" + sp.id + " from a measured " + measure + " g", () => sm.measureSpool(sp.id, Number(measure)));
          setMeasure("");
        }}>SET FROM SCALE</Btn>
      </Row>

      <Divider />
      <Row gap={10} style="flex-wrap:wrap">
        <Row gap={8} style="flex:1 1 auto">
          <Label>ARCHIVED</Label>
          <Toggle on={!!f.v.archived} onClick={() => f.set("archived", !f.v.archived)} />
          <Val size={9} color={T.faint}>KEEPS HISTORY, HIDES IT FROM THE LIST</Val>
        </Row>
        {sp.id !== activeId ? <Btn small onClick={() => onSetActive(sp.id)}>
          {printing ? "SET ACTIVE (CONFIRM)" : "SET ACTIVE"}</Btn> : null}
      </Row>
    </> : null}
  </Modal>;
}

// ---- FILAMENTS -------------------------------------------------------------------------------------
// A spool must reference a filament, so this cannot be left to Spoolman's UI without breaking "new spool".
export function FilamentsTab({ sm, say, connected }) {
  const [q, setQ] = React.useState("");
  const [edit, setEdit] = React.useState(null);
  const [vendorHint, setVendorHint] = React.useState(null);   // manufacturer with no matching vendor
  const [dbOpen, setDbOpen] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState(null);
  const filaments = useAsync(() => sm.listFilaments(), [connected]);
  const vendors = useAsync(() => sm.listVendors(), [connected]);
  const materials = useAsync(() => sm.materials(), [connected]);
  const all = Array.isArray(filaments.data) ? filaments.data : [];
  const vens = Array.isArray(vendors.data) ? vendors.data : [];
  const mats = Array.isArray(materials.data) ? materials.data : [];
  const save = useSave(() => filaments.reload(), say);

  const needle = q.trim().toLowerCase();
  const rows = all.filter(x => !needle ||
    `${x.id} ${x.name || ""} ${x.material || ""} ${(x.vendor || {}).name || ""} ${x.article_number || ""}`.toLowerCase().includes(needle))
    .sort((a, b) => a.id - b.id);

  const cols = [
    { k: "id", label: "ID", w: "50px", render: r => <span style={S(`color:${T.mute}`)}>{"#" + r.id}</span> },
    { k: "name", label: "NAME", w: "minmax(0,2fr)", render: r => <Row gap={7}>
        <span style={S(`width:9px; height:9px; flex:none; border-radius:2px; border:1px solid ${T.line2}; background:${swatch(r.color_hex) || EMPTY_COLOR}`)} />
        <span style={S("min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")}>{r.name || "—"}</span></Row> },
    { k: "material", label: "MATERIAL", w: "minmax(0,1fr)", render: r => r.material || "—" },
    { k: "vendor", label: "VENDOR", w: "minmax(0,1fr)", render: r => (r.vendor || {}).name || "—" },
    { k: "dia", label: "DIA", w: "62px", align: "right", render: r => (num(r.diameter) === null ? "—" : num(r.diameter).toFixed(2)) },
    { k: "den", label: "DENSITY", w: "76px", align: "right", render: r => (num(r.density) === null ? "—" : num(r.density).toFixed(2)) },
    { k: "temp", label: "NOZZLE", w: "72px", align: "right", render: r => (num(r.settings_extruder_temp) === null ? "—" : num(r.settings_extruder_temp) + "°") },
  ];

  return <>
    <Row gap={8} style="flex-wrap:wrap">
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="name · material · vendor · article" style="flex:1 1 240px" />
      <Btn small onClick={() => setDbOpen(true)}>FROM DATABASE</Btn>
      <Btn small kind="accent" onClick={() => { setVendorHint(null); setEdit({}); }}>NEW FILAMENT</Btn>
      <Btn small onClick={() => { filaments.reload(); vendors.reload(); }}>REFRESH</Btn>
    </Row>
    <div style={S("margin-top:8px; flex:1; min-height:0; overflow:auto")}>
      {filaments.loading && !all.length ? <div style={S(`padding:14px 8px; ${mono(10, `color:${T.ghost}`)}`)}>LOADING FILAMENTS …</div>
        : filaments.error ? <Row gap={10} style="padding:12px 8px"><Val size={10.5} color={T.err}>{filaments.error}</Val><Btn small onClick={() => filaments.reload()}>RETRY</Btn></Row>
          : <Table cols={cols} rows={rows} rowKey={r => r.id} onRow={r => setEdit(r)} empty={needle ? "NO FILAMENT MATCHES" : "NO FILAMENTS"} />}
    </div>
    <Val size={9.5} color={T.faint} style="margin-top:6px">{rows.length + " / " + all.length}</Val>

    {dbOpen ? <ExternalPicker sm={sm} vens={vens} onClose={() => setDbOpen(false)}
      onPick={e => {
        const { draft, vendorName } = fromExternal(e, vens);
        setDbOpen(false); setVendorHint(vendorName); setEdit(draft);
      }} /> : null}

    {edit ? <FilamentForm sm={sm} fl={edit} vens={vens} mats={mats} save={save} vendorHint={vendorHint}
      onVendorCreated={v => { setVendorHint(null); vendors.reload(); return v; }}
      onClose={() => { setEdit(null); setVendorHint(null); }} onDelete={() => setConfirmDel(edit)} /> : null}
    {confirmDel ? <Modal open title={"DELETE FILAMENT #" + confirmDel.id} onClose={() => setConfirmDel(null)} width={430}>
      <Confirm yes="DELETE" no="CANCEL"
        text={"Delete filament #" + confirmDel.id + " (" + (confirmDel.name || confirmDel.material || "—") + ")? Spoolman refuses while spools still reference it."}
        onYes={async () => { const ok = await save.run("Deleted filament #" + confirmDel.id, () => sm.deleteFilament(confirmDel.id)); setConfirmDel(null); if (ok) setEdit(null); }}
        onNo={() => setConfirmDel(null)} />
    </Modal> : null}
  </>;
}

function FilamentForm({ sm, fl, vens, mats, save, onClose, onDelete, vendorHint, onVendorCreated }) {
  const isNew = !fl.id;
  const initial = React.useMemo(() => ({
    name: fl.name || "", vendor_id: (fl.vendor || {}).id ?? null, material: fl.material || "",
    color_hex: (fl.color_hex || "").replace(/^#/, ""),
    diameter: num(fl.diameter) ?? 1.75, density: num(fl.density) ?? 1.24,
    weight: num(fl.weight), spool_weight: num(fl.spool_weight), price: num(fl.price),
    settings_extruder_temp: num(fl.settings_extruder_temp), settings_bed_temp: num(fl.settings_bed_temp),
    article_number: fl.article_number || "", comment: fl.comment || "",
  }), [fl.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const f = useForm(initial);
  const swatchCol = swatch(f.v.color_hex) || EMPTY_COLOR;

  const footer = <>
    {save.err ? <Val size={9.5} color={T.err} style="flex:1; overflow:hidden; text-overflow:ellipsis">{save.err}</Val>
      : <Val size={9.5} color={T.faint} style="flex:1">{"DENSITY AND DIAMETER DRIVE THE g <-> m CONVERSION"}</Val>}
    {!isNew ? <Btn small kind="ghost" onClick={onDelete}>DELETE</Btn> : null}
    <Btn small kind="accent" disabled={save.busy} onClick={async () => {
      const body = f.diff();
      // Spoolman requires density and diameter on create, and they are what the dashboard's gram/metre
      // split is computed from — a filament without them silently falls back to 1.75 / 1.24.
      if (isNew && (!f.v.density || !f.v.diameter)) { save.fail("Density and diameter are required"); return; }
      const ok = isNew
        ? await save.run("Created filament", () => sm.createFilament(Object.assign({ density: f.v.density, diameter: f.v.diameter }, body)))
        : (Object.keys(body).length ? await save.run("Saved filament #" + fl.id, () => sm.updateFilament(fl.id, body)) : true);
      if (ok) onClose();
    }}>{save.busy ? "SAVING…" : isNew ? "CREATE" : "SAVE"}</Btn>
  </>;

  return <Modal open width={540} onClose={onClose} footer={footer}
    title={isNew ? "NEW FILAMENT" : "FILAMENT #" + fl.id + " · " + (fl.name || fl.material || "—")}>
    <Row gap={10} style="flex-wrap:wrap">
      <F label="NAME"><Txt f={f} k="name" ph="e.g. Tangerine Yellow" /></F>
      <F label="VENDOR" hint={vendorHint ? "not in Spoolman yet" : null}>
        <Row gap={6}>
          <Sel f={f} k="vendor_id" options={vens.map(v => ({ id: v.id, label: v.name }))} blank="—" />
          {/* The catalogue names a manufacturer that has no vendor record here. Creating it silently
              would be worse than asking — one click, and it is selected. */}
          {vendorHint ? <Btn small disabled={save.busy} onClick={async () => {
            const ok = await save.run("Created vendor " + vendorHint, async () => {
              const v = await sm.createVendor({ name: vendorHint });
              if (v && v.id) { f.set("vendor_id", v.id); onVendorCreated && onVendorCreated(v); }
            });
            return ok;
          }}>{"+ " + vendorHint}</Btn> : null}
        </Row>
      </F>
    </Row>
    <Row gap={10} style="margin-top:10px; flex-wrap:wrap">
      <F label="MATERIAL"><Sel f={f} k="material" options={mats} blank="—" /></F>
      <F label="COLOUR (rrggbb)" w={140} hint="no leading #">
        <Row gap={6}>
          <span style={S(`width:20px; height:20px; flex:none; border-radius:3px; border:1px solid ${T.line2}; background:${swatchCol}`)} />
          <Txt f={f} k="color_hex" ph="ffc72c" />
        </Row>
      </F>
    </Row>
    <Row gap={10} style="margin-top:10px; flex-wrap:wrap">
      <F label="DIAMETER (mm)" w={110}><Txt f={f} k="diameter" type="number" /></F>
      <F label="DENSITY (g/cm³)" w={120}><Txt f={f} k="density" type="number" /></F>
      <F label="NET WEIGHT (g)" w={120}><Txt f={f} k="weight" type="number" /></F>
      <F label="EMPTY SPOOL (g)" w={120}><Txt f={f} k="spool_weight" type="number" /></F>
    </Row>
    <Row gap={10} style="margin-top:10px; flex-wrap:wrap">
      <F label="NOZZLE °C" w={100}><Txt f={f} k="settings_extruder_temp" type="number" /></F>
      <F label="BED °C" w={100}><Txt f={f} k="settings_bed_temp" type="number" /></F>
      <F label="PRICE" w={90}><Txt f={f} k="price" type="number" /></F>
      <F label="ARTICLE No."><Txt f={f} k="article_number" /></F>
    </Row>
    <Row gap={10} style="margin-top:10px"><F label="COMMENT"><Txt f={f} k="comment" /></F></Row>
  </Modal>;
}

// ---- VENDORS ---------------------------------------------------------------------------------------
export function VendorsTab({ sm, say, connected }) {
  const [edit, setEdit] = React.useState(null);
  const [confirmDel, setConfirmDel] = React.useState(null);
  const vendors = useAsync(() => sm.listVendors(), [connected]);
  const all = Array.isArray(vendors.data) ? vendors.data : [];
  const save = useSave(() => vendors.reload(), say);

  const cols = [
    { k: "id", label: "ID", w: "50px", render: r => <span style={S(`color:${T.mute}`)}>{"#" + r.id}</span> },
    { k: "name", label: "VENDOR", w: "minmax(0,2fr)", render: r => r.name || "—" },
    { k: "esw", label: "EMPTY SPOOL (g)", w: "140px", align: "right", render: r => (num(r.empty_spool_weight) === null ? "—" : num(r.empty_spool_weight).toFixed(0)) },
    { k: "comment", label: "COMMENT", w: "minmax(0,2fr)", render: r => r.comment || "—" },
  ];

  return <>
    <Row gap={8}>
      <Val size={9.5} color={T.faint} style="flex:1">{all.length + " VENDORS"}</Val>
      <Btn small kind="accent" onClick={() => setEdit({})}>NEW VENDOR</Btn>
      <Btn small onClick={() => vendors.reload()}>REFRESH</Btn>
    </Row>
    <div style={S("margin-top:8px; flex:1; min-height:0; overflow:auto")}>
      {vendors.loading && !all.length ? <div style={S(`padding:14px 8px; ${mono(10, `color:${T.ghost}`)}`)}>LOADING VENDORS …</div>
        : vendors.error ? <Row gap={10} style="padding:12px 8px"><Val size={10.5} color={T.err}>{vendors.error}</Val><Btn small onClick={() => vendors.reload()}>RETRY</Btn></Row>
          : <Table cols={cols} rows={all.slice().sort((a, b) => a.id - b.id)} rowKey={r => r.id} onRow={r => setEdit(r)} empty="NO VENDORS" />}
    </div>

    {edit ? <VendorForm sm={sm} vn={edit} save={save}
      onClose={() => setEdit(null)} onDelete={() => setConfirmDel(edit)} /> : null}

    {confirmDel ? <Modal open title={"DELETE VENDOR #" + confirmDel.id} onClose={() => setConfirmDel(null)} width={430}>
      <Confirm yes="DELETE" no="CANCEL"
        text={"Delete vendor #" + confirmDel.id + " (" + (confirmDel.name || "—") + ")? Spoolman refuses while filaments still reference it."}
        onYes={async () => { const ok = await save.run("Deleted vendor #" + confirmDel.id, () => sm.deleteVendor(confirmDel.id)); setConfirmDel(null); if (ok) setEdit(null); }}
        onNo={() => setConfirmDel(null)} />
    </Modal> : null}
  </>;
}

function VendorForm({ sm, vn, save, onClose, onDelete }) {
  const isNew = !vn.id;
  const initial = React.useMemo(() => ({
    name: vn.name || "", empty_spool_weight: num(vn.empty_spool_weight), comment: vn.comment || "",
  }), [vn.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const f = useForm(initial);
  return <Modal open width={460} onClose={onClose}
    title={isNew ? "NEW VENDOR" : "VENDOR #" + vn.id + " · " + (vn.name || "—")}
    footer={<>
      {save.err ? <Val size={9.5} color={T.err} style="flex:1; overflow:hidden; text-overflow:ellipsis">{save.err}</Val> : <span style={S("flex:1")} />}
      {!isNew ? <Btn small kind="ghost" onClick={onDelete}>DELETE</Btn> : null}
      <Btn small kind="accent" disabled={save.busy} onClick={async () => {
        const body = f.diff();
        if (isNew && !f.v.name) { save.fail("A vendor needs a name"); return; }
        const ok = isNew
          ? await save.run("Created vendor", () => sm.createVendor(Object.assign({ name: f.v.name }, body)))
          : (Object.keys(body).length ? await save.run("Saved vendor #" + vn.id, () => sm.updateVendor(vn.id, body)) : true);
        if (ok) onClose();
      }}>{save.busy ? "SAVING…" : isNew ? "CREATE" : "SAVE"}</Btn>
    </>}>
    <Row gap={10} style="flex-wrap:wrap">
      <F label="NAME"><Txt f={f} k="name" /></F>
      <F label="EMPTY SPOOL (g)" w={140} hint="default for this vendor's spools"><Txt f={f} k="empty_spool_weight" type="number" /></F>
    </Row>
    <Row gap={10} style="margin-top:10px"><F label="COMMENT"><Txt f={f} k="comment" /></F></Row>
  </Modal>;
}

// ---- external catalogue picker ---------------------------------------------------------------------
// Spoolman's "database": 6,967 commercial filaments, 2.6 MB, and NO server-side query parameters — so
// every filter here is client-side. Two consequences shape this component:
//   · it is only mounted when the picker opens, so visiting the FILAMENTS tab never pulls 2.6 MB;
//   · the rendered list is CAPPED. 6,967 rows of DOM would stall the page, and the honest answer to an
//     unfiltered search is "narrow it down", not thirty seconds of layout.
const CAP = 150;

function ExternalPicker({ sm, vens, onClose, onPick }) {
  const [q, setQ] = React.useState("");
  const [maker, setMaker] = React.useState(null);
  const [mat, setMat] = React.useState(null);
  const db = useAsync(() => sm.externalFilaments(), []);
  const all = Array.isArray(db.data) ? db.data : [];

  // Facets from the catalogue itself. Manufacturers already present as vendors float to the top,
  // because those are the ones this printer actually buys.
  const known = React.useMemo(() => new Set((vens || []).map(v => String(v.name || "").toLowerCase())), [vens]);
  const makers = React.useMemo(() => {
    const c = new Map();
    for (const e of all) { const m = e.manufacturer || ""; if (m) c.set(m, (c.get(m) || 0) + 1); }
    return [...c.entries()]
      .sort((a, b) => (known.has(b[0].toLowerCase()) - known.has(a[0].toLowerCase())) || b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => ({ id: name, label: name + " (" + n + ")" + (known.has(name.toLowerCase()) ? " ✓" : "") }));
  }, [all, known]);
  const mats = React.useMemo(() => {
    const c = new Map();
    for (const e of all) { const m = e.material || ""; if (m) c.set(m, (c.get(m) || 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => ({ id: m, label: m + " (" + n + ")" }));
  }, [all]);

  // EVERY token must appear, in any order. Substring matching on the joined string made word order
  // significant — "bambu abs azure" found nothing because the haystack reads "Bambu Lab Azure ABS",
  // which is not how anyone searches a catalogue of 7,000 products.
  const tokens = React.useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const hits = React.useMemo(() => all.filter(e => {
    if (maker && e.manufacturer !== maker) return false;
    if (mat && e.material !== mat) return false;
    if (!tokens.length) return true;
    const hay = `${e.manufacturer || ""} ${e.name || ""} ${e.material || ""}`.toLowerCase();
    return tokens.every(t => hay.includes(t));
  }), [all, tokens, maker, mat]);
  const shown = hits.slice(0, CAP);

  return <Modal open width={620} onClose={onClose} title="FILAMENT DATABASE"
    footer={<>
      <Val size={9.5} color={T.faint} style="flex:1">
        {db.loading ? "LOADING THE CATALOGUE …"
          : hits.length > CAP ? hits.length + " MATCHES — SHOWING " + CAP + ", NARROW THE SEARCH"
            : hits.length + " OF " + all.length + " MATCHES"}
      </Val>
      <Btn small onClick={onClose}>CANCEL</Btn>
    </>}>
    <Row gap={8} style="flex-wrap:wrap">
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="manufacturer · name · material" style="flex:1 1 200px" />
      <Sel f={{ v: { maker }, set: (_k, x) => setMaker(x) }} k="maker" options={makers} blank="ALL MAKERS" />
      <Sel f={{ v: { mat }, set: (_k, x) => setMat(x) }} k="mat" options={mats} blank="ALL MATERIALS" />
    </Row>

    <div style={S(`margin-top:9px; max-height:340px; overflow-y:auto; overscroll-behavior:contain; border:1px solid ${T.line}; border-radius:4px`)}>
      {db.loading ? <div style={S(`padding:16px; ${mono(10, `color:${T.ghost}`)}`)}>FETCHING 6,967 ENTRIES (2.6 MB) — ONCE PER SESSION …</div>
        : db.error ? <Row gap={10} style="padding:12px"><Val size={10.5} color={T.err}>{db.error}</Val><Btn small onClick={() => db.reload()}>RETRY</Btn></Row>
          : !shown.length ? <div style={S(`padding:16px; ${mono(10, `color:${T.faint}`)}`)}>NO CATALOGUE ENTRY MATCHES</div>
            : shown.map(e => {
              const col = swatch(e.color_hex) || (Array.isArray(e.color_hexes) && swatch(e.color_hexes[0])) || EMPTY_COLOR;
              return <Hv key={e.id} as="div" onClick={() => onPick(e)}
                style={`display:flex; align-items:center; gap:9px; padding:6px 10px; cursor:pointer; border-bottom:1px solid ${T.line}`}
                hover={`background:${T.panel3}`}>
                <span style={S(`width:11px; height:11px; flex:none; border-radius:2px; border:1px solid ${T.line2}; background:${col}`)} />
                <span style={S(`width:104px; flex:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${mono(9.5, `color:${known.has(String(e.manufacturer || "").toLowerCase()) ? T.ok : T.mute}`)}`)}>{e.manufacturer}</span>
                <span style={S(`flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; color:${T.body}`)}>{e.name}</span>
                <Chip color={T.dim}>{e.material}</Chip>
                <Val size={9} color={T.faint}>{(e.diameter ?? "—") + "mm"}</Val>
                <Val size={9} color={T.faint}>{(e.extruder_temp ?? "—") + "°"}</Val>
              </Hv>;
            })}
    </div>
  </Modal>;
}
