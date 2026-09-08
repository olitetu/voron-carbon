// MACHINE page — host system, MCUs, endstops, host power, systemd services and the update manager,
// all on ONE scrolling page. Config files have their own page (/config); this one only points there.
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, Divider, Table, Confirm,
         T, mono, fmtBytes, fmtDate } from "../../lib/design.jsx";
import { S, Hv } from "../../lib/ui.js";
import { useStore, useAsync, usePersisted } from "../../lib/useStore.js";
import { makeMachineActions, throttleSummary, fmtUptime, isPrintActive, KLIPPER_SERVICES } from "../../lib/actions/machine.js";

const KLIPPER_STATS_INTERVAL = 5;   // s — the window `mcu_awake` is measured over

// bytes_retransmit is a BYTE count, not a packet count, and every link re-sends a handful of bytes
// just establishing itself (measured on this printer with nothing wrong with it: 9 B on `mcu`, 9 B on
// `mcu mmu`, 0 elsewhere). Warning at >0 therefore painted a permanent yellow "18 B RETRANSMITTED"
// header on a healthy machine — a crying-wolf alarm. Kilobytes are the point at which a CAN/USB link
// is actually losing data, which is what the per-MCU note already said.
const RT_WARN = 1024, RT_BAD = 65536;
const rtTone = b => (b === null ? T.ghost : b >= RT_BAD ? T.err : b >= RT_WARN ? T.warn : T.mute);

const DASH = "—";
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
// boot() opens the websocket asynchronously, so every RPC issued on the first render of a cold load
// rejects with "not connected". Staying pending until st.connected turns true keeps the panels in
// their loading state instead of latching that error, and the flag is a dependency so they refetch
// after a reconnect. (Same idiom as the FILES and HISTORY pages.)
const PENDING = new Promise(() => {});
// The actions log their own failures and resolve false instead of throwing, but a button handler
// must never be the place an unhandled rejection surfaces — so every fire-and-forget goes through this.
const fire = p => { Promise.resolve(p).catch(() => { /* logged by the action */ }); };

/** Label / value row, using the design's inner divider (#10161e) rather than a Panel border. */
function KV({ k, v, color = T.body, title, wrap }) {
  return <div title={title} style={S("display:flex; align-items:baseline; justify-content:space-between; gap:14px; padding:5px 0; border-bottom:1px solid #10161e")}>
    <span style={S(`font-size:11.5px; color:${T.dim}; white-space:nowrap`)}>{k}</span>
    <span style={S(`${mono(11, `color:${color}`)}; text-align:right; min-width:0; ${wrap ? "" : "overflow:hidden; text-overflow:ellipsis; white-space:nowrap"}`)}>{v}</span>
  </div>;
}

/** Hairline usage bar — the design has no progress primitive, so it is spelled out here. */
function Meter({ pct, color = T.info, w = 46 }) {
  const p = Math.max(0, Math.min(100, num(pct) === null ? 0 : pct));
  return <span style={S(`display:inline-block; width:${w}px; height:4px; border-radius:2px; background:${T.panel2}; overflow:hidden; vertical-align:middle`)}>
    <span style={S(`display:block; height:100%; width:${p}%; background:${color}`)} /></span>;
}

/**
 * Wide table in its own scroller. Table's columns are fixed px, so SERVICES needs ~500 px and UPDATE
 * MANAGER ~885 px; below that the grid pushed the whole PAGE wider than the viewport. The shell has
 * no outer overflow-x on purpose (the nav rail is position:sticky and an outer scroller was its
 * containing block), so a wide table has to scroll inside its own panel instead. Orca's Device tab is
 * routinely narrower than 900 px, which is where this showed up.
 */
function Wide({ min, children }) {
  return <div style={S("max-width:100%; overflow-x:auto; overflow-y:hidden")}>
    <div style={S(`min-width:${min}px`)}>{children}</div></div>;
}

/** Anchor styled as a Btn. Orca ejects the user to their system browser on any new window, so these
    are same-tab hrefs with `download` — never target=_blank. */
function LinkBtn({ href, children, title }) {
  return <Hv as="a" href={href} download title={title}
    style={`padding:4px 8px; border:1px solid ${T.line}; background:${T.panel}; border-radius:4px; ${mono(9, `letter-spacing:.1em; color:${T.dim}`)}; text-decoration:none; white-space:nowrap; transition:.12s`}
    hover={`border-color:${T.line2}; color:${T.text}`} active="transform:translateY(1px)">{children}</Hv>;
}

