#!/usr/bin/env bash
# Install the Carbon Screen host helper (wifi, and screen-off or backlight).
#
# Run ON THE PRINTER, over SSH, as your normal user (the script calls sudo
# itself), from your git checkout, while you can still reach the printer:
#     cd ~/voron-carbon && bash tools/helper/install_helper.sh
#
# Never copy tools/ into ~/printer_data: Moonraker's file API lets every trusted
# LAN client write there, and this script installs, as root, what it finds next
# to itself. It refuses to run from there, and from a checkout whose tools/helper
# has local changes.
#
# First, CUTOVER Phase 1: tools/install.sh, from this same checkout, must have
# (re)generated the Carbon nginx site, which carries the /helper/ block. This
# script checks that before it changes anything, and stops if it is not so.
#
# What it installs (--uninstall removes each):
#   user carbon-net          system user: no home, no login shell, no groups
#                            (`video` only when a backlight device exists)
#   /usr/local/lib/carbon-helper/carbon_helper.py      root-owned
#   /etc/systemd/system/carbon-helper.service         runs it as carbon-net, 127.0.0.1:8770
#   /etc/polkit-1/rules.d/60-carbon-network.rules     NetworkManager, for carbon-net only
#   /etc/udev/rules.d/60-carbon-backlight.rules       only when a backlight device exists
#
# Reversible:  cd ~/voron-carbon && bash tools/helper/install_helper.sh --uninstall
# removes all of the above. It keeps any wifi profiles saved from the panel, and
# never touches KlipperScreen's polkit rule or anyone's group memberships.
#
# It does NOT touch your network configuration. It installs a service that CAN
# change it later, from the touchscreen.
set -euo pipefail

USER_NAME="${SUDO_USER:-${USER:-$(id -un)}}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6 || true)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC_USER=carbon-net
DEST=/usr/local/lib/carbon-helper
UNIT=/etc/systemd/system/carbon-helper.service
POLKIT=/etc/polkit-1/rules.d/60-carbon-network.rules
UDEV=/etc/udev/rules.d/60-carbon-backlight.rules
SITE_PORT=8767        # the Carbon nginx site (tools/install.sh --port)
HELPER_PORT=8770      # carbon-helper.service: CARBON_HELPER_PORT
IFACE=wlan0           # carbon-helper.service: CARBON_HELPER_IFACE
# The helper refuses every request without this header; nginx sets it from $server_addr.
# The direct calls to :8770 below send it by hand.
LOCAL_HDR='X-Carbon-Local-Addr: 127.0.0.1'

