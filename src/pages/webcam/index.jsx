// WEBCAM page — full-size viewing for every camera Moonraker knows about.
//
// None of the stream plumbing is re-implemented here: streamUrl / camTransform / fpsFromState /
// CLIENT_KEY come from the dashboard's adapter, which already documents why the delivered rate has
// to be MEASURED out of ustreamer's /state (an <img> on multipart/x-mixed-replace fires no per-frame
// load event, and `target_fps` is the configured rate, not what arrives).
import React from "react";
import { Panel, Btn, Chip, Label, Val, Row, T, mono, fmtBytes } from "../../lib/design.jsx";
import { S } from "../../lib/ui.js";
import { useStore, usePersisted } from "../../lib/useStore.js";
import { streamUrl, camTransform, fpsFromState, fpsTrack, CLIENT_KEY } from "../dashboard/adapters/webcam.js";

const NO_CAMS = [];                                  // stable identity: the poll effect must not re-arm every render
const IDENT = { rot: 0, fh: false, fv: false };      // "as Moonraker configured it"
const SNAP_TIMEOUT_MS = 15000;
// The webcam list arrives with hydration, a few hundred ms after `connected` flips. Accusing the
// user of having configured no camera in that window is wrong, and Orca reloads this page on nearly
// every preset change — so the accusation flashed constantly.
const HYDRATE_GRACE_MS = 2000;

/** Not every install fills in `uid`; fall back to the name so persisted keys stay stable. */
const camId = c => String((c && (c.uid || c.name)) || "cam");

/** ustreamer's /state sits beside the stream: "/webcam/?action=stream" -> "/webcam/state". */
function stateUrl(cam, base) {
  const b = String((cam && cam.stream_url) || "").split("?")[0].replace(/\/$/, "");
  return b ? (/^https?:/i.test(b) ? b : (base || "") + b) + "/state" : "";
}

/** Snapshot endpoint. Moonraker normally supplies it; derive it from the stream when it does not. */
function snapUrl(cam, base) {
  const raw = (cam && cam.snapshot_url) || String((cam && cam.stream_url) || "").replace("action=stream", "action=snapshot");
  return raw ? (/^https?:/i.test(raw) ? raw : (base || "") + raw) : "";
}

/** Frame ratio: the camera's declared aspect_ratio, else what it is actually capturing, else 4:3. */
function aspect(cam, camState) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String((cam && cam.aspect_ratio) || ""));
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return [Number(m[1]), Number(m[2])];
  const r = camState && camState.source && camState.source.resolution;
  if (r && r.width > 0 && r.height > 0) return [r.width, r.height];
  return [4, 3];
}

/** The local override is a DELTA on Moonraker's flags, so RESET means "back to the configured view". */
function effective(cam, d) {
  // Number() on the delta too: this half comes back from localStorage, where it may be anything.
  return {
    rotation: ((((Number(cam.rotation) || 0) + (Number(d.rot) || 0)) % 360) + 360) % 360,
    flip_horizontal: !!cam.flip_horizontal !== !!d.fh,
    flip_vertical: !!cam.flip_vertical !== !!d.fv,
  };
}

