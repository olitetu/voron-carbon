# Putting Carbon Screen on the panel

How to replace KlipperScreen with Carbon Screen on the printer's own touchscreen,
in an order that never leaves the machine without a local UI.

**The one rule.** After the swap this panel is the *only* local UI on the machine,
and this printer has **no wired link** (eth0 exists but carries nothing: 0 bytes, no address) — SSH runs over
the same wifi the panel depends on. So the escape hatches get built *before* the thing they rescue:
updates before the swap, the helper before wifi can break, and a rollback command
rehearsed before it is needed.

Every phase is reversible on its own. Nothing removes KlipperScreen; it is only
ever stopped and disabled.

---

## Phase 0 — before touching anything

All read-only, from a laptop.

```bash
curl -s http://voron.local:8767/server/info | python3 -m json.tool | head -20
curl -s 'http://voron.local:8767/printer/objects/query?print_stats=state&pause_resume=is_paused&configfile=save_config_pending'
```

- `klippy_state` is `ready`
- `print_stats.state` is **not** `printing` or `paused`
- `save_config_pending` is **false** — resolve it first. The Phase 4 smoke test
  includes a firmware restart, which would silently discard pending changes.

Then the escape hatch, **from your phone, not your laptop**:

```bash
ssh olitetu@voron.local 'sudo -n true && echo SUDO-OK'
```

If that fails, stop.

Then the way in **without wifi**. The kernel console is on tty1 (`console=tty1` in
`cmdline.txt`), and Xorg allows Ctrl+Alt+Fn VT switching by default, so a USB
keyboard plugged into the Pi reaches a login prompt even when the panel is dark and
the network is gone. Prove it is usable while SSH still works:

```bash
systemctl is-enabled getty@tty1; systemctl is-active getty@tty1   # enabled / active (note any autologin)
sudo passwd -S olitetu            # second field must be P: a usable local password is set
su - olitetu -c true              # type it once: proves you KNOW it (sudo -n true does not)
```

Check that one of the Pi's USB-A ports is free, or note which cable is safe to pull
(the webcam). Never unplug the MCU, the MMU board or the probe.

KlipperScreen's X does not ask for a particular VT (its `xinit` gets no `vtN`), so it
takes the first free one. Find it while KlipperScreen is still on the panel, and write
it on the card in place of `__`:

```bash
sudo grep -h 'using VT number' /var/log/Xorg.0.log ~/.local/share/xorg/Xorg.0.log 2>/dev/null
ls -la ~/.xserverrc 2>/dev/null   # should not exist; if it does, it wraps BOTH panels' X
```

Now write the card and tape it inside the enclosure — the moment you need it is the
moment you cannot look it up on the printer:

> **Panel dead?** Over SSH: `sudo carbon-panel-rollback`.
> **No wifi/SSH either?** Plug a USB keyboard into the Pi. Press Ctrl+Alt+F1; if
> there is no login prompt, Ctrl+Alt+F2. Log in as `olitetu` (the local password,
> not your SSH key). Run `sudo carbon-panel-rollback`. KlipperScreen takes the screen
> by itself; if it doesn't, press Ctrl+Alt+F__ (KlipperScreen's VT, found below).
> Wifi broken too? `sudo nmtui` on the same console.

Finally: photograph the KlipperScreen home screen, and tap all four corners of the
panel. If part of the digitiser is already dead you want to know now, not after
the swap.

---

## Phase 1 — serve the new files

Nothing about the panel changes. Carbon keeps running as it does today; the new
files simply start being served beside it.

First bring the tooling over. Everything in `tools/kiosk/`, `tools/helper/` and
`tools/install.sh` runs from this checkout, and the installers refuse a copy with
local changes:

