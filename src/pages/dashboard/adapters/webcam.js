// Dashboard "WEBCAM" panel: the design drew a placeholder ("MJPEG STREAM"); this feeds the real stream.
// The full multi-camera page lives in src/pages/webcam/.
//
// FPS is MEASURED, not assumed. Two facts drove this:
//   1. `target_fps` from Moonraker is the CONFIGURED rate (30 here) and says nothing about what arrives.
//      On this printer the camera captures 31 fps but each client receives 6-8 — the frames are ~72 KB
//      (camera-native MJPEG, `encoder.quality: 0`), so 30 fps would need ~17 Mbps per viewer.
//   2. An <img> streaming multipart/x-mixed-replace fires NO load event per frame in Chrome (verified:
//      0 events in 6 s), so frames cannot be counted in the page.
// ustreamer's /state reports per-client fps, and it echoes a `key` query param back per client — so the
// stream URL is tagged and we read our OWN delivered rate rather than a guess.

/**
 * Tag that marks a connection as ours in ustreamer's clients_stat. It is a BUILD constant, not a
 * per-page-load id — every tab, and Orca beside a browser, sends the same one — so a match narrows
 * the entries to "a carbon viewer", never to "this exact <img>". fpsFromState below depends on that.
 */
export const CLIENT_KEY = "carbon";

/** CSS transform for Moonraker's flip/rotation flags. */
export function camTransform(cam) {
  const t = [];
  const rot = Number(cam && cam.rotation) || 0;
  if (rot) t.push(`rotate(${rot}deg)`);
  if (cam && cam.flip_horizontal) t.push("scaleX(-1)");
  if (cam && cam.flip_vertical) t.push("scaleY(-1)");
  return t.length ? t.join(" ") : "none";
}

/** Absolute stream URL, tagged with our client key so /state can report our real rate. */
export function streamUrl(cam, base) {
  if (!cam || !cam.stream_url) return "";
  const raw = /^https?:/i.test(cam.stream_url) ? cam.stream_url : (base || "") + cam.stream_url;
  return raw + (raw.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(CLIENT_KEY);
}

/** Our delivered fps from ustreamer's state, plus what the camera is actually capturing. */
export function fpsFromState(camState) {
  const r = camState || {};
  const stream = r.stream || {};
  const stats = stream.clients_stat || {};
  // The key is per-BUILD, not per-connection: a second tab (or Orca beside a browser) shows up as a
  // second clients_stat entry carrying the same key, in an order ustreamer chooses. Taking the first
  // match therefore read whichever connection ustreamer listed first — measured: a tab that had just
  // opened sat at 0 fps for its first second, so the healthy 30 fps tab would have reported a stall.
  // The best of the matching entries is the honest answer to "is a carbon viewer getting frames".
  let mine = null;
  for (const c of Object.values(stats)) {
    if (!c || c.key !== CLIENT_KEY) continue;
    const f = Number(c.fps);
    if (Number.isFinite(f) && (mine === null || f > mine)) mine = f;
  }
  const captured = r.source && Number.isFinite(Number(r.source.captured_fps)) ? Number(r.source.captured_fps) : null;
  return {
    delivered: mine,
    captured,
    clients: Number.isFinite(Number(stream.clients)) ? Number(stream.clients) : null,
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
// ---------------------------------------------------------------------------
const SEEN = new Map();
const STALL_SAMPLES = 3;
const STARVED_SAMPLES = 2;

/** { stale: no sample yet for this stream, settling: first sample only, stalled/starving: held long enough }. */
export function fpsTrack(key, src, camState) {
  let s = SEEN.get(key);
  if (!s || s.src !== src) { s = { src: src || "", state: null, n: 0, zeros: 0, lows: 0 }; SEEN.set(key, s); }
  if (src && camState && camState !== s.state) {
    s.state = camState;
    s.n += 1;
    const f = fpsFromState(camState);
    s.zeros = f.delivered === 0 ? s.zeros + 1 : 0;
    // The sample after the zero is partial too (measured: 14 of 30 fps), which looked exactly like
    // bandwidth starvation — so that verdict also has to hold for more than one sample.
    const low = f.delivered > 0 && f.captured > 0 && f.delivered < f.captured * 0.5;
    s.lows = low ? s.lows + 1 : 0;
  }
  return {
    stale: s.n === 0, settling: s.n <= 1,
    stalled: s.zeros >= STALL_SAMPLES, starving: s.lows >= STARVED_SAMPLES,
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
  const cams = Array.isArray(st.webcams) ? st.webcams : [];
  const cam = cams[0] || null;
  const visible = st.visible !== false;
  // A hidden tab keeps its MJPEG connection unless the src is cleared, and ustreamer divides
  // bandwidth between clients — so an unwatched tab would slow down the one being watched.
  const src = cam && visible ? streamUrl(cam, api.base) : "";
  const live = !!src && st.connected !== false;
  const track = fpsTrack("dash", live ? src : "", st.camState);
  const raw = fpsFromState(st.camState);
  // Only a live stream has CURRENT numbers, and only once /state has been read at least once since
  // this connection opened — otherwise these are last load's figures for a connection that is gone.
  const delivered = live && !track.settling ? raw.delivered : null;
  const captured = live && !track.stale ? raw.captured : null;
  const clients = live && !track.stale ? raw.clients : null;

  if (st.connected === false) connectedAt = 0;
  else if (!connectedAt) connectedAt = Date.now();

  let label;
  if (!cam) label = st.connected === false ? "OFFLINE"
    : Date.now() - connectedAt < HYDRATE_GRACE_MS ? "LOADING" : "NO CAMERA";
  else if (!visible) label = "PAUSED";
  else if (!live) label = "OFFLINE";
  else if (delivered === null) label = "LIVE";                  // warming up, or /state not reachable
  else if (delivered === 0) label = track.stalled ? "STALLED · 0 FPS" : "LIVE";
  else label = `LIVE · ${delivered} FPS`;

  // Amber when we are getting far less than the camera produces — that is a bandwidth problem,
  // and the design's palette already means "warning" with this colour. A zero is not starvation:
  // it is either the warm-up above or a dead stream, and both have their own wording.
  const starved = delivered !== null && delivered > 0 && track.starving;
  const stalled = delivered === 0 && track.stalled;
  const colour = !live || !visible ? "#4d5a6b" : stalled ? "#ff5a33" : starved ? "#f0b429" : "#ff5a33";

  return {
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
