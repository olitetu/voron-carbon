// ---------------------------------------------------------------------------
// NETWORK — wifi through the optional host helper; read-only facts from Moonraker without it.
//
// Facts this screen is built on, from read-only GETs to the live printer and from the helper's own source
// (tools/helper/carbon_helper.py). Everything a warning says is computed live from the store; these notes say
// why it says it.
//
//   · wlan0 IS THE ONLY WAY IN. machine.system_info.network lists wlan0 alone (192.168.0.167, a DHCP
//     address). proc_stats has an eth0, and it has carried 0 bytes since boot: there is no cable. wlan0 moves
//     ~2.3 MB/s meanwhile, nearly all of it the camera stream going out. proc_stats `bandwidth` is
//     d(rx+tx)/dt in bytes/s (checked: two samples 4.2 s apart gave 2.18 MB/s against a reported 2.30 MB/s).
//     The ETHERNET row and the warnings read eth0's counters, so a cable plugged in later changes what they say.
//
//   · THIS PANEL SURVIVES ANY WIFI CHANGE. NOTHING ELSE DOES. The panel is served on the printer and reaches
//     Moonraker over 127.0.0.1 (Moonraker's [server] binds 0.0.0.0:7125; the Carbon nginx site's upstream is
//     127.0.0.1:7125), so joining another network, or losing this one, never cuts it off. Every REMOTE client
//     does drop: Orca, phones, Mainsail on another machine, SSH. "This panel survives" is COMPUTED, not
//     assumed: it holds only while API_BASE (or, same-origin, the page itself) is a loopback host. A browser
//     that opened this page as voron.local is itself a remote client, and the text says so.
//     Spoolman drops too. moonraker.conf has `[spoolman] server: http://192.168.0.167:7912`, and that is
//     wlan0's own address, so when the address goes, Moonraker's route to Spoolman goes too (usage waits in
//     pending_reports), and on a network that hands out a different address it stays gone until that line
//     is edited. The screen reads [spoolman] from server.config and names Spoolman only while its host IS the
//     current address. Nothing about it is hardcoded.
//
//   · MOONRAKER DOES NOT KNOW THE SSID. system_info carries the interface, its addresses and the MAC, nothing
//     more. Without the helper the SSID is shown as unknown, with that reason, not a guess.
//
//   · THE HELPER IS OPTIONAL AND LOOPBACK-ONLY. Its nginx block answers 403 to a LAN client (allow 127.0.0.1;
//     deny all), and the helper itself refuses a request nginx did not accept on loopback. So a page opened
//     as voron.local is read-only even with the helper installed; only the kiosk's 127.0.0.1 page can change
//     wifi. Before the helper is installed, /helper/ answers 502 on loopback. The read-only panel says which.
//
//   · WHAT THE HELPER REFUSES, THIS SCREEN DOES NOT OFFER. The helper will not forget the profile wlan0 is
//     connected through, and will not switch the radio off while a wifi profile is up. Both answer 409,
//     because wlan0 is the only link. Those two controls are greyed with that reason, and tapping them says
//     so. CONNECT is a two-phase commit: if the new network does not come up with an address, the helper
//     brings the previous profile back before it answers, and the answer says whether that worked. When nmcli
//     cannot say which profile is up, the helper refuses all three changes rather than guess.
//
//   · NMCLI FAILING IS NOT "NOTHING THERE". /health reports whether the helper found nmcli (helper.nmcli);
//     without it this screen is read-only and says nmcli is missing. A /net whose nmcli failed carries
//     `error`, and is shown as unreadable, not as "no address": every warning below would otherwise say a
//     change cuts nothing. A /wifi whose nmcli failed is an error, never "radio off" or "no networks".
//
//   · /net's "ssid" IS A PROFILE NAME. It is nmcli's GENERAL.CONNECTION. On Raspberry Pi OS a profile made
//     by the Imager is called "preconfigured", not the SSID (the name on this printer could not be read
//     remotely). So the headline SSID comes from the scan's in-use row, and the profile name is shown beside
//     it when the two differ. The scan's `known` means "some profile is named after this SSID", which is
//     exactly what FORGET (`nmcli connection delete <name>`) can act on, so FORGET is live only there. The
//     network in use is SAVED (no password asked) even when its profile has another name. That row's
//     FORGET is greyed with the reason.
//
//   · SCAN ON TAP ONLY. /wifi always runs `nmcli device wifi list --rescan yes`, which takes the only radio
//     off-channel for a few seconds under that 2.3 MB/s stream. /net is a plain `nmcli device show`, polled
//     every 5 s while this screen is visible. The last scan is kept, with its time, when the screen is left
//     and reopened. It is not silently re-run.
//
//   · HOW LONG A CONNECT CAN TAKE. Every nmcli call in the helper has a timeout, and a connect's steps (which
//     profile is up; the attempt, its argv retry and the address wait in one window; the rollback and its
//     wait; the state sent back) add up to its CONNECT_CEILING. helper.js mirrors that as CONNECT_CEILING_MS
//     and waits longer (CONNECT_TIMEOUT_MS), as does nginx's proxy_read_timeout, so the helper's own answer
//     normally arrives. Only a JSON body with `error` is that answer. nginx's 502/504 page, a dropped socket
//     and the abort are all "unknown", never "failed", and LINK shows how it ends.
//     The helper also serialises every NetworkManager change under ONE lock. A FORGET or RADIO sent while an
//     unanswered connect still holds it would queue, outlive helper.js's 8 s timeout (reported as a failure),
//     and then run anyway, unannounced. So after any unanswered change the controls stay LOCKED, with a
//     countdown, until /net shows the link activated with an address for 4 s (the helper answers within ~1 s
//     of that), or the helper's worst case for that change has passed since it was sent (CONNECT_CEILING_MS,
//     CHANGE_CEILING_MS). An abort after CONNECT_TIMEOUT_MS is already past the ceiling, so it locks nothing.
//     The attempt is kept at module level, so leaving the screen mid-connect and coming back picks it up.
//
// NO G-CODE. Nothing on this screen reaches Klipper. Wifi goes to the helper and needs neither Moonraker nor
// Klipper to be up, which is why this screen does not use act.blocked. A wifi fix must still be possible
// while Klipper is shut down. act.refuse carries every failure into the command log.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { API_BASE } from "../../lib/boot.js";
import { useAsync } from "../../lib/useStore.js";
import { fmtBytes } from "../../lib/design.jsx";
import { C, F, L, TAP, mono } from "../tokens.js";
import { job as jobVm, badgeStyle, microLabel, fmtClock, fmtHM } from "../vm.js";
import { Panel, PanelBtn, Empty } from "../parts.jsx";
import { ConfirmBox } from "./move.jsx";
import { helper, bars, netFromMoonraker, CONNECT_CEILING_MS, CONNECT_TIMEOUT_MS, CHANGE_CEILING_MS } from "../helper.js";