// ---------------------------------------------------------------------------------------------
// SYSTEM — host, MCUs, endstops
// ---------------------------------------------------------------------------------------------
function SystemPanel({ st, sys }) {
  const info = (sys.data && sys.data.system_info) || {};
  const raw = st.raw || {};
  const cpu = info.cpu_info || {}, distro = info.distribution || {}, sd = info.sd_info || {}, py = info.python || {};
  const ps = st.procStats || {};
  const usage = ps.system_cpu_usage || {};
  const memT = num((ps.system_memory || {}).total), memU = num((ps.system_memory || {}).used);
  const memPct = memT && memU !== null ? (memU / memT) * 100 : null;
  const temp = num(ps.cpu_temp);
  const load = num(usage.cpu);
  const thr = throttleSummary(ps.throttled_state);
  // numeric, not lexicographic — a default sort() puts cpu10 between cpu1 and cpu2 on a big host
  const cores = Object.keys(usage).filter(k => /^cpu\d+$/.test(k)).sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));
  const ips = []
    .concat(...Object.entries(info.network || {}).map(([nic, n]) =>
      ((n && n.ip_addresses) || []).filter(a => a.family === "ipv4" && !a.is_link_local).map(a => nic + " " + a.address)));

  return <Panel title="SYSTEM" accent={thr.clean ? T.ok : T.warn} style="align-self:start"
    right={<Chip color={st.connected ? T.ok : T.err} pulse={st.connected}>{st.connected ? "ONLINE" : "OFFLINE"}</Chip>}>
    {/* Undervoltage/throttling is the single most useful thing on a Pi-hosted printer, so it goes first. */}
    {!thr.clean && <div style={S(`border:1px solid ${thr.now.length ? "#4a2318" : "#3a2f14"}; background:${thr.now.length ? "#1a0e09" : "#14100a"}; border-radius:4px; padding:8px 10px; margin-bottom:10px`)}>
      <Label style={`color:${thr.now.length ? T.accent : T.warn}`}>{thr.now.length ? "THROTTLING NOW" : "THROTTLED SINCE BOOT"}</Label>
      <div style={S(`${mono(10.5, `color:${thr.now.length ? T.accent : T.warn}`)}; margin-top:5px; line-height:1.55`)}>{(thr.now.length ? thr.now : thr.past).join(" · ")}</div>
      {!!(thr.now.length && thr.past.length) && <div style={S(`${mono(9.5, `color:${T.mute}`)}; margin-top:4px`)}>{"earlier: " + thr.past.join(" · ")}</div>}
      <div style={S(`font-size:11px; color:${T.dim}; margin-top:6px; text-wrap:pretty`)}>An under-powered supply or a hot SoC shows up here long before it shows up as a failed print.</div>
    </div>}
    {thr.clean && thr.known && <div style={S("margin-bottom:8px")}><Chip color={T.ok} border="#1c3d37">POWER &amp; THERMALS CLEAN</Chip></div>}

    {sys.error && <div style={S(`${mono(10, `color:${T.err}`)}; padding:6px 0`)}>{"system_info: " + sys.error}</div>}
    <KV k="Host" v={(st.printerInfo && st.printerInfo.hostname) || DASH} color={T.text} />
    <KV k="Model" v={cpu.model || DASH} title={cpu.model} />
    <KV k="CPU" v={<Row gap={7} style="justify-content:flex-end">
      <Meter pct={load} color={load === null ? T.ghost : load >= 85 ? T.err : load >= 65 ? T.warn : T.info} />
      <span>{load === null ? DASH : load.toFixed(1) + " %"}</span>
      <span style={S(`color:${T.mute}`)}>{(cpu.cpu_count || cores.length || "?") + "×" + (cpu.processor ? " " + cpu.processor : "")}</span>
    </Row>} />
    {!!cores.length && <div style={S("display:flex; gap:3px; padding:6px 0 8px; align-items:center")}>
      {cores.map(k => { const v = num(usage[k]) || 0;
        return <span key={k} title={k + ": " + v.toFixed(1) + " %"} style={S(`flex:1; height:14px; border-radius:2px; background:${T.panel2}; display:flex; align-items:flex-end; overflow:hidden`)}>
          <span style={S(`width:100%; height:${Math.max(4, Math.min(100, v))}%; background:${v >= 85 ? T.err : v >= 65 ? T.warn : T.info}`)} /></span>; })}
    </div>}
    <KV k="CPU temp" v={temp === null ? DASH : temp.toFixed(1) + " °C"} color={temp === null ? T.body : temp >= 80 ? T.err : temp >= 70 ? T.warn : T.body} />
    <KV k="Memory" v={<Row gap={7} style="justify-content:flex-end">
      <Meter pct={memPct} color={memPct === null ? T.ghost : memPct >= 90 ? T.err : memPct >= 75 ? T.warn : T.ok} />
      <span>{memU === null || memT === null ? DASH : fmtBytes(memU * 1024) + " / " + fmtBytes(memT * 1024)}</span>
    </Row>} />
    <KV k="Uptime" v={fmtUptime(ps.system_uptime)} />
    <KV k="Distribution" v={distro.name || DASH} title={distro.name} />
    <KV k="Kernel" v={distro.kernel_version || DASH} />
    <KV k="Python" v={(py.version_string || DASH).split(" ")[0]} title={py.version_string} />
    <KV k="SD card" v={sd.product_name ? `${sd.manufacturer || ""} ${sd.product_name} · ${sd.capacity || ""}`.trim() : DASH} />
    <KV k="Network" v={ips.length ? ips.join("  ") : DASH} title={ips.join("\n")} />
    <Divider />
    {/* "v0.13.0-745-gf0892d82-dirty" ellipsises in a narrow column — keep the whole string on hover. */}
    <KV k="Klipper" v={(st.printerInfo && st.printerInfo.software_version) || DASH} title={(st.printerInfo && st.printerInfo.software_version) || undefined}
      color={st.klippy === "ready" ? T.ok : st.klippy === "shutdown" || st.klippy === "error" ? T.err : T.warn} />
    <KV k="Moonraker" v={(st.serverInfo && st.serverInfo.moonraker_version) || DASH} title={(st.serverInfo && st.serverInfo.moonraker_version) || undefined} />
    <KV k="Klippy state" v={st.klippy || "unknown"} color={st.klippy === "ready" ? T.ok : T.warn} />
    {!!(raw.webhooks && raw.webhooks.state_message && st.klippy !== "ready") &&
      <div style={S(`${mono(10, `color:${T.warn}`)}; padding:8px 0 0; line-height:1.5; white-space:pre-wrap`)}>{raw.webhooks.state_message}</div>}
  </Panel>;
}