say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*"; }
die()  { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

# ================================================================ uninstall
if [[ "${1:-}" == "--uninstall" ]]; then
  if systemctl is-active --quiet carbon-kiosk 2>/dev/null; then
    warn "The panel will lose its wifi and screen-off controls. Afterwards, restart it so it"
    warn "re-probes the helper:  sudo systemctl restart carbon-kiosk"
  fi
  say "Stopping and removing the helper"
  sudo systemctl disable --now carbon-helper 2>/dev/null || true
  sudo rm -f -- "$UNIT" "$POLKIT" "$UDEV"
  sudo systemctl daemon-reload
  sudo systemctl reset-failed carbon-helper 2>/dev/null || true
  sudo udevadm control --reload 2>/dev/null || true
  sudo rm -rf -- "$DEST"
  if getent passwd "$SVC_USER" >/dev/null; then
    sudo userdel "$SVC_USER" || warn "Could not remove the $SVC_USER user; remove it by hand:  sudo userdel $SVC_USER"
  fi
  say "Removed the program, its unit, its polkit rule, the udev rule and the $SVC_USER user."
  say "Kept: wifi profiles saved from the panel, KlipperScreen's polkit rule, every group membership."
  say "nginx needs no change: the /helper/ location that tools/install.sh generates stays. With no"
  say "helper it answers 502 on loopback (403 from the LAN), and the panel hides wifi and screen-off."
  say "Do not hand-edit the generated site."
  exit 0
fi

# ================================================================ 0. preflight: changes nothing
(( EUID != 0 )) || die "Run as your normal user over SSH (the script calls sudo itself), not as root or via sudo."

# ---- where this script runs from. This protects a genuine script whose sibling
#      files were changed; it cannot protect against a planted script.
REAL="$(cd "$HERE" && pwd -P)"
PD="$(cd "$HOME_DIR/printer_data" 2>/dev/null && pwd -P || true)"
if [[ -n "$PD" ]]; then
  case "$REAL/" in
    "$PD"/*) die "Refusing to run from $REAL: Moonraker lets every trusted LAN client write there. Run it from your git checkout:  cd ~/voron-carbon && bash tools/helper/install_helper.sh" ;;
  esac
fi
command -v git >/dev/null || die "git not found. Run this from a git checkout of voron-carbon."
TOP="$(git -C "$REAL" rev-parse --show-toplevel 2>/dev/null)" \
  || die "$REAL is not inside a git checkout. Run it from your clone:  cd ~/voron-carbon && bash tools/helper/install_helper.sh"
DIRTY="$(git --no-optional-locks -C "$TOP" status --porcelain -- "$REAL")" \
  || die "git status failed in $TOP"
[[ -z "$DIRTY" ]] || die "tools/helper has local changes. Review them (git -C $TOP diff -- tools/helper), then commit or discard them, and re-run:
$DIRTY"

command -v nmcli   >/dev/null || die "nmcli not found. NetworkManager is required."
command -v curl    >/dev/null || die "curl not found:  sudo apt install -y curl"
command -v ip      >/dev/null || die "ip not found:  sudo apt install -y iproute2"
[[ -x /usr/bin/python3 ]]     || die "/usr/bin/python3 not found; carbon-helper.service runs it by that path."
sudo -v || die "sudo is required."
sudo test -d /etc/polkit-1/rules.d || die "/etc/polkit-1/rules.d is missing -- is polkitd installed?  (sudo apt install -y polkitd)"

# ---- nginx. The /helper/ block belongs to tools/install.sh; this only checks it.
say "Checking the nginx /helper/ block"
NGX="$(sudo nginx -T 2>/dev/null)" || die "sudo nginx -T failed: nginx's configuration does not load. See:  sudo nginx -t"
SITE_ROOT="$(awk -v p="listen $SITE_PORT" 'index($0, p) {b = 1} b && $1 == "root" {sub(/;$/, "", $2); print $2; exit}' <<<"$NGX")"
REGEN="cd $TOP && bash tools/install.sh --root ${SITE_ROOT:-<the root the site serves>} --port $SITE_PORT"
HELPER_LOC='^[[:space:]]*location[[:space:]]+\^~[[:space:]]+/helper/'
N="$(grep -cE "$HELPER_LOC" <<<"$NGX" || true)"
[[ "$N" == 1 ]] || die "nginx has ${N:-0} 'location ^~ /helper/' blocks, expected exactly 1. Do NOT hand-edit the site; regenerate it:  $REGEN"
BLOCK="$(awk '/^[[:space:]]*location[[:space:]]+\^~[[:space:]]+\/helper\// {b = 1} b {print} b && /}/ {exit}' <<<"$NGX")"
if ! grep -qE '^[[:space:]]*allow[[:space:]]+127\.0\.0\.1;' <<<"$BLOCK" \
   || ! grep -qE '^[[:space:]]*deny[[:space:]]+all;' <<<"$BLOCK"; then
  die "The /helper/ block does not say  allow 127.0.0.1; ... deny all;  Regenerate the site:  $REGEN"
fi
if ! grep -qE 'proxy_set_header[[:space:]]+X-Carbon-Local-Addr[[:space:]]+\$server_addr;' <<<"$BLOCK"; then
  die "The /helper/ block predates X-Carbon-Local-Addr, and this helper refuses every request without it. Regenerate the site from this checkout:  $REGEN"
fi
REALIP="$(grep -nE '^[[:space:]]*(set_real_ip_from|real_ip_header)[[:space:]]' <<<"$NGX" || true)"
if [[ -n "$REALIP" ]]; then
  warn "nginx uses the realip module. It rewrites \$remote_addr, which allow/deny test, so the"
  warn "/helper/ allow/deny may not mean what it says. The helper's own check reads \$server_addr,"
  warn "which realip cannot change, so it still holds. Check this does not apply to port $SITE_PORT:"
  sed 's/^/      /' <<<"$REALIP"
fi

# ---- a LAN client must get 403 from /helper/. Tested against this Pi's own LAN addresses:
#      nginx then sees the LAN address on both ends, exactly as for a client on the LAN.
LAN4="$(ip -4 -o addr show dev "$IFACE" 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4; exit}' || true)"
LAN6="$(ip -6 -o addr show dev "$IFACE" scope link 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4; exit}' || true)"
lan_refused() {   # $1 label, $2 URL, $3 v4|v6
  local code
  code="$(curl -sg -o /dev/null -m 5 -w '%{http_code}' "$2" || true)"
  case "$code" in
    403) say "  $1 -> 403" ;;
    404) die "/helper/ answered 404 via $1: the RUNNING nginx site has no /helper/ block. Reload nginx (sudo systemctl reload nginx), or regenerate:  $REGEN" ;;
    000) if [[ "$3" == v6 ]]; then
           warn "  $1 -> no answer: IPv6 is untested here, not passed. Check it from your laptop (see the end)."
         else
           die "Nothing answered on $1:$SITE_PORT, so the LAN check could not run. Is nginx up?"
         fi ;;
    *)   die "/helper/ answered $code via $1, expected 403: the loopback-only rule is not in effect. Do not continue." ;;
  esac
}
say "Checking that the LAN is refused at /helper/"
if [[ -n "$LAN4" ]]; then lan_refused "$LAN4" "http://$LAN4:$SITE_PORT/helper/health" v4; fi
if [[ -n "$LAN6" ]]; then lan_refused "[$LAN6]" "http://[$LAN6%25$IFACE]:$SITE_PORT/helper/health" v6; fi
[[ -n "$LAN4$LAN6" ]] || warn "$IFACE has no address, so the LAN check cannot run here. Run it from your laptop (see the end)."

# ================================================================ from here on, things change
on_exit() {
  local rc=$?
  trap '' INT HUP   # a second ^C must not cut the disable below short
  set +e   # errexit stays on in a trap: a warn to a hung-up SSH pty would end it before the disable
  # Not rc == 0: a SIGHUP/SIGINT mid-command can run this trap with $? still 0 from the command before.
  [[ -n "${INSTALL_DONE:-}" ]] && return 0
  warn "Install stopped (exit $rc). Nothing here touched NetworkManager; wifi is unchanged."
  if [[ -f "$UNIT" ]]; then
    sudo systemctl disable --now carbon-helper 2>/dev/null || true   # stops the Restart=always loop
    warn "The helper is stopped. Why:  sudo journalctl -u carbon-helper -n 30 --no-pager"
  fi
  warn "Undo the rest:  cd $TOP && bash tools/helper/install_helper.sh --uninstall"
}
INSTALL_DONE=""   # set only just before the final message; an inherited value must not skip the rollback
trap on_exit EXIT

say "Installing from $TOP (printer user: $USER_NAME, service user: $SVC_USER)"

# ---------------------------------------------------------------- 1. the service user
if ! getent passwd "$SVC_USER" >/dev/null; then
  sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin --comment "Carbon Screen host helper" "$SVC_USER"
  say "Created system user $SVC_USER"
fi
SVC_UID="$(id -u "$SVC_USER")"
(( SVC_UID != 0 )) || die "$SVC_USER has uid 0. Refusing: the helper must never run as root."
(( SVC_UID < 1000 )) || die "$SVC_USER exists as a regular account (uid $SVC_UID), not this helper's system user. Remove or rename it first."
SVC_SHELL="$(getent passwd "$SVC_USER" | cut -d: -f7)"
case "$SVC_SHELL" in
  /usr/sbin/nologin|/sbin/nologin|/bin/false|/usr/bin/false) ;;
  *) die "$SVC_USER has a login shell ($SVC_SHELL). Refusing; it should be /usr/sbin/nologin." ;;
esac

# ---------------------------------------------------------------- 2. the program, root-owned
sudo install -d -o root -g root -m 0755 "$DEST"
sudo install -o root -g root -m 0755 "$HERE/carbon_helper.py" "$DEST/carbon_helper.py"
say "Installed $DEST/carbon_helper.py (root-owned)"

# ---------------------------------------------------------------- 3. polkit
sudo install -o root -g root -m 0644 "$HERE/60-carbon-network.rules" "$POLKIT"
say "Installed $POLKIT (NetworkManager, for $SVC_USER only)"
# Root does the lookup: rules.d may not be readable by this user.
KS_RULES="$(sudo find /etc/polkit-1/rules.d /usr/share/polkit-1/rules.d -maxdepth 1 -name 'KlipperScreen.rules' 2>/dev/null || true)"
if [[ -n "$KS_RULES" ]]; then
  warn "KlipperScreen's polkit rule is present: ${KS_RULES//$'\n'/ }"
  warn "Depending on its version it grants NetworkManager to the 'network' group and/or to user"
  warn "$USER_NAME (plus reboot/power-off). Ours is independent, so removing KlipperScreen will not"
  warn "break wifi; until that file is gone, $USER_NAME's processes can change wifi without the helper."
fi
OTHERS="$(sudo sh -c 'grep -l NetworkManager /etc/polkit-1/rules.d/*.rules /usr/share/polkit-1/rules.d/*.rules 2>/dev/null' \
          | grep -v '/60-carbon-network\.rules$' || true)"
if [[ -n "$OTHERS" ]]; then
  say "Other polkit rules that mention NetworkManager:"
  sed 's/^/      /' <<<"$OTHERS"
fi

# ---------------------------------------------------------------- 4. backlight
if compgen -G "/sys/class/backlight/*" >/dev/null; then
  sudo install -o root -g root -m 0644 "$HERE/60-carbon-backlight.rules" "$UDEV"
  sudo udevadm control --reload
  # --action=add: the rules match ACTION=="add", and trigger sends "change" by default (udevadm(8)).
  sudo udevadm trigger --action=add -s backlight || true
  sudo usermod -aG video "$SVC_USER"
  say "Installed $UDEV and added $SVC_USER to 'video' (backlight: $(ls /sys/class/backlight | tr '\n' ' '))"
else
  warn "No /sys/class/backlight device: this is an HDMI panel, so there is no software brightness."
  warn "Expected, not a fault: the udev rule is skipped, $SVC_USER gets no 'video' group, and the"
  warn "app hides the brightness control."
fi
EXTRA="$(id -nG "$SVC_USER" | tr ' ' '\n' | grep -vxE "$SVC_USER|video" || true)"
[[ -z "$EXTRA" ]] || die "$SVC_USER is in groups it must not be in: ${EXTRA//$'\n'/ }. Remove them (sudo gpasswd -d $SVC_USER <group>) and re-run."

# ---------------------------------------------------------------- 5. the service
sudo install -o root -g root -m 0644 "$HERE/carbon-helper.service" "$UNIT"
grep -qxF "User=$SVC_USER" "$UNIT" || die "$UNIT does not say User=$SVC_USER. Refusing to start it."
grep -qxF "ExecStart=/usr/bin/python3 $DEST/carbon_helper.py" "$UNIT" \
  || die "$UNIT does not run $DEST/carbon_helper.py. Refusing to start it."
sudo systemctl daemon-reload
if ! VERIFY="$(sudo systemd-analyze verify "$UNIT" 2>&1)"; then
  warn "systemd-analyze verify reported problems with $UNIT:"
  sed 's/^/      /' <<<"$VERIFY"
fi
sudo systemctl enable carbon-helper
# restart, not start: "If the units are not running yet, they will be started" (systemctl(1)),
# and a re-run then tests the new carbon_helper.py and unit rather than the old process.
sudo systemctl restart carbon-helper

H="http://127.0.0.1:$HELPER_PORT"
hc()  { curl -fsS -m "${2:-10}" -H "$LOCAL_HDR" "$H$1"; }   # GET straight to the helper; fails on 4xx/5xx
hcb() { curl -sS  -m "${2:-10}" -H "$LOCAL_HDR" "$H$1"; }   # the same, printing the body whatever the status
# Type=simple: restart returns once the process is forked, not once it listens.
UP=""
for _ in $(seq 1 15); do
  if hc /health 2 >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done
[[ -n "$UP" ]] || die "The helper is not answering on 127.0.0.1:$HELPER_PORT 15 s after starting."
say "Service: $(systemctl is-active carbon-helper || true)"
JOURNAL="$(sudo journalctl -b -u carbon-helper --no-pager 2>/dev/null || true)"
if grep -qi 'BPF firewalling not supported' <<<"$JOURNAL"; then
  warn "systemd reports that BPF firewalling is not supported here, so the unit's IPAddressDeny and"
  warn "IPAddressAllow are NOT enforced. The helper still binds 127.0.0.1 only."
fi

# ---------------------------------------------------------------- 6. smoke test
say "Smoke test"
HEALTH="$(hc /health)" || die "The helper stopped answering on :$HELPER_PORT."
printf '    health : %s\n' "$HEALTH"
WANT="$(sha256sum "$DEST/carbon_helper.py" | cut -d' ' -f1)"
grep -qF "\"sha256\": \"$WANT\"" <<<"$HEALTH" \
  || die "The process answering is not the code just installed (sha256 $WANT). Restart it:  sudo systemctl restart carbon-helper"
printf '    net    : %s\n' "$(hc /net || echo '(failed)')"
DISPLAY_JSON="$(hc /display || true)"
printf '    display: %s\n' "${DISPLAY_JSON:-(failed)}"
echo
WIFI="$(hcb /wifi 70 || true)"
if grep -qF '"radio": false' <<<"$WIFI"; then
  warn "The wifi radio is off, so the scan could not be tested."
elif grep -qF '"aps"' <<<"$WIFI"; then
  say "Wifi scan works: the helper can use NetworkManager."
else
  warn "Wifi scan failed: ${WIFI:-no answer}"
  warn "Why:  sudo journalctl -u carbon-helper -n 50 --no-pager"
  warn "      sudo journalctl -u polkit -b --no-pager | grep -iE 'error|rules'   (a rules file that does not compile is reported there)"
  warn "      pkaction | grep NetworkManager   (the action ids this NetworkManager defines)"
fi
if grep -qF '"blank_supported": true' <<<"$DISPLAY_JSON"; then
  say "Screen-off (DPMS) is reachable from the helper."
else
  warn "Screen-off is unavailable to the helper: X on :0 has not admitted $SVC_USER, or has no DPMS."
  warn "The Carbon kiosk session must run  xhost +SI:localuser:$SVC_USER  (KlipperScreen's does not,"
  warn "so this is expected until the kiosk swap). The panel has no screen-off control yet, either."
fi

# ---------------------------------------------------------------- 7. the boundary, with the helper up
say "Checking the nginx /helper/ boundary"
C="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$SITE_PORT/helper/health" || true)"
case "$C" in
  200) say "  127.0.0.1 -> 200" ;;
  403) die "Loopback got 403 through nginx: the RUNNING /helper/ block does not send X-Carbon-Local-Addr. Reload nginx (sudo systemctl reload nginx), or regenerate:  $REGEN" ;;
  *)   die "Loopback got $C from http://127.0.0.1:$SITE_PORT/helper/health, expected 200. Regenerate the site:  $REGEN" ;;
esac
C6="$(curl -sg -o /dev/null -m 5 -w '%{http_code}' "http://[::1]:$SITE_PORT/helper/health" || true)"
if [[ "$C6" == 200 ]]; then say "  [::1] -> 200"; else warn "  [::1] -> $C6, expected 200 (harmless if nginx does not listen on IPv6)"; fi
# Now that the helper answers, a missing deny would show up here as 200.
if [[ -n "$LAN4" ]]; then lan_refused "$LAN4" "http://$LAN4:$SITE_PORT/helper/health" v4; fi
if [[ -n "$LAN6" ]]; then lan_refused "[$LAN6]" "http://[$LAN6%25$IFACE]:$SITE_PORT/helper/health" v6; fi
if [[ -n "$LAN4" ]]; then
  RC=0
  curl -s -m 3 -o /dev/null "http://$LAN4:$HELPER_PORT/health" || RC=$?
  [[ "$RC" == 7 ]] || die "The helper's own port answered on $LAN4:$HELPER_PORT (curl exit $RC, expected 7): it must listen on 127.0.0.1 only."
  say "  $LAN4:$HELPER_PORT -> refused"
fi

INSTALL_DONE=1   # on_exit: every check above passed
cat <<NEXT

Installed. Still to do by hand:

  1. The kiosk browser MUST open  http://127.0.0.1:$SITE_PORT/screen.html
     NOT http://voron.local:$SITE_PORT/ -- through the hostname the request reaches
     nginx on the LAN address, and /helper/ (correctly) refuses it.

  2. From your laptop, check that the LAN is refused over IPv4 and IPv6 (a GET, not -I):
       for f in -4 -6; do curl \$f -s -m5 -o /dev/null -w "\$f %{http_code}\\n" http://voron.local:$SITE_PORT/helper/health; done
     Both must print 403. 000 on -6 means IPv6 was not tested, not that it passed.

  3. After the kiosk swap, once KlipperScreen is gone (docs/CUTOVER.md):
       - delete KlipperScreen.rules from /etc/polkit-1/rules.d and /usr/share/polkit-1/rules.d
       - sudo gpasswd -d $USER_NAME network
       - then, in an SSH shell as $USER_NAME, this must answer that you are NOT authorized:
           pkcheck --action-id org.freedesktop.NetworkManager.settings.modify.system --process \$\$
     Until then, KlipperScreen's rule still lets $USER_NAME's processes (Moonraker included)
     change wifi without going through the helper. And if  sudo -n true  succeeds as
     $USER_NAME, passwordless sudo outweighs all of this.

To undo everything:  cd $TOP && bash tools/helper/install_helper.sh --uninstall
NEXT
