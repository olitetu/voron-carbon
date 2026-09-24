// Dashboard "WEBCAM" panel: the design drew a placeholder ("MJPEG STREAM"); this feeds the real stream.
// The full multi-camera page lives in src/pages/webcam/, the touchscreen's in src/screen/screens/camera.jsx;
// both take their stream plumbing and status wording from here.
//
// FPS is MEASURED, not assumed. Two facts drove this:
//   1. `target_fps` from Moonraker is the CONFIGURED rate (30 here) and says nothing about what arrives.
//      When this was written the camera sent camera-native MJPEG (`encoder.quality: 0`, ~72 KB frames)
//      and each client received 6-8 of 31 fps — 30 would have needed ~17 Mbps per viewer. crowsnest now
//      runs the CPU encoder at Q55 (~35 KB snapshot) and every viewer gets the full 30, but that is a
//      property of today's settings, not something the configured rate could ever have told us.
//   2. An <img> streaming multipart/x-mixed-replace fires exactly ONE load event, at the first frame, and
//      nothing per frame after it (measured in Chromium 152 against a local multipart server). So frames
//      cannot be counted in the page.
// ustreamer's /state reports per-client fps, and it echoes a `key` query param back per client — so the
// stream URL is tagged and we read our OWN delivered rate rather than a guess.
//
// A dead stream is mostly SILENT, which is why the rate matters beyond display. Same measurement: only
// a connection that fails BEFORE its first frame (a 404, nginx's 502 while crowsnest is down) fires
// `error`. One cut after it fires nothing and the image is cleared (complete, naturalWidth 0); one that
// ends cleanly or goes quiet fires nothing and the last frame stays up. /state shows both of those: a
// closed connection drops out of clients_stat (fpsTrack's `missing`), a quiet one stays listed at 0 fps
// (`stalled`). A cut is also visible to a page that probes the <img> for naturalWidth 0.

/**
 * Tag that marks a desktop connection as ours in ustreamer's clients_stat. It is a BUILD constant, not a
 * per-page-load id — every tab, and Orca beside a browser, sends the same one — so a match narrows
 * the entries to "a carbon viewer", never to "this exact <img>". fpsFromState below depends on that.
 */
export const CLIENT_KEY = "carbon";

/**
 * The touchscreen's own tag. With the shared key a desktop tab's 30 fps stood in for the panel's, so a panel
 * stream that had closed cleanly behind a frozen frame still read LIVE. ustreamer echoes any key verbatim
 * (measured: "carbon-screen" listed as sent; a keyless client is listed with key "0").
 */
export const SCREEN_CLIENT_KEY = "carbon-screen";

/** CSS transform for Moonraker's flip/rotation flags. */
export function camTransform(cam) {
  const t = [];
  const rot = Number(cam && cam.rotation) || 0;
  if (rot) t.push(`rotate(${rot}deg)`);
  if (cam && cam.flip_horizontal) t.push("scaleX(-1)");
  if (cam && cam.flip_vertical) t.push("scaleY(-1)");
  return t.length ? t.join(" ") : "none";
}

/** Absolute stream URL, tagged with the surface's client key so /state can report its real rate. */
export function streamUrl(cam, base, key = CLIENT_KEY) {
  if (!cam || !cam.stream_url) return "";
  const raw = /^https?:/i.test(cam.stream_url) ? cam.stream_url : (base || "") + cam.stream_url;
  return raw + (raw.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key);
}

/**
 * Delivered fps for connections tagged `key`, plus what the camera is actually capturing.
 * `listable`: every clients_stat entry carries a key, so an absent `key` really means "not connected".
 */