```bash
cd ~/voron-carbon && git status --short && git pull --ff-only
test -x tools/kiosk/carbon-kiosk-wait.sh && test -x tools/kiosk/carbon-kiosk-fallback.sh \
  && grep -q '^StartLimitBurst=4' tools/kiosk/carbon-kiosk.service \
  && grep -q 'X-Carbon-Local-Addr' tools/install.sh && echo TOOLING-OK
```

Then build (skip it if `dist/` was just synced from a desktop checkout at the same commit):

```bash
cd ~/voron-carbon && npm ci && npm run build
```

`npm run build` rewrites `dist/` **in place**, and today `dist/` *is* the live
root, so the desktop UI changes when the build runs, not when the installer runs.

Re-run the installer to pick up the new cache rules and the `/helper/` block. Pass
the root the site serves **now** — read it rather than assume it:

```bash
awk '$1=="root"' /etc/nginx/sites-available/carbon     # today: /home/olitetu/voron-carbon/dist
bash tools/install.sh --root "$HOME/voron-carbon/dist" --port 8767 --dry-run
```

Confirm it prints `Carbon files: /home/olitetu/voron-carbon/dist`, **no**
`ROOT CHANGE` block, and that the generated config has the `screen.*`, `safe.html`,
`release_info.json`, `fonts/fonts.css` and `location ^~ /helper/` blocks. Then run
the same command without `--dry-run`. (Leaving `--root` off also works now: a re-run
keeps the root the live site already serves. After Phase 2's relocate that is the
relocated path, not `dist/`.)

On a re-run the site is already enabled, so if `nginx -t` fails the installer puts
the previous file back from its dated backup, and nginx is never reloaded with the
broken one.

Verify. Each of these gives a different answer on the old site, so they prove the
re-run took:

```bash
for f in screen.html screen.js screen.css safe.html; do
  printf '%-12s %s\n' "$f" "$(curl -s -o /dev/null -w '%{http_code} %header{cache-control}' http://voron.local:8767/$f)"
done                                                   # each: 200 no-store, no-cache, must-revalidate
curl -s -o /dev/null -w '%{http_code}\n' http://voron.local:8767/helper/health   # 403 from the LAN (404 = old site)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/helper/health     # on the Pi: 502 until Phase 3
```

Open `http://voron.local:8767/screen.html` in a desktop browser at 1024x600 and
click through it. **Also open `safe.html`** — that is the fallback when the app
bundle will not run, and it is worth knowing it works before you rely on it.

> Rollback: `sudo cp -p /etc/nginx/sites-available/carbon.bak-<stamp> /etc/nginx/sites-available/carbon && sudo nginx -t && sudo systemctl reload nginx`
> — never remove the site: that takes desktop Carbon down too.

---

## Phase 2 — make the UI updatable  ← the real prerequisite

**Do not skip this, and do not do it after Phase 4.** Once the panel is the only
local UI, a bad build with no update path means fixing it over the wifi that the
panel is also responsible for.

Carbon is currently **not** registered with Moonraker's update manager — it does
not appear in `machine.update.status`, and the repo has no release tags at all.
So there is no way to update or roll back the UI from the printer.

Cut a release, so the version on the printer is one CI built from a clean checkout:

```bash
bash tools/release.sh v0.1.0        # tags, pushes, asks CI to build
```

Install *that* release into the served root, then register it:

```bash
bash tools/enable_updates.sh                 # dry run: shows what it would add
bash tools/enable_updates.sh --apply         # appends, after a dated backup
sudo systemctl restart moonraker
curl -s 'http://voron.local:8767/machine/update/status?refresh=false' | grep -o voron-carbon
```

**The trade:** a directory registered with `update_manager` becomes read-only to
the Moonraker file API, so `tools/deploy.py` can no longer push into it. Dev
builds keep going to the config root; the served copy only ever changes by a
release. That is the point — it is what makes rollback possible.

If you relocated the served copy (`--relocate`), every later `tools/install.sh`
re-run must keep that root. Leave `--root` off (it is kept), or pass the relocated
path. The README's `--root "$PWD/dist"` would point nginx back into the checkout,
away from the path `update_manager` manages; the installer prints `ROOT CHANGE` —
answer N.

