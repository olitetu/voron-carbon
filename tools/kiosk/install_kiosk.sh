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
# || true: after an SSH hangup (trap '' HUP) writes to the dead pty fail with EIO, and
# a lost message must not end the script under set -e mid-swap.
say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*" || true; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*" || true; }
fail() { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

# The way back from KlipperScreen to Carbon, printed wherever one is needed.
# reset-failed first: after a start-limit trip (or a few rehearsals) systemd refuses
# a plain start with "Start request repeated too quickly". Enable+start carbon
# BEFORE disabling KlipperScreen, so no step leaves both disabled.
COME_BACK='sudo systemctl reset-failed carbon-kiosk; sudo systemctl enable --now carbon-kiosk && sudo systemctl disable KlipperScreen'
LIBDIR=/usr/local/lib/carbon-kiosk

if [ "$UNINSTALL" = 1 ]; then
  say "Removing the kiosk and restoring KlipperScreen"
  # Read these BEFORE deleting the files that record them. `systemctl show` prints an
  # empty value (exit 0) for a unit that does not exist.
  K_USER="$(systemctl show -p User --value carbon-kiosk.service 2>/dev/null || true)"
  [ -n "$K_USER" ] || K_USER="$(systemctl show -p User --value KlipperScreen.service 2>/dev/null || true)"
  K_USER="${K_USER:-${SUDO_USER:-$USER}}"
  K_HOME="$(getent passwd "$K_USER" | cut -d: -f6 || true)"
  K_PROFILE="$( (. /etc/default/carbon-kiosk 2>/dev/null; echo "${KIOSK_PROFILE:-}") || true)"

  # 1. Panel first. Nothing in this step may abort (set -e) before KlipperScreen is
  #    started, so each step that can fail says so and carries on. KlipperScreen is
  #    enabled before carbon-kiosk is disabled: never a boot with neither.
  trap '' HUP INT
  sudo systemctl enable KlipperScreen.service || warn "enabling KlipperScreen failed; continuing"
  sudo systemctl disable --now carbon-kiosk.service || warn "disabling carbon-kiosk failed; continuing"
  sudo rm -f /etc/systemd/system/multi-user.target.wants/carbon-kiosk.service \
             /etc/systemd/system/carbon-kiosk.service /etc/systemd/system/carbon-kiosk-fallback.service \
             /usr/local/bin/carbon-panel-rollback /etc/default/carbon-kiosk || warn "removing the kiosk files failed; continuing"
  sudo rm -rf "$LIBDIR" || warn "removing $LIBDIR failed; continuing"
  sudo systemctl daemon-reload || warn "daemon-reload failed; continuing"
  sudo systemctl reset-failed carbon-kiosk.service carbon-kiosk-fallback.service 2>/dev/null || true
  sudo systemctl start KlipperScreen.service || warn "starting KlipperScreen failed; see the log below"
  trap - HUP INT

  # 2. Check that it STAYS up, not just that it started.
  n0="$(systemctl show -p NRestarts --value KlipperScreen.service 2>/dev/null || true)"; sleep 8
  n1="$(systemctl show -p NRestarts --value KlipperScreen.service 2>/dev/null || true)"
  st="$(systemctl is-active KlipperScreen.service || true)"
  if [ "$st" != active ] || [ "${n1:-0}" != "${n0:-0}" ]; then
    warn "KlipperScreen is $st and restarted $(( ${n1:-0} - ${n0:-0} )) time(s) in 8 s. Recent log:"
    journalctl -u KlipperScreen -n 30 --no-pager | sed 's/^/    /' || true
  fi

  # 3. Cosmetic cleanup. Never fatal.
  ASVC="$K_HOME/printer_data/moonraker.asvc"
  if [ -n "$K_HOME" ] && [ -f "$ASVC" ] && grep -qx carbon-kiosk "$ASVC"; then
    if sudo sed -i '/^carbon-kiosk$/d' "$ASVC"; then
      say "removed carbon-kiosk from moonraker.asvc (Moonraker reads it only at startup; restart it when not printing)"
    else
      warn "could not edit $ASVC"
    fi
  fi
  [ -n "$K_HOME" ] && rm -rf "$K_HOME/carbon-kiosk" || true
  [ -n "$K_PROFILE" ] && say "Chromium profile left at $K_PROFILE (rm -rf it to reclaim space)"
  say "Done. KlipperScreen: $(systemctl is-active KlipperScreen.service || true)"
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
# `chromium` is the real package on Raspberry Pi OS bookworm; chromium-browser is
# only a transitional name for it. No unclutter: the unit starts X with -nocursor.
BROWSER=""
for c in chromium chromium-browser google-chrome-stable; do command -v "$c" >/dev/null && { BROWSER="$c"; break; }; done
[ -n "$BROWSER" ] || fail "No chromium found. Install it BEFORE taking the panel down (CUTOVER Phase 4, step 0):  sudo apt update && sudo apt install -y chromium"
say "browser: $BROWSER ($($BROWSER --version 2>/dev/null | head -1))"
command -v xinit >/dev/null || fail "xinit not found:  sudo apt install -y xinit"

if [ -r /etc/X11/Xwrapper.config ]; then
  grep -q 'allowed_users=anybody' /etc/X11/Xwrapper.config \
    || warn "/etc/X11/Xwrapper.config lacks allowed_users=anybody — xinit as $KS_USER may be refused."
fi
id -nG "$KS_USER" | tr ' ' '\n' | grep -qx tty   || warn "$KS_USER is not in the 'tty' group."
id -nG "$KS_USER" | tr ' ' '\n' | grep -qx video || warn "$KS_USER is not in the 'video' group."
# The kiosk has no logind session (no PAMName), so GPU access cannot come from
# logind's per-session device ACLs; group membership is what is left.
id -nG "$KS_USER" | tr ' ' '\n' | grep -qx render || warn "$KS_USER is not in the 'render' group — Chromium may fall back to software rendering."
# RPi kernels leave the memory cgroup controller off without cgroup_enable=memory.
grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null \
  || warn "memory cgroup controller is off: the unit's MemoryHigh/MemoryMax are inert (OOMScoreAdjust still makes the kernel kill the panel before Klipper). See CUTOVER Phase 5."

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
HOME_DIR="$(getent passwd "$KS_USER" | cut -d: -f6 || true)"
[ -n "$HOME_DIR" ] || fail "no passwd entry for $KS_USER (User= of KlipperScreen.service). Nothing was installed."
install -d -o "$KS_USER" -g "$KS_USER" "$HOME_DIR/carbon-kiosk"
sudo install -m 0755 -o "$KS_USER" -g "$KS_USER" "$HERE/carbon-kiosk-session.sh" "$HOME_DIR/carbon-kiosk/carbon-kiosk-session.sh"
sudo install -m 0755 -o "$KS_USER" -g "$KS_USER" "$HERE/carbon-kiosk-wait.sh" "$HOME_DIR/carbon-kiosk/carbon-kiosk-wait.sh"
say "installed $HOME_DIR/carbon-kiosk/carbon-kiosk-session.sh and carbon-kiosk-wait.sh"

printf 'KIOSK_URL=%s\nKIOSK_SIZE=1024,600\nKIOSK_PROFILE=%s/.carbon-kiosk\n# KIOSK_ROTATE=\n# KIOSK_TOUCH_MATRIX=\n# KIOSK_EXTRA_FLAGS=\n' \
  "$KIOSK_URL" "$HOME_DIR" | sudo tee /etc/default/carbon-kiosk >/dev/null
say "wrote /etc/default/carbon-kiosk"

sed -e "s|__USER__|$KS_USER|g" -e "s|__TTY__|$KS_TTY|g" -e "s|__TTY_VT__|$VT|g" \
  "$HERE/carbon-kiosk.service" | sudo tee /etc/systemd/system/carbon-kiosk.service >/dev/null
sudo install -m 0644 "$HERE/carbon-kiosk-fallback.service" /etc/systemd/system/carbon-kiosk-fallback.service
# The fallback runs as root, so its script lives root-owned outside anyone's home.
sudo install -d -m 0755 "$LIBDIR"
sudo install -m 0755 "$HERE/carbon-kiosk-fallback.sh" "$LIBDIR/fallback.sh"
sudo install -m 0755 "$HERE/carbon-panel-rollback" /usr/local/bin/carbon-panel-rollback
sudo systemctl daemon-reload
say "installed carbon-kiosk.service, its fallback ($LIBDIR/fallback.sh), and /usr/local/bin/carbon-panel-rollback"

# ── 4b. prove systemd applied what the automatic fallback depends on ────────────
# The fallback once shipped dead because systemd 252 silently ignored a key in the
# wrong section. Check the values systemd is actually USING, before the panel is
# touched. Output is captured first, then grepped from a here-string, so pipefail
# and SIGPIPE cannot hide a match. Keep the numbers in step with carbon-kiosk.service.
VERIFY="$(systemd-analyze verify /etc/systemd/system/carbon-kiosk.service /etc/systemd/system/carbon-kiosk-fallback.service 2>&1 || true)"
if grep -qi 'carbon-kiosk.*unknown' <<<"$VERIFY"; then
  grep -i 'carbon-kiosk' <<<"$VERIFY" | sed 's/^/    /' || true
  fail "systemd ignores part of the kiosk units (above). Nothing was switched; KlipperScreen is untouched."
fi
SL_I="$(systemctl show -p StartLimitIntervalUSec --value carbon-kiosk.service)"
SL_B="$(systemctl show -p StartLimitBurst --value carbon-kiosk.service)"
T_S="$(systemctl show -p TimeoutStartUSec --value carbon-kiosk.service)"
say "systemd applies: start limit $SL_B starts per $SL_I, start timeout $T_S"
[ "$SL_I" = 5min ] && [ "$SL_B" = 4 ] && [ "$T_S" = 40s ] \
  || fail "carbon-kiosk's start limit is not 4 / 5min / 40s, so the automatic fallback to KlipperScreen would never fire. Nothing was switched."
grep -q -- ' -nocursor' /etc/systemd/system/carbon-kiosk.service \
  || fail "the installed unit does not start X with -nocursor. Nothing was switched."

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
# EOF (^D, no tty) makes read return 1: take it as "no". Not || true: "y" then ^D leaves reply=y.
read -r -p "  Proceed? [y/N] " reply || reply=""
case "$reply" in [yY]*) ;; *) echo "  Aborted. Nothing was switched; the units are installed but not enabled."; exit 0 ;; esac

