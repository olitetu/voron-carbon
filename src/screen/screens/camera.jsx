// ---------------------------------------------------------------------------
// CAMERA — the printer camera, as big as the 1024x548 content area allows.
//
// What this printer actually has (read from the live machine, not the plan):
//   server.webcams.list -> ONE camera, "Back": service mjpegstreamer-adaptive,
//     stream_url /webcam/?action=stream, aspect_ratio 4:3, target_fps 30 (idle 15),
//     flip_horizontal AND flip_vertical true, rotation 0, enabled.
//   /webcam/state (ustreamer, run by the crowsnest service, which is active) ->
//     640x480, CPU encoder at quality 55, captured_fps 30-31, and every viewer
//     receiving the full 30. A snapshot is ~35 KB, so one 30 fps viewer is ~8 Mbit/s.
//   /webcam/ is proxied on :8767 as well (GET :8767/webcam/state -> 200), so on the
//     kiosk, which loads 127.0.0.1:8767, the relative stream URL is same-origin.
//
// Nothing about the stream is re-implemented here. streamUrl / camTransform /
// fpsTrack / camStatus are the shared adapter's (src/pages/dashboard/adapters/
// webcam.js), boot.js already polls ustreamer's /state once a second into
// st.camState, and REFRESH is the adapter's technique: an <img> on
// multipart/x-mixed-replace never reconnects by itself once the stream stalls, so a
// DIFFERENT url (`&n=<nonce>`, ignored by ustreamer, `key` kept) is the only thing
// that makes it drop the dead connection and open a new one. fpsTrack is keyed by
// url, so a refresh restarts the warm-up instead of inheriting the stall.
//
// Decisions, and why:
//
//   RELEASE. st.visible false removes the src ATTRIBUTE (React does that for an
//   undefined src), which aborts the request, and unmount removes it by hand --
//   "the node was removed, so it probably closed" is not good enough when the cost
//   is another viewer's frame rate. The tracker is told about the release too, so
//   coming back starts a fresh warm-up. On the kiosk the page is effectively never
//   hidden (DPMS blanking does not change document.hidden), so leaving this screen
//   is what really releases the camera.
//
//   MOONRAKER OFFLINE DOES NOT STOP THE PICTURE. The desktop page drops the stream
//   when the websocket drops, because there that usually means the printer is
//   unreachable. On the panel the camera is nginx -> crowsnest on the same host and
//   does not depend on Moonraker, so a Moonraker restart is exactly when watching
//   the machine is useful.
//
//   A DEAD STREAM IS DETECTED THREE WAYS, because `error` alone misses most deaths.
//   Measured in Chromium 152 against a local multipart server: an <img> on
//   multipart/x-mixed-replace fires ONE `load` (first frame) and then nothing. A
//   connection that fails BEFORE the first frame (404, nginx 502 while crowsnest is
//   down) fires `error`. A connection that is cut AFTER it (chunked stream reset)
//   fires NOTHING: the image is just cleared (complete, naturalWidth 0). A stream
//   that ends cleanly or goes quiet also fires nothing, and the last frame stays up.
//   So: `error` -> STREAM LOST; a 1 s probe that saw a frame on this src and now
//   finds the image cleared -> STREAM LOST; and ustreamer listing NO key=carbon-screen
//   client for 3 consecutive polls while ours is open (fpsTrack's `missing`) ->
//   NOT RECEIVING (the frozen-frame case, e.g. a crowsnest restart that nginx
//   closes cleanly).
//
//   A STALE /state IS NOT A FRAME RATE. When ustreamer's /state stops answering
//   (hung or failing), boot keeps the last good object in st.camState -- which
//   would read "LIVE · 30 FPS" over a frozen picture. Only a sample that ARRIVED
//   while this screen was watching counts; older than 3.5 s (three missed 1 s
//   polls) and the rate is unknown and says so. A stream that has
//   just (re)opened gets that same 3.5 s before any verdict, because boot's poll
//   pauses while the page is hidden and the first new sample takes up to 1 s.
//
//   DELIVERED IS THIS PANEL'S. The stream is tagged key=carbon-screen, not the
//   desktop's key=carbon, so a desktop tab's 30 fps can no longer stand in for a
//   panel stream that closed cleanly behind a frozen frame. Only a second
//   screen.html open elsewhere shares this key; the best of the two is read then.
//
//   THE LARGER VIEW FILLS. A 4:3 frame's biggest whole view in 1024x548 is 731x548,
//   only ~5% bigger than the 699x524 it gets beside the stats column. So tapping the
//   picture goes edge to edge and defaults to FILL (cover): 1024 wide, 1.4x, the
//   middle 71% of the frame's height. FIT is one tap away and remembered on this
//   panel. The status bar stays up either way -- it carries the emergency stop.
//
//   ROTATION. A 90/270 camera is sized with container-query units, so it needs no
//   measuring (the desktop page measures because ResizeObserver never fires in a
//   non-composited webview). This camera is rotation 0, so its path uses plain
//   100% sizing and does not depend on container queries at all.
//
// This screen sends NOTHING to the printer. Every control is local to the stream.
// ---------------------------------------------------------------------------
import React from "react";
import { S } from "../../lib/ui.js";
import { usePersisted } from "../../lib/useStore.js";
import { streamUrl, camTransform, fpsTrack, camStatus, SCREEN_CLIENT_KEY } from "../../pages/dashboard/adapters/webcam.js";
import { C, F, L, TAP, mono } from "../tokens.js";
import { badgeStyle } from "../vm.js";
import { Panel, PanelBtn, Chip, Empty } from "../parts.jsx";