> Rollback: `cp moonraker.conf.bak-<stamp> moonraker.conf && sudo systemctl restart moonraker`

---

## Phase 3 — the host helper

Only needed for wifi and screen-off. Skip it and the panel still works; the network
screen just shows read-only SSID/IP/MAC.

**This panel is HDMI, so there is no software brightness.** HDMI exposes no
`/sys/class/backlight` device, the udev rule is skipped, and the app hides the
brightness control rather than offering one that fails. Screen-*off* does work, via
DPMS — which is why the kiosk session sets `xset dpms 0 0 0` (DPMS on, every
timeout zero) instead of `xset -dpms`, which the first `force off` silently undoes,
bringing back the 10-minute auto-blank.

Do it **after Phase 1** (the installer checks the `/helper/` block Phase 1 wrote and
refuses an older one) and **before Phase 4**. Wifi changes today go through
KlipperScreen's own polkit rule. Depending on its installer's version that is
`/usr/share/polkit-1/rules.d/KlipperScreen.rules` or
`/etc/polkit-1/rules.d/KlipperScreen.rules`, granting the `network` group and the
user; check which exists with `sudo cat` on both. Ours is separate: it grants
NetworkManager only to the helper's own system user, `carbon-net`. Installing it
first means there is never a window where wifi cannot be reconfigured from the panel.

Phase 1 already added the `/helper/` nginx block; do not add it again. Run it as
`olitetu` (not with sudo; it calls sudo itself) from the clean checkout:

```bash
cd ~/voron-carbon && bash tools/helper/install_helper.sh
```

Then verify the trust boundary — **both results are required**:

```bash
# on the printer
curl -s http://127.0.0.1:8767/helper/health     # -> {"ok": true, ...}
# from your laptop
curl -sI http://voron.local:8767/helper/health  # -> 403
```

A 200 from the laptop means the loopback rule is missing and wifi control is
exposed to the LAN. Fix that before continuing.

> Rollback: `bash tools/helper/install_helper.sh --uninstall`

---

## Phase 4 — the swap

### Step 0 — install the browser, while nothing is printing

Chromium is **not** installed on this Pi. On Raspberry Pi OS bookworm the real
package is `chromium` (`chromium-browser` is only a transitional name for it). Keep
its Recommends: they bring `chromium-sandbox`, `rpi-chromium-mods` and the Mesa
drivers.

```bash
df -h /            # at least 700 MB free: chromium + chromium-common + chromium-l10n + .debs
sudo apt update && sudo apt install -y chromium && sudo apt-mark manual chromium && sudo apt clean
apt-cache policy chromium            # Installed ends in +rptN; version table lists archive.raspberrypi.com
apt-mark showmanual | grep -x chromium
chromium --version
```

`apt-mark manual` matters: if chromium only arrived as a dependency of the
transitional package, removing that package later would let `apt autoremove` delete
the panel's browser. No `unclutter`: the kiosk's X server runs with `-nocursor`.

### Step 1 — install and switch

```bash
bash tools/kiosk/install_kiosk.sh --dry-run     # reads KlipperScreen's unit, changes nothing
bash tools/kiosk/install_kiosk.sh
```

It reads the installed KlipperScreen unit for the user and tty rather than
guessing them, refuses to run if Chromium is missing or the UI is not answering,
checks that systemd **really applied** the start limit the automatic fallback
depends on (`systemd-analyze verify` shows no ignored key; `5min / 4 / 40s`), and
prompts before switching. The switch enables Carbon *before* disabling
KlipperScreen, so a dropped SSH session can never leave both disabled. It then
watches for 20 s and only reports success if the kiosk has **not restarted** and
Chromium is running.

