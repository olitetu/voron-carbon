// ---------------------------------------------------------------------------
// SYSTEM — what this printer runs on, and the four ways to restart it.
//
// Read from the live printer (2026-09-23, read-only GETs), not assumed:
//
// MCUS. Four, discovered from the store rather than listed (raw keys "mcu" / "mcu *"; boot.js subscribes
// them in full, mcu_constants included):
//   mcu          stm32f446xx  180 MHz  USB  v0.12.0-267-g12cd1d9e
//   mcu mmu      stm32g0b1xx   64 MHz  USB  v0.12.0-290-g14a83103c
//   mcu can0     stm32g0b1xx   64 MHz  CAN  v0.13.0-288-g1da2e39b
//   mcu scanner  stm32f042x6   48 MHz  CAN  "CARTOGRAPHER 5.0.0"   <- vendor firmware, not a Klipper build
// against a host at v0.13.0-745-gf0892d82-dirty. So all three Klipper-built MCUs are OLDER than the host,
// and it works: Klipper does not require the versions to match, it only stops with "MCU Protocol error"
// when a command it needs is missing from the firmware. That is reported in neutral grey, not as a
// warning — a permanent yellow row for a working machine is the crying-wolf the desktop MCU panel already
// had to unlearn (see RT_WARN in lib/actions/machine.js).
//
//   · mcu_awake is SECONDS awake per stats report, and the MCU sends one every 5 s (idle here: 0.002 s,
//     i.e. 0.04 %). One decimal would draw that as a flat 0.0 %, so anything under 1 % gets two.
//   · bytes_retransmit is BYTES. A healthy link re-sends a few just connecting (9 B on mcu and mmu here),
//     so the header only calls a link lossy past a kilobyte — the desktop MACHINE page's thresholds.
//   · MCU temperature comes from the config, not from sensor names: configfile.settings has four
//     `temperature_sensor` sections with sensor_type temperature_mcu and sensor_mcu mcu / can0 / mmu /
//     scanner (their names are OCTOPUS, EBB 2209, MMU, Cartographer). Mapping by sensor_mcu is exact;
//     guessing from "OCTOPUS" would not survive a rename.
//   · Link type is the MCU's own config section: canbus_uuid -> CAN, a /dev/serial/by-id/usb-… -> USB.
//     The scanner has no [mcu scanner] section; Cartographer's [scanner] section carries its canbus_uuid.
//
// HOST. Raspberry Pi 5 Model B Rev 1.0, 4 GB, Debian 12 (bookworm), kernel 6.12.93+rpt-rpi-2712, from
// machine.system_info (st.systemInfo) and machine.proc_stats (st.procStats; boot merges the incremental
// pushes — they carry no system_uptime). throttled_state read bits 0x50000 = "under-voltage occurred" +
// "throttling occurred" since boot, decoded by the shared throttleSummary(). This Pi browns out and resets
// itself while IDLE (sustained 5 V under-voltage, diagnosed 2026-09-10, hardware fix pending), so UPTIME is
// a health reading here, not trivia. And the sticky bits live in VideoCore firmware: they survive a warm
// reboot and clear only when the 5 V rail really drops — REBOOT HOST does not reset them, and the panel
// says so rather than let a reboot look like a fix.
//
// VERSIONS. Klipper's RUNNING version is printer.info (st.printerInfo), Moonraker's is server.info
// (moonraker_version v0.10.0-21-g9bceead, API 1.5.0). Everything else, and how far behind each is, is
// machine.update.status with refresh=false — Moonraker's CACHED answer (0.16 s here; refresh=true walks
// GitHub and is rate-limited, so it belongs to the UPDATES screen and a tap). Fetched once when the screen
// opens and again on notify_update_refreshed: a read, never a command. Moonraker reports untracked files
// as `anomalies` — seven mmu_*.py in klipper/klippy/extras and mmu_server.py in moonraker: Happy Hare's
// own files. That list keeps only *.py/*.c/*.cpp paths, so HH's core package (klippy/extras/mmu/ — its
// mmu.py imports `from ..homing`) is not in it; the rows therefore say "HH FILES UNTRACKED", not a count.
// A HARD recover of either repo deletes them and takes the MMU down, so those two rows say so, and this
// screen offers no update or recover at all — it only reports.
//
// THE DANGER ROW goes through the shared makeMachineActions (lib/actions/machine.js), which uses the
// Moonraker endpoints printer.firmware_restart / printer.restart / machine.reboot / machine.shutdown —
// NOT printer.gcode.script. That matters: FIRMWARE_RESTART is needed exactly when Klipper has shut down,
// and act.guarded refuses everything then. Each one confirms first. All four are refused while a print is
// printing OR paused (isPrintActive, which lets go once Klippy itself is shut down/disconnected, because
// print_stats keeps saying "printing" after a shutdown). When Klippy is disconnected from Moonraker the
// restart endpoints cannot reach it, so RESTART becomes a restart of the klipper systemd service — the one
// thing that still works — and FIRMWARE RESTART says why it is off. "Disconnected" is not taken from the
// store's notifications alone: Moonraker (9bceead, klippy_connection._check_ready) notifies only ready and
// shutdown when Klippy reconnects, so boot.js (watchKlippy) re-reads server.info every 2 s while the store
// says disconnected or startup, and stores what it finds — a read.
// RESTART and FIRMWARE RESTART both drop unsaved SAVE_CONFIG changes; the confirm says so whenever
// configfile.save_config_pending is set.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { useAsync } from "../../lib/useStore.js";
import { fmtBytes } from "../../lib/design.jsx";
import { makeMachineActions, isPrintActive, throttleSummary, fmtUptime, behindOf, repoFlags, updateSummary, updateOrder,
         untrackedFiles, isHappyHareFile, KLIPPER_STATS_INTERVAL, RT_WARN, RT_BAD } from "../../lib/actions/machine.js";
