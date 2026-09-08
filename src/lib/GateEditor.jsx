// Gate editor — the one place a gate's filament is changed, shared by the dashboard MMU spool cards,
// the SPOOLMAN page's gate strip and the MMU panel's ⋮ menu. There is deliberately no second copy:
// Mainsail's MMU panel is being retired, and a dialog that drifted between three call sites would be
// the same problem in a new place.
//
// SPOOLMAN IS THE SOURCE OF TRUTH. Filament identity — name, material, colour, temperature, weights,
// usage — belongs to the spool record, so all of it is REFLECTED read-only here. The only write that
// touches identity is choosing which spool sits in the gate, and even then no attribute is typed in:
// changing the spool makes Happy Hare fetch that spool's record and overwrite the gate's name /
// material / colour / temperature from it (measured live: it replaced a passed TEMP=200 with the
// spool's own 250 C).
//
// Which command carries that assignment depends on spoolman_support and is NOT obvious — see
// assignSpool() in lib/actions/mmu.js. Short version: in `pull` mode it goes through MMU_SPOOLMAN; in
// `push` mode (this printer) it must go to the LOCAL map via MMU_GATE_MAP, because MMU_SPOOLMAN there
// writes only the remote record and the next sync pushes HH's unchanged map back out, silently undoing
// the assignment.
//
// Two attributes are genuinely local to Happy Hare and editable here — HH's own source says so
// ("gate_speed_override and gate_status can be set locally"):
//   · Filament available in gate  → AVAILABLE
//   · Load speed override         → SPEED (HH clamps to 10..150)
import React from "react";
import { Modal, Btn, Chip, Label, Val, Row, Divider, Input, Toggle, Confirm, T, mono, fmtDate } from "./design.jsx";
import { S, Hv } from "./ui.js";
import { useStore } from "./useStore.js";
import { useSpoolList, filterSpools, swatch, grams, metres, whenSeconds, spoolName, fillOf, num, EMPTY_COLOR, LOW } from "./spools.js";

const R = 25, C = 2 * Math.PI * R;

/** The design's spool ring: track + coloured arc for the remaining fraction. */
function SpoolRing({ color, fill }) {
  const f = fill === null ? 1 : fill;
  return <div style={S("position:relative; width:76px; height:76px; flex:none")}>
    <svg viewBox="0 0 60 60" style={S("width:76px; height:76px; transform:rotate(-90deg)")}>
      <circle cx="30" cy="30" r={R} fill="none" stroke={T.panel2} strokeWidth="4" />
      <circle cx="30" cy="30" r={R} fill="none" stroke={color || EMPTY_COLOR} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${(C * f).toFixed(1)} ${C.toFixed(1)}`} opacity={fill === null ? 0.35 : 1} />
    </svg>
    <div style={S("position:absolute; inset:0; display:flex; align-items:center; justify-content:center")}>
      <Val size={12} color={fill !== null && fill <= LOW ? T.warn : T.text}>
        {fill === null ? "—" : Math.round(fill * 100) + "%"}
      </Val>
    </div>
  </div>;
}

/** One read-only fact, laid out like the design's stat rows. */
function Fact({ label, children }) {
  return <div style={S("min-width:0")}>
    <Label>{label}</Label>
    <div style={S(`margin-top:3px; font-size:12px; color:${T.body}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{children}</div>
  </div>;
}

