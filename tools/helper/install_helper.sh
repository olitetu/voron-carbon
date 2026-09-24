#!/usr/bin/env bash
# Install the Carbon Screen host helper (wifi + backlight).
#
# Run ON THE PRINTER, over SSH, while you can still reach it:
#     bash ~/printer_data/config/carbon/tools/helper/install_helper.sh
#
# Reversible. `--uninstall` puts everything back.
#
# It does NOT touch your network configuration. It installs a service that CAN
# change it later, from the touchscreen.
set -euo pipefail

USER_NAME="${SUDO_USER:-$USER}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
DEST="$HOME_DIR/carbon-helper"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=/etc/systemd/system/carbon-helper.service
POLKIT=/etc/polkit-1/rules.d/60-carbon-network.rules
UDEV=/etc/udev/rules.d/60-carbon-backlight.rules

say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*"; }
die()  { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  say "Stopping and removing the helper"
  sudo systemctl disable --now carbon-helper 2>/dev/null || true
  sudo rm -f "$UNIT" "$POLKIT" "$UDEV"
  sudo systemctl daemon-reload
  sudo udevadm control --reload 2>/dev/null || true
  rm -rf "$DEST"
  say "Removed. The nginx /helper/ block (if you added it) is still there and now"
  say "returns 502; delete it from the Carbon site and reload nginx to finish."
  exit 0
fi

command -v nmcli >/dev/null || die "nmcli not found. NetworkManager is required."
command -v python3 >/dev/null || die "python3 not found."

say "Installing for user: $USER_NAME"

# ---------------------------------------------------------------- 1. the program
install -d "$DEST"
install -m 0755 "$HERE/carbon_helper.py" "$DEST/carbon_helper.py"
say "Installed $DEST/carbon_helper.py"

# ---------------------------------------------------------------- 2. group + polkit
if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx network; then
  say "Adding $USER_NAME to the 'network' group"
  sudo usermod -aG network "$USER_NAME"
  warn "Group change needs a re-login (or reboot) to take effect for your shell."
fi
if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx video; then
  sudo usermod -aG video "$USER_NAME"
fi
sudo install -m 0644 "$HERE/60-carbon-network.rules" "$POLKIT"
say "Installed $POLKIT"
if [[ -f /etc/polkit-1/rules.d/KlipperScreen.rules ]]; then
  warn "KlipperScreen.rules is still present and grants the same access."
  warn "Ours is independent, so removing KlipperScreen will not break wifi."
fi

# ---------------------------------------------------------------- 3. backlight
if compgen -G "/sys/class/backlight/*" >/dev/null; then
  sudo install -m 0644 "$HERE/60-carbon-backlight.rules" "$UDEV"
  sudo udevadm control --reload
  sudo udevadm trigger -s backlight || true
  say "Installed $UDEV (backlight: $(ls /sys/class/backlight | tr '\n' ' '))"
else
  warn "No /sys/class/backlight device -- this is an HDMI panel, so there is no"
  warn "software brightness. Expected, not a fault: the udev rule is skipped and the"
  warn "app hides the brightness control. Screen-off still works, via DPMS."
fi

# DPMS is the only screen-power control an HDMI panel has, so check it exists now
# rather than discovering it is missing the first time someone taps screen-off.
if command -v xset >/dev/null; then
  if DISPLAY=:0 xset q 2>/dev/null | grep -q DPMS; then
    say "DPMS present on :0 -- screen-off will work"
  else
    warn "xset reports no DPMS on :0. Screen-off will be unavailable."
    warn "(Harmless while KlipperScreen owns the display; re-check after the swap.)"
  fi
else
  warn "xset not installed -- screen-off unavailable:  sudo apt install -y x11-xserver-utils"
fi

# ---------------------------------------------------------------- 4. service
sed "s/%i/$USER_NAME/g" "$HERE/carbon-helper.service" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now carbon-helper
sleep 2
say "Service: $(systemctl is-active carbon-helper)"

# ---------------------------------------------------------------- 5. smoke test
say "Smoke test"
H=http://127.0.0.1:8770
curl -fsS "$H/health"  | sed 's/^/    health : /' || die "helper is not answering on :8770"
curl -fsS "$H/net"     | sed 's/^/    net    : /' || true
curl -fsS "$H/display" | sed 's/^/    display: /' || true
echo
if curl -fsS "$H/wifi" | grep -q '"ssid"'; then
  say "Wifi scan works."
else
  warn "Wifi scan returned nothing. If the service only just gained the 'network'"
  warn "group, reboot and re-run this smoke test:  curl -s $H/wifi"
fi

cat <<'NEXT'

Two manual steps remain:

  1. nginx -- add the block in tools/helper/nginx-helper.conf to the Carbon site
     (the one serving 8767), then:  sudo nginx -t && sudo systemctl reload nginx
     Verify:  curl -s http://127.0.0.1:8767/helper/health

  2. The kiosk browser MUST open  http://127.0.0.1:8767/screen.html
     NOT http://voron.local:8767/ -- through the hostname the request reaches
     nginx from the LAN address and the /helper/ block will (correctly) deny it.

To undo everything:  bash install_helper.sh --uninstall
NEXT