const POLL_MS = 5000;
const GLYPHS = ["▂", "▄", "▆", "█"];
const LEFT_W = 372;
const SETTLE_MS = 4000;            // link seen activated with an address this long => the helper has answered
const secsOf = ms => Math.round(ms / 1000);

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
const PAGE_HOST = typeof location !== "undefined" ? location.hostname : "";
// Where this page's Moonraker socket actually goes. Same-origin (API_BASE "") means the page's own host.
const API_HOST = (() => {
  try { return API_BASE ? new URL(API_BASE, location.href).hostname : PAGE_HOST; } catch (e) { return PAGE_HOST; }
})();
const PANEL_LOCAL = LOOPBACK.test(API_HOST);

// Outlives the component: a connect can run for minutes, and a scan is a radio action not worth repeating on
// every visit. `op` is the operation in flight, `scan` the last /wifi answer, `radio` the last known radio
// ({on, at}), `probe` a CHECK AGAIN answer, `scanning` a /wifi in flight, `unsettled` the lock after an
// unanswered change ({label, ssid, until, onLink, upAt}).
const keep = { op: null, scan: null, radio: null, probe: null, scanning: null, unsettled: null };

const msgOf = e => (e && e.name === "AbortError" ? "no answer" : (e && e.message) || String(e));
const errOf = e => (e && e.data && e.data.error) || msgOf(e);
/** True only for an answer the helper itself wrote. nginx's 502/504 pages are HTML, so they carry no `error`. */
const helperAnswered = e => !!(e && e.status && e.data && typeof e.data.error === "string");
const utf8len = s => { try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; } };

/** nmcli GENERAL.STATE, e.g. "100 (connected)" -> a badge. */
function devState(s) {
  const m = String(s || "").match(/^(\d+)\s*\((.*)\)$/);
  const code = m ? Number(m[1]) : NaN;
  const text = m ? m[2] : String(s || "unknown");
  const b = (kind, label) => ({ code, text, kind, label });
  if (code === 100) return b("ok", "CONNECTED");
  if (code === 60) return b("warn", "NEEDS PASSWORD");
  if (code >= 40 && code < 100) return b("warn", "CONNECTING");
  if (code === 30) return b("warn", "DISCONNECTED");
  if (code === 110) return b("warn", "DISCONNECTING");
  if (code === 120) return b("err", "FAILED");
  if (code === 20) return b("off", "UNAVAILABLE");
  if (code === 10) return b("off", "UNMANAGED");
  return b("off", "UNKNOWN");
}

/** What nmcli's SECURITY column means for joining. The helper sends a PSK or nothing. */
function secOf(ap) {
  const s = String((ap && ap.security) || "");
  const enterprise = /802\.1X/i.test(s);
  const wep = /\bWEP\b/i.test(s) && !/WPA/i.test(s);
  const owe = /\bOWE\b/i.test(s) && !/WPA|SAE/i.test(s);        // enhanced open: encrypted, no password
  return { enterprise, wep, needsPsk: !(ap && ap.open) && !owe && !enterprise, label: ap && ap.open ? "OPEN" : s || "SECURED" };
}

/** A key nmcli would reject anyway, caught before the radio is touched. */
function pskProblem(psk, wep) {
  if (wep) return /^(.{5}|.{13}|[0-9a-f]{10}|[0-9a-f]{26})$/i.test(psk) ? null : "a WEP key is 5 or 13 characters, or 10 or 26 hex digits";
  if (/^[0-9a-f]{64}$/i.test(psk)) return null;
  return psk.length >= 8 && psk.length <= 63 ? null : `a WPA password is 8–63 characters; that one is ${psk.length}`;
}

/** A disabled control on a touchscreen has no hover, so a tap on it says why instead. */
function Act({ act, label, sub, tone, why, onTap, h = TAP.min }) {
  return (
    <div onClick={why ? () => act.refuse(label, why) : undefined} style={S("min-width:0")}>
      <PanelBtn label={label} sub={sub} tone={tone} h={h} disabled={!!why} why={why || undefined} onTap={onTap} />
    </div>
  );
}

function Row({ k, v, color = C.body }) {
  return (
    <div style={S("display:flex; align-items:center; gap:12px; min-width:0")}>
      <span style={S(mono(F.micro, `letter-spacing:.12em; color:${C.faint}; flex:none`))}>{k}</span>
      <span style={S(mono(F.label, `margin-left:auto; color:${color}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; text-align:right`))}>{v}</span>
    </div>
  );
}