The kiosk opens **`http://127.0.0.1:8767/screen.html`**, not the hostname. That is
deliberate: the `/helper/` endpoints are loopback-only, and through the hostname
the request arrives from the LAN address and is correctly denied.

Re-check by hand once:

```bash
systemctl show -p StartLimitIntervalUSec -p StartLimitBurst -p TimeoutStartUSec carbon-kiosk   # 5min / 4 / 40s
systemctl show -p NRestarts carbon-kiosk                       # 0
journalctl -u carbon-kiosk -b | grep -c 'UI never came up'     # 0 with the UI healthy
```

Then, on the panel:

- no cursor, no toolbar, no scrollbars, nothing selectable on a long press
- two-finger pinch does nothing; a swipe in from the left edge does nothing
- buttons do not stay lit after a tap
- every nav destination opens and comes back; no blank screen anywhere
- the emergency stop is one tap from every screen — open its confirm and cancel

### Step 2 — rehearse every way back, for real

**The start-limit budget.** The automatic fallback fires when carbon-kiosk is
started a 5th time inside 5 minutes. *Every* start counts, manual ones included —
the installer's, each `restart`, each restart from Moonraker's services menu. Hit
it by rehearsing too fast and KlipperScreen takes the panel: safe, and undone with
the come-back line below, whose `reset-failed` also zeroes the count. Never use a
bare `systemctl start`/`restart` to come back after the fallback fired: systemd
refuses it ("Start request repeated too quickly") while Conflicts= still stops
KlipperScreen.

The come-back line, used everywhere below:

```bash
sudo systemctl reset-failed carbon-kiosk; sudo systemctl enable --now carbon-kiosk && sudo systemctl disable KlipperScreen
```

**1. The manual rollback, twice:**

```bash
sudo carbon-panel-rollback                 # KlipperScreen repaints on the panel
# then the come-back line
```

**2. With a keyboard, no SSH involved.** With Carbon on the panel: Ctrl+Alt+F1, log
in, `sudo carbon-panel-rollback`, confirm KlipperScreen repaints (Ctrl+Alt+F and the
VT number on the card if it does not take the screen), then the come-back line.

**3. A deliberate restart keeps Carbon.** A clean stop is a success for systemd, so
`OnFailure=` normally does not fire at all. If it does (the stop half failed), the
fallback sees the restart still under way and leaves the panel alone:

```bash
sudo systemctl restart carbon-kiosk        # Carbon comes back, NOT KlipperScreen
systemctl show -p NRestarts carbon-kiosk   # 0 (a manual restart is not counted here)
journalctl -t carbon-kiosk -n 3            # usually nothing new; at most "... coming back up: panel left alone"
```

Once more from MACHINE → services → carbon-kiosk (Moonraker reads
`moonraker.asvc` only at startup, so restart Moonraker first, when not printing).

**4. The automatic path.** Point the kiosk at a dead port, then kill **only the
browser**, so that no manual start is involved:

```bash
sudo sed -i 's|^KIOSK_URL=.*|KIOSK_URL=http://127.0.0.1:9/screen.html|' /etc/default/carbon-kiosk
pkill -o -f 'user-data-dir=/home/olitetu/.carbon-kiosk'
journalctl -u carbon-kiosk -u carbon-kiosk-fallback -f
```