function McuPanel({ st, api }) {
  const raw = st.raw || {};
  const names = Object.keys(raw).filter(k => k === "mcu" || k.indexOf("mcu ") === 0)
    .sort((a, b) => (a === "mcu" ? -1 : b === "mcu" ? 1 : a.localeCompare(b)));
  const retrans = names.reduce((n, k) => n + (num(((raw[k] || {}).last_stats || {}).bytes_retransmit) || 0), 0);
  // Happy Hare keeps its own log; it is only offered when this printer actually runs an MMU.
  const logs = [["klippy.log", "KLIPPY.LOG"], ["moonraker.log", "MOONRAKER.LOG"]].concat(raw.mmu ? [["mmu.log", "MMU.LOG"]] : []);

  const tone = retrans >= RT_BAD ? T.err : retrans >= RT_WARN ? T.warn : T.ok;
  // No MCU has reported yet -> there are no links to call clean. A green "LINKS CLEAN" chip over an
  // empty panel is the one reading that is certainly wrong, so it waits for real data.
  return <Panel title="MCUS" accent={names.length ? tone : T.line2} style="align-self:start"
    right={names.length ? <span title={"bytes_retransmit, summed over every MCU: " + fmtBytes(retrans)}>
      <Chip color={tone}>{retrans >= RT_WARN ? fmtBytes(retrans) + " RETRANSMITTED" : "LINKS CLEAN"}</Chip></span> : null}>
    {!names.length && <div style={S(`${mono(10, `color:${T.mute}`)}; padding:14px 0`)}>{st.connected ? "Waiting for the first status update…" : "Not connected"}</div>}
    <div style={S("display:grid; gap:8px")}>
      {names.map(k => {
        const o = raw[k] || {}, ls = o.last_stats || {};
        const awake = num(ls.mcu_awake);
        const awakePct = awake === null ? null : (awake / KLIPPER_STATS_INTERVAL) * 100;
        const task = num(ls.mcu_task_avg);
        const rt = num(ls.bytes_retransmit);
        const freq = num(ls.freq);
        const rtColor = rtTone(rt);   // see RT_WARN: a handful of bytes is the normal cost of connecting
        return <div key={k} style={S(`border:1px solid ${T.line}; border-radius:4px; background:${T.panel3}; padding:8px 10px`)}>
          <Row style="justify-content:space-between; gap:10px">
            <Val size={11.5} color={T.text}>{k}</Val>
            <Val size={10} color={T.mute} style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{o.mcu_version || DASH}</Val>
          </Row>
          <div style={S("display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:8px")}>
            {/* An idle MCU is awake ~0.02 % of the window (measured: 0.001 s of 5). One decimal
                rendered three of this printer's four MCUs as a flat "0.0 %" — a real number shown as
                zero — so anything under 1 % gets a second decimal. */}
            <div><Label>AWAKE</Label><div style={S("margin-top:3px")} title={awake === null ? undefined : awake + " s awake per " + KLIPPER_STATS_INTERVAL + " s window"}>
              <Val size={11} color={awakePct !== null && awakePct >= 60 ? T.warn : T.body}>{awakePct === null ? DASH : (awakePct < 1 ? awakePct.toFixed(2) : awakePct.toFixed(1)) + " %"}</Val></div></div>
            <div><Label>TASK AVG</Label><div style={S("margin-top:3px")}>
              <Val size={11}>{task === null ? DASH : (task * 1e6).toFixed(0) + " µs"}</Val></div></div>
            <div><Label>RETRANSMIT</Label><div style={S("margin-top:3px")}>
              <Val size={11} color={rtColor}>{rt === null ? DASH : fmtBytes(rt)}</Val></div></div>
            {/* Whole MHz: the clock is nominal (64/180/400…), and ".00" pushed the value onto two lines in a three-column layout. */}
            <div><Label>FREQ</Label><div style={S("margin-top:3px")}>
              <Val size={11} color={T.mute}>{freq === null ? DASH : Math.round(freq / 1e6) + " MHz"}</Val></div></div>
          </div>
          {rt !== null && rt >= RT_WARN && <div style={S(`${mono(9.5, `color:${T.warn}`)}; margin-top:7px; line-height:1.5`)}>
            {fmtBytes(rt) + " re-sent — a CAN or USB link losing this much will eventually lose the print."}</div>}
        </div>;
      })}
    </div>
    <Divider />
    <Row gap={6}><Label style="margin-right:2px">LOGS</Label>
      {logs.map(([f, label]) => <LinkBtn key={f} href={api ? api.fileUrl("logs", f) : "#"} title={"Download " + f}>{label}</LinkBtn>)}
    </Row>
  </Panel>;
}