import { num } from "../../lib/spools.js";
import { shortVersion } from "../../pages/dashboard/adapters/shell.js";
import { C, F, L, TAP, mono } from "../tokens.js";
import { badgeStyle, microLabel } from "../vm.js";
import { Panel, PanelBtn, Bar, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";

const DASH = "—";
/** Stays pending until the socket is up, so a cold load shows "reading" instead of latching "not connected". */
const PENDING = new Promise(() => {});
/** Actions log their own failures; a tap handler must never be where a rejection surfaces. */
const fire = p => { Promise.resolve(p).catch(() => { /* logged by the action */ }); };

/** "v0.13.0-745-g…" -> [0,13,0,745]; null for anything that is not a Klipper build string. */
function kver(v) {
  const m = String(v || "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/);
  return m ? [m[1], m[2], m[3], m[4] || 0].map(Number) : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
const pctText = p => (p === null ? DASH : (p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : String(Math.round(p))) + " %");
const hotCol = (v, warn, bad) => (v === null ? C.mute : v >= bad ? C.accent : v >= warn ? C.bed : C.text);

/** Link type from the MCU's own config section. */
function linkOf(sec) {
  if (!sec) return null;
  if (sec.canbus_uuid) return "CAN";
  const s = String(sec.serial || "");
  if (!s) return null;
  if (/klipper_host_mcu/.test(s)) return "HOST";
  if (/usb|ttyACM/i.test(s)) return "USB";
  return "UART";
}

/** Every MCU in the store, with its chip, link, firmware and load. */
function mcuRows(raw, config, hostVersion) {
  const cfg = config || {};
  const keys = Object.keys(raw);
  const names = keys.filter(k => k === "mcu" || k.indexOf("mcu ") === 0)
    .sort((a, b) => (a === "mcu" ? -1 : b === "mcu" ? 1 : a.localeCompare(b)));
  // temperature_mcu sensors, keyed by the MCU object they measure (configfile keys are lower-case).
  const tempKey = {};
  for (const sec of Object.keys(cfg)) {
    const o = cfg[sec];
    if (sec.indexOf("temperature_sensor ") !== 0 || !o || o.sensor_type !== "temperature_mcu") continue;
    const m = String(o.sensor_mcu || "mcu").toLowerCase();
    const target = m === "mcu" ? "mcu" : "mcu " + m;
    const key = keys.find(k => k.toLowerCase() === sec);
    if (key && !tempKey[target]) tempKey[target] = key;
  }
  const host = kver(hostVersion);
  return names.map(k => {
    const o = raw[k] || {}, ls = o.last_stats || {}, mc = o.mcu_constants || {};
    const short = k === "mcu" ? "mcu" : k.slice(4);
    const awake = num(ls.mcu_awake);
    const mv = kver(o.mcu_version);
    let verNote = null;
    if (o.mcu_version && !mv) verNote = "VENDOR FIRMWARE";
    else if (mv && host) { const c = cmpVer(mv, host); if (c < 0) verNote = "OLDER THAN HOST"; else if (c > 0) verNote = "NEWER THAN HOST"; }
    const tk = tempKey[k.toLowerCase()];
    const clock = num(mc.CLOCK_FREQ);
    return {
      key: k, short,
      chip: [mc.MCU || null, clock ? Math.round(clock / 1e6) + " MHz" : null].filter(Boolean).join(" · ") || DASH,
      link: linkOf(cfg[k.toLowerCase()] || cfg[short.toLowerCase()]),
      version: o.mcu_version || DASH, verNote,
      awakePct: awake === null ? null : (awake / KLIPPER_STATS_INTERVAL) * 100,
      task: num(ls.mcu_task_avg),
      rt: num(ls.bytes_retransmit),
      temp: tk ? num((raw[tk] || {}).temperature) : null,
    };
  });
}

/**
 * One component's VERSIONS cell, by the UPDATES screen's rules (the shared behindOf / repoFlags), so the two
 * screens never disagree. null = no entry.
 */
function behind(v) {
  if (!v) return null;
  const cur = { text: "CURRENT", tone: C.mute };
  const b = behindOf(v);
  if (v.configured_type === "system") return b ? { text: b + " PKG", tone: C.bed } : cur;
  // Most specific first, like the UPDATES row badge: a dirty repo reads DIRTY, not INVALID.
  const flag = repoFlags(v)[0];
  if (flag) return { text: flag[0], tone: flag[1] === "err" ? C.accent : C.bed };
  // null is "Moonraker could not tell" (a "?" remote), not current.
  if (b === null) return { text: "?", tone: C.mute };
  if (!b) return cur;
  // `web` clients count no commits: the remote version string is what there is to show.
  return num(v.commits_behind_count) !== null ? { text: b + " BEHIND", tone: C.bed } : { text: "→ " + v.remote_version, tone: C.bed };
}

/**
 * Does Moonraker's `anomalies` list Happy Hare files untracked in this checkout? A yes/no, not a count:
 * the list is filtered to *.py/*.c/*.cpp, so HH's core — the klippy/extras/mmu/ package (its mmu.py
 * imports `from ..homing`) — is never in it, and "7 files" would undercount what a hard recover deletes.
 */
const hhUntracked = v => untrackedFiles(v).some(isHappyHareFile);

/**
 * Why a power action is off right now, as [long reason, short sub-label]. null = allowed.
 * The print guard reads the STORE (`s`), exactly as makeMachineActions will when the call is made;
 * `klippyNow` is st.klippy (kept current by boot.js watchKlippy, see System) and only decides whether
 * the printer.* endpoints can reach Klippy at all.
 */
function powerWhy(s, kind, klippyNow) {
  if (!s.connected) return ["Moonraker is offline", "MOONRAKER OFFLINE"];
  if (isPrintActive(s)) {
    const raw = s.raw || {};
    const paused = String((raw.print_stats || {}).state) === "paused" || !!(raw.pause_resume || {}).is_paused;
    return [`a print is ${paused ? "paused" : "printing"} — finish or cancel it first`, paused ? "NOT WHILE PAUSED" : "NOT WHILE PRINTING"];
  }
  if (kind === "fw" && klippyNow === "disconnected")
    return ["Klippy is not connected to Moonraker, so the firmware restart cannot reach it — RESTART restarts the klipper service instead", "KLIPPY NOT CONNECTED"];
  return null;
}

// ---------------------------------------------------------------------------
function Tile({ k, v, color = C.text, sub, children }) {
  return (
    <div style={S(`display:flex; flex-direction:column; gap:3px; min-width:0; padding:7px 10px; border:1px solid ${C.line2}; border-radius:${L.radiusSm}px; background:${C.panelSunk}`)}>
      <span style={S(mono(F.micro, `letter-spacing:.16em; color:${C.faint}`))}>{k}</span>
      <span style={S(mono(F.num2, `color:${color}; line-height:1.1; white-space:nowrap`))}>{v}</span>
      {children}
      {sub ? <span style={S(mono(F.micro, `color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{sub}</span> : null}
    </div>
  );
}

function MiniStat({ k, v, color = C.body }) {
  return (
    <div style={S("display:flex; flex-direction:column; gap:2px; min-width:0")}>
      <span style={S(mono(F.micro, `letter-spacing:.12em; color:${C.faint}`))}>{k}</span>
      <span style={S(mono(F.body, `color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{v}</span>
    </div>
  );
}

function HostPanel({ st }) {
  const ps = st.procStats || {};
  const si = st.systemInfo || {};
  const cpu = si.cpu_info || {}, distro = si.distribution || {};
  const usage = ps.system_cpu_usage || {};
  const load = num(usage.cpu);
  const cores = Object.keys(usage).filter(k => /^cpu\d+$/.test(k))
    .sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));
  const mem = ps.system_memory || {};
  const memT = num(mem.total), memU = num(mem.used);
  const memPct = memT && memU !== null ? (memU / memT) * 100 : null;
  const gb = kb => (kb / 1048576).toFixed(1);
  const temp = num(ps.cpu_temp);
  // Klipper's own temperature_host sensor tracks the peak since Klipper started; find it by sensor_type.
  const cfg = st.config || {};
  const hostSec = Object.keys(cfg).find(k => k.indexOf("temperature_sensor ") === 0 && (cfg[k] || {}).sensor_type === "temperature_host");
  const hostKey = hostSec ? Object.keys(st.raw).find(k => k.toLowerCase() === hostSec) : null;
  const peak = hostKey ? num((st.raw[hostKey] || {}).measured_max_temp) : null;
  const thr = throttleSummary(ps.throttled_state);
  const thrKind = !thr.known ? "off" : thr.now.length ? "err" : thr.past.length ? "warn" : "ok";
  // Short on purpose: "THROTTLING NOW" wrapped the "HOST · VORON" title onto two lines. The block below says NOW.
  const thrLabel = !thr.known ? "NO DATA" : thr.now.length ? "THROTTLED" : thr.past.length ? "SINCE BOOT" : "CLEAN";
  const host = (st.printerInfo && st.printerInfo.hostname) || "";
  const os = [distro.id ? distro.id.charAt(0).toUpperCase() + distro.id.slice(1) + (distro.version ? " " + distro.version : "") : distro.name, distro.kernel_version]
    .filter(Boolean).join(" · ");

  return (
    <Panel title={host ? `HOST · ${host.toUpperCase()}` : "HOST"}
      right={<span style={S(badgeStyle(st.connected ? thrKind : "off"))}>{st.connected ? thrLabel : "LAST KNOWN"}</span>}
      bodyStyle="padding:10px 12px; gap:8px; overflow:hidden">
      <div style={S("flex:none; display:flex; flex-direction:column; gap:2px; min-width:0")}>
        <span style={S(mono(F.label, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{cpu.model || DASH}</span>
        <span style={S(mono(F.micro, `color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
          {[cpu.cpu_count ? `${cpu.cpu_count}× ${cpu.processor || "CPU"}` : null, memT ? `${gb(memT)} GB RAM` : null].filter(Boolean).join(" · ") || DASH}
        </span>
        <span style={S(mono(F.micro, `color:${C.faint}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{os || DASH}</span>
      </div>

      <div style={S("flex:none; display:grid; grid-template-columns:1fr 1fr; gap:8px")}>
        <Tile k="CPU TEMP" v={temp === null ? DASH : temp.toFixed(1) + " °C"} color={hotCol(temp, 70, 80)}
          sub={peak !== null ? `PEAK ${peak.toFixed(1)} °C` : "SOC"} />
        <Tile k="CPU" v={load === null ? DASH : load.toFixed(1) + " %"} color={hotCol(load, 65, 85)}>
          {/* per-core load: drawn, not written — the total above is the number */}
          <div style={S("display:flex; gap:3px; height:15px; align-items:flex-end")}>
            {cores.length ? cores.map(c => {
              const v = num(usage[c]) || 0;
              return (
                <span key={c} style={S(`flex:1; height:100%; border-radius:2px; background:${C.track}; display:flex; align-items:flex-end; overflow:hidden`)}>
                  <span style={S(`width:100%; height:${Math.max(8, Math.min(100, v))}%; background:${v >= 85 ? C.accent : v >= 65 ? C.bed : C.cool}`)} />
                </span>
              );
            }) : <span style={S(mono(F.micro, `color:${C.mute}`))}>{DASH}</span>}
          </div>
        </Tile>
        <Tile k="MEMORY" v={pctText(memPct)} color={hotCol(memPct, 75, 90)}
          sub={memT && memU !== null ? `${gb(memU)} / ${gb(memT)} GB` : DASH}>
          <Bar pct={memPct || 0} color={memPct !== null && memPct >= 90 ? C.accent : memPct !== null && memPct >= 75 ? C.bed : C.cool} h={4} />
        </Tile>
        <Tile k="UPTIME" v={fmtUptime(num(ps.system_uptime))} sub="SINCE LAST BOOT" />
      </div>

      {/* Scrolls rather than clips: with every NOW and SINCE-BOOT bit set the text outgrows the space left. */}
      <div style={S(`flex:1; min-height:0; display:flex; flex-direction:column; gap:5px; padding:8px 10px; border-radius:${L.radiusSm}px; overflow-y:auto; ${thrKind === "err"
        ? `border:1px solid ${C.accentLine}; background:${C.accentBg2};`
        : thrKind === "warn" ? `border:1px solid ${C.warnLine}; background:${C.warnBg};`
        : `border:1px solid ${C.line2}; background:${C.panelSunk};`}`)}>
        <span style={S(microLabel(C.faint))}>POWER &amp; THERMALS</span>
        {!thr.known ? (
          <span style={S(mono(F.micro, `color:${C.mute}`))}>{st.connected ? "Waiting for machine.proc_stats…" : "Moonraker is offline"}</span>
        ) : thr.clean ? (
          <span style={S(mono(F.micro, `color:${C.cool}`))}>No under-voltage or throttling since boot.</span>
        ) : (
          <>
            {thr.now.length ? <span style={S(mono(F.micro, `color:${C.accent}; line-height:1.4`))}>{"NOW: " + thr.now.join(" · ")}</span> : null}
            {thr.past.length ? <span style={S(mono(F.micro, `color:${C.bed}; line-height:1.4`))}>{thr.past.join(" · ")}</span> : null}
            {thr.past.length ? (
              <span style={S(`font-size:${F.micro}px; color:${C.dim}; line-height:1.4; text-wrap:pretty`)}>
                Sticky: a reboot does not clear these — only a real power loss does.
              </span>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

function McuPanel({ st, klippy }) {
  const raw = st.raw || {};
  const rows = mcuRows(raw, st.config, st.printerInfo && st.printerInfo.software_version);
  const retrans = rows.reduce((n, r) => n + (r.rt || 0), 0);
  const kind = retrans >= RT_BAD ? "err" : retrans >= RT_WARN ? "warn" : "ok";
  // The store never clears raw, and Moonraker resubscribes only on notify_klippy_ready: once Klippy is
  // disconnected, in error or starting, these numbers are the previous session's. A shut-down Klippy still
  // serves its objects (and the re-sent count is then the diagnosis), so shutdown stays live.
  const live = st.connected && (klippy === "ready" || klippy === "shutdown");
  return (
    <Panel title={rows.length ? `MCUS · ${rows.length}` : "MCUS"}
      right={!rows.length ? null : !live ? <span style={S(badgeStyle("off"))}>LAST KNOWN</span>
        : <span style={S(badgeStyle(kind))}>{retrans >= RT_WARN ? `${fmtBytes(retrans)} RE-SENT` : "LINKS CLEAN"}</span>}
      bodyStyle="padding:8px; gap:6px; overflow-y:auto">
      {!rows.length ? (
        <Empty title="NO MCU DATA" hint={st.connected ? "Waiting for Klipper's first status update." : "Moonraker is offline."} />
      ) : rows.map(r => (
        // 5px vertical padding: at 6px four cards measured 410px in a 405px body — the last card's edge scrolled.
        <div key={r.key} style={S(`flex:none; display:flex; flex-direction:column; gap:4px; padding:5px 10px; border:1px solid ${C.line2}; border-radius:${L.radiusSm}px; background:${C.panelSunk}`)}>
          <div style={S("display:flex; align-items:center; gap:8px; min-width:0")}>
            <span style={S(mono(F.label, `letter-spacing:.1em; color:${C.text}; flex:none`))}>{r.short.toUpperCase()}</span>
            {r.link ? <span style={S(`${mono(F.micro, `letter-spacing:.1em; color:${C.dim}`)}; padding:0 6px; border:1px solid ${C.line3}; border-radius:3px; flex:none`)}>{r.link}</span> : null}
            <span style={S(`margin-left:auto; min-width:0; ${mono(F.micro, `color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}`)}>{r.chip}</span>
          </div>
          <div style={S("display:flex; align-items:center; gap:8px; min-width:0")}>
            <span style={S(mono(F.micro, `color:${C.body}; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{r.version}</span>
            {r.verNote ? <span style={S(`margin-left:auto; flex:none; ${mono(F.micro, `letter-spacing:.06em; color:${C.mute}`)}`)}>{r.verNote}</span> : null}
          </div>
          <div style={S("display:grid; grid-template-columns:repeat(4,1fr); gap:8px")}>
            <MiniStat k="AWAKE" v={pctText(r.awakePct)} color={r.awakePct !== null && r.awakePct >= 60 ? C.bed : C.body} />
            <MiniStat k="TASK AVG" v={r.task === null ? DASH : Math.round(r.task * 1e6) + " µs"} />
            <MiniStat k="RE-SENT" v={r.rt === null ? DASH : fmtBytes(r.rt)}
              color={r.rt === null ? C.mute : r.rt >= RT_BAD ? C.accent : r.rt >= RT_WARN ? C.bed : C.body} />
            <MiniStat k="TEMP" v={r.temp === null ? DASH : r.temp.toFixed(1) + " °C"} color={r.temp === null ? C.mute : C.body} />
          </div>
        </div>
      ))}
    </Panel>
  );
}

function Headline({ name, badge, extra, version, right, note }) {
  return (
    <div style={S(`flex:none; display:flex; flex-direction:column; gap:3px; padding:7px 0; border-bottom:1px solid ${C.line2}`)}>
      <div style={S("display:flex; align-items:center; gap:8px; min-width:0")}>
        <span style={S(microLabel(C.dim))}>{name}</span>
        {badge || null}
        {extra ? <span style={S(mono(F.micro, `color:${C.faint}; white-space:nowrap`))}>{extra}</span> : null}
        {right ? <span style={S(`margin-left:auto; flex:none; ${mono(F.micro, `letter-spacing:.06em; color:${right.tone}; white-space:nowrap`)}`)}>{right.text}</span> : null}
      </div>
      <span style={S(mono(F.label, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{version}</span>
      {note ? <span style={S(mono(F.micro, `letter-spacing:.04em; color:${C.bed}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{note}</span> : null}
    </div>
  );
}

function VersionsPanel({ st, klippy: klippyNow, upd, go }) {
  const data = upd.data || {};
  const vi = data.version_info || {};
  const kl = vi.klipper, mr = vi.moonraker;
  // Offline, the Klippy state is only the last thing Moonraker said — do not keep asserting it.
  const klippy = st.connected ? klippyNow || "unknown" : "unknown";
  const kKind = klippy === "ready" ? "ok" : klippy === "startup" ? "warn" : klippy === "unknown" ? "off" : "err";
  const hhNote = v => (hhUntracked(v) ? "HH FILES UNTRACKED · NO HARD RECOVER" : null);
  // The UPDATES screen's order (updateOrder: system last), minus the two rows drawn above.
  const others = Object.keys(vi).filter(n => n !== "klipper" && n !== "moonraker").sort(updateOrder);
  // The UPDATES header's counts (updateSummary): components and apt packages kept apart, and a component
  // Moonraker could not check reads UNKNOWN rather than ALL CURRENT.
  const sum = updateSummary(data);
  const updSub = upd.loading ? (st.connected ? "READING…" : "OFFLINE")
    : upd.error ? "UNAVAILABLE"
    : [sum.pending ? `${sum.pending} BEHIND` : sum.unknown ? `${sum.unknown} UNKNOWN` : null,
       sum.packages ? `${sum.packages} PKG` : null].filter(Boolean).join(" · ") || "ALL CURRENT";
  const moon = st.serverInfo || {};

  return (
    <Panel title="VERSIONS" bodyStyle="padding:4px 12px 10px; gap:0">
      <Headline name="KLIPPER" badge={<span style={S(badgeStyle(kKind))}>{klippy.toUpperCase()}</span>}
        version={(st.printerInfo && st.printerInfo.software_version) || (kl && kl.full_version_string) || DASH}
        right={behind(kl)} note={hhNote(kl)} />
      <Headline name="MOONRAKER" extra={moon.api_version_string ? `API ${moon.api_version_string}` : null}
        version={moon.moonraker_version || (mr && mr.full_version_string) || DASH}
        right={behind(mr)} note={hhNote(mr)} />
      <div style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column")}>
        {upd.error ? (
          <span style={S(mono(F.micro, `color:${C.accent}; padding:10px 0; line-height:1.4`))}>{"update manager: " + upd.error}</span>
        ) : !others.length ? (
          <span style={S(mono(F.micro, `color:${C.mute}; padding:10px 0`))}>
            {upd.loading ? (st.connected ? "Reading the update manager…" : "Moonraker is offline") : "The update manager lists no other components."}
          </span>
        ) : others.map(n => {
          const v = vi[n] || {};
          const b = behind(v) || { text: DASH, tone: C.mute };
          return (
            <div key={n} style={S(`flex:none; display:grid; grid-template-columns:minmax(0,1fr) 76px 80px; align-items:center; gap:8px; height:30px; border-bottom:1px solid ${C.line1}`)}>
              <span style={S(mono(F.label, `color:${C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{n}</span>
              <span style={S(mono(F.micro, `color:${C.dim}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
                {v.configured_type === "system" ? DASH : shortVersion(v.version)}
              </span>
              <span style={S(mono(F.micro, `letter-spacing:.04em; color:${b.tone}; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>{b.text}</span>
            </div>
          );
        })}
      </div>
      <div style={S("flex:none; padding-top:8px")}>
        <PanelBtn label="UPDATES" sub={updSub} h={TAP.min + 4} onTap={() => go("updates")} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
export default function System({ st, go, api, act }) {
  const [confirm, setConfirm] = React.useState(null);
  // The confirm is open for seconds; the guard must be re-read at CONFIRM, not at the tap that opened it.
  const stRef = React.useRef(st);
  stRef.current = st;

  // makeMachineActions logs its intent and failures straight into the screen command log (act.log:
  // st.screenLog, and warn/err also toast), the same arrangement as console.jsx.
  // Screens get no store; the actions only read store.state, so hand them the live state through the ref.
  const machine = React.useMemo(
    () => makeMachineActions({ api, store: { get state() { return stRef.current; } }, log: act.log }),
    [api, act]);

  // Moonraker's cached update status (refresh=false): a read, once per open, and again when Moonraker
  // announces a refresh someone else ran.
  const upd = useAsync(() => (api && st.connected ? api.updateStatus(false) : PENDING), [api, st.connected]);
  const reloadUpd = upd.reload;
  React.useEffect(() => {
    if (!api || typeof api.on !== "function") return undefined;
    const off = api.on("update_refreshed", () => reloadUpd());
    return () => { try { off(); } catch (e) { /* already gone */ } };
  }, [api, reloadUpd]);

  // st.klippy is trusted as is. Moonraker (9bceead, klippy_connection._check_ready) notifies only ready and
  // shutdown when Klippy reconnects, so a Klippy back in "error" (a config or MCU-connect error) or "startup"
  // is announced by nothing. boot.js watchKlippy covers that: while the store says disconnected or startup it
  // re-reads server.info every 2 s and stores the real state, so FIRMWARE RESTART, the documented way out of
  // an MCU-connect error, is not disabled by a false "KLIPPY NOT CONNECTED".
  const klippy = st.klippy;
  const klippyRef = React.useRef(klippy);
  klippyRef.current = klippy;

  const raw = st.raw || {};
  const kDown = klippy === "disconnected";
  const mcuNames = Object.keys(raw).filter(k => k === "mcu" || k.indexOf("mcu ") === 0).map(k => (k === "mcu" ? "mcu" : k.slice(4)));
  const s1 = mcuNames.length === 1 ? "" : "s";
  const pending = !!(raw.configfile || {}).save_config_pending;
  const lose = pending ? " The unsaved SAVE_CONFIG changes are discarded." : "";
  const thr = throttleSummary((st.procStats || {}).throttled_state);
  const model = ((st.systemInfo || {}).cpu_info || {}).model || "";
  const pi5 = /Raspberry Pi 5/i.test(model);
  const hostWord = /Raspberry Pi/i.test(model) ? "the Raspberry Pi" : "the host";

  const ROW = [
    {
      k: "fw", label: "FIRMWARE RESTART", guard: "fw",
      tone: klippy === "shutdown" || klippy === "error" ? "accent" : undefined,
      sub: klippy === "shutdown" ? "CLEARS THE SHUTDOWN" : mcuNames.length ? `RESETS ${mcuNames.length} MCU${s1.toUpperCase()}` : "RESETS THE MCUS",
      cmd: "FIRMWARE_RESTART → printer.firmware_restart",
      text: `Reset ${mcuNames.length ? `${mcuNames.length} MCU${s1} (${mcuNames.join(", ")})` : "every MCU"} and restart Klipper? Heaters switch off and homing and the gantry level are lost.${lose}`,
      run: () => machine.firmwareRestart(),
    },
    kDown ? {
      k: "restart", label: "RESTART KLIPPER", guard: "restart", sub: "SERVICE · KLIPPY DOWN",
      cmd: "machine.services.restart klipper",
      text: "Klippy is not connected to Moonraker, so a RESTART cannot reach it. Restart the klipper systemd service instead?",
      run: () => machine.serviceAction("klipper", "restart"),
    } : {
      k: "restart", label: "RESTART", guard: "restart",
      sub: klippy === "shutdown" ? "WON'T CLEAR A SHUTDOWN" : "RE-READS PRINTER.CFG",
      cmd: "RESTART → printer.restart",
      text: `Restart the Klipper host process and re-read printer.cfg? Heaters switch off and homing is lost. It does not clear an MCU shutdown — that needs FIRMWARE RESTART.${lose}`,
      run: () => machine.klipperRestart(),
    },
    {
      k: "reboot", label: "REBOOT HOST", guard: "host", tone: "danger", sub: pi5 ? "RASPBERRY PI 5" : "WHOLE HOST",
      cmd: "machine.reboot",
      text: `Reboot ${hostWord}? Klipper, Moonraker and this screen go down until it has booted again.${thr.past.length ? " The sticky under-voltage flags survive a reboot, so they will still show afterwards." : ""}`,
      run: () => machine.hostReboot(),
    },
    {
      k: "shutdown", label: "SHUTDOWN HOST", guard: "host", tone: "danger", sub: "POWER-ON BY HAND",
      cmd: "machine.shutdown",
      text: `Power ${hostWord} off? Nothing on this screen can bring it back — it has to be switched on at the printer${pi5 ? " (the Pi 5's power button, or a power cycle)" : " (a power cycle)"}.`,
      run: () => machine.hostShutdown(),
    },
  ];

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>
      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:300px minmax(0,1fr) 310px; gap:${L.gap}px`)}>
        <HostPanel st={st} />
        <McuPanel st={st} klippy={klippy} />
        <VersionsPanel st={st} klippy={klippy} upd={upd} go={go} />
      </div>

      {/* The danger row. Every one confirms; every one is refused while a print is printing or paused. */}
      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px repeat(4,1fr); gap:8px`)}>
        <span />
        {ROW.map(a => {
          const why = powerWhy(st, a.guard, klippy);
          return (
            <PanelBtn key={a.k} label={a.label} sub={why ? why[1] : a.sub} tone={why ? undefined : a.tone} h={TAP.primary}
              disabled={!!why} why={why ? why[0] : undefined}
              onTap={() => setConfirm(a)} />
          );
        })}
      </div>

      {confirm ? (
        <ConfirmBox a={{ label: confirm.label, confirm: confirm.text, cmd: confirm.cmd }}
          onNo={() => setConfirm(null)}
          onYes={() => {
            const c = confirm; setConfirm(null);
            const why = powerWhy(stRef.current, c.guard, klippyRef.current);
            if (why) { act.refuse(c.label, why[0]); return; }
            fire(c.run());
          }} />
      ) : null}
    </div>
  );
}