/** Delivered vs captured FPS, viewers, and the colour + wording the indicator should carry. */
function status(camState, mode, track) {
  const raw = fpsFromState(camState);
  // Only a live stream has CURRENT numbers. Both /state polls (boot's and this page's) stop while the
  // tab is hidden, and a still or a released stream leaves the last poll sitting there — reporting
  // that as the rate would claim a frame rate for a connection that is no longer open.
  // `track` adds the other half of that rule (see fpsTrack): a connection that has only just opened
  // is reported by ustreamer at a fraction of its rate — 0 fps for the first sample — so the first
  // sample is not a rate either, and a zero is only a stall once it has held for three of them.
  const live = mode === "live";
  const delivered = live && !track.settling ? raw.delivered : null;
  const captured = live && !track.stale ? raw.captured : null;
  const clients = live && !track.stale ? raw.clients : null;
  const stalled = delivered === 0 && track.stalled;
  // Well under what the sensor produces is bandwidth starvation, not a slow camera: ustreamer splits
  // the pipe between clients and this host is on WiFi. Amber is the design's word for that. A zero is
  // never starvation — it is the warm-up or a dead stream, and both have their own wording.
  const starved = delivered !== null && delivered > 0 && captured !== null && captured > 0 && track.starving;
  const s = { delivered, captured, clients, starved, stalled };
  if (mode === "disabled") return Object.assign(s, { label: "DISABLED", colour: T.ghost });
  if (mode === "offline") return Object.assign(s, { label: "OFFLINE", colour: T.faint });
  if (mode === "paused") return Object.assign(s, { label: "PAUSED", colour: T.faint });
  if (mode === "still") return Object.assign(s, { label: "STILL", colour: T.info });
  if (mode === "error") return Object.assign(s, { label: "STREAM LOST", colour: T.err });
  if (delivered === null) return Object.assign(s, { label: "LIVE", colour: T.accent });   // warming up, or no /state
  if (delivered === 0) return Object.assign(s, stalled ? { label: "STALLED · 0 FPS", colour: T.err } : { label: "LIVE", colour: T.accent });
  return Object.assign(s, { label: `LIVE · ${delivered} FPS`, colour: starved ? T.warn : T.accent });
}

/** Adds a line to the shared console log (same shape DashboardLogic.log writes). */
function pushLog(store, message, type) {
  if (!store) return;
  const entry = { time: Date.now() / 1000, message: String(message), type: type || "info", local: true };
  store.set({ log: [entry].concat(store.state.log || []).slice(0, 2000) });
}

// The design's viewfinder brackets, reused so the page reads as the same instrument as the dashboard.
const CORNERS = [
  `left:8px; top:8px; border-left:2px solid ${T.accent}; border-top:2px solid ${T.accent}`,
  `right:8px; top:8px; border-right:2px solid ${T.accent}; border-top:2px solid ${T.accent}`,
  `left:8px; bottom:8px; border-left:2px solid ${T.accent}; border-bottom:2px solid ${T.accent}`,
  `right:8px; bottom:8px; border-right:2px solid ${T.accent}; border-bottom:2px solid ${T.accent}`,
];
const HATCH = "repeating-linear-gradient(135deg,#0a0e14 0px,#0a0e14 9px,#0c1119 9px,#0c1119 18px)";

function Stat({ k, v, color = T.text, title }) {
  // The value is ellipsised at narrow widths (SERVICE = "mjpegstreamer-adaptive" needs 155 px in a
  // 94 px minimum column), so it always carries a tooltip — otherwise the truncation hides it for good.
  return <div title={title || (typeof v === "string" ? v : undefined)} style={S("min-width:0")}>
    <Label>{k}</Label>
    <div style={S("margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")}><Val size={11.5} color={color}>{v}</Val></div>
  </div>;
}