export function fpsFromState(camState, key = CLIENT_KEY) {
  const r = camState || {};
  const stream = r.stream || {};
  const listed = stream.clients_stat;
  const stats = listed && typeof listed === "object" ? listed : {};
  // The key is per-BUILD, not per-connection: a second tab (or Orca beside a browser) shows up as a
  // second clients_stat entry carrying the same key, in an order ustreamer chooses. Taking the first
  // match therefore read whichever connection ustreamer listed first — measured: a tab that had just
  // opened sat at 0 fps for its first second, so the healthy 30 fps tab would have reported a stall.
  // The best of the matching entries is the honest answer to "is a viewer with this key getting frames".
  let mine = null;
  for (const c of Object.values(stats)) {
    if (!c || c.key !== key) continue;
    const f = Number(c.fps);
    if (Number.isFinite(f) && (mine === null || f > mine)) mine = f;
  }
  const captured = r.source && Number.isFinite(Number(r.source.captured_fps)) ? Number(r.source.captured_fps) : null;
  return {
    delivered: mine,
    captured,
    clients: Number.isFinite(Number(stream.clients)) ? Number(stream.clients) : null,
    // This printer's ustreamer lists every client with a key ("0" when none was sent — measured), so a
    // list without ours (an empty one included) means our connection is not open. A ustreamer that
    // echoes no keys, or has no clients_stat at all, cannot say we are missing, and must not be read so.
    listable: !!listed && typeof listed === "object" && Object.values(listed).every(c => c && c.key !== undefined),
  };
}

// ---------------------------------------------------------------------------
// Warm-up tracking — why a fresh connection may NOT be believed straight away.
//
// ustreamer counts each client's frames over the PREVIOUS whole second, so a connection that has
// only just opened is reported at a fraction of its real rate. Measured against this printer while
// connecting a client and polling /state every 200 ms:
//     0.30 s -> fps 0     0.58 s -> fps 14     1.78 s -> fps 31 (steady)
// Reporting that first sample verbatim is what flashed a red "STALLED · 0 FPS" — and, one poll
// later, the amber "14 OF 30 FPS ARRIVING" bandwidth warning — on every reload and every time the
// tab came back. Orca reloads this page on nearly every preset change, so it was seen constantly.
//
// So each panel's stream is tracked: samples are counted by /state OBJECT IDENTITY (the pollers hand
// over a fresh object every second, so this counts polls, not renders, and calling it twice for the
// same sample is a no-op), the first sample only proves the connection exists, and a zero has to
// hold for THREE samples before it is called a stall. Keyed by panel+stream URL, so releasing the
// stream (hidden tab, snapshot, route change) or retrying it starts the warm-up over.
//
// `missing` is the frozen-frame case from the header: a stream that ended cleanly (a crowsnest restart
// that nginx closes cleanly) fires no event and leaves the last frame up, and the only trace is that
// ustreamer stops listing our key. A new connection is listed within ~0.3 s (the measurement above), so
// three samples in a row without it is not a slow start. The first sample is not counted: it may predate
// the connection (the object already in the store when the stream opened).
// ---------------------------------------------------------------------------
const SEEN = new Map();
const STALL_SAMPLES = 3;
const STARVED_SAMPLES = 2;
const MISSING_SAMPLES = 3;

/**
 * { stale: no sample yet for this stream, settling: first sample only, stalled/starving/missing: held long
 * enough, misses: samples in a row not listing `key`, key: the client key the verdicts are about }.
 * `id` names the panel; `key` must be the one its `src` was tagged with (streamUrl's third argument).
 */
export function fpsTrack(id, src, camState, key = CLIENT_KEY) {
  let s = SEEN.get(id);
  if (!s || s.src !== src) { s = { src: src || "", state: null, n: 0, zeros: 0, lows: 0, misses: 0 }; SEEN.set(id, s); }
  if (src && camState && camState !== s.state) {
    s.state = camState;
    s.n += 1;
    const f = fpsFromState(camState, key);
    s.zeros = f.delivered === 0 ? s.zeros + 1 : 0;
    // The sample after the zero is partial too (measured: 14 of 30 fps), which looked exactly like
    // bandwidth starvation — so that verdict also has to hold for more than one sample.
    const low = f.delivered > 0 && f.captured > 0 && f.delivered < f.captured * 0.5;
    s.lows = low ? s.lows + 1 : 0;
    s.misses = s.n > 1 && f.listable && f.delivered === null ? s.misses + 1 : 0;
  }
  return {
    stale: s.n === 0, settling: s.n <= 1,
    stalled: s.zeros >= STALL_SAMPLES, starving: s.lows >= STARVED_SAMPLES,
    misses: s.misses, missing: s.misses >= MISSING_SAMPLES, key,
  };
}