/** fpsTrack key for this surface. Separate from the dashboard's "dash", so their warm-ups never mix. */
const TRACK_KEY = "screen";
/** boot.js polls /state every 1 s; three missed polls and the last reading is no longer a rate. */
const STATE_STALE_MS = 3500;
/** Stats column. 1024 - 2*12 pad - 280 - 10 gap = 710 wide x 524 high: a 4:3 frame is 699x524 in it. */
const SIDE_W = 280;
/** Value colour for each badge kind, so the DELIVERED figure reads in the badge's colour. */
const INK = { ok: C.cool, warn: C.bed, err: C.accent, off: C.mute };

/** Moonraker's flip/rotation flags in words — "FLIP H + V" on this camera. */
function orientation(cam) {
  const rot = Number(cam && cam.rotation) || 0;
  const h = !!(cam && cam.flip_horizontal), v = !!(cam && cam.flip_vertical);
  const out = [];
  if (rot) out.push(`ROT ${rot}°`);
  if (h || v) out.push("FLIP " + [h ? "H" : "", v ? "V" : ""].filter(Boolean).join(" + "));
  return out.length ? out.join(" · ") : "AS CAPTURED";
}

const CORNERS = [["left", "top"], ["right", "top"], ["left", "bottom"], ["right", "bottom"]];