export default function Network({ st, meta, say, api, act, askInput, probeHelper }) {
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The latest link facts, for closures armed in an older render (the re-prompt after a rejected password,
  // a scan resolving after the link changed). Written each render, read only from callbacks.
  const live = React.useRef({ profile: null });

  // ---- is the helper there? main.jsx probes once at start; CHECK AGAIN re-asks /health from here. Its answer
  //      is kept at module level, so leaving and reopening the screen does not fall back to the start-up probe.
  const [probe, setProbe] = React.useState(keep.probe);
  const [probing, setProbing] = React.useState(false);
  const hasHelper = probe !== null ? probe : st.helper === true ? true : st.helper === false ? false : null;
  // helper.nmcli comes from the same /health answer as hasHelper (main.jsx's probe, or CHECK AGAIN's).
  const noNmcli = hasHelper === true && !helper.nmcli;
  const avail = hasHelper === true && !noNmcli;
  const visible = st.visible !== false;

  const [net, setNet] = React.useState(null);
  const [netAt, setNetAt] = React.useState(0);
  const [netErr, setNetErr] = React.useState(null);
  const [scan, setScan] = React.useState(keep.scan);
  const [scanning, setScanning] = React.useState(!!keep.scanning);
  const [scanErr, setScanErr] = React.useState(null);
  const [radio, setRadio] = React.useState(keep.radio);
  const [busy, setBusy] = React.useState(keep.op);
  const [confirm, setConfirm] = React.useState(null);
  const [, tick] = React.useReducer(n => n + 1, 0);

  // `at` is when the state was sampled (the request's start), so a poll already in flight when RADIO OFF
  // answered cannot land afterwards and read as newer evidence.
  const acceptNet = React.useCallback((n, at = Date.now()) => {
    // The lock after an unanswered change lifts once the link has been activated with an address for
    // SETTLE_MS: the helper's last step is an address wait that returns the moment there is one.
    // Only a connect ends that way; an unanswered forget or radio says nothing about the link, so it waits out
    // its window.
    const u = keep.unsettled;
    if (u && u.onLink) {
      if (n && n.ip && devState(n.state).code === 100) {
        if (!u.upAt) u.upAt = Date.now();
        else if (Date.now() - u.upAt >= SETTLE_MS) keep.unsettled = null;
      } else u.upAt = 0;
    }
    if (alive.current) { setNet(n); setNetAt(at); setNetErr(null); }
  }, []);

  const readNet = React.useCallback(() => {
    const at = Date.now();
    return helper.net()
      .then(n => acceptNet(n, at))
      .catch(e => { if (alive.current) setNetErr(msgOf(e)); });
  }, [acceptNet]);

  // Self-scheduling rather than setInterval, so a slow `nmcli device show` never has a second request
  // stacked behind it.
  React.useEffect(() => {
    if (!avail || !visible) return undefined;
    let on = true, t = null;
    const loop = () => readNet().finally(() => { if (on) t = setTimeout(loop, POLL_MS); });
    loop();
    return () => { on = false; clearTimeout(t); };
  }, [avail, visible, readNet]);

  // An operation or scan started before this screen was left is still running: follow it to the end.
  React.useEffect(() => {
    const follow = p => p && p.then(() => setTimeout(() => {
      if (!alive.current) return;
      setBusy(keep.op); setScan(keep.scan); setRadio(keep.radio); setScanning(!!keep.scanning); readNet();
    }, 0));
    follow(keep.op && keep.op.promise);
    follow(keep.scanning);
  }, [readNet]);

  // The elapsed counter on the busy banner, and the countdown on the lock after an unanswered change.
  const unsettled = keep.unsettled && Date.now() < keep.unsettled.until ? keep.unsettled : null;
  const ticking = !!busy || !!unsettled;
  React.useEffect(() => {
    if (!ticking) return undefined;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // Where Moonraker reaches Spoolman, to know whether a wifi change takes Spoolman with it.
  const cfg = useAsync(() => (st.connected ? api.rpc("server.config") : Promise.resolve(null)), [st.connected]);
  let spoolHost = null;
  try { spoolHost = new URL(cfg.data.config.spoolman.server).hostname; } catch (e) { spoolHost = null; }

  // ---- derived -------------------------------------------------------------
  const mr = netFromMoonraker(st);
  // A /net whose nmcli failed says nothing about the link: its "no address" is "could not read". Everything
  // below then falls back to Moonraker's facts, and nmWhy keeps the controls shut.
  const nmErr = net && net.error ? String(net.error) : null;
  const netOk = nmErr ? null : net;
  const ds = netOk ? devState(netOk.state) : null;
  const profile = netOk ? netOk.ssid : null;                   // a PROFILE name — see the header
  live.current = { profile };
  // The scan's in-use row is true only of the moment it was taken. Trust it while the same profile is up;
  // after a drop or a change made elsewhere, no row claims to be connected until the next scan.
  const scanFresh = !!(scan && profile && scan.profile === profile);
  const aps = ((scan && scan.aps) || []).map(a => (a.active && !scanFresh ? { ...a, active: false } : a));
  const activeAp = aps.find(a => a.active) || null;
  const iface = (net && net.iface) || (mr && mr.iface) || "wlan0";
  const ip = netOk ? netOk.ip : mr ? mr.ip : null;
  const up = !!ip;
  // Newest evidence wins. NetworkManager holds a wifi device at 20 (unavailable) while the radio is off, so
  // any state from 30 (disconnected) up means the radio is on. A later scan or RADIO answer overrides it.
  const devSaysOn = !!(ds && ds.code >= 30);
  const radioNow = devSaysOn && (!radio || netAt >= radio.at) ? true : radio ? radio.on : null;
  const ps = st.procStats || {};
  const nics = ps.network || {};
  const wl = nics[iface];
  const bw = wl && Number.isFinite(wl.bandwidth) ? wl.bandwidth : null;
  const eth = nics.eth0 ? { bytes: (nics.eth0.rx_bytes || 0) + (nics.eth0.tx_bytes || 0), bw: nics.eth0.bandwidth || 0 } : null;
  const ethIdle = !!eth && eth.bytes === 0;
  const spoolOnLink = !!(spoolHost && ip && spoolHost === ip);
  const printing = jobVm(st, meta).active;
  const panelSays = PANEL_LOCAL
    ? "This panel stays up, because it reaches Moonraker on 127.0.0.1."
    : `This page drops too: it reaches Moonraker through ${API_HOST || "the network"}, not loopback.`;

  const busyWhy = busy ? `${busy.label.toLowerCase()}${busy.ssid ? " " + busy.ssid : ""} is still running` : null;
  const silentWhy = avail && netErr ? `the helper is not answering (${netErr})` : null;
  // Until /net has answered, every warning below would be written from nothing ("nothing is connected, so
  // nothing drops"). So nothing that touches the link is offered before it has.
  const readingWhy = avail && !net && !netErr ? "the link state is still being read from the helper" : null;
  const nmWhy = avail && nmErr ? `the helper could not read ${iface} through nmcli (${nmErr}), so what a change would cut is unknown` : null;
  const lockWhy = unsettled
    ? `the helper may still be working on the unanswered ${unsettled.label.toLowerCase()}${unsettled.ssid ? " " + unsettled.ssid : ""}, and would queue this behind it`
    : null;
  const opWhy = busyWhy || silentWhy || readingWhy || nmWhy || lockWhy;

  // ---- the operations --------------------------------------------------------
  const putScan = next => { keep.scan = next; if (alive.current) setScan(next); };
  const patchAps = (fn, extra) => { if (keep.scan) putScan({ ...keep.scan, ...extra, aps: keep.scan.aps.map(fn) }); };
  const putRadio = on => { const r = { on, at: Date.now() }; keep.radio = r; if (alive.current) setRadio(r); };
  const leaveUnsettled = (label, ssid, since, ms, onLink = false) => { keep.unsettled = { label, ssid, until: since + ms, onLink, upAt: 0 }; if (alive.current) tick(); };

  const runOp = (label, ssid, fn) => {
    const op = { label, ssid, prev: live.current.profile, since: Date.now() };
    op.promise = Promise.resolve().then(fn).then(r => ({ ok: true, r }), e => ({ ok: false, e }));
    keep.op = op;
    setBusy(op);
    return op.promise.then(res => {
      if (keep.op === op) keep.op = null;
      if (alive.current) setBusy(null);
      return { ...res, since: op.since };
    });
  };

  const scanNow = () => {
    setScanning(true); setScanErr(null);
    const p = helper.wifi()
      .then(w => {
        // `saved`: some profile can join it, so no password is needed. That holds for `known` rows, and
        // also for the in-use row, whose profile may be named otherwise ("preconfigured"). `known` stays the
        // helper's: a profile NAMED after the SSID, which is the only kind FORGET can delete. The profile the
        // in-use row belongs to is read when the answer lands, not when SCAN was tapped.
        // An nmcli failure arrives as an error (SCAN FAILED), so a 200's `radio` is the radio's real state.
        const list = Array.isArray(w && w.aps) ? w.aps.map(a => ({ ...a, saved: !!(a.known || a.active) })) : [];
        putScan({ at: Date.now(), radio: !!(w && w.radio), aps: list, profile: live.current.profile });
        if (w && typeof w.radio === "boolean") putRadio(w.radio);
      })
      .catch(e => { if (alive.current) setScanErr(errOf(e)); })
      .finally(() => { if (keep.scanning === p) keep.scanning = null; if (alive.current) setScanning(false); });
    keep.scanning = p;
  };

  const warnJoin = ssid => {
    const t = [];
    if (up) {
      t.push(`Move ${iface}${profile ? ` from ${profile}` : ""} to ${ssid}? ${panelSays}`);
      t.push(`Orca, phones, other browsers and SSH lose the printer now${ethIdle ? ", and eth0 carries nothing, so there is no other way in" : ""}. On another network it will almost certainly get a different address, so they must be pointed at the new one.`);
      if (spoolOnLink) t.push(`Spoolman is configured at ${spoolHost}, this link's own address: Moonraker cannot reach it while that address is gone, and on a network that hands out another one, not until moonraker.conf's [spoolman] server is changed. Usage reports queue meanwhile.`);
      if (printing) t.push("The print itself carries on.");
      t.push(profile ? `If ${ssid} does not come up with an address, the helper puts ${profile} back before it answers.` : `If ${ssid} does not come up with an address, the attempt is abandoned.`);
    } else {
      t.push(`Join ${ssid}? ${iface} has no address now, so no remote client is connected to lose. ${profile ? `If ${ssid} does not come up with an address, the helper tries ${profile} again.` : `If ${ssid} does not come up with an address, the attempt is abandoned.`}`);
    }
    return t.join(" ");
  };

  const doConnect = async ({ ssid, psk, hidden, ap }) => {
    const res = await runOp("CONNECTING", ssid, () => helper.connect(ssid, psk || "", !!hidden));
    if (res.ok) {
      const n = (res.r && res.r.net) || null;
      if (n) acceptNet(n);
      // The helper verified an address on `ssid`, so the list can say so without a rescan. The profile it
      // came up under becomes the scan's reference, so the row stays trusted (see scanFresh).
      patchAps(a => ({ ...a, active: a.ssid === ssid, saved: a.saved || a.ssid === ssid }), { profile: n ? n.ssid : null });
      putRadio(true);
      say(`ON ${ssid}${n && n.ip ? " · " + n.ip : ""}`);
      return;
    }
    const e = res.e, d = (e && e.data) || {};
    if (helperAnswered(e)) {
      if (d.net) acceptNet(d.net);
      // The helper says which of three things happened to the previous link: it never touched it (the new
      // profile failed before wlan0 moved), it brought it back, or it could not.
      const back = !d.previous ? ""
        : d.untouched ? `still on ${d.previous}`
        : d.reverted ? `back on ${d.previous}`
        : `and could NOT get back onto ${d.previous}`;
      const pw = e.status === 401 && /secret|password|psk/i.test(d.error || "");
      const leftover = d.cleanup ? `a saved profile could not be removed (${d.cleanup})` : "";
      act.refuse(`CONNECT ${ssid}`, [pw ? "password rejected" : d.error, back, leftover].filter(Boolean).join(" — "));
      // A SAVED network whose stored secret was rejected: ask for a new one (it confirms again).
      if (e.status === 401 && !psk && ap && alive.current) startConnect(ap, true);
      return;
    }
    // No answer the helper wrote: helper.js's abort, nginx's own 502/504, or a dropped socket. Until the
    // helper's ceiling has passed since the connect was sent, it may still be joining or rolling back under
    // its lock, so nothing else is sent until the link settles. The abort comes after that ceiling, so by
    // then the helper has finished (or died) and only the link can say how.
    const running = Date.now() < res.since + CONNECT_CEILING_MS;
    if (running) leaveUnsettled("CONNECT", ssid, res.since, CONNECT_CEILING_MS, true);
    act.refuse(`CONNECT ${ssid}`, `${e && e.name === "AbortError" ? `no answer within ${secsOf(CONNECT_TIMEOUT_MS)} s` : `no answer from the helper (${msgOf(e)})`}, so the outcome is unknown. ${running
      ? "It may still be joining or rolling back: LINK shows how it ends, and the wifi controls stay locked until it settles"
      : "The helper is past its own worst case, so it is no longer working on it: LINK shows how it ended"}`);
    readNet();
  };

  // `join` rather than a finished string: the warning is written at render time from the live link, because
  // this can be armed from an older closure (the re-prompt after a rejected saved password).
  const confirmConnect = ({ ssid, psk, hidden, ap }) => setConfirm({
    label: `CONNECT ${ssid}`,
    join: ssid,
    cmd: `nmcli device wifi connect "${ssid}" ifname ${iface}${hidden ? " hidden yes" : ""}${psk ? " · password on stdin" : ""}`,
    exec: () => doConnect({ ssid, psk, hidden, ap }),
  });

  const askPsk = (ssid, wep, note) => askInput({
    mode: "password", label: `PASSWORD · ${ssid}`, value: "",
    hint: note || (wep ? "WEP KEY" : "8–63 CHARACTERS"),
  });

  const startConnect = async (ap, forcePsk = false) => {
    const sec = secOf(ap);
    if (sec.enterprise) return act.refuse(`CONNECT ${ap.ssid}`, "802.1X needs a username and certificate, and the helper can only send a password");
    let psk = "";
    if (sec.needsPsk && (forcePsk || !ap.saved)) {
      const v = await askPsk(ap.ssid, sec.wep, forcePsk ? "SAVED ONE REJECTED" : null);
      if (v === null) return null;
      const bad = pskProblem(v, sec.wep);
      if (bad) return act.refuse(`CONNECT ${ap.ssid}`, bad);
      psk = v;
    }
    return confirmConnect({ ssid: ap.ssid, psk, hidden: false, ap });
  };

  // Hidden networks never appear in a scan. Secured only: the keyboard cannot commit an empty password,
  // and an open hidden network is rare enough not to earn a third prompt.
  const joinHidden = async () => {
    const ssid = await askInput({ mode: "text", label: "HIDDEN NETWORK · SSID", value: "", hint: "EXACT NAME · CASE MATTERS" });
    if (ssid === null) return;
    if (utf8len(ssid) > 32) { act.refuse("HIDDEN NETWORK", "an SSID is at most 32 bytes"); return; }
    const psk = await askPsk(ssid, false, "WPA · 8–63 CHARACTERS");
    if (psk === null) return;
    const bad = pskProblem(psk, false);
    if (bad) { act.refuse(`CONNECT ${ssid}`, bad); return; }
    confirmConnect({ ssid, psk, hidden: true, ap: null });
  };

  // forget / radio hold the same helper lock. An unanswered one may still run later, so it locks too.
  const quickFailed = (what, kind, ssid, res) => {
    if (helperAnswered(res.e)) { act.refuse(what, errOf(res.e)); return; }
    leaveUnsettled(kind, ssid, res.since, CHANGE_CEILING_MS);
    act.refuse(what, `no answer from the helper (${msgOf(res.e)}), so it may still happen. Scan again once the controls unlock`);
    readNet();
  };

  const askForget = ap => setConfirm({
    label: `FORGET ${ap.ssid}`,
    confirm: `Delete the saved profile "${ap.ssid}"? ${profile && up
      ? `The printer is on ${profile}, so nothing disconnects now. But it can no longer fall back to ${ap.ssid} if ${profile} drops`
      : `Nothing is connected now, and ${ap.ssid} will no longer be joined automatically`}${ethIdle ? ". With eth0 unused, a printer with no wifi can be reached only from its own panel" : ""}.`,
    cmd: `nmcli connection delete "${ap.ssid}"`,
    exec: async () => {
      const res = await runOp("FORGETTING", ap.ssid, () => helper.forget(ap.ssid));
      if (res.ok) { patchAps(a => (a.ssid === ap.ssid ? { ...a, known: false, saved: false } : a)); say(`FORGOT ${ap.ssid}`); }
      else quickFailed(`FORGET ${ap.ssid}`, "FORGET", ap.ssid, res);
    },
  });

  const setRadioOn = async on => {
    const label = on ? "RADIO ON" : "RADIO OFF";
    const res = await runOp(label, null, () => helper.radio(on));
    if (!res.ok) { quickFailed(label, label, null, res); return; }
    putRadio(on);
    // The list was true of a radio that is now off, and must not come back as "no networks found".
    if (!on) putScan(null);
    say(on ? "WIFI RADIO ON" : "WIFI RADIO OFF");
    readNet();
  };

  const askRadioOff = () => setConfirm({
    label: "WIFI RADIO OFF",
    confirm: `Switch the wifi radio off? ${iface} is not connected, but with the radio off the printer cannot join any network until it is switched back on here, and NetworkManager keeps it off across reboots${ethIdle ? ". No Orca, no phone, no SSH: eth0 carries nothing" : ""}. ${PANEL_LOCAL ? "This panel keeps working, because it reaches Moonraker on 127.0.0.1." : `This page loses the printer too, because it reaches Moonraker through ${API_HOST}.`}`,
    cmd: "nmcli radio wifi off",
    exec: () => setRadioOn(false),
  });

  const checkAgain = () => {
    setProbing(true);
    // Through main.jsx when mounted there, so the answer also updates st.helper (the MORE tile, other screens).
    (probeHelper || (() => helper.probe()))().then(ok => { keep.probe = !!ok; if (alive.current) setProbe(!!ok); })
      .finally(() => { if (alive.current) setProbing(false); });
  };

  // ---- LINK (both modes) -----------------------------------------------------
  const helperNet = avail && netOk;
  const headline = helperNet ? (activeAp ? activeAp.ssid : profile || "OFFLINE") : iface;
  const subline = helperNet
    ? (activeAp && profile && profile !== activeAp.ssid ? `SSID · PROFILE "${profile}"`
      : activeAp ? `SSID · FROM THE ${fmtClock(new Date(scan.at))} SCAN`
      : profile ? "PROFILE NAME · SCAN TO READ THE SSID"
      : ds.text.toUpperCase())
    : avail && nmErr && !netErr ? `NMCLI FAILED · ${nmErr}`
    : avail && !netErr ? "READING THE HELPER…"
    : "SSID UNKNOWN · MOONRAKER HAS NO SSID";
  const badge = helperNet ? (netErr ? { kind: "warn", label: "STALE" } : ds)
    : { kind: up ? "ok" : "warn", label: up ? "HAS ADDRESS" : "NO ADDRESS" };
  const ethLabel = !eth ? "none reported"
    : eth.bytes === 0 ? `eth0 · 0 B in ${Number.isFinite(ps.system_uptime) ? fmtHM(ps.system_uptime) : "this boot"}`
    : `eth0 · ${fmtBytes(Math.round(eth.bw))}/s`;
  const rows = helperNet ? [
    ["IPV4", net.ip ? `${net.ip}${net.prefix ? "/" + net.prefix : ""}` : "—"],
    ["GATEWAY", net.gateway || "—"],
    ["DNS", net.dns && net.dns.length ? net.dns.join(" ") : "—"],
    ["MAC", net.mac || "—"],
    ["SIGNAL", activeAp ? `${activeAp.signal}% · ${activeAp.band} · CH ${activeAp.chan}` : up ? "— · TAP SCAN" : "—", activeAp ? C.cool : C.mute],
    ["TRAFFIC", bw != null ? `${fmtBytes(Math.round(bw))}/s RX+TX` : "—"],
    ["ETHERNET", ethLabel, ethIdle ? C.bed : C.body],
  ] : [
    ["IPV4", mr && mr.ip ? mr.ip : "—"],
    ["MAC", mr && mr.mac ? mr.mac : "—"],
    ["TRAFFIC", bw != null ? `${fmtBytes(Math.round(bw))}/s RX+TX` : "—"],
    ["ETHERNET", ethLabel, ethIdle ? C.bed : C.body],
    ["SOURCE", mr ? "machine.system_info" : "system_info not read yet", C.mute],
  ];

  const link = (
    <Panel title={`LINK · ${iface.toUpperCase()}`}
      right={<span style={S(badgeStyle(avail ? (netErr || nmErr ? "warn" : "ok") : "off"))}>{avail ? (netErr ? "HELPER SILENT" : nmErr ? "NMCLI FAILED" : "HELPER") : "READ-ONLY"}</span>}
      bodyStyle="padding:12px 14px; gap:8px; overflow-y:auto">
      <div style={S("flex:none; display:flex; align-items:center; gap:10px; min-width:0")}>
        <span style={S(mono(F.num2, `line-height:1; flex:none; color:${up ? C.cool : C.ghost}`))}>{up ? "⌁" : "⊘"}</span>
        <span style={S(mono(F.num1, `color:${C.text}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>{headline}</span>
        {badge ? <span style={S(`margin-left:auto; flex:none; ${badgeStyle(badge.kind)}`)}>{badge.label}</span> : null}
      </div>
      <span style={S(`flex:none; ${mono(F.micro, `letter-spacing:.08em; color:${C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`)}`)}>{subline}</span>
      <div style={S("flex:none; display:flex; flex-direction:column; gap:6px; margin-top:4px")}>
        {rows.map(([k, v, c]) => <Row key={k} k={k} v={v} color={c} />)}
      </div>
      <div style={S(`margin-top:auto; flex:none; display:flex; flex-direction:column; gap:6px; padding:10px 12px; border-radius:7px; background:${C.warnBg}; border:1px solid ${C.warnLine}`)}>
        <span style={S(microLabel(C.bed))}>WHAT A WIFI CHANGE CUTS</span>
        <span style={S(`font-size:${F.label}px; color:${C.body}; line-height:1.45; text-wrap:pretty`)}>
          {PANEL_LOCAL
            ? "Not this panel, which reaches Moonraker on 127.0.0.1. Every remote client does: "
            : `This page, which reaches Moonraker through ${API_HOST || "the network"}, and every other remote client: `}
          {`Orca, phones, other browsers, SSH${spoolOnLink ? `, and Moonraker's route to Spoolman (${spoolHost} is this link's own address)` : ""}. `}
          {ethIdle ? "eth0 has carried 0 bytes since boot, so there is no other way in."
            : eth && eth.bytes > 0 ? "eth0 is carrying traffic too, so a cable may keep remote clients connected." : ""}
        </span>
      </div>
    </Panel>
  );

  // ---- READ-ONLY: no helper (or not on loopback) --------------------------------
  if (!avail) {
    const loopback = LOOPBACK.test(PAGE_HOST);
    const hint = hasHelper === null ? "Asking /helper/health…"
      : noNmcli ? "The host helper answers, but it found no nmcli, so it can neither read nor change wifi. Install NetworkManager's command-line tool on the printer (sudo apt install network-manager), restart carbon-helper, then CHECK AGAIN."
      : !loopback
        ? `This page was opened as ${PAGE_HOST || "a remote address"}. The helper answers only on loopback (nginx allows 127.0.0.1 and denies everyone else), so wifi can be changed only from the printer's own panel at http://127.0.0.1:8767/screen.html.`
        : "Nothing answered at /helper/health. Scan, connect, forget and radio need the host helper: run tools/helper/install_helper.sh on the printer, and add the /helper/ block from tools/helper/nginx-helper.conf to the Carbon site.";
    return (
      <div style={S(`height:100%; display:grid; grid-template-columns:${LEFT_W}px minmax(0,1fr); gap:${L.gap}px; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px; animation:ksFade .18s ease both`)}>
        {link}
        <Panel title="WIFI CONTROLS"
          right={<span style={S(badgeStyle(hasHelper === null ? "warn" : "off"))}>{hasHelper === null ? "CHECKING" : "UNAVAILABLE"}</span>}
          bodyStyle="padding:12px 14px; gap:10px">
          <Empty title={hasHelper === null ? "CHECKING FOR THE HOST HELPER" : noNmcli ? "NMCLI MISSING" : "READ-ONLY"} hint={hint} />
          {hasHelper === false || noNmcli ? (
            <div style={S("flex:none; display:grid; grid-template-columns:1fr 240px 1fr")}>
              <span />
              <Act act={act} label="CHECK AGAIN" sub="GET /helper/health" why={probing ? "already asking" : null} onTap={checkAgain} />
              <span />
            </div>
          ) : null}
        </Panel>
      </div>
    );
  }

  // ---- NETWORKS (helper) -------------------------------------------------------
  const now = Date.now();
  const secs = busy ? Math.max(0, Math.round((now - busy.since) / 1000)) : 0;
  const left = unsettled ? Math.max(0, Math.ceil((unsettled.until - now) / 1000)) : 0;
  const list = scanErr ? <Empty title="SCAN FAILED" hint={scanErr} />
    : radioNow === false ? <Empty title="RADIO OFF" hint="Nothing can be scanned or joined until the radio is switched back on." />
    : !scan ? <Empty title="NOT SCANNED YET" hint={`A scan takes the radio off-channel for a few seconds, and ${iface} is this printer's only link. So it runs when you tap SCAN, not every time this screen opens.`} />
    : !aps.length ? <Empty title="NO NETWORKS FOUND" hint="Hidden networks never appear in a scan. Use HIDDEN NETWORK." />
    : aps.map(ap => {
      const sec = secOf(ap);
      const lit = bars(ap.signal);
      const joinWhy = opWhy || (sec.enterprise ? "802.1X needs a username and certificate, and the helper can only send a password" : null);
      // `ap.ssid === profile` as well as `ap.active`: the in-use row is demoted when the scan goes stale, but the
      // profile the link is on is still the one the helper refuses to delete.
      const forgetWhy = opWhy || (ap.active || (profile && ap.ssid === profile) ? `the helper will not delete the profile ${iface} is connected through, because it is the only link`
        : !ap.known ? "its profile is saved under another name, and the helper deletes profiles by SSID" : null);
      return (
        <div key={ap.ssid} style={S(`flex:none; display:flex; align-items:center; gap:12px; padding:6px 12px; border-bottom:1px solid ${C.line0}; background:${ap.active ? C.rowOn : "transparent"}`)}>
          <span style={S(mono(F.val, "flex:none; width:44px; letter-spacing:-1px"))}>
            {GLYPHS.map((g, i) => <span key={i} style={S(`color:${i < lit ? (ap.active ? C.cool : C.dim) : C.ghost2}`)}>{g}</span>)}
          </span>
          <div style={S("flex:1; min-width:0; display:flex; flex-direction:column; gap:3px")}>
            <div style={S("display:flex; align-items:center; gap:8px; min-width:0")}>
              <span style={S(mono(F.val, `color:${ap.active ? C.accent : C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>{ap.ssid}</span>
              {ap.active ? <span style={S(`flex:none; ${badgeStyle("ok")}`)}>CONNECTED</span>
                : ap.saved ? <span style={S(`flex:none; ${badgeStyle("off")}`)}>SAVED</span> : null}
            </div>
            <span style={S(mono(F.micro, `color:${sec.enterprise ? C.bed : C.mute}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`))}>
              {(sec.enterprise ? [sec.label, `${ap.signal}%`, "NEEDS A LOGIN"]
                : [sec.label, ap.band, ap.chan ? `CH ${ap.chan}` : null, `${ap.signal}%`]).filter(Boolean).join(" · ")}
            </span>
          </div>
          <div style={S("flex:none; width:104px")}>
            {ap.saved || ap.known || ap.active ? <Act act={act} label="FORGET" why={forgetWhy} onTap={() => askForget(ap)} /> : null}
          </div>
          <div style={S("flex:none; width:112px")}>
            {!ap.active ? <Act act={act} label="CONNECT" tone={ap.saved ? "accent" : undefined} why={joinWhy} onTap={() => startConnect(ap)} /> : null}
          </div>
        </div>
      );
    });

  const scanWhy = opWhy || (scanning ? "a scan is already running" : radioNow === false ? "the radio is off, so switch it on first" : null);
  const hiddenWhy = opWhy || (radioNow === false ? "the radio is off, so switch it on first" : null);
  const radioOffWhy = opWhy || (radioNow === null ? "the radio state is unknown until a scan reports it"
    : profile ? `the helper refuses while ${iface} is up, because it is the only link` : null);

  // One strip for "something is running" and for "something got no answer and may still be running".
  const strip = busy ? {
    text: `${busy.label}${busy.ssid ? " " + busy.ssid : ""} · ${secs} s`,
    note: busy.label === "CONNECTING" ? (busy.prev ? `FALLS BACK TO ${busy.prev}` : `UP TO ${secsOf(CONNECT_CEILING_MS)} s`) : "",
  } : unsettled ? {
    text: `${unsettled.label}${unsettled.ssid ? " " + unsettled.ssid : ""} · NO ANSWER`,
    note: `LOCKED · ${left} s`,
  } : null;

  return (
    <div style={S(`height:100%; display:flex; flex-direction:column; gap:${L.gap}px; padding:${L.pad}px; position:relative; animation:ksFade .18s ease both`)}>
      <div style={S(`flex:1; min-height:0; display:grid; grid-template-columns:${LEFT_W}px minmax(0,1fr); gap:${L.gap}px`)}>
        {link}
        <Panel title={`NETWORKS${scan && radioNow !== false ? ` · ${aps.length}` : ""}`}
          right={<>
            {scanning ? <span style={S(badgeStyle("warn"))}>SCANNING</span>
              : scan ? <span style={S(mono(F.micro, `letter-spacing:.1em; color:${C.faint}`))}>{`SCANNED ${fmtClock(new Date(scan.at))}`}</span> : null}
            <span style={S(badgeStyle(radioNow === true ? "ok" : radioNow === false ? "warn" : "off"))}>
              {radioNow === true ? "RADIO ON" : radioNow === false ? "RADIO OFF" : "RADIO ?"}
            </span>
          </>}>
          {strip ? (
            <div style={S(`flex:none; display:flex; align-items:center; gap:12px; padding:10px 14px; background:${C.warnBg}; border-bottom:1px solid ${C.warnLine}`)}>
              <span style={S(`flex:none; width:8px; height:8px; border-radius:50%; background:${C.bed}; animation:ksPulse 1.2s ease-in-out infinite`)} />
              <span style={S(mono(F.label, `letter-spacing:.12em; color:${C.bed}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`))}>
                {strip.text}
              </span>
              <span style={S(`margin-left:auto; flex:none; ${mono(F.micro, `letter-spacing:.08em; color:${C.mute}`)}`)}>
                {strip.note}
              </span>
            </div>
          ) : null}
          <div style={S("flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column")}>{list}</div>
        </Panel>
      </div>

      <div style={S(`flex:none; display:grid; grid-template-columns:${L.fab + L.fabInset}px 1fr 1fr 1fr; gap:8px`)}>
        <span />
        <Act act={act} label="SCAN" h={TAP.primary} tone={!scan ? "accent" : undefined}
          sub={scanning ? "SCANNING…" : scan ? `LAST ${fmtClock(new Date(scan.at))}` : "NOT YET"}
          why={scanWhy} onTap={scanNow} />
        <Act act={act} label="HIDDEN NETWORK" sub="TYPE THE SSID" h={TAP.primary} why={hiddenWhy} onTap={joinHidden} />
        {radioNow === false
          ? <Act act={act} label="RADIO ON" sub="WIFI IS OFF" tone="accent" h={TAP.primary} why={opWhy} onTap={() => setRadioOn(true)} />
          : <Act act={act} label="RADIO OFF" sub={profile ? `${iface} IS UP` : "CONFIRMS FIRST"} tone="danger" h={TAP.primary} why={radioOffWhy} onTap={askRadioOff} />}
      </div>

      {/* opWhy is re-read at CONFIRM: the helper may have gone silent, nmcli failed or /net not answered
          while the box was open, and the warning in it was then written from a link state no longer known. */}
      {confirm ? (
        <ConfirmBox a={confirm.join ? { ...confirm, confirm: warnJoin(confirm.join) } : confirm} onNo={() => setConfirm(null)}
          onYes={() => { const c = confirm; setConfirm(null); if (opWhy) act.refuse(c.label, opWhy); else c.exec(); }} />
      ) : null}
    </div>
  );
}