function Cam({ cam, camState, api, store, visible, connected, single, total, focused, onFocus }) {
  const id = camId(cam);
  const [oriRaw, setOri] = usePersisted("webcam.ori." + id, IDENT);
  const [fit, setFit] = usePersisted("webcam.fit." + id, "contain");
  const [shot, setShot] = React.useState(null);        // { url, at, bytes } — a still, shown INSTEAD of the stream
  const [err, setErr] = React.useState("");
  const [lost, setLost] = React.useState(false);       // the <img> reported the stream connection died
  const [retry, setRetry] = React.useState(0);         // cache-buster so RETRY re-requests rather than replaying the failure
  const [busy, setBusy] = React.useState(false);
  const [fs, setFs] = React.useState(false);
  const [box, setBox] = React.useState(null);          // measured frame size; the rotation maths needs real pixels
  const boxRef = React.useRef(null);
  const imgRef = React.useRef(null);
  const shotRef = React.useRef("");
  const aliveRef = React.useRef(true);
  const abortRef = React.useRef(null);

  // React hands a ref callback null on unmount; keep the node anyway, the cleanup below needs it.
  const holdImg = React.useCallback(el => { if (el) imgRef.current = el; }, []);

  const ori = oriRaw && typeof oriRaw === "object" ? oriRaw : IDENT;   // a hand-edited localStorage key must not crash us
  const enabled = cam.enabled !== false && !!cam.stream_url;
  // A still is LOCAL data: it stays valid (and stays labelled STILL) when Moonraker drops, so it is
  // tested before `connected`.
  const mode = !enabled ? "disabled" : shot ? "still" : !connected ? "offline" : !visible ? "paused" : lost ? "error" : "live";
  // Clearing the src is the point: an MJPEG connection left open keeps taking its share of
  // ustreamer's bandwidth from whoever IS watching. A still frees it too, so it is not just cosmetic.
  const src = mode === "live" ? streamUrl(cam, api.base) + (retry ? "&r=" + retry : "") : "";
  // Keyed by camera + stream URL, so releasing the stream or hitting RETRY restarts the warm-up.
  const sx = status(camState, mode, fpsTrack("page." + id, src, camState));

  // Measure by hand as well as by ResizeObserver: RO callbacks are delivered on a RENDERING STEP,
  // which a webview that is not being composited never runs (verified here — rAF did not fire either).
  // Without the manual read `box` stays null, the geometry falls back to width/height:100% and a
  // 90°/270° camera is rotated OUT of its own frame and clipped. The layout effect also re-measures
  // after rotate/fullscreen change the frame's shape, before the browser paints it.
  const measure = React.useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) setBox(p => (p && p.w === r.width && p.h === r.height ? p : { w: r.width, h: r.height }));
  }, []);
  React.useLayoutEffect(measure);
  React.useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  React.useEffect(() => {
    const onFs = () => {
      const cur = document.fullscreenElement || document.webkitFullscreenElement || null;
      setFs(!!cur && cur === boxRef.current);
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => { document.removeEventListener("fullscreenchange", onFs); document.removeEventListener("webkitfullscreenchange", onFs); };
  }, []);

  // Unmount: drop the src by hand. Removing the node usually aborts the request, but "usually" is not
  // good enough when the cost is the visible page's frame rate.
  React.useEffect(() => {
    aliveRef.current = true;                           // set on mount, not just at init, so a remount re-arms it
    return () => {
      aliveRef.current = false;
      if (imgRef.current) imgRef.current.removeAttribute("src");
      if (shotRef.current) URL.revokeObjectURL(shotRef.current);
      if (abortRef.current) abortRef.current.abort();   // a snapshot in flight holds a socket open
    };
  }, []);

  // A reconnect, or the tab coming back, is a fresh chance for the stream — do not keep showing the
  // old failure. Deliberately not keyed on `lost` itself: that would re-arm the stream the instant it
  // failed, and the retry would loop.
  React.useEffect(() => { if (connected && visible && enabled) setLost(false); }, [connected, visible, enabled]);

  async function snap() {
    const url = snapUrl(cam, api.base);
    if (!url || busy) return;
    // A snapshot is served from the NEXT captured frame, so a camera that has stopped delivering
    // never answers — and the fetch would sit there with the button stuck on "CAPTURING…".
    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), SNAP_TIMEOUT_MS) : 0;
    abortRef.current = ac;
    setBusy(true); setErr("");
    try {
      const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(),   // ustreamer serves these cacheable
        ac ? { signal: ac.signal } : undefined);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = await r.blob();
      // Unmounted while the fetch was in flight: the cleanup has already run, so an object URL made
      // now would never be revoked. Drop the blob instead.
      if (!aliveRef.current) return;
      if (shotRef.current) URL.revokeObjectURL(shotRef.current);
      shotRef.current = URL.createObjectURL(b);
      setShot({ url: shotRef.current, at: Date.now(), bytes: b.size });
      pushLog(store, `Webcam ${cam.name}: snapshot captured (${fmtBytes(b.size)})`, "info");
    } catch (e) {
      // "Failed to fetch" tells the user nothing. A TypeError from fetch is the network/CORS case —
      // it is what the dev server (a different origin from the camera) hits, since ustreamer and
      // nginx BOTH add Access-Control-Allow-Origin to a snapshot and a doubled header is rejected.
      const m = ac && ac.signal.aborted ? `no frame within ${SNAP_TIMEOUT_MS / 1000} s`
        : e instanceof TypeError ? "the camera did not answer (network or CORS)"
          : ((e && e.message) || String(e));
      if (!aliveRef.current) return;
      setErr("Snapshot failed — " + m);
      pushLog(store, `Webcam ${cam.name}: snapshot failed — ${m}`, "err");
    } finally {
      if (timer) clearTimeout(timer);
      if (abortRef.current === ac) abortRef.current = null;
      if (aliveRef.current) setBusy(false);
    }
  }

  function clearShot() {
    if (shotRef.current) { URL.revokeObjectURL(shotRef.current); shotRef.current = ""; }
    setShot(null);
  }

  // Orca's WKWebView does not always expose the Fullscreen API, and a button that can only ever log
  // "not available" is a dead control — so it is disabled up front rather than after the click.
  const fsOk = typeof document === "undefined" ? false
    : document.fullscreenEnabled !== undefined ? !!document.fullscreenEnabled
      : document.webkitFullscreenEnabled !== undefined ? !!document.webkitFullscreenEnabled
        : !!(typeof Element !== "undefined" && Element.prototype
          && (Element.prototype.requestFullscreen || Element.prototype.webkitRequestFullscreen));

  // Fullscreen API on the frame element — never a new window: Orca's OnNewWindow handler ejects the
  // user into their system browser and cancels the navigation.
  async function toggleFs() {
    const el = boxRef.current;
    if (!el) return;
    const open = document.fullscreenElement || document.webkitFullscreenElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      // `open === el` matters with several cameras: pressing FULLSCREEN on the second one while the
      // first is expanded should switch to it, not just collapse the first.
      if (open === el) { if (exit) await exit.call(document); }
      else if (req) await req.call(el);
      else pushLog(store, "Fullscreen is not available in this webview", "warn");
    } catch (e) {
      // An embedded webview may refuse the API outright; say so rather than doing nothing visible.
      pushLog(store, `Fullscreen refused — ${(e && e.message) || e}`, "err");
    }
  }

  const setDelta = patch => setOri(p => Object.assign({}, (p && typeof p === "object") ? p : IDENT, patch));
  const dirty = !!(ori.rot || ori.fh || ori.fv);

  // ---- frame geometry
  // A CSS rotate() does not touch the layout box, so a 90°/270° camera would be letter-boxed into the
  // wrong frame and clipped. The frame's ratio is inverted for those and the image is sized from the
  // frame's measured pixels (swapped) so it lands exactly inside once rotated — which also stays
  // correct in fullscreen, where the UA overrides the frame's aspect-ratio with the screen's.
  const eff = effective(cam, ori);
  const [aw, ah] = aspect(cam, camState);
  const swap = eff.rotation === 90 || eff.rotation === 270;
  const tf = camTransform(eff);
  let imgStyle;
  if (box && box.w > 0 && box.h > 0) {
    const pick = fit === "cover" ? Math.max : Math.min;
    const bw = swap ? box.h : box.w, bh = swap ? box.w : box.h;
    const w = pick(bw, bh * aw / ah);
    imgStyle = `position:absolute; left:50%; top:50%; width:${w.toFixed(1)}px; height:${(w * ah / aw).toFixed(1)}px;`
      + ` object-fit:${fit}; transform:translate(-50%,-50%)${tf === "none" ? "" : " " + tf}`;
  } else {
    imgStyle = `position:absolute; inset:0; width:100%; height:100%; object-fit:${fit}; transform:${tf}`;
  }

  const res = camState && camState.source && camState.source.resolution
    ? `${camState.source.resolution.width} × ${camState.source.resolution.height}` : "—";
  const enc = camState && camState.encoder
    ? String(camState.encoder.type || "?") + (camState.encoder.quality !== undefined ? ` · Q${camState.encoder.quality}` : "") : "—";
  const placeholder = mode === "disabled" ? "CAMERA DISABLED"
    : mode === "offline" ? "PRINTER UNREACHABLE"
      : mode === "error" ? "STREAM UNAVAILABLE"
        : mode === "paused" ? "STREAM RELEASED · TAB HIDDEN" : "MJPEG STREAM";

  return (
    <Panel flat style="overflow:hidden" bodyStyle="display:flex; flex-direction:column"
      title={String(cam.name || "CAMERA").toUpperCase()}
      right={<>
        <Chip color={sx.colour} pulse={mode === "live" && !sx.stalled}>{sx.label}</Chip>
        {total > 1 && <Btn small kind="ghost" onClick={onFocus}>{focused ? "SHOW ALL" : "FOCUS"}</Btn>}
      </>}>

      <div ref={boxRef} style={S(`position:relative; overflow:hidden; display:flex; align-items:center; justify-content:center; border-bottom:1px solid ${T.line}; `
        + (fs ? `background:${T.bg}` : `aspect-ratio:${swap ? `${ah}/${aw}` : `${aw}/${ah}`}; ${single ? "max-height:70vh; " : ""}background:${HATCH}`))}>
        {/* An <img> on multipart/x-mixed-replace fires `error` when the connection dies — the only
            signal there is that the stream stopped, since it fires no per-frame load event. Without
            it the chip would keep claiming LIVE over a broken-image glyph. */}
        {src ? <img ref={holdImg} src={src} alt="" style={S(imgStyle)}
          onError={() => { setLost(true); pushLog(store, `Webcam ${cam.name}: stream connection lost`, "err"); }} /> : null}
        {shot ? <img src={shot.url} alt="" style={S(imgStyle)} /> : null}
        {/* T.mute, not the design's T.ghost placeholder colour: measured 2.0:1 against this frame,
            and unlike the mockup's inert "MJPEG STREAM" this line is the only thing telling the user
            WHY there is no picture. T.mute is 4.2:1 and still reads as muted. */}
        {!src && !shot ? <span style={S(mono(10, `color:${T.mute}; letter-spacing:.14em; text-align:center; padding:0 16px`))}>{placeholder}</span> : null}

        <div style={S("position:absolute; inset:8px; border:1px solid rgba(255,90,51,.18); pointer-events:none")} />
        {CORNERS.map((c, i) => <div key={i} style={S(`position:absolute; width:14px; height:14px; pointer-events:none; ${c}`)} />)}

        {shot ? <div style={S(`position:absolute; left:0; right:0; top:0; padding:6px 10px; display:flex; align-items:center; gap:10px; background:rgba(6,8,11,.82); border-bottom:1px solid ${T.line}`)}>
          <span style={S(mono(9, `letter-spacing:.12em; color:${T.info}`))}>
            {`STILL · ${new Date(shot.at).toLocaleTimeString()} · ${fmtBytes(shot.bytes)}`}
          </span>
          <div style={S("margin-left:auto")}><Btn small onClick={clearShot}>RESUME STREAM</Btn></div>
        </div> : null}

        {fs ? <div style={S("position:absolute; left:0; right:0; bottom:0; padding:8px 12px; display:flex; align-items:center; gap:10px; background:linear-gradient(transparent,rgba(6,8,11,.9))")}>
          <span style={S(mono(10, `letter-spacing:.16em; color:${T.dim}`))}>{String(cam.name || "CAMERA").toUpperCase()}</span>
          <Chip color={sx.colour} pulse={mode === "live" && !sx.stalled}>{sx.label}</Chip>
          <div style={S("margin-left:auto")}><Btn small onClick={toggleFs}>EXIT FULLSCREEN</Btn></div>
        </div> : null}
      </div>

      <Row gap={6} style={`padding:8px 12px; flex-wrap:wrap; border-bottom:1px solid ${T.line}`}>
        {mode === "error" ? <Btn small kind="accent" onClick={() => { setRetry(n => n + 1); setLost(false); }}
          title="reconnect to the stream">RETRY</Btn> : null}
        <Btn small onClick={snap} disabled={!enabled || busy || !connected}
          title={!connected ? "the printer is unreachable" : "fetch one frame and hold it"}>{busy ? "CAPTURING…" : "SNAPSHOT"}</Btn>
        <Btn small onClick={toggleFs} disabled={!enabled || !fsOk}
          title={fsOk ? "expand the frame to the whole screen" : "fullscreen is not available in this webview"}>{fs ? "EXIT FULL" : "FULLSCREEN"}</Btn>
        <Btn small onClick={() => setFit(fit === "cover" ? "contain" : "cover")}
          title={fit === "cover" ? "cropping to fill the frame" : "whole frame, letterboxed"}>{fit === "cover" ? "FILL" : "FIT"}</Btn>
        <div style={S(`flex:none; width:1px; height:16px; background:${T.line}; margin:0 2px`)} />
        <Btn small onClick={() => setDelta({ rot: ((Number(ori.rot) || 0) + 90) % 360 })} title="rotate 90° — this browser only, Moonraker is not changed">{"↻ 90°"}</Btn>
        <Btn small kind={ori.fh ? "accent" : "default"} onClick={() => setDelta({ fh: !ori.fh })} title="mirror horizontally — this browser only">{"⇄ H"}</Btn>
        <Btn small kind={ori.fv ? "accent" : "default"} onClick={() => setDelta({ fv: !ori.fv })} title="mirror vertically — this browser only">{"⇅ V"}</Btn>
        {dirty ? <Btn small kind="warn" onClick={() => setOri(IDENT)} title="back to Moonraker's own flip/rotation">RESET</Btn> : null}
      </Row>

      <div style={S("display:grid; grid-template-columns:repeat(auto-fit,minmax(94px,1fr)); gap:9px 12px; padding:10px 12px")}>
        <Stat k="DELIVERED" color={sx.colour} title={`measured for this client (key=${CLIENT_KEY}) — target_fps is the configured rate, not what arrives`}
          v={sx.delivered === null ? "—" : sx.delivered + " FPS"} />
        <Stat k="CAPTURED" v={sx.captured === null ? "—" : sx.captured + " FPS"} title="what the sensor is producing" />
        <Stat k="VIEWERS" v={sx.clients === null ? "—" : String(sx.clients)} title="clients ustreamer is currently feeding" />
        <Stat k="RESOLUTION" v={res} />
        <Stat k="ENCODER" v={enc} />
        <Stat k="SERVICE" v={String(cam.service || "—")} />
      </div>

      {sx.starved ? <div style={S(`padding:0 12px 10px; ${mono(9.5, `color:${T.warn}; line-height:1.6`)}`)}>
        {`${sx.delivered} OF ${sx.captured} FPS ARRIVING — ustreamer divides the stream across ${sx.clients || 1} viewer${sx.clients === 1 ? "" : "s"} and this host is on WiFi. Closing other viewers gives this one the bandwidth back.`}
      </div> : null}

      {mode === "error" ? <div style={S(`padding:0 12px 10px; ${mono(9.5, `color:${T.err}; line-height:1.6`)}`)}>
        {`THE STREAM CLOSED — ${String(cam.service || "the camera service")} may have restarted or the camera was unplugged. RETRY reconnects.`}
      </div> : null}

      {err ? <div style={S(`padding:0 12px 10px; ${mono(9.5, `color:${T.err}; line-height:1.6`)}`)}>{err}</div> : null}
    </Panel>
  );
}

