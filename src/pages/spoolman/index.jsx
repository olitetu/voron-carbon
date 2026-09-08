// SPOOLMAN page — Spoolman's own web UI, embedded, plus the strip it cannot draw: Moonraker's
// active spool and Happy Hare's gate → spool map. Spoolman is a separate service on its own port
// and knows nothing about this printer's MMU, so the gate mapping only exists here.
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Divider, Input, Table, Confirm, T, mono, fmtDate } from "../../lib/design.jsx";
import { S, Hv } from "../../lib/ui.js";
import { useStore, useAsync, usePersisted } from "../../lib/useStore.js";
import GateEditor from "../../lib/GateEditor.jsx";
import { makeMmuActions } from "../../lib/actions/mmu.js";
import { useSpoolList, num, swatch, grams, metres, whenSeconds, spoolName, fillOf, filterSpools, EMPTY_COLOR, DESIGN_BLACK, LOW } from "../../lib/spools.js";

// Spoolman's address comes from moonraker.conf ([spoolman] server:). When that lookup fails, fall
// back the way the contract does — Moonraker's own host on Spoolman's default port, never a literal
// hostname, because this build is also served from the printer itself under whatever name it answers to.
const fallbackUrl = api => String((api && api.base) || (typeof location !== "undefined" ? location.origin : "")).replace(/:\d+$/, "") + ":7912";
// Spool formatting (swatch / grams / metres / fillOf / LOW ...) is shared with the gate editor —
// see lib/spools.js. Only the date wrapper stays local, because it composes the design's fmtDate.
const when = iso => { const t = whenSeconds(iso); return t === null ? "—" : fmtDate(t); };