export default function GateEditor({ open, gate, store, api, act, onClose }) {
  const st = useStore(store);
  const list = useSpoolList(api, st, { enabled: open });
  const [picking, setPicking] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [pending, setPending] = React.useState(null);   // { id } awaiting the mid-print confirm
  const [speed, setSpeed] = React.useState(null);       // local while dragging; null = follow the store

  const raw = st.raw || {};
  const mmu = raw.mmu || {};
  const g = Number(gate);
  const at = (k, d) => { const v = (mmu[k] || [])[g]; return v === undefined || v === null ? d : v; };

  const spoolId = num(at("gate_spool_id", -1));
  const spool = spoolId && spoolId > 0 ? list.byId[spoolId] : null;
  const fil = (spool && spool.filament) || {};
  // Prefer Spoolman's record; fall back to HH's mirrored copy only until the list arrives.
  const name = spoolName(spool) !== "—" ? spoolName(spool) : (at("gate_filament_name", "") || "—");
  const material = fil.material || at("gate_material", "") || "—";
  const color = swatch(fil.color_hex) || swatch(at("gate_color", ""));
  const temp = num(fil.settings_extruder_temp) ?? num(at("gate_temperature", null));
  const available = !!num(at("gate_status", 0));
  const storeSpeed = num(at("gate_speed_override", 100)) ?? 100;
  const shownSpeed = speed === null ? storeSpeed : speed;

  const printing = ["printing", "paused"].indexOf((raw.print_stats || {}).state) >= 0;
  const gateIds = Array.isArray(mmu.gate_spool_id) ? mmu.gate_spool_id : [];
  const rows = React.useMemo(
    () => filterSpools(list.all, q, { activeId: st.activeSpool || null, gateIds }),
    [list.all, q, st.activeSpool, mmu.gate_spool_id]
  );

  // Reset the transient bits whenever the dialog opens on a different gate.
  React.useEffect(() => { setPicking(false); setQ(""); setPending(null); setSpeed(null); }, [gate, open]);

  const call = (fn, ...args) => (act && typeof act[fn] === "function" ? act[fn](...args) : undefined);

  /** Moonraker attributes filament use to whatever spool is mapped AT THE TIME, so mid-print asks first. */
  const chooseSpool = id => {
    if (id === spoolId) { setPicking(false); return; }
    if (printing) { setPending({ id }); return; }
    call("assignSpool", g, id);
    setPicking(false);
  };
  const commitSpeed = v => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n === storeSpeed) { setSpeed(null); return; }
    call("setGateLocal", g, { speed_override: n });
    setSpeed(null);
  };

  const footer = <>
    <Val size={9.5} color={T.faint} style="flex:1; letter-spacing:.06em">
      {"SPOOLMAN HOLDS FILAMENT IDENTITY"}
    </Val>
    <Btn small onClick={onClose}>CLOSE</Btn>
  </>;

  return <Modal open={open} onClose={onClose} width={430}
    title={"GATE " + (Number.isFinite(g) ? g : "?") + " · CHANGE FILAMENT"} footer={footer}>

    {pending ? <Confirm
      text={`A print is running. Re-mapping gate ${g} now changes how the rest of this job's filament use is attributed in Spoolman.`}
      yes="RE-MAP ANYWAY" no="KEEP CURRENT"
      onYes={() => { call("assignSpool", g, pending.id); setPending(null); setPicking(false); }}
      onNo={() => setPending(null)} /> : null}

    {/* ---- what Spoolman says is in this gate (read-only) ---- */}
    <Row gap={14} align="flex-start">
      <SpoolRing color={color} fill={fillOf(spool)} />
      <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:9px")}>
        <div style={S("min-width:0")}>
          <div style={S(`font-size:14px; color:${T.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{name}</div>
          <Row gap={6} style="margin-top:4px">
            <Chip color={T.dim}>{material}</Chip>
            {temp !== null ? <Chip color={T.warn}>{temp + "°C"}</Chip> : null}
            {spoolId && spoolId > 0
              ? <Val size={9.5} color={T.mute}>{"#" + spoolId}</Val>
              : <Val size={9.5} color={T.faint}>{"NO SPOOL"}</Val>}
          </Row>
        </div>
        <Row gap={16}>
          <Fact label="REMAINING">{grams(num(spool && spool.remaining_weight))}</Fact>
          <Fact label="LENGTH LEFT">{metres(num(spool && spool.remaining_length))}</Fact>
        </Row>
        <Fact label="LAST USED">
          {(() => { const t = whenSeconds(spool && spool.last_used); return t === null ? "—" : fmtDate(t); })()}
        </Fact>
      </div>
    </Row>

    <Row gap={8} style="margin-top:12px">
      <Btn small kind="accent" onClick={() => setPicking(p => !p)}>{picking ? "CANCEL" : "CHOOSE SPOOL"}</Btn>
      {spoolId && spoolId > 0
        ? <Btn small kind="ghost" onClick={() => (printing ? setPending({ id: null }) : call("assignSpool", g, null))}>CLEAR</Btn>
        : null}
      <Btn small kind="ghost" title="Rebuild Happy Hare's Spoolman cache and re-sync the gate map"
        onClick={() => call("refreshSpoolman")} style="margin-left:auto">REFRESH</Btn>
    </Row>

    {/* ---- the picker: assignment is the only identity write, and it lands in Spoolman ---- */}
    {picking ? <div style={S(`margin-top:10px; border:1px solid ${T.line}; border-radius:5px; overflow:hidden`)}>
      <div style={S(`padding:7px; border-bottom:1px solid ${T.line}`)}>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="name · material · vendor · id" style="width:100%" />
      </div>
      <div style={S("max-height:210px; overflow-y:auto; overscroll-behavior:contain")}>
        {list.loading && !rows.length
          ? <div style={S(`padding:12px; ${mono(10, `color:${T.faint}`)}`)}>LOADING SPOOLS…</div>
          : list.error
            ? <div style={S(`padding:12px; ${mono(10, `color:${T.err}`)}`)}>{"SPOOLMAN: " + list.error}</div>
            : !rows.length
              ? <div style={S(`padding:12px; ${mono(10, `color:${T.faint}`)}`)}>NO MATCHING SPOOLS</div>
              : rows.map(sp => {
                const f = sp.filament || {}, fl = fillOf(sp), inGate = gateIds.indexOf(sp.id);
                return <Hv key={sp.id} as="div" onClick={() => chooseSpool(sp.id)}
                  style={`display:flex; align-items:center; gap:8px; padding:6px 9px; cursor:pointer; border-bottom:1px solid ${T.line}; ${sp.id === spoolId ? `background:${T.panel3}` : ""}`}
                  hover={`background:${T.panel3}`}>
                  <span style={S(`width:10px; height:10px; flex:none; border-radius:2px; border:1px solid ${T.line2}; background:${swatch(f.color_hex) || EMPTY_COLOR}`)} />
                  <span style={S(`flex:1; min-width:0; font-size:12px; color:${T.body}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{spoolName(sp)}</span>
                  {inGate >= 0 && inGate !== g ? <Chip color={T.warn}>{"GATE " + inGate}</Chip> : null}
                  <Val size={9.5} color={fl !== null && fl <= LOW ? T.warn : T.mute}>{fl === null ? "—" : Math.round(fl * 100) + "%"}</Val>
                  <Val size={9.5} color={T.faint}>{"#" + sp.id}</Val>
                </Hv>;
              })}
      </div>
    </div> : null}

    <Divider />

    {/* ---- the two attributes Happy Hare owns locally ---- */}
    <Row gap={10}>
      <div style={S("flex:1; min-width:0")}>
        <div style={S(`font-size:12px; color:${T.body}`)}>{"Filament available in gate"}</div>
        <Val size={9.5} color={T.faint}>{"HAPPY HARE, NOT SPOOLMAN"}</Val>
      </div>
      <Toggle on={available} onClick={() => call("setGateLocal", g, { status: !available })} />
    </Row>

    <Row gap={10} style="margin-top:12px">
      <div style={S("flex:1; min-width:0")}>
        <div style={S(`font-size:12px; color:${T.body}`)}>{"Load speed override"}</div>
        <Val size={9.5} color={T.faint}>{"10–150% OF THE GATE'S LOAD SPEED"}</Val>
      </div>
      <Input type="number" value={String(shownSpeed)} style="width:64px; text-align:right"
        onChange={e => setSpeed(e.target.value)} onEnter={() => commitSpeed(shownSpeed)} />
      <Val size={10} color={T.mute}>%</Val>
    </Row>
    <input type="range" min="10" max="150" step="5" value={String(shownSpeed)}
      onChange={e => setSpeed(e.target.value)} onMouseUp={e => commitSpeed(e.target.value)}
      onTouchEnd={e => commitSpeed(shownSpeed)}
      style={S(`width:100%; margin-top:8px; accent-color:${T.accent}`)} />
  </Modal>;
}