export default function Camera({ st, say, api }) {
  const cams = Array.isArray(st.webcams) ? st.webcams.filter(c => c && typeof c === "object") : [];
  const cam = cams[0] || null;

  const [large, setLarge] = React.useState(false);
  const [fillRaw, setFill] = usePersisted("screen.camera.fill", true);
  const fill = fillRaw !== false;                       // a hand-edited localStorage value must not break the view
  const [nonce, setNonce] = React.useState(0);
  const [lostSrc, setLostSrc] = React.useState("");     // the src whose connection the <img> reported dead
  const [, tick] = React.useReducer(n => n + 1, 0);
  const imgRef = React.useRef(null);
  // The /state object present at mount is of unknown age (at 0): only one that ARRIVES while we watch is fresh.
  const seen = React.useRef({ state: st.camState || null, at: 0 });
  const opened = React.useRef({ src: "", at: 0 });            // when the current src was (re)opened
  const shown = React.useRef("");                             // the src the probe has seen displaying a frame

  // React hands a ref callback null on unmount; keep the node, the cleanup below needs it.
  const holdImg = React.useCallback(el => { if (el) imgRef.current = el; }, []);

  const visible = st.visible !== false;
  const enabled = !!cam && cam.enabled !== false;
  const base = enabled && cam.stream_url ? streamUrl(cam, api.base, SCREEN_CLIENT_KEY) : "";
  const want = base && visible ? base + (nonce ? "&n=" + nonce : "") : "";
  const lost = !!want && lostSrc === want;
  const src = lost ? "" : want;
  const mode = !cam ? "none" : !enabled ? "disabled" : !base ? "nourl" : !visible ? "paused" : lost ? "lost" : "live";
  const live = mode === "live";

  // Freshness of ustreamer's /state: boot hands over a NEW object per successful poll.
  const now = Date.now();
  if (st.camState && st.camState !== seen.current.state) seen.current = { state: st.camState, at: now };
  if (opened.current.src !== src) opened.current = { src, at: now };
  const age = seen.current.at ? now - seen.current.at : Infinity;
  const fresh = age < STATE_STALE_MS;
  // Just (re)opened -- mount, REFRESH, the page coming back -- and no new sample yet: no verdict, not "stale".
  const waking = !fresh && !!src && now - opened.current.at < STATE_STALE_MS;

  const track = fpsTrack(TRACK_KEY, src, st.camState, SCREEN_CLIENT_KEY);
  // Only a live stream with a current sample has current numbers. Once the probe has seen a frame on this
  // src it is live, only its rate is not known yet, so the warm-up reads LIVE rather than CONNECTING.
  const sx = camStatus(st.camState, track, live && fresh, { connecting: shown.current !== src });
  const { delivered, captured, clients, stalled, starved, noSignal, missing, unlisted } = sx;
  const cs = st.camState || null;

  // Once a second while a stream is open: re-render (a dead poll leaves nothing else to, and staleness is a
  // function of time), and probe the <img>. Chromium fires no event when a stream dies after its first frame;
  // it clears the image. So a src that has shown a frame and is now complete with naturalWidth 0 has died.
  // getAttribute guards the gap where React has not yet applied a new src (no src also reads complete/0).
  React.useEffect(() => {
    if (!src) { shown.current = ""; return undefined; }
    const t = setInterval(() => {
      const el = imgRef.current;
      if (el && el.getAttribute("src") === src) {
        if (el.naturalWidth > 0) shown.current = src;
        else if (shown.current === src && el.complete) setLostSrc(src);
      }
      tick();
    }, 1000);
    return () => clearInterval(t);
  }, [src]);

  // Moonraker coming back, or the page becoming visible again, is a fresh chance for the stream. Deliberately
  // not keyed on the failure itself: that would re-arm the stream the instant it failed, and loop.
  React.useEffect(() => { if (st.connected && visible) setLostSrc(""); }, [st.connected, visible]);

  React.useEffect(() => () => {
    if (imgRef.current) imgRef.current.removeAttribute("src");
    fpsTrack(TRACK_KEY, "", null);                      // released: the next visit warms up from scratch
  }, []);

  // ---- no camera at all: say which of the four reasons it is
  if (!cam) {
    // webcams lands in the SAME store.set as printerInfo/tempHistory at the end of boot's hydrate(), so either
    // of those being present means the list has been read and an empty one is a real answer.
    const hydrated = !!(st.printerInfo || st.tempHistory);
    const [title, hint] = !st.connected
      ? ["MOONRAKER OFFLINE", "The camera list comes from Moonraker. It is read again as soon as the connection is back."]
      : !hydrated && st.klippy !== "ready"
        ? ["WAITING FOR KLIPPER", `Carbon reads the camera list during start-up, once Klipper reports ready. Klipper is ${st.klippy || "unknown"}.`]
        : !hydrated
          ? ["LOADING CAMERAS", "Reading the camera list from Moonraker."]
          : ["NO CAMERA CONFIGURED", "Moonraker lists no webcams. Add one in Mainsail or Fluidd, or a [webcam] section in moonraker.conf — the list is pushed live, so it appears here without a restart."];
    return (
      <div style={S(`height:100%; padding:${L.pad}px; padding-bottom:${L.fab + L.fabInset}px; animation:ksFade .18s ease both`)}>
        <Panel title="CAMERA" style="height:100%"><Empty title={title} hint={hint} /></Panel>
      </div>
    );
  }

  const name = String(cam.name || "camera");
  const NAME = name.toUpperCase();

  // ---- status: one word for the badge, one kind for its colour
  let label, kind;
  if (mode === "disabled") { label = "DISABLED"; kind = "off"; }
  else if (mode === "nourl") { label = "NO STREAM URL"; kind = "off"; }
  else if (mode === "paused") { label = "RELEASED"; kind = "off"; }
  else if (mode === "lost") { label = "STREAM LOST"; kind = "err"; }
  else if (!fresh && !waking) { label = "LIVE · FPS —"; kind = "off"; }
  else if (noSignal) { label = "NO SIGNAL"; kind = "err"; }
  // Cannot collide with STALLED: a stall needs our key listed at 0 fps, `missing` needs it absent.
  else if (missing) { label = "NOT RECEIVING"; kind = "err"; }
  else { label = sx.label; kind = sx.kind; }        // STALLED, the warm-up (CONNECTING / LIVE), or the rate

  // The one line that says what is wrong and what to do. Placeholders carry it for a stream that is not open.
  let hint = null, hintCol = C.faint;
  if (live) {
    if (!fresh && !waking) {
      const secs = Number.isFinite(age) ? Math.round(age / 1000) : null;
      hint = `ustreamer's /state has ${secs !== null ? `not answered for ${secs} s` : "not answered since this screen opened"}, so the frame rate is unknown. If the picture has frozen, REFRESH.`;
      hintCol = C.bed;
    } else if (noSignal) {
      hint = "ustreamer is running but the camera reports no signal — check its USB cable. REFRESH cannot help until it is back.";
      hintCol = C.accent;
    } else if (stalled) {
      hint = "No frames for ~3 s. A stalled MJPEG stream never reconnects by itself — REFRESH opens a new connection.";
      hintCol = C.accent;
    } else if (missing) {
      // Frozen only if the probe saw a frame on this src. Before one, the frame is empty, and a connection that
      // had failed would have fired `error` (STREAM LOST), so this one has simply not got through to ustreamer.
      hint = `ustreamer has not listed this panel's connection for ${track.misses} polls, so ` + (shown.current === src
        ? "it has ended and the picture is frozen (crowsnest restarted?). REFRESH opens a new one."
        : "it has not got through to the camera. REFRESH opens a new one.");
      hintCol = C.accent;
    } else if (starved) {
      const nv = clients || 1;
      hint = `Only ${delivered} of ${captured} fps are arriving; ustreamer is feeding ${nv} viewer${nv === 1 ? "" : "s"}. Closing other viewers gives the frames back.`;
      hintCol = C.bed;
    } else if (unlisted) {
      hint = "ustreamer does not list this connection yet. If the picture stays blank, REFRESH.";
    } else if (!st.connected) {
      hint = "Moonraker is offline. The picture comes straight from crowsnest, so it keeps running.";
    } else {
      hint = "Tap the picture for the larger view.";
    }
  }

  const placeholder = {
    disabled: ["CAMERA DISABLED", `Moonraker lists ${name} as disabled. Enable it in Mainsail or Fluidd and it appears here without a restart.`],
    nourl: ["NO STREAM URL", `Moonraker's entry for ${name} has no stream_url, so there is nothing to open.`],
    paused: ["STREAM RELEASED", "This page is hidden, so the MJPEG connection is closed and ustreamer's bandwidth goes to whoever is watching. It reopens by itself."],
    lost: ["STREAM LOST", `The stream from ${name} failed or was cut — crowsnest may have restarted or the camera was unplugged. REFRESH opens a new connection.`],
  }[mode] || null;

  // ---- controls (local to the stream: nothing here reaches the printer)
  // Short on purpose: it is also the button's sub-line, which must fit 280 px at 12 px mono.
  const refreshWhy = mode === "disabled" ? "disabled in Moonraker"
    : mode === "nourl" ? "no stream_url"
      : mode === "paused" ? "page hidden — reopens itself" : null;
  const attention = lost || stalled || missing || (live && !fresh && !waking);
  const refresh = () => {
    if (refreshWhy) return;
    setLostSrc("");
    setNonce(Date.now());
    say(attention ? "RECONNECTING — THE STREAM HAD STOPPED" : "RECONNECTING STREAM");
  };
  const canToggle = large || live;
  const toggle = () => setLarge(!large);

  // ---- geometry. A CSS rotate() does not move the layout box, so a 90/270 camera gets the frame's height as
  // its width (container-query units) and is centred before rotating. 0/180 is plain 100% sizing.
  const rot = (((Number(cam.rotation) || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const tf = camTransform(cam);
  const fit = large && fill ? "cover" : "contain";
  const imgStyle = !src ? "display:none"
    : swap ? `position:absolute; left:50%; top:50%; width:100cqh; height:100cqw; object-fit:${fit}; transform:translate(-50%,-50%)${tf === "none" ? "" : " " + tf}; pointer-events:none`
      : `position:absolute; inset:0; width:100%; height:100%; object-fit:${fit}; transform:${tf}; pointer-events:none`;

  const rows = [
    ["DELIVERED", delivered === null ? "—" : `${delivered} FPS`, INK[kind]],
    ["CAPTURED", captured === null ? "—" : `${captured} FPS`],
    ["VIEWERS", clients === null ? "—" : String(clients)],
    ["RESOLUTION", cs && cs.source && cs.source.resolution && cs.source.resolution.width
      ? `${cs.source.resolution.width} × ${cs.source.resolution.height}` : "—"],
    ["ENCODER", cs && cs.encoder
      ? String(cs.encoder.type || "?") + (cs.encoder.quality != null ? ` · Q${cs.encoder.quality}` : "") : "—"],
    ["ORIENTATION", orientation(cam)],
    ["SERVICE", String(cam.service || "—")],
  ];
  if (cams.length > 1) rows.push(["CAMERAS", `1 OF ${cams.length}`]);

  return (
    <div style={S(`height:100%; display:grid; grid-template-columns:${large ? "minmax(0,1fr)" : `${SIDE_W}px minmax(0,1fr)`}; grid-template-rows:minmax(0,1fr); gap:${large ? 0 : L.gap}px; padding:${large ? 0 : L.pad}px; animation:ksFade .18s ease both`)}>

      {/* Stats column. Kept in the same child slot (null when large) so the frame -- and the <img>, and its
          connection -- survive the toggle instead of reconnecting. Bottom clears the nav corner button. */}
      {large ? null : (
        <div style={S(`display:flex; flex-direction:column; gap:${L.gap}px; min-height:0; min-width:0; padding-bottom:${L.fab + L.fabInset - L.pad}px`)}>
          <Panel title={NAME} right={<span style={S(badgeStyle(kind))}>{label}</span>}
            style="flex:1; min-height:0; overflow:hidden" bodyStyle="padding:10px 13px; gap:7px; overflow:hidden">
            {rows.map(([k, v, col]) => (
              <div key={k} style={S(`display:flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; ${mono(F.label)}`)}>
                <span style={S(`letter-spacing:.12em; color:${C.faint}; flex:none`)}>{k}</span>
                <span style={S(`color:${col || C.body}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`)}>{v}</span>
              </div>
            ))}
            {hint ? (
              // Scrolls rather than clips: at the XL type scale a four-line hint is taller than the room left.
              <div style={S(`margin-top:auto; padding-top:9px; border-top:1px solid ${C.line2}; font-size:${F.body}px; color:${hintCol}; line-height:1.45; text-wrap:pretty; min-height:0; overflow-y:auto`)}>{hint}</div>
            ) : null}
          </Panel>
          <div style={S("flex:none; display:flex; flex-direction:column; gap:8px")}>
            <PanelBtn label="↻ REFRESH" tone={attention ? "accent" : undefined} h={TAP.primary}
              sub={refreshWhy ? refreshWhy.toUpperCase() : stalled ? "STREAM STALLED" : lost ? "STREAM LOST" : missing ? "NOT RECEIVING" : "NEW CONNECTION"}
              disabled={!!refreshWhy} why={refreshWhy} onTap={refresh} />
            <PanelBtn label="LARGER VIEW" sub={live ? "OR TAP THE PICTURE" : "NOTHING IS STREAMING"} h={TAP.min}
              disabled={!live} why={live ? null : "nothing is streaming"} onTap={toggle} />
          </div>
        </div>
      )}

      <div onClick={canToggle ? toggle : undefined}
        style={S(`position:relative; min-width:0; min-height:0; overflow:hidden; background:${C.void_}; cursor:${canToggle ? "pointer" : "default"}; ${swap ? "container-type:size; " : ""}${large ? "" : `border:1px solid ${C.line2}; border-radius:${L.radius}px`}`)}>
        {/* The <img> is always mounted, so releasing the stream is React REMOVING the src attribute (which
            aborts the request) rather than trusting node removal to close it. `error` only covers a connection
            that fails before its first frame; a death after it is caught by the probe (see the header). */}
        <img ref={holdImg} src={src || undefined} alt="" draggable={false} style={S(imgStyle)}
          onError={e => { const s = e.currentTarget.getAttribute("src"); if (s) setLostSrc(s); }} />

        {!large && src ? CORNERS.map(([x, y]) => (
          <span key={x + y} style={S(`position:absolute; ${x}:10px; ${y}:10px; width:16px; height:16px; border-${x}:2px solid ${C.accent}; border-${y}:2px solid ${C.accent}; opacity:.7; pointer-events:none`)} />
        )) : null}

        {placeholder ? (
          <div style={S("position:absolute; inset:0; display:flex")}>
            <Empty title={placeholder[0]} hint={placeholder[1]} />
          </div>
        ) : null}

        {large ? (
          <>
            <span style={S(`position:absolute; top:10px; left:10px; ${badgeStyle(kind)}`)}>{`${NAME} · ${label}`}</span>
            {/* Taps on the controls must not fall through to the picture's toggle. */}
            <div onClick={e => e.stopPropagation()}
              style={S(`position:absolute; top:10px; right:10px; display:flex; align-items:center; gap:8px; padding:6px; border-radius:${L.radius}px; background:rgba(6,8,11,.78); border:1px solid ${C.line3}; cursor:default`)}>
              <Chip label="FIT" on={!fill} flex="none" minW={68} fs={F.label} onTap={() => setFill(false)} />
              <Chip label="FILL" on={fill} flex="none" minW={68} fs={F.label} onTap={() => setFill(true)} />
              <div style={S("width:150px")}>
                <PanelBtn label="↻ REFRESH" tone={attention ? "accent" : undefined} h={TAP.min}
                  disabled={!!refreshWhy} why={refreshWhy} onTap={refresh} />
              </div>
              <Chip label="EXIT" flex="none" minW={80} fs={F.label} onTap={() => setLarge(false)} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
