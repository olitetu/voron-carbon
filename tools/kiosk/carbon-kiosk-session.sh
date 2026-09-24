#!/usr/bin/env bash
# X session for the Carbon Screen kiosk. Started by xinit from carbon-kiosk.service.
#
# Everything here is about making a browser stop behaving like a browser: no cursor,
# no blanking, no zoom, no back-swipe, no restore-session bubble after a power cut.
set -u

CONF=/etc/default/carbon-kiosk
[ -r "$CONF" ] && . "$CONF"

: "${KIOSK_URL:=http://127.0.0.1:8767/screen.html}"
: "${KIOSK_SIZE:=1024,600}"
: "${KIOSK_PROFILE:=$HOME/.carbon-kiosk}"
: "${KIOSK_ROTATE:=}"          # normal | left | right | inverted  (xrandr)
: "${KIOSK_TOUCH_MATRIX:=}"    # 9 floats for a rotated digitiser

log() { echo "[carbon-kiosk] $*"; }

# --- display -----------------------------------------------------------------
# The owner runs the panel always-on (KlipperScreen had screen_blanking = off,
# use_dpms = False). Match that: nothing here may blank the screen behind their back.
#
# Not `xset -dpms`. That only clears the server's DPMS-enabled flag. The extension
# stays, and the helper's `xset dpms force off/on` runs DPMSEnable first, so
# screen-off would still work. But that re-enable brings back the server's default
# DPMS timeouts (10 min each, see xorg.conf(5); `xset s off` does not change them).
# After the first manual screen-off, the panel would start blanking itself on idle.
# `xset dpms 0 0 0` keeps DPMS on with every timeout at 0, so a later re-enable can
# never bring back auto-blank. (HDMI has no /sys/class/backlight: DPMS is the only
# screen-off there is.)
xset s off
xset s noblank
xset dpms 0 0 0
# The host helper (tools/helper/) runs as its own user, carbon-net, and its screen-off is
# `xset dpms force off/on` on this display. Let that one local user connect to :0, nobody else.
xhost +SI:localuser:carbon-net >/dev/null 2>&1 || log "xhost failed: the host helper cannot switch the screen off"

if [ -n "$KIOSK_ROTATE" ] && command -v xrandr >/dev/null; then
  OUT="$(xrandr --query | awk '/ connected/{print $1; exit}')"
  [ -n "$OUT" ] && xrandr --output "$OUT" --rotate "$KIOSK_ROTATE" && log "rotated $OUT $KIOSK_ROTATE"
fi
if [ -n "$KIOSK_TOUCH_MATRIX" ] && command -v xinput >/dev/null; then
  # Rotating the framebuffer does not rotate the digitiser; without this the touches
  # land on the wrong axis and the panel looks broken rather than rotated.
  xinput --list --name-only | while read -r dev; do
    case "$dev" in
      *ouch*|*TSC*|*Goodix*|*FT5*|*ILITEK*|*eGalax*)
        xinput set-prop "$dev" "Coordinate Transformation Matrix" $KIOSK_TOUCH_MATRIX 2>/dev/null \
          && log "touch matrix applied to '$dev'" ;;
    esac
  done
fi

# No cursor: carbon-kiosk.service starts X with -nocursor, so none is ever drawn.
# Not unclutter: it is not installed here, and its two packages behave differently
# (unclutter-xfixes' `-idle 0` hides the pointer only until the first input).

# --- browser -----------------------------------------------------------------
# `chromium` first: on Raspberry Pi OS bookworm it is the real package, and
# chromium-browser only a transitional name for it.
BROWSER=""
for c in chromium chromium-browser google-chrome-stable; do
  command -v "$c" >/dev/null && { BROWSER="$c"; break; }
done
[ -z "$BROWSER" ] && { log "FATAL: no chromium found"; sleep 5; exit 1; }
log "using $BROWSER -> $KIOSK_URL"

# A power cut mid-write leaves 'Exited cleanly: false' in Preferences, and Chromium
# then covers the UI with a restore-session bubble that nobody is there to dismiss.
PREF="$KIOSK_PROFILE/Default/Preferences"
if [ -f "$PREF" ]; then
  sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$PREF" 2>/dev/null
fi
mkdir -p "$KIOSK_PROFILE"

# Keep Chromium's scratch and shared-memory files off the SD card. On this OS every
# launch goes through the /usr/bin/chromium wrapper, whose /etc/chromium.d flags
# include --disable-dev-shm-usage (Debian #1072299): shared memory then goes to
# TMPDIR, i.e. /tmp on the SD card. Point TMPDIR at the unit's RuntimeDirectory
# instead: RAM, private to this user, removed at stop, and NOT under /dev/shm, which
# logind's RemoveIPC= empties of this user's files when their last SSH session ends.
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ] && [ -w "$XDG_RUNTIME_DIR" ]; then
  export TMPDIR="$XDG_RUNTIME_DIR/tmp"
  mkdir -p -m 700 "$TMPDIR"
fi

# --disable-renderer-accessibility: rpi-chromium-mods' /etc/chromium.d flags force full
# renderer accessibility, a CPU and memory cost on a Pi that a touch panel never uses.
# Chromium only checks that the switch is present, and checks this one first.
exec "$BROWSER" \
  --kiosk --app="$KIOSK_URL" \
  --user-data-dir="$KIOSK_PROFILE" \
  --window-size="$KIOSK_SIZE" --window-position=0,0 \
  --start-fullscreen \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --disable-features=Translate,TranslateUI,InfiniteSessionRestore,MediaRouter \
  --no-first-run --fast --fast-start \
  --disable-pinch --overscroll-history-navigation=0 \
  --disable-translate --disable-notifications --disable-sync \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --disable-pip \
  --disable-renderer-accessibility \
  --enable-features=OverlayScrollbar \
  ${KIOSK_EXTRA_FLAGS:-}