export default function Page({ store, api }) {
  const st = useStore(store);
  // Memoized because the poll effect below depends on it: a fresh array every render would tear the
  // interval down and re-arm it on every store emit (which is once a second, from the temp history).
  const cams = React.useMemo(() => {
    const w = st.webcams;
    if (!Array.isArray(w) || !w.length) return NO_CAMS;
    const ok = w.filter(c => c && typeof c === "object");
    return ok.length ? ok : NO_CAMS;
  }, [st.webcams]);
  const visible = st.visible !== false;
  const connected = st.connected !== false;
  const [focus, setFocus] = usePersisted("webcam.focus", null);
  const [states, setStates] = React.useState({});
  // See HYDRATE_GRACE_MS: `connected` flips a hydration round-trip before st.webcams is filled in.
  const [waited, setWaited] = React.useState(false);
  React.useEffect(() => {
    setWaited(false);
    const h = setTimeout(() => setWaited(true), HYDRATE_GRACE_MS);
    return () => clearTimeout(h);
  }, [connected]);

  // boot.js already polls /state once a second for webcams[0] (-> st.camState), so only the EXTRA
  // cameras need a poll here. Gives up after 3 failures the way boot's does: a non-ustreamer service
  // has no /state at all and would otherwise be hit forever.
  React.useEffect(() => {
    const extra = cams.slice(1).filter(c => c && c.enabled !== false && c.stream_url);
    if (!visible || !extra.length) return undefined;
    let alive = true;
    const fails = {}, busyFor = {};
    const tick = () => extra.forEach(c => {
      const id = camId(c);
      // A camera host slower than the 1 s tick would otherwise stack a new request on every tick.
      if ((fails[id] || 0) > 3 || busyFor[id]) return;
      busyFor[id] = true;
      fetch(stateUrl(c, api.base))
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(j => { if (alive) { fails[id] = 0; setStates(p => Object.assign({}, p, { [id]: j.result || j })); } })
        .catch(() => { fails[id] = (fails[id] || 0) + 1; })
        .then(() => { busyFor[id] = false; });
    });
    tick();
    const h = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(h); };
  }, [cams, visible, api]);

  const stateFor = c => (cams[0] && camId(cams[0]) === camId(c) ? st.camState : states[camId(c)]) || null;
  const picked = focus ? cams.filter(c => camId(c) === focus) : cams;
  const list = picked.length ? picked : cams;        // a persisted focus on a camera that is gone must not blank the page
  const one = list.length === 1;

  if (!cams.length) {
    const settled = connected && waited;    // only then is "no camera" an answer rather than a guess
    return <div style={S("flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:1fr")}>
      <Panel title="WEBCAM">
        <div style={S("padding:30px 12px; text-align:center")}>
          <div style={S(mono(11, `letter-spacing:.24em; color:${settled ? T.mute : T.faint}`))}>
            {!connected ? "WAITING FOR MOONRAKER" : settled ? "NO CAMERA CONFIGURED" : "LOADING CAMERAS…"}
          </div>
          {settled ? <div style={S(`margin-top:10px; font-size:12px; color:${T.mute}; line-height:1.7`)}>
            Moonraker reports no webcams. Add one in Fluidd or Mainsail (or a <span style={S(mono(11, `color:${T.body}`))}>[webcam]</span> section
            in moonraker.conf) — the list is pushed live, so it appears here without a reload.
          </div> : null}
        </div>
      </Panel>
    </div>;
  }

  return <div style={S(`flex:1; display:grid; gap:10px; padding:10px; align-content:start; grid-template-columns:${one ? "1fr" : "repeat(auto-fit,minmax(340px,1fr))"}`)}>
    {list.map(c => <Cam key={camId(c)} cam={c} camState={stateFor(c)} api={api} store={store}
      visible={visible} connected={connected} single={one} total={cams.length}
      focused={focus === camId(c)} onFocus={() => setFocus(focus === camId(c) ? null : camId(c))} />)}
  </div>;
}