/**
 * The readout for one stream: which numbers are current, and the words every surface shares for them.
 *   live        the stream is open AND camState is a current sample (each surface decides what current means)
 *   connecting  no frame has been seen yet, so the warm-up reads CONNECTING rather than LIVE
 * kind is palette-neutral, for each surface to colour: "ok" frames arriving, "warn" starved, "err" stalled,
 * "off" rate not known yet. noSignal, missing and unlisted are reported but NOT worded here: only the
 * touchscreen names them today, and the desktop surfaces keep the labels they have always shown.
 * The numbers are read for the track's own key, so they and its verdicts are about the same connections.
 */
export function camStatus(camState, track, live, opts) {
  const o = opts || {};
  const raw = fpsFromState(camState, track.key);
  // Only a live stream has CURRENT numbers, and only once /state has been read at least once since this
  // connection opened — otherwise they are the last connection's figures (see fpsTrack for why the first
  // sample is not a rate either).
  const delivered = live && !track.settling ? raw.delivered : null;
  const captured = live && !track.stale ? raw.captured : null;
  const clients = live && !track.stale ? raw.clients : null;
  const stalled = delivered === 0 && track.stalled;
  // Well under what the sensor produces is bandwidth starvation, not a slow camera: ustreamer splits the
  // pipe between clients. A zero is never starvation — it is the warm-up or a dead stream, and both have
  // their own wording.
  const starved = delivered !== null && delivered > 0 && captured !== null && captured > 0 && track.starving;
  const cs = camState || {};
  let label, kind;
  if (stalled) { label = "STALLED · 0 FPS"; kind = "err"; }
  else if (delivered === null || delivered === 0) { label = o.connecting ? "CONNECTING" : "LIVE"; kind = "off"; }
  else { label = `LIVE · ${delivered} FPS`; kind = starved ? "warn" : "ok"; }
  return {
    delivered, captured, clients, stalled, starved, label, kind,
    // ustreamer is up but its source is not. ustreamer serves its own placeholder frames then (not
    // reproduced on this printer), so the rate alone could read healthy.
    noSignal: live && !track.stale && !!(cs.source && cs.source.online === false),
    missing: live && track.missing,
    unlisted: live && !track.settling && raw.delivered === null,
  };
}

// The webcam list arrives with hydration, a few hundred ms AFTER `connected` flips — so an
// unqualified "NO CAMERA" was shown on every load before Moonraker had been asked. Reset on
// disconnect so a camera deleted later still reads NO CAMERA rather than LOADING.
let connectedAt = 0;
const HYDRATE_GRACE_MS = 2500;

