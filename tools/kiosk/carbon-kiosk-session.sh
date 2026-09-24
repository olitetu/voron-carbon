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
# BUT NOT with `xset -dpms`, which is what you reach for first and is wrong here.
# That disables the DPMS extension outright, and this is an HDMI panel: DPMS is the
# ONLY way to turn the screen off (there is no /sys/class/backlight node on HDMI).
# Disabling it would make the helper's screen-off a silent no-op.
#
# So: leave DPMS ENABLED and set every automatic timeout to zero. The screen never
# blanks on its own, and `xset dpms force off` still works when the user asks for it.
xset s off
xset s noblank
xset dpms 0 0 0

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

command -v unclutter >/dev/null && unclutter -idle 0 -root &

# --- browser -----------------------------------------------------------------
BROWSER=""
for c in chromium-browser chromium google-chrome-stable; do
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
  --enable-features=OverlayScrollbar \
  ${KIOSK_EXTRA_FLAGS:-}
