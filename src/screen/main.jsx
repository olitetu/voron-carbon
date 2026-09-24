// ---------------------------------------------------------------------------
// Carbon Screen — entry point for the printer's own 1024x600 touch panel.
//
// A SECOND entry beside src/main.jsx (the desktop app), sharing lib/ verbatim:
// boot(), Moonraker, Store, hh.js, ui.js. Nothing here changes the dashboard, and
// no rule is copied from it: the MORE tile's update count is lib/actions/machine.js's
// updateSummary(), the same one the UPDATES screen's header uses.
//
// Dev:  serve this build on localhost and add ?api=http://voron.local:8767
//       (Moonraker's cors_domains already allows *://localhost:*).
// Prod: served same-origin from the printer on :8767, so API_BASE is "".
// ---------------------------------------------------------------------------
import React from "react";
import { createRoot } from "react-dom/client";
import { boot } from "../lib/boot.js";
import { useStore } from "../lib/useStore.js";
import { Frame, StatusBar, Nav, Toast, Confirm, TITLES } from "./shell.jsx";
import { fmtClock } from "./vm.js";
import { S } from "../lib/ui.js";
import { C, F, mono } from "./tokens.js";
import Home from "./screens/home.jsx";
import More, { MORE_TILES } from "./screens/more.jsx";
import Mmu from "./screens/mmu.jsx";
import Move from "./screens/move.jsx";
import Temp from "./screens/temp.jsx";
import Extrude from "./screens/extrude.jsx";
import Files from "./screens/files.jsx";
import Macros from "./screens/macros.jsx";
import Fans from "./screens/fans.jsx";
import Job from "./screens/job.jsx";
import Recover from "./screens/recover.jsx";
import Console from "./screens/console.jsx";
import Camera from "./screens/camera.jsx";
import Spoolman from "./screens/spoolman.jsx";
import BedMesh from "./screens/bedmesh.jsx";
import Zoffset from "./screens/zoffset.jsx";
import FineTune from "./screens/finetune.jsx";
import Limits from "./screens/limits.jsx";
import GateMap from "./screens/gatemap.jsx";
import Ttg from "./screens/ttg.jsx";
import MmuStats from "./screens/mmustats.jsx";
import History from "./screens/history.jsx";
import Updates from "./screens/updates.jsx";
import Notifications from "./screens/notifications.jsx";
import Network from "./screens/network.jsx";
import System from "./screens/system.jsx";
import Stub from "./screens/stub.jsx";
import { helper } from "./helper.js";
import { makeActions } from "./actions.js";
// The MORE tile's { pending, unknown, packages }: the same counts the UPDATES screen's header shows.
import { updateSummary } from "../lib/actions/machine.js";
import Keyboard from "./Keyboard.jsx";

const { api, store } = boot();
// Debug handle, matching src/main.jsx's window.__carbon. `act` is attached once the
// App mounts, so a command can be exercised from devtools without a UI path --
// useful because every button on the MMU screen moves real hardware.
window.__carbonScreen = { api, store };

/**
 * Every screen, by key. BUILT is derived from it, so a registered screen can never be missing from the set
 * MORE uses for its TODO badges. Anything else go() is asked for renders an honest Stub.
 */
const SCREENS = {
  home: Home, more: More, mmu: Mmu, move: Move, temp: Temp, extrude: Extrude, files: Files, macros: Macros,
  fans: Fans, job: Job, recover: Recover,
  console: Console, camera: Camera, spoolman: Spoolman, bedmesh: BedMesh, zoffset: Zoffset, finetune: FineTune,
  limits: Limits, gatemap: GateMap, ttg: Ttg, mmustats: MmuStats, history: History, updates: Updates,
  notifications: Notifications, network: Network, system: System,
};
const BUILT = new Set(Object.keys(SCREENS));

const MORE_KEYS = new Set(MORE_TILES.map(t => t[0]));

/** Undismissed announcements, and how many of them Moonraker marks priority "high" (the status-bar badge). */
function announcementCounts(a) {
  const live = (a && Array.isArray(a.entries) ? a.entries : []).filter(e => e && !e.dismissed);
  return { announcements: live.length, announcementsHigh: live.filter(e => e.priority === "high").length };
}

/**
 * A screen that throws while rendering must not take the shell with it. With no boundary React unmounts the
 * WHOLE tree, and the status bar is where STOP lives (this printer sets confirm_estop = True; see shell.jsx).
 * App keys it by screen, so leaving the broken screen clears the error.
 */
class ScreenBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { this.props.onError(`${this.props.title} screen failed: ${(error && error.message) || error}`); }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return <Stub title={this.props.title} tag="SCREEN ERROR"
      plan={`This screen stopped with an error: ${(e && e.message) || e}. STOP, the status bar and every other screen still work.`} />;
  }
}