# Order is the safety here: after every step the panel has a UI now or at next boot.
#   enable carbon  -> both enabled: at boot Conflicts= lets carbon win (systemd.unit(5))
#   disable KS     -> boot state is carbon only; KlipperScreen is still on the panel now
#   stop KS, start carbon -> the only dark moment, and the boot state is already right
# The old `disable --now KS` then `enable --now carbon` left BOTH disabled if the SSH
# session, which runs over the panel's own wifi, dropped between the two.
trap '' HUP INT                                   # a dropped session or stray ^C cannot leave the swap half-done
sudo systemctl enable  carbon-kiosk.service
sudo systemctl disable KlipperScreen.service
sync                                              # this Pi browns out: get the boot state onto disk first
sudo systemctl stop KlipperScreen.service || true # explicit and ordered, not left to Conflicts= timing
if ! sudo systemctl start carbon-kiosk.service; then
  # HUP/INT stay ignored through the rescue below: a ^C or a dropped session while the log
  # prints must not stop the script before it hands the panel back. It exits right after.
  warn "carbon-kiosk failed to start. Recent log:"
  journalctl -u carbon-kiosk -n 30 --no-pager | sed 's/^/    /' || true
  # KlipperScreen is already stopped. Do not leave the panel dark while the start limit
  # runs out: if systemd has already given up, hand the panel back right now.
  if systemctl is-failed --quiet carbon-kiosk.service; then
    sudo systemctl start KlipperScreen.service && warn "KlipperScreen is back on the panel for this boot."
  else
    warn "It keeps retrying and hands the panel to KlipperScreen by itself within ~3 min if it cannot."
  fi
  warn "Put the old panel back for good with:  sudo carbon-panel-rollback"
  exit 1