export function webcamVals(ctx) {
  const st = (ctx && ctx.st) || {};
  const api = (ctx && ctx.api) || {};
  const ui = (ctx && ctx.ui) || {};
  const set = ctx && typeof ctx.set === "function" ? ctx.set : () => {};
  const log = ctx && typeof ctx.log === "function" ? ctx.log : () => {};
  const cams = Array.isArray(st.webcams) ? st.webcams : [];
  const cam = cams[0] || null;
  const visible = st.visible !== false;
  // A hidden tab keeps its MJPEG connection unless the src is cleared, and ustreamer divides
  // bandwidth between clients — so an unwatched tab would slow down the one being watched.
  // REFRESH bumps ui.camNonce. An <img> streaming multipart MJPEG never reconnects on its own once the stream
  // stalls; a DIFFERENT url is the only thing that makes it drop the dead connection and open a new one.
  // ustreamer ignores the extra param, and `key` stays, so the fps readout keeps finding our connection. The
  // fps tracker is keyed by url, so a refresh restarts its warm-up rather than inheriting the stall.
  const baseSrc = cam && visible ? streamUrl(cam, api.base) : "";
  const src = baseSrc && ui.camNonce ? baseSrc + "&n=" + ui.camNonce : baseSrc;
  const live = !!src && st.connected !== false;
  const track = fpsTrack("dash", live ? src : "", st.camState);
  const sx = camStatus(st.camState, track, live);
  const { delivered, captured, clients, stalled, starved } = sx;

  if (st.connected === false) connectedAt = 0;
  else if (!connectedAt) connectedAt = Date.now();

  let label;
  if (!cam) label = st.connected === false ? "OFFLINE"
    : Date.now() - connectedAt < HYDRATE_GRACE_MS ? "LOADING" : "NO CAMERA";
  else if (!visible) label = "PAUSED";
  else if (!live) label = "OFFLINE";
  else label = sx.label;                    // "LIVE" while warming up or with /state unreachable

  // Amber when we are getting far less than the camera produces — that is a bandwidth problem,
  // and the design's palette already means "warning" with this colour.
  const colour = !live || !visible ? "#4d5a6b" : stalled ? "#ff5a33" : starved ? "#f0b429" : "#ff5a33";

  const camRefresh = () => {
    if (!cam) { log("Webcam: no camera configured", "warn"); return; }
    log("Webcam: reconnecting " + (cam.name || "the stream") + (stalled ? " (stream had stalled)" : ""), "info");
    set({ camNonce: Date.now() });
  };

  return {
    camRefresh,
    camRefreshLabel: "\u21bb REFRESH",
    camRefreshTitle: cam ? "Reconnect the stream" + (stalled ? " — it has stopped delivering frames" : "") : "No camera configured",
    // Lit amber once the stream is known to have stalled: that is exactly when this is the button to press.
    camRefreshStyle: "margin-left:10px; padding:2px 7px; border-radius:3px; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.1em; cursor:pointer; white-space:nowrap; border:1px solid " +
      (stalled ? "#f0b429" : "#1c2430") + "; color:" + (stalled ? "#f0b429" : "#6b7789") + "; background:" + (stalled ? "#14100a" : "transparent") +
      "; transition:transform .07s ease, border-color .12s" + (stalled ? "; animation:vGlow 2.4s ease-in-out infinite" : ""),
    camSrc: src,
    camName: cam ? String(cam.name || "WEBCAM").toUpperCase() : "WEBCAM",
    camCount: cams.length,
    camLabel: label,
    camFps: delivered,
    camCapturedFps: captured,
    camClients: clients,
    camTitle: cam
      ? `${cam.name || "camera"} · ${cam.service || "?"}` +
        (captured !== null ? ` · camera ${captured} fps` : "") +
        (delivered !== null ? ` · delivered ${delivered} fps` : "") +
        (clients !== null ? ` · ${clients} viewer${clients === 1 ? "" : "s"}` : "")
      : st.connected === false ? "not connected to Moonraker" : "no camera configured",
    camLabelStyle: "margin-left:auto; display:flex; align-items:center; gap:6px; font-family:'JetBrains Mono',monospace; font-size:9px; color:" + colour,
    camDotStyle: "width:5px; height:5px; border-radius:50%; background:" + colour +
      (live && visible && !stalled ? "; animation:vPulse 1.4s ease-in-out infinite" : ""),
    // Sits inside the design's position:relative / aspect-ratio:4/3 frame, behind its scanline overlays.
    camImgStyle: src
      ? `position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transform:${camTransform(cam)}`
      : "display:none",
  };
}

export default webcamVals;