// Around the whole app. ScreenBoundary keeps a crash inside one screen; anything above it (the shell, the status
// bar, App itself) would unmount the tree and leave the panel black. Hand over to safe.html instead.
class RootBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    const why = `crashed: ${(error && error.message) || error}`.slice(0, 200);
    setTimeout(() => location.replace("safe.html?from=screen&why=" + encodeURIComponent(why)), 1500);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div style={{ position: "fixed", inset: 0, background: "#06080b", color: "#f0b429", display: "flex",
      alignItems: "center", justifyContent: "center", font: "14px 'JetBrains Mono', monospace", letterSpacing: ".16em" }}>
      CARBON SCREEN STOPPED · OPENING SAFE MODE…</div>;
  }
}

function App() {
  const st = useStore(store);
  // The boot watchdog in screen.html stands down once the first frame is on the panel.
  React.useEffect(() => { window.__carbonScreenUp = true; }, []);
  const [screen, setScreen] = React.useState("home");
  const [navOpen, setNavOpen] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const [ask, setAsk] = React.useState(null);
  const [clock, setClock] = React.useState(() => fmtClock(new Date()));
  const [meta, setMeta] = React.useState(null);
  const toastTimer = React.useRef(null);

  const say = React.useCallback(msg => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Command log. The action layer writes every command and every failure here, so
  // there is a record after the 2.6 s toast has gone -- the export had only the
  // toast, fired BEFORE the command ran, and nothing that could show a failure.
  const log = React.useCallback((message, kind) => {
    store.update(st => ({
      screenLog: [{ t: Date.now(), message: String(message), kind: kind || "info" }]
        .concat(st.screenLog || []).slice(0, 300),
    }));
    if (kind === "err" || kind === "warn") say(String(message));
  }, [say]);

  const act = React.useMemo(() => makeActions({ api, store, log }), [log]);
  React.useEffect(() => { window.__carbonScreen.act = act; }, [act]);

  // ---- on-screen keyboard -----------------------------------------------------
  // Promise-based so a caller reads like a prompt:
  //     const v = await askInput({ mode: "numeric", label: "NOZZLE", max: 300 });
  //     if (v !== null) act.run(`M104 S${v}`);
  const [kb, setKb] = React.useState(null);
  const askInput = React.useCallback(req => new Promise(resolve => {
    setKb({ req, resolve });
  }), []);
  const kbCommit = v => { const k = kb; setKb(null); if (k) k.resolve(v); };
  const kbCancel = () => { const k = kb; setKb(null); if (k) k.resolve(null); };

  const go = React.useCallback(k => { setScreen(k); setNavOpen(false); }, []);

  // RECOVER opens by itself when Happy Hare pauses a print — the moment KlipperScreen's HH edition pops its
  // dialog. Once per pause (keyed on the reason), so walking away to another screen is respected; a NEW reason
  // during the same pause (HH re-checks and finds another problem) opens it again, because that is new news.
  const hhPause = (st.raw.mmu || {}).is_paused ? String((st.raw.mmu || {}).reason_for_pause || "paused") : "";
  const lastPause = React.useRef("");
  React.useEffect(() => {
    if (!hhPause) { lastPause.current = ""; return; }
    if (hhPause !== lastPause.current) { lastPause.current = hhPause; go("recover"); }
  }, [hhPause, go]);

  // Is the host helper installed? Probed once; every control it would power stays
  // hidden until this answers, so the panel never offers something that will fail.
  // One probe path for the whole app: the start-up probe and NETWORK's CHECK AGAIN both land in the store, so the
  // MORE tile's "read-only" and every helper-powered control follow a helper installed after boot.
  const probeHelper = React.useCallback(() => helper.probe().then(ok => {
    store.set({ helper: ok, helperBacklight: helper.backlight, helperCanBlank: helper.canBlank });
    return ok;
  }), []);
  React.useEffect(() => { probeHelper(); }, [probeHelper]);

  // SCREEN OFF (SYSTEM screen): the helper's `xset dpms force off`. X wakes the panel on any touch by itself,
  // and that touch would also reach the page, so a black overlay goes up FIRST and swallows the waking tap.
  // It stays until 400 ms after the finger lifts (ConfirmBox's arm delay), so no part of that tap, pointerup,
  // the synthesised mouse events or the click, can land on STOP or anything else under it.
  const [blanked, setBlanked] = React.useState(false);
  const wakeTimer = React.useRef(null);
  const screenOff = React.useCallback(async () => {
    setBlanked(true);
    try { await helper.blank(true); }
    catch (e) { setBlanked(false); log(`SCREEN OFF failed: ${(e && e.message) || e}`, "err"); }
  }, [log]);
  const wake = React.useCallback(() => {
    helper.blank(false).catch(() => { /* X has already woken it on the touch */ });
  }, []);
  const unblank = React.useCallback(() => {
    if (wakeTimer.current) clearTimeout(wakeTimer.current);
    wakeTimer.current = setTimeout(() => { wakeTimer.current = null; setBlanked(false); }, 400);
  }, []);
  React.useEffect(() => () => { if (wakeTimer.current) clearTimeout(wakeTimer.current); }, []);
  // Anything that needs someone at the printer turns the panel back on: an MMU pause, a pause, an error.
  const printState = (st.raw.print_stats || {}).state || "";
  const needsEyes = !!hhPause || printState === "paused" || printState === "error" || st.klippy === "shutdown";
  React.useEffect(() => {
    if (needsEyes && blanked) { wake(); setBlanked(false); }
  }, [needsEyes, blanked, wake]);

  // clock, 1/s — the only always-running timer. The export ticked its whole tree at 120 ms.
  React.useEffect(() => {
    const t = setInterval(() => setClock(fmtClock(new Date())), 1000);
    return () => clearInterval(t);
  }, []);

  // Side channels the shell needs but boot() does not fetch: file count, history totals,
  // update status, announcements, system info. One shot each, refreshed on the events that matter.
  const filename = (st.raw.print_stats || {}).filename || "";
  React.useEffect(() => {
    if (!filename) { setMeta(null); return; }
    let alive = true;
    api.fileMeta(filename).then(m => { if (alive) setMeta(m); }).catch(() => { if (alive) setMeta(null); });
    return () => { alive = false; };
  }, [filename]);

  // Each lands on its own, and only once the socket is actually up.
  //
  // Two bugs lived here. First they were behind one Promise.all, so the slowest
  // (machine.update.status — seconds on this host) held back the fastest and every tile read "—".
  // Then they fired on mount, before api.connect() had a websocket, so all five rejected and
  // nothing retried because the only dep was filesVersion, which never changes on an idle printer.
  // Hence the explicit `ready` gate in the deps.
  const ready = st.connected && st.klippy === "ready";
  React.useEffect(() => {
    if (!ready) return;
    let alive = true;
    const put = patch => { if (alive) store.set(patch); };
    api.dirInfo("gcodes", false)
      .then(d => put({ filesCount: d && d.files ? d.files.length : null }))
      .catch(() => put({ filesCount: null }));
    api.historyTotals()
      .then(t => put({ historyTotals: (t && (t.job_totals || t)) || null }))
      .catch(() => {});
    return () => { alive = false; };
  }, [ready, st.filesVersion]);

  // machine.system_info is Moonraker's own and answers with Klipper down -- the moment the UPDATES screen needs
  // service_state to say who owns the panel, and NETWORK its addresses. So it is gated on the socket, and
  // re-read on every Klippy transition (a restart changes service_state), as the ready gate used to do.
  React.useEffect(() => {
    if (!st.connected) return;
    let alive = true;
    api.systemInfo()
      .then(s => { if (alive) store.set({ systemInfo: (s && (s.system_info || s)) || null }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [st.connected, st.klippy]);

  // Announcements and update status are Moonraker's own components, so they are gated on the SOCKET, not on
  // Klippy: they answer while Klipper is down, which is when an update notice matters most, and the effect
  // re-runs on every reconnect. Between connects they follow Moonraker's events instead of going stale when
  // something is dismissed, snoozed, woken, refreshed or updated -- here, in Mainsail, or by Moonraker's own
  // timers. Both reads are read-only; machine.update.status with refresh=false returns the cached state.
  React.useEffect(() => {
    if (!st.connected) return;
    let alive = true;
    // include_dismissed defaults to TRUE in announcements.py (get_boolean("include_dismissed", True)), which
    // counted dismissed and snoozed entries as unread.
    const readAnnouncements = () => api.rpc("server.announcements.list", { include_dismissed: false })
      .then(a => { if (alive) store.set(announcementCounts(a)); })
      .catch(() => {});
    const putUpdates = u => { if (alive) store.set({ updateStatus: updateSummary(u) }); };
    const readUpdates = () => api.updateStatus(false).then(putUpdates).catch(() => {});
    readAnnouncements();
    readUpdates();
    const offs = [
      // moonraker.js emits these under their method names (its _notify default case).
      ...["notify_announcement_update", "notify_announcement_dismissed", "notify_announcement_wake"]
        .map(ev => api.on(ev, readAnnouncements)),
      // notify_update_refreshed carries the same payload machine.update.status returns, so use it directly.
      api.on("update_refreshed", u => (u && u.version_info ? putUpdates(u) : readUpdates())),
      // An update or recover streams notify_update_response lines; the last one has complete: true.
      api.on("notify_update_response", r => { if (r && r.complete) readUpdates(); }),
    ];
    return () => { alive = false; offs.forEach(off => off()); };
  }, [st.connected]);

  // Objects boot.js does not cover, added to the SAME subscription rather than
  // replacing it — Moonraker.subscribe() does `Object.assign(this.subs, objects)`
  // and then resubscribes, so this is additive and survives a klippy restart.
  //
  //   mmu_machine     — static unit config (vendor "ERCF", version 2.0, num_gates, has_bypass)
  //   mmu_leds unit0  — HH's own LED object. boot.js auto-subscribes by object PREFIX and
  //                     "mmu_leds" is not in its list, so without this the MMU LED mode
  //                     never arrives and an LED control would render stale forever.
  //   manual_probe    — is_active is the only honest gate for a Z-calibrate wizard: Klipper
  //                     registers TESTZ/ACCEPT/ABORT only DURING a session, so a capability
  //                     check for them is false exactly when the wizard is needed.
  React.useEffect(() => {
    if (st.klippy !== "ready") return;
    let alive = true;
    api.subscribe({ mmu_machine: null, "mmu_leds unit0": null, manual_probe: null })
      .then(status => { if (alive && status) store.mergeStatus(status); })
      .catch(() => {});
    return () => { alive = false; };
  }, [st.klippy]);

  // --- machine-wide actions. Both are guarded: this printer sets confirm_estop = True.
  const onEstop = () => setAsk({
    title: "EMERGENCY STOP", danger: true, cmd: "printer.emergency_stop",
    text: "Halt the printer immediately? Heaters and motors stop and Klipper shuts down — a firmware restart is needed afterwards.",
    run: () => api.emergencyStop().then(() => say("EMERGENCY STOP")).catch(e => say(e.message)),
  });
  const onFirmwareRestart = () => setAsk({
    title: "FIRMWARE RESTART", danger: true, cmd: "FIRMWARE_RESTART",
    text: "Restart the Klipper firmware and reconnect?",
    run: () => api.firmwareRestart().then(() => say("FIRMWARE_RESTART")).catch(e => say(e.message)),
  });

  // KlipperScreen's titlebar temperatures are tappable to set a target, on every
  // panel. Restore that: it is the fastest path to the thing people most often
  // want, and it is the first real caller of the keyboard.
  const setTarget = React.useCallback(async which => {
    const e = st.raw.extruder || {}, b = st.raw.heater_bed || {};
    const spec = which === "nozzle"
      ? { label: "NOZZLE TARGET", value: Math.round(e.target || 0), max: 300, cmd: v => `M104 S${v}` }
      : { label: "BED TARGET", value: Math.round(b.target || 0), max: 120, cmd: v => `M140 S${v}` };
    const v = await askInput({
      mode: "numeric", label: spec.label, value: spec.value, unit: "\u00b0C",
      min: 0, max: spec.max, allowNegative: false,
      hint: "0 turns it off",
    });
    if (v === null) return;
    act.run(spec.cmd(Math.round(Number(v))));
  }, [st.raw.extruder, st.raw.heater_bed, askInput, act]);

  const parent = MORE_KEYS.has(screen) ? "more" : null;
  const Screen = SCREENS[screen] || null;

  return (
    <Frame>
      <StatusBar st={st} meta={meta} clock={clock} go={go} onEstop={onEstop} onFirmwareRestart={onFirmwareRestart} onTemp={setTarget} />
      <div style={{ flex: 1, minHeight: 0, position: "relative", zIndex: 4, overflow: "hidden" }}>
        {Screen
          ? (
            <ScreenBoundary key={screen} title={TITLES[screen] || screen.toUpperCase()} onError={m => log(m, "err")}>
              <Screen st={st} meta={meta} go={go} say={say} api={api} act={act} askInput={askInput} built={BUILT} probeHelper={probeHelper} screenOff={screenOff} />
            </ScreenBoundary>
          )
          : <Stub title={TITLES[screen] || screen.toUpperCase()} />}
      </div>
      <Nav screen={screen} open={navOpen} setOpen={setNavOpen} go={go} parent={parent} />
      <Toast text={toast} />
      <Confirm ask={ask} onNo={() => setAsk(null)} onYes={() => { const a = ask; setAsk(null); if (a && a.run) a.run(); }} />
      {kb ? <Keyboard req={kb.req} onCommit={kbCommit} onCancel={kbCancel} /> : null}
      {blanked ? (
        <div role="button" aria-label="Wake the screen"
          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); wake(); }}
          onPointerUp={e => { e.stopPropagation(); unblank(); }}
          onPointerCancel={unblank}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#000", touchAction: "none",
            display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 28 }}>
          <span style={S(mono(F.micro, `letter-spacing:.2em; color:${C.faint}`))}>TAP TO WAKE</span>
        </div>
      ) : null}
    </Frame>
  );
}

createRoot(document.getElementById("screen")).render(<RootBoundary><App /></RootBoundary>);