function EndstopPanel({ act, printing }) {
  const [res, setRes] = React.useState(null);
  const [at, setAt] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(true);
  // The page can be left mid-query. (Set on the way in as well, so a remount re-arms the ref.)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Never queried on mount: the query flushes Klipper's move queue (see actions/machine.js).
  // queryEndstops() resolves null for BOTH a refusal and an RPC failure and only says which in the
  // console, so a failed click was indistinguishable from never having clicked — a dead button.
  const query = () => {
    setBusy(true);
    Promise.resolve(act.queryEndstops())
      .then(r => { if (alive.current) { setRes(r || null); setAt(r ? Date.now() : null); setFailed(!r); } })
      .catch(() => { if (alive.current) { setRes(null); setAt(null); setFailed(true); } })
      .then(() => { if (alive.current) setBusy(false); });
  };
  const rows = res ? Object.keys(res).sort() : [];

  // A one-shot reading with nothing to say when it was taken reads as live state. It is not: the
  // switches move whenever the toolhead does, and Orca reloads this page constantly, so the stamp
  // is the only thing separating "just queried" from "queried before the last homing move".
  return <Panel title="ENDSTOPS" accent={T.info} style="align-self:start"
    right={<Row gap={6}>
      {!!at && <Label>{"AT " + new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Label>}
      <Btn small onClick={query} disabled={busy || printing}
        title={printing ? "Refused while printing — the query flushes the move queue" : "printer.query_endstops.status"}>{busy ? "…" : "QUERY"}</Btn>
    </Row>}>
    {!res && <div style={S(`${mono(10, `color:${failed && !printing ? T.err : T.mute}`)}; padding:12px 0; line-height:1.6`)}>
      {printing ? "Unavailable while printing — the query stalls the move queue."
        : failed ? "The query failed — see the console for what Klipper said."
        : "Not queried. QUERY reads every endstop once."}</div>}
    {rows.map(k => {
      const trig = String(res[k]).toUpperCase() === "TRIGGERED";
      return <div key={k} style={S("display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid #10161e")}>
        <Val size={11} color={T.dim}>{k}</Val>
        <Chip color={trig ? T.accent : T.mute} border={trig ? "#4a2318" : T.line} bg={trig ? "#1a0e09" : T.panel} pulse={trig}>{trig ? "TRIGGERED" : "open"}</Chip>
      </div>;
    })}
  </Panel>;
}

// ---------------------------------------------------------------------------------------------
// SERVICES — systemd units + host power
// ---------------------------------------------------------------------------------------------
function ServicesPanel({ sys, act, printing, connected }) {
  const info = (sys.data && sys.data.system_info) || {};
  const states = info.service_state || {};
  const list = (info.available_services || []).slice().sort();
  const [confirm, setConfirm] = React.useState(null);

  const ask = (name, action) => setConfirm({
    name, action,
    text: action === "restart" && name === "moonraker"
      ? "Restart Moonraker? This UI loses its websocket and reconnects on its own."
      : action === "stop"
        ? `Stop ${name}? It will stay down until something starts it again.`
        : `${action === "start" ? "Start" : "Restart"} ${name}?`,
  });
  // systemd needs a moment to settle before active_state reflects the new reality — re-read after it
  // has. (notify_service_state_changed reloads too; this covers a unit Moonraker does not track.)
  const settle = React.useRef(null);
  React.useEffect(() => () => clearTimeout(settle.current), []);
  const go = () => {
    const c = confirm; setConfirm(null);
    if (c) fire(act.serviceAction(c.name, c.action).then(() => { clearTimeout(settle.current); settle.current = setTimeout(() => sys.reload(), 1200); }));
  };

  const cols = [
    { k: "name", label: "SERVICE", w: "minmax(120px,1fr)", render: r => <Val size={11} color={T.text}>{r.name}</Val> },
    { k: "state", label: "STATE", w: "150px", render: r => {
      const a = r.s.active_state, sub = r.s.sub_state;
      // available_services and service_state come from two different systemd reads, so a unit can be
      // listed with no state at all. That was painted in T.ghost (2:1 against the panel — effectively
      // invisible) and read "unknown"; say plainly that it is Moonraker that does not know.
      const c = a === "active" ? T.ok : a === "failed" ? T.err : a ? T.mute : T.warn;
      return <span title={a ? undefined : "Moonraker lists this unit but reports no state for it — the buttons still act on systemd"}>
        <Chip color={c} pulse={a === "active"}>{a ? a + (sub && sub !== a ? " · " + sub : "") : "no state"}</Chip></span>;
    } },
    { k: "act", label: "", w: "196px", align: "right", render: r => {
      // Restarting or stopping klipper mid-print kills the job; the action refuses it too, but the
      // button must not look available. Every other unit here is harmless while a print runs.
      const fatal = printing && KLIPPER_SERVICES.includes(r.name);
      const why = fatal ? "Refused while a print is running — it would kill the job" : undefined;
      return <Row gap={4} style="justify-content:flex-end">
        <Btn small onClick={() => ask(r.name, "restart")} disabled={fatal} title={why}>RESTART</Btn>
        {r.s.active_state === "active"
          ? <Btn small kind="warn" onClick={() => ask(r.name, "stop")} disabled={fatal || r.name === "moonraker"}
              title={r.name === "moonraker" ? "Nothing here could start it again" : why}>STOP</Btn>
          : <Btn small kind="ok" onClick={() => ask(r.name, "start")}>START</Btn>}
      </Row>;
    } },
  ];

  return <Panel title="SERVICES" accent={T.info} flat style="align-self:start"
    right={<Row gap={6}><Label>{list.length + " UNITS"}</Label>
      <Btn small onClick={() => sys.reload()} disabled={!connected} title={connected ? "Re-read machine.system_info" : "Not connected"}>REFRESH</Btn></Row>}>
    <div style={S("padding:8px 10px")}>
      {sys.error && <div style={S(`${mono(10, `color:${T.err}`)}; padding:8px 2px`)}>{sys.error}</div>}
      <Wide min={498}>
        {/* Offline, the loader stays pending forever (see PENDING) — "Loading…" would be a lie that
            never resolves, so say what is actually being waited on, like the UPDATE MANAGER does. */}
        <Table cols={cols} rows={list.map(n => ({ name: n, s: states[n] || {} }))} rowKey={r => r.name}
          empty={sys.loading ? (connected ? "Loading…" : "Waiting for the printer…") : "No services reported"} />
      </Wide>
    </div>
    {confirm && <Confirm text={confirm.text} yes={confirm.action.toUpperCase()} onYes={go} onNo={() => setConfirm(null)} />}
  </Panel>;
}

function PowerPanel({ act, printing, klippy }) {
  const [confirm, setConfirm] = React.useState(null);
  const ask = (text, yes, run) => setConfirm({ text, yes, run });
  const go = () => { const c = confirm; setConfirm(null); if (c) fire(c.run()); };

  const ROWS = [
    { label: "FIRMWARE RESTART", kind: "warn", hint: "Resets the MCUs and reloads the config. The only way out of a Klipper shutdown.",
      text: "FIRMWARE_RESTART — reset every MCU and reload the config?", run: () => act.firmwareRestart() },
    { label: "KLIPPER RESTART", kind: "warn", hint: "Restarts the Klipper host process and re-reads printer.cfg.",
      text: "RESTART — restart the Klipper host process?", run: () => act.klipperRestart() },
    { label: "MOONRAKER RESTART", kind: "default", hint: "Restarts the API server. This page reconnects by itself.", always: true,
      text: "Restart Moonraker? This UI loses its websocket and reconnects on its own.", run: () => act.moonrakerRestart() },
    { label: "HOST REBOOT", kind: "danger", hint: "Reboots the whole host. Everything goes down for about a minute.",
      text: "Reboot the host? Klipper, Moonraker and this page all go down.", run: () => act.hostReboot() },
    { label: "HOST SHUTDOWN", kind: "danger", hint: "Powers the host off. It has to be switched back on by hand.",
      text: "Shut the host down? It will need to be powered back on by hand.", run: () => act.hostShutdown() },
  ];

  return <Panel title="HOST POWER" accent={T.err} flat style="align-self:start"
    right={<Chip color={klippy === "ready" ? T.ok : T.warn}>{"KLIPPY " + String(klippy || "unknown").toUpperCase()}</Chip>}>
    <div style={S("padding:10px 12px")}>
      <Btn kind="danger" style="width:100%; padding:10px 11px; letter-spacing:.22em"
        onClick={() => ask("EMERGENCY STOP — shut the MCUs down immediately? A running print is lost and FIRMWARE_RESTART is needed to recover.", "M112", () => act.estop())}>
        EMERGENCY STOP
      </Btn>
      <div style={S(`${mono(9.5, `color:${T.mute}`)}; margin-top:6px; line-height:1.5`)}>M112 — cuts heaters and steppers at once. Recovery needs a firmware restart.</div>
      <Divider />
      {ROWS.map(r => {
        const blocked = printing && !r.always;
        return <div key={r.label} style={S("display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid #10161e")}>
          <div style={S("flex:1; min-width:0")}>
            <Val size={11} color={blocked ? T.faint : T.text}>{r.label}</Val>
            <div style={S(`font-size:11px; color:${T.dim}; margin-top:3px; text-wrap:pretty`)}>{blocked ? "Refused while a print is running." : r.hint}</div>
          </div>
          <Btn kind={r.kind} disabled={blocked} onClick={() => ask(r.text, r.label.split(" ").pop(), r.run)}>RUN</Btn>
        </div>;
      })}
    </div>
    {confirm && <Confirm text={confirm.text} yes={confirm.yes} onYes={go} onNo={() => setConfirm(null)} />}
  </Panel>;
}

// ---------------------------------------------------------------------------------------------
// UPDATES
// ---------------------------------------------------------------------------------------------
/** Moonraker orders version_info by config order; pin the two that matter to the top, system last. */
function updateOrder(a, b) {
  const rank = n => (n === "klipper" ? 0 : n === "moonraker" ? 1 : n === "system" ? 3 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Moonraker writes "?" for a version it could not determine — rate limited, offline, or an invalid repo. */
const unknownVersion = v => !v || v === "?";

/**
 * How far behind a component is, in whatever unit it counts in (commits, or apt packages).
 * null = Moonraker does not know, which is NOT the same as "up to date": a `web` client whose remote
 * version came back "?" used to compare "v2.17.0" against "?", conclude 1 behind, and offer an UPDATE
 * button whose confirm read "Update mainsail to ?".
 */
function behindOf(v) {
  if (v.configured_type === "system") return num(v.package_count) || 0;
  const c = num(v.commits_behind_count);
  if (c !== null) return c;
  if (unknownVersion(v.version) || unknownVersion(v.remote_version)) return null;
  return v.version !== v.remote_version ? 1 : 0;   // `web` clients count no commits, only the two strings
}

/**
 * Is there a list behind the BEHIND badge? `system` has package_list and a git repo has
 * commits_behind; a `web` client has neither — its "1" is "an update exists", not one commit, and
 * opening it produced a panel headed "COMMITS BEHIND" apologising that nothing was cached.
 */
const canExpand = v => v.configured_type === "system" || v.configured_type === "git_repo" || Array.isArray(v.commits_behind);

function UpdatesPanel({ api, act, printing, connected, serverInfo }) {
  const s = useAsync(() => (api && connected ? api.updateStatus(false) : PENDING), [api, connected]);
  const [expanded, setExpanded] = usePersisted("machine.upExpand", null);
  const [confirm, setConfirm] = React.useState(null);
  const [feed, setFeed] = React.useState([]);
  const reload = s.reload;

  // Moonraker narrates updates over the socket and pushes a full status after a refresh; both are
  // free here, and they are the only way to see progress without polling a rate-limited endpoint.
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    const offs = [
      api.on("notify_update_response", d => {
        const line = String((d && d.message) || "").trim();
        if (line) setFeed(f => f.concat(line).slice(-60));
        if (d && d.complete) reload();
      }),
      api.on("update_refreshed", () => reload()),
    ];
    return () => offs.forEach(f => { try { f(); } catch (e) { /* already gone */ } });
  }, [api, reload]);

  const data = s.data || {};
  const vi = data.version_info || {};
  const names = Object.keys(vi).sort(updateOrder);
  const rows = names.map(n => Object.assign({ name: n }, vi[n]));
  const pending = rows.filter(r => behindOf(r) > 0).length;
  const busy = !!data.busy;
  const rate = num(data.github_requests_remaining);

  const ask = (text, yes, run) => setConfirm({ text, yes, run });
  const go = () => { const c = confirm; setConfirm(null); if (c) { setFeed([]); fire(c.run()); } };

  const cols = [
    // Long names ("Klipper-Adaptive-Meshing-Purging") ellipsise in this column — carry the full one in a
    // title. (Val takes no title prop, hence the wrapper.)
    { k: "name", label: "COMPONENT", w: "minmax(140px,1fr)", render: r => <span title={r.name}><Val size={11} color={T.text}>{r.name}</Val></span> },
    // `system` carries no installed version: package_count is the number of UPGRADABLE apt packages,
    // so printing it here read "33 packages" INSTALLED next to "33 upgradable" AVAILABLE — the same
    // number under two labels that contradict each other, on a host with ~2000 packages installed.
    { k: "cur", label: "INSTALLED", w: "130px", render: r => r.configured_type === "system"
      ? <span title="Moonraker reports no installed-package count for the system entry"><Val size={10.5} color={T.ghost}>{DASH}</Val></span>
      : <Val size={10.5}>{r.version || DASH}</Val> },
    { k: "rem", label: "AVAILABLE", w: "130px", render: r => {
      const b = behindOf(r);
      if (r.configured_type === "system") return <Val size={10.5} color={b > 0 ? T.warn : T.mute}>{b > 0 ? b + " upgradable" : "current"}</Val>;
      if (unknownVersion(r.remote_version)) return <span title="Moonraker could not determine the remote version — GitHub unreachable or rate limited">
        <Val size={10.5} color={T.mute}>{DASH}</Val></span>;
      return <Val size={10.5} color={b > 0 ? T.warn : T.mute}>{r.remote_version}</Val>;
    } },
    { k: "behind", label: "BEHIND", w: "96px", align: "right", render: r => {
      const b = behindOf(r);
      if (b === null) return <span title="Unknown — Moonraker has no remote version to compare against"><Val size={10.5} color={T.mute}>?</Val></span>;
      if (!b) return <Val size={10.5} color={T.ghost}>{DASH}</Val>;
      const badge = `display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:3px; border:1px solid #3a2f14; background:#14100a; ${mono(9, `letter-spacing:.08em; color:${T.warn}`)}`;
      // Only a git repo or `system` has a list to open; a web client's "1" just means "newer exists".
      if (!canExpand(r)) return <span title={"A newer release is published (" + (r.remote_version || "?") + ")"} style={S(badge)}>NEW</span>;
      return <Hv as="span" onClick={() => setExpanded(expanded === r.name ? null : r.name)}
        title={r.configured_type === "system" ? "Show the upgradable packages" : "Show the commits this repo is behind"}
        style={`${badge}; cursor:pointer`} hover={`border-color:${T.warn}`}>{b + (r.configured_type === "system" ? " PKG" : " ⟩")}</Hv>;
    } },
    { k: "flags", label: "STATE", w: "minmax(150px,1fr)", render: r => {
      const bad = [];
      if (r.is_dirty) bad.push(["DIRTY", T.warn]);
      if (r.is_valid === false) bad.push(["INVALID", T.err]);
      if (r.corrupt) bad.push(["CORRUPT", T.err]);
      if (r.detached) bad.push(["DETACHED", T.warn]);
      if (r.channel_invalid) bad.push(["BAD CHANNEL", T.err]);
      if (r.debug_enabled) bad.push(["DEBUG", T.info]);
      // Six flags need ~390 px in a ~150 px cell and a flex row does not ellipsise, so the tail is cut
      // with nothing to show for it — the title is the only way to read CORRUPT off a clipped row.
      const body = bad.length
        ? <span title={bad.map(([t]) => t).join(" · ")}><Row gap={4}>{bad.map(([t, c]) => <Chip key={t} color={c} border={c === T.err ? "#4a2318" : "#3a2f14"}>{t}</Chip>)}</Row></span>
        : <Val size={10} color={T.mute}>{[r.channel, r.branch].filter(Boolean).join(" · ") || r.configured_type || ""}</Val>;
      // Moonraker's own repo audit (untracked sources, wrong remote, …). It is not a flag and it does
      // not set is_dirty — this printer's moonraker checkout carries mmu_server.py untracked and still
      // reads clean — but it is exactly what decides whether an UPDATE applies without a conflict.
      const notes = [].concat(r.anomalies || [], r.warnings || []).filter(Boolean);
      if (!notes.length) return body;
      return <Row gap={5}><span style={S("min-width:0; overflow:hidden; text-overflow:ellipsis")}>{body}</span>
        <span title={notes.join("\n")}><Chip color={T.info}>NOTE</Chip></span></Row>;
    } },
    { k: "act", label: "", w: "180px", align: "right", render: r => {
      const b = behindOf(r);
      const broken = !!(r.is_dirty || r.corrupt || r.is_valid === false);
      // This printer keeps Happy Hare's files untracked INSIDE the klipper and moonraker checkouts;
      // a hard recover re-clones and deletes exactly those. Moonraker already names them in
      // `anomalies`, so put them in the dialog rather than behind a hover on another column.
      const notes = [].concat(r.anomalies || [], r.warnings || []).filter(Boolean);
      // Confirm renders one plain line, so join with a separator rather than newlines.
      const recoverText = `Recover ${r.name}? A hard recovery re-clones the repo and throws away every local change to it.`
        + (notes.length ? " Moonraker reports: " + notes.join(" · ") : "");
      const target = r.configured_type === "system" ? "the latest packages" : (unknownVersion(r.remote_version) ? "the latest release" : r.remote_version);
      return <Row gap={4} style="justify-content:flex-end">
        {broken && <Btn small kind="warn" disabled={busy || printing}
          onClick={() => ask(recoverText, "RECOVER", () => act.recoverUpdate(r.name, true).then(reload))}>RECOVER</Btn>}
        {b > 0
          ? <Btn small kind="accent" disabled={busy || printing}
              onClick={() => ask(`Update ${r.name} to ${target}? It restarts once the update finishes.`, "UPDATE", () => act.runUpdate(r.name).then(reload))}>UPDATE</Btn>
          : b === null
            ? <span title="Nothing to compare against — this is not a claim that it is current"><Val size={9.5} color={T.mute}>UNKNOWN</Val></span>
            : <Val size={9.5} color={T.mute}>UP TO DATE</Val>}
      </Row>;
    } },
  ];

  // usePersisted survives an Orca reload, so `expanded` can name a row that has since gone away or
  // that a newer build no longer lets you open — check both, not just presence.
  const exp = expanded && vi[expanded] && canExpand(vi[expanded]) ? vi[expanded] : null;
  const expCommits = (exp && Array.isArray(exp.commits_behind) ? exp.commits_behind : []);
  const expBehind = exp ? num(exp.commits_behind_count) : null;

  // The response feed is the only progress an update shows. It kept its scroll at the top, so after
  // ~10 lines the newest line — the one painted brighter as "current" — sat below the fold.
  const feedRef = React.useRef(null);
  React.useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [feed]);

  // Moonraker reports the update_manager sections it could NOT load (this printer: led_effect and
  // Spoolman, both pointing at directories that no longer exist). Those components are simply absent
  // from the table below, so without this the page silently under-reports what it manages.
  const warnings = (serverInfo && Array.isArray(serverInfo.warnings) ? serverInfo.warnings : [])
    .filter(w => /update_manager/i.test(String(w)));
  const failed = (serverInfo && Array.isArray(serverInfo.failed_components) ? serverInfo.failed_components : []);

  return <Panel title="UPDATE MANAGER" accent={pending ? T.warn : T.ok} flat
    right={<Row gap={6}>
      {busy && <Chip color={T.warn} pulse>RUNNING</Chip>}
      {rate !== null && <div title="GitHub allows 60 unauthenticated requests per hour"><Label>{rate + "/" + (num(data.github_rate_limit) || 60) + " GH"}</Label></div>}
      {/* Moonraker answers machine.update.refresh with a 503 while Klippy prints, so the button says so up front. */}
      <Btn small onClick={() => { setFeed([]); fire(act.refreshUpdates()); }} disabled={busy || printing}
        title={printing ? "Refused while printing — Moonraker will not refresh mid-print" : "Re-checks every repo against GitHub — slow, and rate limited"}>REFRESH</Btn>
      <Btn small kind="accent" disabled={busy || printing || !pending}
        onClick={() => ask(`Update all ${pending} outdated components? Every one of them restarts what it patched.`, "UPDATE ALL", () => act.updateAll().then(reload))}>UPDATE ALL</Btn>
    </Row>}>
    <div style={S("padding:8px 10px")}>
      {printing && <div style={S(`${mono(10, `color:${T.warn}`)}; padding:4px 2px 10px; line-height:1.5`)}>A print is running — updates are refused until it finishes.</div>}
      {s.error && <div style={S(`${mono(10, `color:${T.err}`)}; padding:8px 2px`)}>{s.error}</div>}
      {/* This printer alone emits seven of these (two dead paths, five "unparsed option" follow-ups),
          so only the first few are printed; the rest hang off the count's tooltip. */}
      {/* These carry absolute paths and repo URLs with no break opportunity in them; without
          overflow-wrap the longest one sets the panel's min-content width and scrolls the PAGE. */}
      {!!(warnings.length || failed.length) && <div style={S(`border:1px solid #3a2f14; background:#14100a; border-radius:4px; padding:7px 9px; margin:2px 0 9px; min-width:0; overflow-wrap:anywhere`)}>
        <Label style={`color:${T.warn}`}>{failed.length ? "MOONRAKER COMPONENTS FAILED TO LOAD" : "UPDATE MANAGER WARNINGS"}</Label>
        {failed.map(f => <div key={f} style={S(`${mono(10, `color:${T.warn}`)}; margin-top:5px`)}>{f}</div>)}
        {warnings.slice(0, 3).map((w, i) => <div key={i} style={S(`${mono(9.5, `color:${T.body}`)}; margin-top:5px; line-height:1.5; text-wrap:pretty`)}>{w}</div>)}
        {warnings.length > 3 && <div title={warnings.slice(3).join("\n\n")} style={S(`${mono(9.5, `color:${T.mute}`)}; margin-top:5px; cursor:default`)}>{"+" + (warnings.length - 3) + " more"}</div>}
        <div style={S(`font-size:11px; color:${T.dim}; margin-top:6px; text-wrap:pretty`)}>A component that failed to load is not in the table below and is never updated.</div>
      </div>}
      <Wide min={886}>
        <Table cols={cols} rows={rows} rowKey={r => r.name}
          empty={s.loading ? (connected ? "Loading update status…" : "Waiting for the printer…") : "Update manager reported nothing"} />
      </Wide>

      {exp && <div style={S(`margin-top:10px; border:1px solid ${T.line}; border-radius:4px; background:${T.panel3}; padding:9px 11px`)}>
        <Row style="justify-content:space-between">
          <Label>{expanded.toUpperCase() + (exp.configured_type === "system" ? " — UPGRADABLE PACKAGES" : " — COMMITS BEHIND")}</Label>
          <Btn small kind="ghost" onClick={() => setExpanded(null)}>CLOSE</Btn>
        </Row>
        {exp.configured_type === "system"
          ? <div style={S(`${mono(10, `color:${T.body}`)}; margin-top:8px; line-height:1.7; word-break:break-all`)}>{(exp.package_list || []).join("  ") || DASH}</div>
          : <div style={S("margin-top:6px")}>
              {expCommits.slice(0, 12).map((c, i) => <div key={c.sha || i} style={S("display:flex; gap:10px; padding:4px 0; border-bottom:1px solid #10161e")}>
                <Val size={10} color={T.faint} style="flex:none; width:60px">{String(c.sha || "").slice(0, 7)}</Val>
                <Val size={10} color={T.mute} style="flex:none; width:56px">{c.date ? fmtDate(Number(c.date)).split(" ").slice(0, 2).join(" ") : DASH}</Val>
                <span style={S(`flex:1; min-width:0; ${mono(10, `color:${T.body}`)}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`)}>{c.subject}</span>
              </div>)}
              {expCommits.length === 0 && <div style={S(`${mono(10, `color:${T.mute}`)}; padding:6px 0`)}>Moonraker did not cache the commit list for this repo.</div>}
              {/* Moonraker caps the cached log (KlipperScreen here: 304 behind, 31 cached), so "+19 more"
                  on its own contradicted the 304 in the BEHIND badge that opened this panel. */}
              {expCommits.length > 12 && <div style={S(`${mono(9.5, `color:${T.faint}`)}; padding:6px 0`)}>
                {"+" + (expCommits.length - 12) + " more"
                  + (expBehind !== null && expBehind > expCommits.length ? " — Moonraker cached " + expCommits.length + " of " + expBehind + " commits" : "")}</div>}
              {/* A URL, not a micro-label — Label's letter-spacing makes one unreadable. */}
              <Val size={9.5} color={T.faint} style="display:block; margin-top:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{exp.remote_url || ""}</Val>
            </div>}
      </div>}

      {!!feed.length && <div ref={feedRef} style={S(`margin-top:10px; border:1px solid ${T.line}; border-radius:4px; background:#0a0e14; padding:8px 10px; max-height:180px; overflow:auto`)}>
        {feed.map((l, i) => <div key={i} style={S(`${mono(10, `color:${i === feed.length - 1 ? T.body : T.mute}`)}; line-height:1.55; white-space:pre-wrap; word-break:break-word`)}>{l}</div>)}
      </div>}
    </div>
    {confirm && <Confirm text={confirm.text} yes={confirm.yes} onYes={go} onNo={() => setConfirm(null)} />}
  </Panel>;
}

