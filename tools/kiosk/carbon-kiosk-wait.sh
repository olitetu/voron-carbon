#!/usr/bin/env bash
# ExecStartPre of carbon-kiosk.service: wait until the panel's page is really being
# served before X and Chromium start. Installed next to carbon-kiosk-session.sh.
#
# Why a script and not an inline `sh -c` in the unit: systemd expands $VAR, ${VAR}
# and %-specifiers in unit lines before sh ever sees them. Nothing is rewritten here.
#
# Why it gives up after ~30 s: it runs under the unit's TimeoutStartSec=40, and each
# failed attempt is one start counted toward StartLimitBurst=4 in 300 s. Short
# attempts are what let a dead UI reach start-limit-hit, and so the fallback to
# KlipperScreen, in ~2.5 min. 30 s is ample: the unit is ordered After=nginx.service,
# so nginx is already listening, and a static page on loopback answers in
# milliseconds. A boot where it is slower simply gets the next attempts.
set -u

CONF=/etc/default/carbon-kiosk
[ -r "$CONF" ] && . "$CONF"
: "${KIOSK_URL:=http://127.0.0.1:8767/screen.html}"

WAIT=30        # keep the worst case (WAIT + 2 s sleep + 2 x 3 s curl = 38 s) under TimeoutStartSec=40

# The page, and for Carbon Screen its bundle too: a 200 screen.html next to a 404
# screen.js (a bad release, a half-finished build) is still a black panel.
PROBES=("$KIOSK_URL")
case "$KIOSK_URL" in
  */screen.html) PROBES+=("${KIOSK_URL%/*}/screen.js") ;;
esac

deadline=$((SECONDS + WAIT))
last=""
while :; do
  ok=1
  for u in "${PROBES[@]}"; do
    if ! err="$(curl -fsS -m 3 -o /dev/null "$u" 2>&1)"; then
      ok=0; last="$u: $err"; break
    fi
  done
  [ "$ok" = 1 ] && exit 0
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep 2
done
echo "carbon-kiosk: UI never came up within ${WAIT}s (last: ${last:-no answer})"
exit 1