export default function Page({ store, api }) {
  const st = useStore(store);
  const [pickerOpen, setPickerOpen] = usePersisted("spoolman.picker", false);
  const [q, setQ] = usePersisted("spoolman.q", "");
  const [pending, setPending] = React.useState(null);   // spool awaiting the mid-print confirm
  const [editGate, setEditGate] = React.useState(null); // gate whose "change filament" dialog is open
  const [frame, setFrame] = React.useState(0);          // bumped to remount the iframe (RELOAD)

  const say = React.useCallback((message, type) => {
    const entry = { time: Date.now() / 1000, message: String(message), type: type || "info", local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }, [store]);

  // Where Spoolman lives + whether Moonraker's own connection to it is up. Re-runs on (re)connect,
  // because an rpc issued before the socket is open rejects immediately.
  const svc = useAsync(() => Promise.all([
    api.rpc("server.config").catch(() => null),
    api.rpc("server.spoolman.status"),
  ]).then(([cfg, s]) => {
    // status.spool_id IS the id Moonraker logs usage against — the authority for this strip. The
    // store learns the active spool from boot's hydrate(), which only runs on a klippy-READY boot,
    // and from notify_active_spool_set, which only fires on a CHANGE. Open Carbon while Klipper is
    // down (or reconnect after a Moonraker restart) and activeSpool stays null forever — the card
    // reads "No active spool" while a spool is very much active. Adopt the truth we just fetched;
    // this also makes REFRESH re-sync it.
    if ("spool_id" in s) {
      const id = typeof s.spool_id === "number" ? s.spool_id : null;
      if (id !== (store.state.activeSpool ?? null)) store.set({ activeSpool: id });
    }
    return {
      url: String((((cfg || {}).config || {}).spoolman || {}).server || fallbackUrl(api)).replace(/\/+$/, ""),
      // no [spoolman] section in moonraker.conf → the url above is a guess, so say so in the offline copy
      configured: !!(((cfg || {}).config || {}).spoolman || {}).server,
      connected: !!s.spoolman_connected,
      pending: (s.pending_reports || []).length,
    };
  }), [st.connected]);

  // The whole spool list (~40 spools): names the gate spools the store has not cached yet and backs
  // the picker. Shared with the gate editor — the fetch, the merge and the "store wins" rule are in
  // lib/spools.js so both surfaces show the same numbers.
  const list = useSpoolList(api, st);
  const all = list.all, byId = list.byId;

  const activeId = st.activeSpool || null;
  // The list covers the active spool once loaded; this carries the first paint (and an archived
  // spool, which /spool omits).
  const one = useAsync(() => (activeId && !((st.spools || {})[activeId]) ? api.spoolman("/spool/" + activeId) : Promise.resolve(null)), [activeId, st.connected]);
  const active = (activeId && byId[activeId]) || (one.data && one.data.id === activeId ? one.data : null);

  // Pages receive { store, api, route, navigate } but no action set, so the gate editor's actions are
  // built here. makeMmuActions is a stateless factory over (api, store, log) — one implementation,
  // called from both surfaces, which is why this is not a duplicate of the dashboard's copy.
  const mmuAct = React.useMemo(() => makeMmuActions({ api, store, log: say }), [api, store, say]);

  const raw = st.raw || {};
  const mmu = raw.mmu || null;
  const gateIds = (mmu && Array.isArray(mmu.gate_spool_id)) ? mmu.gate_spool_id : [];
  // A paused job still resumes into the same usage report, so it counts as "in a print" here.
  const printing = ["printing", "paused"].indexOf((raw.print_stats || {}).state) >= 0;
  const gateCount = mmu ? Math.max(0, Math.min(12, mmu.num_gates || gateIds.length || 0)) : 0;
  const online = !!(svc.data && svc.data.connected);
  const url = (svc.data && svc.data.url) || fallbackUrl(api);
  // Spoolman is http-only; a page served over https could never load it in a frame, and the frame
  // would fail silently (blocked by the browser, not by Spoolman) — say so instead.
  const mixed = typeof location !== "undefined" && location.protocol === "https:" && /^http:/i.test(url);

  /**
   * Set the active spool, optimistically: Moonraker acknowledges in a few ms but the confirming
   * notify_active_spool_set (boot.js) lands much later, and a rejected call is put back by hand.
   */
  async function setActive(id) {
    const prev = st.activeSpool ?? null;
    if (id === prev) return;
    store.set({ activeSpool: id });
    const sp = id ? byId[id] : null;
    try {
      // Moonraker runs spool_id through int(), so an explicit null is a 400 ("unable to convert
      // argument") — clearing means sending the request with no spool_id at all, which its handler
      // defaults to None. api.spoolmanSetActive always sends the key, hence the raw rpc here.
      await (id == null ? api.rpc("server.spoolman.post_spool_id", {}) : api.spoolmanSetActive(id));
      // Logged AFTER the round-trip. The store update above is optimistic and self-corrects, but the
      // console is a permanent record: announcing the swap up front left a green "active spool → #35"
      // line standing in the log even when the call failed and the change was rolled back.
      say(id ? `Spoolman: active spool → #${id}${sp ? " · " + spoolName(sp) : ""}` : "Spoolman: active spool cleared", "ok");
    } catch (e) {
      store.set({ activeSpool: prev });
      say(`Spoolman: could not ${id ? `set #${id} active` : "clear the active spool"} — ${(e && e.message) || String(e)}`, "err");
    }
  }
  // Moonraker logs filament use against whichever spool is active AT THE TIME, so swapping during a
  // print silently mis-attributes the rest of the job. Ask first.
  const request = id => {
    if (id === (st.activeSpool ?? null)) return;          // clicking the spool that is already active
    return printing ? setPending({ id }) : setActive(id);
  };
  const refresh = () => { svc.reload(); list.reload(); one.reload(); };

  // ---- picker rows: active first, then the spools sitting in a gate, then the rest
  const needle = String(q || "").trim().toLowerCase();
  const rows = React.useMemo(
    () => filterSpools(all, needle, { activeId, gateIds }),
    [list.data, needle, activeId, mmu && mmu.gate_spool_id]
  );

  const cols = [
    { k: "id", label: "ID", w: "52px", render: r => <span style={S(`color:${r.id === activeId ? T.ok : T.mute}`)}>{"#" + r.id}</span> },
    {
      k: "name", label: "FILAMENT", w: "minmax(0,2fr)", render: r => {
        const g = gateIds.indexOf(r.id);
        return <Row gap={7}>
          <span style={S(`width:9px; height:9px; flex:none; border-radius:2px; border:1px solid ${T.line2}; background:${swatch((r.filament || {}).color_hex) || EMPTY_COLOR}`)} />
          <span style={S("min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")}>{spoolName(r)}</span>
          {g >= 0 && <span style={S(`${mono(9, `color:${T.faint}`)}; flex:none`)}>{"@" + g}</span>}
        </Row>;
      },
    },
    { k: "mat", label: "MATERIAL", w: "minmax(0,1fr)", render: r => (r.filament || {}).material || "—" },
    { k: "vendor", label: "VENDOR", w: "minmax(0,1fr)", render: r => ((r.filament || {}).vendor || {}).name || "—" },
    {
      k: "left", label: "REMAINING", w: "112px", align: "right", render: r => {
        const f = fillOf(r), left = num(r.remaining_weight);
        return <span style={S(`color:${f !== null && f < LOW ? T.warn : T.body}`)}>{grams(left)}{f === null ? "" : ` · ${Math.round(f * 100)}%`}</span>;
      },
    },
  ];

  // ---- active spool card
  const fil = (active && active.filament) || {};
  const col = swatch(fil.color_hex) || T.ghost;
  const fill = fillOf(active);
  const totalW = num(active && active.initial_weight) ?? num(fil.weight);

  return <div style={S("flex:1; display:grid; gap:10px; padding:10px; grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); min-height:0")}>

    <Panel title="ACTIVE SPOOL" right={<Row gap={8}>
      <Chip color={svc.loading ? T.dim : online ? T.ok : T.warn} pulse={online}>{svc.loading ? "CHECKING" : online ? "CONNECTED" : "OFFLINE"}</Chip>
      {!!(svc.data && svc.data.pending) && <Chip color={T.info}>{svc.data.pending + " QUEUED"}</Chip>}
      <Btn small kind={pickerOpen ? "accent" : "default"} onClick={() => setPickerOpen(v => !v)}>{pickerOpen ? "CLOSE PICKER" : "SET ACTIVE"}</Btn>
      <Btn small onClick={refresh}>REFRESH</Btn>
    </Row>}>

      {!activeId ? (
        <Row gap={10}>
          <div style={S(`width:44px; height:44px; flex:none; border-radius:4px; border:1px dashed ${T.line2}; background:${T.panel3}`)} />
          <div>
            <Val size={13} color={T.dim}>No active spool</Val>
            <div style={S(`${mono(10, `color:${T.faint}`)}; margin-top:4px`)}>MOONRAKER IS NOT LOGGING FILAMENT USE — PICK A SPOOL BELOW</div>
          </div>
        </Row>
      ) : !active ? (
        <div style={S(`${mono(10.5, `color:${T.mute}`)}`)}>{one.error ? "SPOOL #" + activeId + " — " + one.error : one.loading ? "LOADING SPOOL #" + activeId + " …" : "SPOOL #" + activeId + " IS NOT IN SPOOLMAN"}</div>
      ) : (
        <Row gap={12} align="stretch">
          <div style={S(`width:44px; flex:none; border-radius:4px; border:1px solid ${T.line2}; background:${col}`)} />
          <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:7px")}>
            <Row gap={8}>
              <Val size={14}>{spoolName(active)}</Val>
              <Chip color={T.dim}>{fil.material || "—"}</Chip>
              {!!(fil.vendor && fil.vendor.name) && <Chip color={T.mute}>{fil.vendor.name.toUpperCase()}</Chip>}
              <Chip color={T.faint}>{"#" + active.id}</Chip>
              {fill !== null && fill < LOW && <Chip color={T.warn} border="#3a2f14" bg="#14100a">LOW</Chip>}
              {!!active.location && <span style={S(`${mono(9, `color:${T.faint}; letter-spacing:.08em`)}; margin-left:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{active.location}</span>}
            </Row>
            <div style={S(`height:6px; border-radius:3px; background:${T.panel2}; border:1px solid ${T.line}; overflow:hidden`)}>
              <div style={S(`height:100%; width:${fill === null ? 0 : (fill * 100).toFixed(1)}%; background:${col}; transition:width .3s ease`)} />
            </div>
            <Row gap={16}>
              <div><Label>REMAINING</Label><Val size={11.5} color={fill !== null && fill < LOW ? T.warn : T.text}>{grams(num(active.remaining_weight))}</Val></div>
              <div><Label>LENGTH</Label><Val size={11.5}>{metres(num(active.remaining_length))}</Val></div>
              <div><Label>USED</Label><Val size={11.5} color={T.body}>{grams(num(active.used_weight))}</Val></div>
              <div><Label>SPOOL</Label><Val size={11.5} color={T.dim}>{grams(totalW)}</Val></div>
              <div><Label>LAST USED</Label><Val size={11.5} color={T.dim}>{when(active.last_used)}</Val></div>
            </Row>
          </div>
        </Row>
      )}

      {/* Gate → spool. Spoolman has no idea these gates exist; Happy Hare's arrays are the only source. */}
      <Divider />
      <Row gap={8} style="margin-bottom:6px">
        <Label>MMU GATES</Label>
        {!!gateCount && <Val size={9.5} color={T.faint}>{(gateIds.slice(0, gateCount).filter(i => i > 0).length) + " OF " + gateCount + " MAPPED TO A SPOOL"}</Val>}
      </Row>
      {!gateCount ? (
        <div style={S(`${mono(10, `color:${T.ghost}`)}`)}>{mmu ? "MMU REPORTS NO GATES" : "NO MMU REPORTED"}</div>
      ) : (
        <div style={S("display:flex; gap:6px; flex-wrap:wrap")}>
          {Array.from({ length: gateCount }, (_, g) => {
            const id = gateIds[g] > 0 ? gateIds[g] : null;
            const sp = id ? byId[id] : null;
            // -1 is Happy Hare's GATE_UNKNOWN; only 0 (GATE_EMPTY) dims. A missing array must not dim
            // every gate, so an absent value reads as unknown rather than as empty.
            const gs = (mmu.gate_status || [])[g];
            const status = typeof gs === "number" ? gs : -1;
            const loadedHere = String(mmu.filament || "").toLowerCase() === "loaded" && mmu.gate === g;
            const isActive = !!id && id === activeId;
            const color = swatch((mmu.gate_color || [])[g]) || swatch(sp && sp.filament && sp.filament.color_hex) || EMPTY_COLOR;
            const name = (sp && spoolName(sp)) || (mmu.gate_filament_name || [])[g] || (mmu.gate_material || [])[g] || "—";
            const f = fillOf(sp);
            return <Hv key={g} as="div" onClick={id ? () => request(id) : undefined}
              title={!id ? "no spool mapped to this gate" : isActive ? "Spool #" + id + " — already the active spool" : "Spool #" + id + " — set active"}
              style={`flex:1 1 108px; min-width:0; padding:6px 8px; border:1px solid ${loadedHere ? "#4a2318" : T.line}; border-radius:4px; background:${loadedHere ? "#12161d" : T.panel3}; display:flex; flex-direction:column; gap:5px; opacity:${status === 0 ? .45 : 1}; ${id ? "cursor:pointer;" : ""}`}
              hover={id ? `border-color:${T.line2}` : ""}>
              <Row gap={5}>
                <Label style={`color:${loadedHere ? T.accent : T.faint}`}>{"G" + g}</Label>
                {isActive && <span style={S(`width:5px; height:5px; border-radius:50%; background:${T.ok}`)} title="active spool" />}
                {/* the strip is where a nearly-empty gate has to be spotted, so it warns on the same
                    threshold as the card's LOW chip — it used to render 5% exactly like 97%. */}
                <Val size={9} color={f !== null && f < LOW ? T.warn : T.mute} style="margin-left:auto">{f === null ? (id ? "#" + id : "—") : Math.round(f * 100) + "%"}</Val>
                {/* The tile's own onClick sets the spool ACTIVE, so this swallows the event. Same dialog
                    the dashboard spool cards open — lib/GateEditor.jsx, mounted once per surface. */}
                <Hv as="div" title={"Change the filament in gate " + g}
                  onClick={e => { if (e && e.stopPropagation) e.stopPropagation(); setEditGate(g); }}
                  style={`cursor:pointer; padding:1px 3px; border-radius:2px; border:1px solid ${T.line2}; ${mono(10.5, `color:${T.dim}; line-height:1`)}`}
                  hover={`background:${T.panel2}; color:${T.text}; border-color:#4a5666`}>{"\u270e"}</Hv>
              </Row>
              <div style={S(`height:4px; border-radius:2px; background:${color}`)} />
              <div style={S(`${mono(10, `color:${T.body}`)}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{name}</div>
              {/* material + spool id is data, not a micro-label: T.faint at 8.5px measured 2.5:1 on
                  this tile's ground, so it reads at T.mute (3.8:1). */}
              <div style={S(`${mono(8.5, `color:${T.mute}; letter-spacing:.1em`)}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>
                {((mmu.gate_material || [])[g] || (sp && sp.filament && sp.filament.material) || "—") + (id ? " · #" + id : "")}
              </div>
            </Hv>;
          })}
        </div>
      )}

      {pickerOpen && <>
        <Divider />
        <Row gap={8}>
          <Label>FILTER</Label>
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="name · material · vendor · id" style="flex:1" />
          <Val size={9.5} color={T.faint}>{rows.length + " / " + all.length}</Val>
          {!!activeId && <Btn small kind="ghost" onClick={() => request(null)}>CLEAR ACTIVE</Btn>}
        </Row>
        <div style={S("max-height:230px; overflow:auto; margin-top:6px")}>
          {list.loading ? <div style={S(`padding:14px 8px; ${mono(10, `color:${T.ghost}`)}`)}>LOADING SPOOLS …</div>
            : list.error ? <Row gap={10} style="padding:12px 8px"><Val size={10.5} color={T.err}>{list.error}</Val><Btn small onClick={() => list.reload()}>RETRY</Btn></Row>
              : <Table cols={cols} rows={rows} rowKey={r => r.id} onRow={r => request(r.id)}
                empty={needle ? "NO SPOOL MATCHES" : "SPOOLMAN HAS NO SPOOLS"}
                rowStyle={r => (r.id === activeId ? "background:#101821" : "")} />}
        </div>
      </>}

      {/* Cancels the panel body's 10px 12px padding so the strip spans the panel like the design's. */}
      {pending && <div style={S("margin:10px -12px -10px; overflow:hidden; border-radius:0 0 5px 5px")}>
        <Confirm yes={pending.id ? "SET ACTIVE" : "CLEAR"}
          text={pending.id
            ? `A print is running. Set #${pending.id} · ${spoolName(byId[pending.id])} active? The rest of this job's filament is logged against it.`
            : "A print is running. Clear the active spool? The rest of this job's filament use is not logged anywhere."}
          onYes={() => { const p = pending; setPending(null); setActive(p.id); }}
          onNo={() => setPending(null)} />
      </div>}
    </Panel>

    {/* min-height only has to keep the frame usable when the row above is tall; 420 forced the whole
        app to grow a page scrollbar on any viewport under ~740 px (Orca's Device tab is short). The
        minmax(0,1fr) row still grows the frame past this on a normal screen. */}
    <Panel title="SPOOLMAN" flat style="min-height:360px" bodyStyle="display:flex"
      right={<Row gap={8}>
        <Val size={9} color={T.faint} style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{url}</Val>
        <Btn small onClick={() => setFrame(n => n + 1)} disabled={!online || mixed}>RELOAD</Btn>
      </Row>}>
      {svc.loading && !svc.data ? (
        <div style={S(`flex:1; display:flex; align-items:center; justify-content:center; ${mono(10, `letter-spacing:.24em; color:${T.ghost}`)}`)}>CONNECTING …</div>
      ) : online && !mixed ? (
        // Cross-origin by design (own port, own service): nothing in here can be styled or scripted
        // from Carbon, and it must stay an iframe — Orca's OnNewWindow handler throws the user out
        // of the app into their system browser, so no target=_blank / window.open anywhere.
        <iframe key={frame} src={url + "/"} title="Spoolman" referrerPolicy="no-referrer"
          style={S(`flex:1; width:100%; border:0; background:${T.bg}; border-radius:0 0 5px 5px`)} />
      ) : (
        <div style={S("flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:40px")}>
          <div style={S(`${mono(11, `letter-spacing:.3em; color:${T.accent}`)}`)}>{mixed ? "SPOOLMAN CANNOT BE FRAMED" : "SPOOLMAN UNREACHABLE"}</div>
          <div style={S(`font-size:12px; color:${T.mute}; max-width:470px; text-align:center; text-wrap:pretty`)}>
            {mixed
              ? "Carbon is served over https and Spoolman answers on " + url + " — the browser blocks that frame as mixed content. Serve Carbon over http, or put Spoolman behind the printer's https."
              : svc.error
                ? "Moonraker did not answer: " + svc.error
                : (svc.data && svc.data.configured)
                  ? "Moonraker cannot reach " + url + ". The service is configured but not responding — nothing would load in the frame, so it is not shown."
                  : "moonraker.conf has no [spoolman] section, so " + url + " is only a guess — and nothing is answering there. Add the server address to moonraker.conf."}
          </div>
          <Btn onClick={refresh}>RETRY</Btn>
        </div>
      )}
    </Panel>

    {/* The one gate editor in the build (lib/GateEditor.jsx); the dashboard mounts the same component. */}
    <GateEditor open={editGate !== null} gate={editGate} store={store} api={api}
      act={mmuAct} onClose={() => setEditGate(null)} />
  </div>;
}