// ---------------------------------------------------------------------------------------------
export default function Page({ store, api, navigate }) {
  const st = useStore(store);                 // pages are rendered as a prop element — subscribe for ourselves

  const log = React.useCallback((message, type) => {
    if (!store) return;
    const entry = { time: Date.now() / 1000, message: String(message), type: type || "info", local: true };
    store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
  }, [store]);
  const act = React.useMemo(() => makeMachineActions({ api, store, log }), [api, store, log]);

  // system_info feeds both the SYSTEM and SERVICES panels, so it is fetched once here.
  const sys = useAsync(() => (api && st.connected ? api.systemInfo() : PENDING), [api, st.connected]);
  // Moonraker announces unit state changes (notify_service_state_changed) — including ones made from
  // outside this UI, e.g. a KlipperScreen restart — so the SERVICES table follows them instead of a timer.
  const sysReload = sys.reload;
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    const off = api.on("service_state", () => sysReload());
    return () => { try { off(); } catch (e) { /* already gone */ } };
  }, [api, sysReload]);

  const printing = isPrintActive(st);
  const thr = throttleSummary((st.procStats || {}).throttled_state);
  // Same-tab only: Orca's webview ejects window.open / target=_blank to the system browser.
  const goConfig = () => { try { typeof navigate === "function" ? navigate("/config") : (location.hash = "/config"); } catch (e) { /* router unavailable */ } };

  return <div style={S("flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:1fr; min-width:0")}>
    {/* Status strip. The config note sits where the CONFIG tab used to be, which is where a hand looks for it. */}
    <div style={S(`display:flex; align-items:center; flex-wrap:wrap; gap:8px 14px; padding:7px 12px; border:1px solid ${T.line}; border-radius:6px; background:${T.panel}`)}>
      <Row gap={7}>
        <span style={S(`font-size:11.5px; color:${T.dim}; white-space:nowrap`)}>Config files have moved to the</span>
        <Hv as="span" onClick={goConfig} title="Open the CONFIG page"
          style={`${mono(10, `letter-spacing:.16em; color:${T.info}`)}; cursor:pointer; white-space:nowrap; transition:.12s`}
          hover={`color:${T.text}`}>CONFIG PAGE ⟩</Hv>
      </Row>
      <div style={S("margin-left:auto; display:flex; align-items:center; flex-wrap:wrap; gap:7px")}>
        {printing && <Chip color={T.accent} pulse>PRINTING — DESTRUCTIVE ACTIONS LOCKED</Chip>}
        {!thr.clean && <Chip color={thr.now.length ? T.accent : T.warn} border="#3a2f14" bg="#14100a">
          {thr.now.length ? "THROTTLING NOW" : "THROTTLED SINCE BOOT"}</Chip>}
        <Label>{(st.printerInfo && st.printerInfo.hostname) || "voron"}</Label>
      </div>
    </div>

    {/* Three columns down to ~950 px, then two, then one — the panels never overflow the page. */}
    <div style={S("display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); align-items:start; min-width:0")}>
      <SystemPanel st={st} sys={sys} />
      <McuPanel st={st} api={api} />
      <div style={S("display:grid; gap:10px; align-content:start; min-width:0")}>
        <EndstopPanel act={act} printing={printing} />
        <PowerPanel act={act} printing={printing} klippy={st.klippy} />
      </div>
    </div>

    <ServicesPanel sys={sys} act={act} printing={printing} connected={st.connected} />
    <UpdatesPanel api={api} act={act} printing={printing} connected={st.connected} serverInfo={st.serverInfo} />
  </div>;
}