fi
trap - HUP INT

# A crash loop can look healthy at any single instant: with RestartSec=5, a kiosk
# that dies 1 s after starting is "active" again 6 s later. Watch long enough for
# several cycles, and require zero restarts and a running browser.
say "Watching carbon-kiosk for 20 s (a crash loop restarts every ~5 s)..."
sleep 20
NR="$(systemctl show -p NRestarts --value carbon-kiosk.service)"
ST="$(systemctl is-active carbon-kiosk.service || true)"
CHROME=absent
pgrep -u "$KS_USER" -f -- "--user-data-dir=$HOME_DIR/.carbon-kiosk" >/dev/null && CHROME=running
echo
printf '  KlipperScreen : %s\n' "$(systemctl is-active KlipperScreen.service || true)"
printf '  carbon-kiosk  : %s (restarts: %s, chromium: %s)\n' "$ST" "$NR" "$CHROME"
echo
if [ "$NR" = 0 ] && [ "$ST" = active ] && [ "$CHROME" = running ]; then
  say "Carbon Screen is up and has not restarted. Look at the panel now."
  say "Re-check in a minute:  systemctl show -p NRestarts carbon-kiosk   (must still be 0)"
else
  warn "carbon-kiosk is not staying up (state=$ST, restarts=$NR, chromium $CHROME). Recent log:"
  journalctl -u carbon-kiosk -n 30 --no-pager | sed 's/^/    /' || true
  warn "Put the old panel back with:  sudo carbon-panel-rollback"
  exit 1
fi
cat <<NEXT

  Roll back      sudo carbon-panel-rollback
  Come back      $COME_BACK
  Watch          journalctl -u carbon-kiosk -u carbon-kiosk-fallback -f
  Remove         bash install_kiosk.sh --uninstall

  Every start counts toward the fallback's limit, manual ones included: a 5th
  start or restart of carbon-kiosk inside 5 minutes (Moonraker's services menu
  too) hands the panel to KlipperScreen. That is safe; the "Come back" line
  undoes it.

  Test the two boots before you trust it: reboot, then a cold power cycle.
NEXT