X exits, `Restart=` restarts it, and each attempt gives up after ~30 s ("UI never
came up"). **KlipperScreen should take the panel by itself after about 2½ minutes**
(4 attempts of ~35 s; the 5th is refused). Meanwhile the panel shows the console's
`voron login:` prompt: Carbon's X never starts while its UI check fails, so the screen
falls back to tty1. That is expected, not a hang. Confirm:

```bash
journalctl -u carbon-kiosk | grep -i 'start request repeated'   # systemd gave up
journalctl -t carbon-kiosk -n 3                                 # "carbon-kiosk gave up (exit-code/…); KlipperScreen restored for this boot"
```

Then put it back:

```bash
sudo sed -i 's|^KIOSK_URL=.*|KIOSK_URL=http://127.0.0.1:8767/screen.html|' /etc/default/carbon-kiosk
# then the come-back line
```

Optionally repeat with the page missing instead of the port dead (the 404 path):
`R=$(awk '$1=="root"{gsub(/;/,"",$2);print $2;exit}' /etc/nginx/sites-available/carbon)`,
`mv "$R/screen.html" "$R/screen.html.off"`, the same `pkill`, wait for KlipperScreen,
`mv` it back, then the come-back line.

The fallback holds **for this boot only**: carbon-kiosk stays enabled, so the next
boot tries Carbon again, and, if the cause is still there, falls back again after
~2½ minutes of a dark panel. To make KlipperScreen stick across reboots, run
`sudo carbon-panel-rollback`.

**The two boot tests are what actually decide whether this shipped:**

1. Reboot from the panel. Carbon returns unattended.
2. Cold boot — shut down, pull power, wait, restore. Carbon returns unattended.

A reboot passes with a warm cache and a settled network. Only the cold boot
catches ordering bugs against nginx, Moonraker and a wifi association that has not
completed yet.

**KlipperScreen updates.** Updating KlipperScreen through Moonraker restarts
`KlipperScreen.service`, and Conflicts= then gives it the panel and stops Carbon.
KlipperScreen being active is exactly the case the fallback leaves alone, so nothing
brings Carbon back before a reboot. Update
KlipperScreen from Mainsail or a desktop, not from the panel. Afterwards, if
KlipperScreen appeared, the fallback still works; bring Carbon back with the
come-back line (or reboot). Do **not** use `carbon-panel-rollback` for this: if the
update broke KlipperScreen, that would make the broken panel the boot default.
Optional: stop Moonraker from restarting KlipperScreen after an update by deleting
the `managed_services: KlipperScreen` line in `[update_manager KlipperScreen]`
(`is_system_service: False` would not do it here: that option only sets the default,
and this printer's moonraker.conf names the service explicitly). Then test the
fallback by hand after each update (`sudo systemctl start KlipperScreen`, look, then
the come-back line).

> Rollback: `sudo carbon-panel-rollback`, or `bash tools/kiosk/install_kiosk.sh --uninstall`

---

## Phase 5 — soak before you trust it

Run it beside a real workload before considering the job done.

First make sure the numbers measure the kiosk. The unit has no PAM session, so Xorg
and Chromium should live in its own cgroup:

```bash
systemd-cgls -u carbon-kiosk.service               # must list Xorg and chromium
grep -w memory /sys/fs/cgroup/cgroup.controllers   # absent => MemoryHigh/Max are inert, MemoryCurrent unset
```

Raspberry Pi kernels leave the memory controller off unless `cmdline.txt` has
`cgroup_enable=memory`. Without it the unit's `MemoryHigh`/`MemoryMax` do nothing;
`OOMScoreAdjust=500` still makes the kernel kill the panel (which restarts) before
Klipper. Turning it on is a boot change, so it is your call:
`sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak && sudo sed -i '1 s/$/ cgroup_enable=memory/' /boot/firmware/cmdline.txt`,
reboot, re-run the `grep` above. (Do not judge by `/proc/cgroups`: a 6.12 kernel built
without cgroup-v1 memory support never lists `memory` there, even when it is on.)

Then, after an hour, a day, and one multi-day print:

```bash
# kiosk memory as PSS: right whatever the cgroup state; summed RSS over-counts Chromium's shared pages
CG=$(cut -d: -f3- /proc/$(systemctl show -p MainPID --value carbon-kiosk)/cgroup)
sudo sh -c "for p in \$(cat /sys/fs/cgroup$CG/cgroup.procs); do cat /proc/\$p/smaps_rollup 2>/dev/null; done" \
  | awk '/^Pss:/{s+=$2} END{printf "kiosk PSS %.0f MB\n", s/1024}'
free -m; df -h /run                  # Chromium's temp/shared memory lives in /run/carbon-kiosk (RAM)
systemctl show -p NRestarts carbon-kiosk
journalctl -u carbon-kiosk --since '1 day ago' | grep -ci 'crash\|renderer.*killed'
```

The kiosk's PSS should settle (roughly 250–500 MB) rather than climb, available
memory should stay above ~1.5 GB while printing, and restarts and the crash count
should stay at zero.

Once during the soak, **log out of every SSH session** and check the panel is still
alive a few minutes later. The kiosk has no logind session, so when your last login
ends logind's `RemoveIPC=` clears this user's IPC objects; Chromium must not care.

Check the browser picked up its flags:

```bash
tr '\0' ' ' < /proc/$(pgrep -of /usr/lib/chromium/chromium)/cmdline | grep -o disable-renderer-accessibility
```

Watch the clock on the status bar. **A painted UI with a frozen clock is the
signature of a wedged renderer** — it looks fine in a photograph and is completely
dead. What IS recovered automatically: a bundle that fails to load or never mounts
(screen.html's 20 s boot watchdog opens `safe.html`), a crash of the whole app (the
root error boundary opens `safe.html`), and a Chromium or X that exits or is
OOM-killed (systemd restarts the session). `safe.html` goes back to the full UI by
itself once a different `screen.js` is deployed. What is NOT: a renderer that hangs
without exiting. Recover it with `sudo systemctl restart carbon-kiosk`, or without
SSH from Mainsail's or desktop Carbon's service list (carbon-kiosk is in
`moonraker.asvc`, once Moonraker has been restarted).

### After the soak: tighten wifi permissions (optional)

With Carbon on the panel, KlipperScreen's polkit grant is only used by the fallback.
Removing it means the fallback KlipperScreen can no longer change wifi, and nothing
else in your login can either:

```bash
sudo rm -f /etc/polkit-1/rules.d/KlipperScreen.rules /usr/share/polkit-1/rules.d/KlipperScreen.rules
sudo gpasswd -d olitetu network
id -nG olitetu                                          # also review netdev: Debian's NetworkManager polkit config trusts it
pkcheck --action-id org.freedesktop.NetworkManager.settings.modify.system --process $$   # from a fresh SSH login: must be denied
```

What remains open is by design: the helper listens on `127.0.0.1:8770` with no
authentication, so any local process, Moonraker included, can use it within its
guards. And passwordless sudo for `olitetu`, if you have it (`sudo -n true`),
outweighs every rule here.

---

## What is where

| | |
|---|---|
| `tools/install.sh` | nginx site on :8767 — serves the app, the panel, safe mode, and proxies the helper |
| `tools/enable_updates.sh` | registers Carbon with Moonraker's update manager |
| `tools/helper/` | the host helper: wifi, backlight, DPMS — loopback only |
| `tools/kiosk/` | the panel itself: session and wait scripts, systemd units, the fallback, installer |
| `sudo carbon-panel-rollback` | one command, puts KlipperScreen back |
| `public/safe.html` | dependency-free fallback UI — e-stop, restarts, console |

## Panel facts

| | |
|---|---|
| Resolution | 1024x600 (from `KlipperScreen.log`, every restart) |
| Connection | **HDMI** — no backlight device, so no software brightness |
| Screen off | DPMS only (`xset dpms force off`) |
| Display server | X11 on `:0`, started with `-nocursor` |
| Host | Raspberry Pi 5, 4 GB, Debian 12 |
| Network | `wlan0` only — eth0 unused (0 bytes, no address) |
| Offline console | tty1 (`console=tty1`), reached with a USB keyboard and Ctrl+Alt+F1 |

Nothing here removes KlipperScreen. Its unit, `KlipperScreen.conf`, `ks_menus.conf`
and the staged `theme-voron-carbon` all stay exactly where they are.
