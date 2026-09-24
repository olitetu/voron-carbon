#!/usr/bin/env bash
#
#   tools/kiosk/install_kiosk.sh [--url URL] [--dry-run] [--uninstall]
#
# Puts Carbon Screen on the printer's physical panel, in place of KlipperScreen.
#
# It does NOT guess how your panel is driven. It reads the installed KlipperScreen
# unit for the user and tty and reuses them, because that unit is the only proof of
# what actually works on this hardware.
#
# KlipperScreen is STOPPED AND DISABLED, never removed: its unit, its config and its
# menus all stay, and `sudo carbon-panel-rollback` brings it back in one command.
#
# Run it over SSH, from a machine that is not the printer, with the panel in view.
set -euo pipefail

URL_DEFAULT="http://127.0.0.1:8767/screen.html"
KIOSK_URL="$URL_DEFAULT"
DRY=0
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) KIOSK_URL="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*"; }
fail() { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  say "Removing the kiosk and restoring KlipperScreen"
  sudo systemctl disable --now carbon-kiosk.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/carbon-kiosk.service \
             /etc/systemd/system/carbon-kiosk-fallback.service \
             /usr/local/bin/carbon-panel-rollback /etc/default/carbon-kiosk
  sudo systemctl daemon-reload
  sudo systemctl enable --now KlipperScreen.service
  say "Done. KlipperScreen is back: $(systemctl is-active KlipperScreen.service)"
  exit 0
fi

# ── 1. learn the machine, do not assume it ──────────────────────────────────────
say "Reading the installed KlipperScreen unit"
systemctl cat KlipperScreen.service >/tmp/ks.unit 2>/dev/null \
  || fail "KlipperScreen.service not found. This script reuses its user and tty; without it, set them by hand."

KS_USER="$(awk -F= '/^User=/{print $2; exit}' /tmp/ks.unit)"
KS_TTY="$(awk -F= '/^TTYPath=/{print $2; exit}' /tmp/ks.unit)"
KS_EXEC="$(awk -F= '/^ExecStart=/{sub(/^ExecStart=/,""); print; exit}' /tmp/ks.unit)"
KS_USER="${KS_USER:-${SUDO_USER:-$USER}}"
KS_TTY="${KS_TTY:-/dev/tty7}"
VT="vt${KS_TTY##*tty}"

say "  user     : $KS_USER"
say "  tty      : $KS_TTY  ($VT)"
say "  execstart: ${KS_EXEC:-unknown}"
echo "$KS_EXEC" | grep -qi 'wayland\|sway\|weston\|cage' \
  && warn "KlipperScreen looks like it starts a WAYLAND session. This kiosk is X11 (xinit); check before proceeding."

# ── 2. dependencies ─────────────────────────────────────────────────────────────
BROWSER=""
for c in chromium-browser chromium google-chrome-stable; do command -v "$c" >/dev/null && { BROWSER="$c"; break; }; done
[ -n "$BROWSER" ] || fail "No chromium found. Install it BEFORE taking the panel down:  sudo apt install -y chromium-browser"
say "browser: $BROWSER ($($BROWSER --version 2>/dev/null | head -1))"
command -v xinit >/dev/null || fail "xinit not found:  sudo apt install -y xinit"
command -v unclutter >/dev/null || warn "unclutter not installed — the mouse cursor may show:  sudo apt install -y unclutter"

if [ -r /etc/X11/Xwrapper.config ]; then
  grep -q 'allowed_users=anybody' /etc/X11/Xwrapper.config \
    || warn "/etc/X11/Xwrapper.config lacks allowed_users=anybody — xinit as $KS_USER may be refused."
fi
id -nG "$KS_USER" | tr ' ' '\n' | grep -qx tty   || warn "$KS_USER is not in the 'tty' group."
id -nG "$KS_USER" | tr ' ' '\n' | grep -qx video || warn "$KS_USER is not in the 'video' group."

# ── 3. is the UI actually being served? ─────────────────────────────────────────
say "Checking the UI is up at $KIOSK_URL"
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$KIOSK_URL" || echo 000)"
[ "$code" = 200 ] || fail "$KIOSK_URL returned $code. Run tools/install.sh first; do not take the panel down until this is 200."
say "  $KIOSK_URL -> 200"
safe="${KIOSK_URL%/*}/safe.html"
[ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$safe" || echo 000)" = 200 ] \
  && say "  safe mode -> 200" || warn "safe.html is NOT served. Install it: it is the fallback when the app bundle breaks."

if [ "$DRY" = 1 ]; then
  say "Dry run: would install carbon-kiosk for $KS_USER on $KS_TTY ($VT) at $KIOSK_URL"
  exit 0
fi

# ── 4. install ──────────────────────────────────────────────────────────────────
HOME_DIR="$(getent passwd "$KS_USER" | cut -d: -f6)"
install -d -o "$KS_USER" -g "$KS_USER" "$HOME_DIR/carbon-kiosk"
sudo install -m 0755 -o "$KS_USER" -g "$KS_USER" "$HERE/carbon-kiosk-session.sh" "$HOME_DIR/carbon-kiosk/carbon-kiosk-session.sh"
say "installed $HOME_DIR/carbon-kiosk/carbon-kiosk-session.sh"

printf 'KIOSK_URL=%s\nKIOSK_SIZE=1024,600\nKIOSK_PROFILE=%s/.carbon-kiosk\n# KIOSK_ROTATE=\n# KIOSK_TOUCH_MATRIX=\n# KIOSK_EXTRA_FLAGS=\n' \
  "$KIOSK_URL" "$HOME_DIR" | sudo tee /etc/default/carbon-kiosk >/dev/null
say "wrote /etc/default/carbon-kiosk"

sed -e "s|__USER__|$KS_USER|g" -e "s|__TTY__|$KS_TTY|g" -e "s|__TTY_VT__|$VT|g" \
  "$HERE/carbon-kiosk.service" | sudo tee /etc/systemd/system/carbon-kiosk.service >/dev/null
sudo install -m 0644 "$HERE/carbon-kiosk-fallback.service" /etc/systemd/system/carbon-kiosk-fallback.service
sudo install -m 0755 "$HERE/carbon-panel-rollback" /usr/local/bin/carbon-panel-rollback
sudo systemctl daemon-reload
say "installed carbon-kiosk.service, its fallback, and /usr/local/bin/carbon-panel-rollback"

# Let Moonraker restart the panel from the UI (MACHINE -> services).
ASVC="$HOME_DIR/printer_data/moonraker.asvc"
if [ -f "$ASVC" ] && ! grep -qx carbon-kiosk "$ASVC"; then
  echo carbon-kiosk | sudo tee -a "$ASVC" >/dev/null
  say "added carbon-kiosk to moonraker.asvc (restart Moonraker for it to take effect)"
fi

# ── 5. the swap ─────────────────────────────────────────────────────────────────
echo
warn "About to stop KlipperScreen and start Carbon on the panel."
warn "KlipperScreen is only DISABLED — 'sudo carbon-panel-rollback' undoes this in one command."
read -r -p "  Proceed? [y/N] " reply
case "$reply" in [yY]*) ;; *) echo "  Aborted. Nothing was switched; the units are installed but not enabled."; exit 0 ;; esac

sudo systemctl disable --now KlipperScreen.service
sudo systemctl enable  --now carbon-kiosk.service
sleep 6
echo
printf '  KlipperScreen : %s\n' "$(systemctl is-active KlipperScreen.service)"
printf '  carbon-kiosk  : %s\n' "$(systemctl is-active carbon-kiosk.service)"
echo
if [ "$(systemctl is-active carbon-kiosk.service)" != active ]; then
  warn "carbon-kiosk is not active. Recent log:"
  journalctl -u carbon-kiosk -n 30 --no-pager | sed 's/^/    /'
  warn "Put the old panel back with:  sudo carbon-panel-rollback"
  exit 1
fi
say "Carbon Screen is on the panel. Look at it now."
cat <<'NEXT'

  Roll back      sudo carbon-panel-rollback
  Come back      sudo systemctl disable --now KlipperScreen && sudo systemctl enable --now carbon-kiosk
  Watch          journalctl -u carbon-kiosk -f
  Remove         bash install_kiosk.sh --uninstall

  Test the two boots before you trust it: reboot, then a cold power cycle.
NEXT
