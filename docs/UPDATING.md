# Updating the printer without breaking Carbon

Runbook for updating Klipper, Moonraker, KlipperScreen, Mainsail and the system packages on `voron.local`.

**Carbon's code needs no change for any of it.** Since the 2026-09-24 panel cutover, however, Carbon is
more than a static bundle. The 7" panel runs it through `carbon-kiosk.service` (Chromium, Xorg via
`xserver-xorg-legacy`, mesa and the kernel, all from apt). `carbon-helper.service` runs `/usr/bin/python3`
behind nginx `/helper/`. `KlipperScreen.service` is installed and disabled, as the automatic fallback. The
fragile things are Happy Hare's and Cartographer's files inside the klipper checkout, the panel's X stack,
and the fallback.

---

## Carbon's surface

| surface | source of truth | size today |
| --- | --- | --- |
| printer objects it subscribes to or queries | `CORE_SUBS` in `src/lib/boot.js`, plus the `api.subscribe` / `api.query` calls elsewhere | 26 + 6 (`mmu_machine`, `mmu_leds unit0`, `manual_probe`, `gcode`, `scanner`, `gcode_macro _Z_OFFSET_VARS`), plus a dynamic sweep |
| Moonraker methods it calls | `"namespace.method"` literals across `src/` | 57, derived at run time |
| G-code it sends | command strings across `src/` | about 88 |
| services | `carbon-kiosk`, `carbon-helper`, the nginx site `carbon` on :8767 | 3 |

`tools/update_verify.py` derives objects, methods and G-code from the source, and checks the :8767 site,
`/helper/`, and that carbon-kiosk owns the panel. It does not check Happy Hare parameter names.

Two findings worth keeping, because they are why the surface is more robust than it looks:

- **A missing printer object does not break the subscription.** Klipper returns `{}` for an unknown
  object rather than an error, so a disappeared object degrades one panel instead of blanking the app.
- **Carbon sends no credentials at all** — bare `new WebSocket(…/websocket)`, no API key, no token, no
  Authorization header. It authenticates purely as a trusted client, which is why Moonraker 0.11's
  credential-validation changes cannot touch it. KlipperScreen v3 is not so lucky; see Moonraker 0.11.

---

## What is actually at risk

| component | risk | why |
| --- | --- | --- |
| **Happy Hare + Cartographer files** | **high, only if someone HARD-recovers klipper, moonraker or KlipperScreen** | They are untracked *inside* those checkouts. A pull or a soft recover keeps them; a hard recover re-clones and deletes them. |
| **Panel (carbon-kiosk)** | **medium** | apt replaces Xorg, `xserver-xorg-legacy`, mesa, `libnss3`, `libgtk-3` and the kernel under it, and the post-apt reboot is the first boot on that stack for Carbon and the fallback alike. |
| **KlipperScreen (fallback)** | **medium** | v3.0.1 → v4.0.0 is 311 commits plus a pip rebuild (pycairo from source). Updating it hands it the panel, and Moonraker 0.11 breaks v3, so the two go together. |
| Mainsail theme | low | Cosmetic. v2.19 moved the MMU card's status text; two selectors in `.theme/custom.css` need a patch. |
| Klipper / Moonraker | low | See below. |
| **Carbon app** | **none found** | Verified by `tools/update_verify.py`. |

### Happy Hare's and Cartographer's footprint

```
~/klipper/klippy/extras/mmu_*.py                       7 files   Happy Hare (Moonraker lists these as anomalies)
~/klipper/klippy/extras/mmu/                           14 files  Happy Hare's core, incl. mmu.py (Moonraker never lists a directory)
~/klipper/klippy/extras/{idm,cartographer,scanner}.py  3 links   Cartographer (hidden via ~/klipper/.git/info/exclude)
~/moonraker/moonraker/components/mmu_server.py
~/KlipperScreen/styles/voron-carbon/                   the fallback's theme
```

A pull and a soft RECOVER (Carbon labels it KEEPS UNTRACKED; checkout + `reset --hard`) keep all of these.
Only a HARD recover (re-clone) deletes them. **Never HARD-recover klipper, moonraker or KlipperScreen.** If a
row reads INVALID or `?`, press REFRESH first. After a hard recover:

- klipper: run `~/cartographer-klipper/install.sh` (re-pips, 10+ min), then `~/Happy-Hare/install.sh -z`.
- moonraker: run `~/Happy-Hare/install.sh -z`, then `sudo systemctl restart moonraker`.
- KlipperScreen: re-run `voron-ui/klipperscreen/install_ks_theme.sh`.

Live inventory: `git -C ~/klipper status --porcelain --ignored --untracked-files=all -- klippy/extras | grep -v pyc`.
klippy.log's `Untracked files` line is truncated to 10 entries.

### Klipper

Nothing in the pending commits removes or renames anything Carbon reads. The only one touching a
configured module is `motion_report: Don't report stale velocity if no move found`, which makes
`live_extruder_velocity` *more* accurate at idle — Carbon's EMA smoothing in
`adapters/common.js` already handles both behaviours, and it makes `nozzle_idle.cfg`'s movement check
more reliable rather than less.

`probe_eddy_current`, `temperature_probe` and `load_cell` all have changes pending — including one
formal `Config_Changes.md` entry renaming `METHOD` to `MANUAL_METHOD` — but **none of them are
configured on this machine**. Cartographer runs its own klippy module, not Klipper's built-in eddy
probe. Re-check this if you ever add one. `manual_probe` also changes (`MANUAL_METHOD`, default `manual`),
so Cartographer's `ManualProbeHelper` call at `scanner.py:1640` behaves as before.

### Moonraker 0.11

Three authorization commits target proxied setups like Carbon's. All three pass:

- *Trusted Client authorization now validates both the forwarded IP and the proxy IP* — Carbon's nginx
  proxies from `127.0.0.1`, and `127.0.0.0/8` is in `trusted_clients`. Forwarded clients are
  `192.168.0.x` and `fe80::`, both covered.
- *Failed API Key comparisons now return 401 instead of falling through* — Carbon sends no key.
- New `use_xheaders` option — **defaults to `True`**, so `X-Forwarded-For` parsing stays on.

Three that are not about Carbon:

- **KlipperScreen v3 always sends an empty `api_key` in identify.** 0.11 validates it, fails, and revokes
  its trusted auth, so v3 on 0.11 paints but gets no data. Update KlipperScreen v4 first, then Moonraker,
  in one sitting.
- **A client that SENDS an `X-Api-Key` must send the right one;** 0.11 answers 401 instead of falling
  back. Blank or correct the slicer's key field before updating.
- **Moonraker's pip step is `-U -r`** (`pip_utils.py:307`), so it upgrades `moonraker-env` and needs the
  network.

Python 3.11.2 on Bookworm, so the dropped 3.7–3.9 packaging support is moot. The venvs survive a
patch-level Python bump; they only break across *minor* versions.

### System packages

Of the ~98 pending, the ones that matter: **nginx** (Carbon's server — Debian preserves
`sites-available/carbon`, you get a few seconds of downtime), **python3.11** (patch bump, venvs fine),
and **linux-image / raspi-firmware / rpi-eeprom** (kernel and bootloader — mandatory reboot, EEPROM
applies at next boot). Xorg, `xserver-xorg-legacy`, mesa, `libnss3` and `libgtk-3` are the panel's
stack: Carbon's kiosk and the KlipperScreen fallback both run on them. Moonraker applies apt through
PackageKit (no password, `--force-confold`, survives an SSH drop) and recomputes the list at run time.
Check it with `sudo apt update && apt list --upgradable` just before.

---

## The run

Every UPDATE is the component's own row in Mainsail or desktop Carbon's MACHINE page, pressed from a
laptop. **Never UPDATE ALL**: it runs apt first, then KlipperScreen, whose restart takes the panel right
after apt, then Klipper, then Moonraker, and it stops half-done at the first failure. **Never update from
the panel. Never RECOVER**; if a row reads INVALID or `?`, press REFRESH.

The come-back line (see CUTOVER.md), used everywhere below:

```bash
sudo systemctl reset-failed carbon-kiosk; sudo systemctl enable --now carbon-kiosk && sudo systemctl disable KlipperScreen
```

### Decide first

| question | recommendation |
| --- | --- |
| KlipperScreen v4 and Moonraker 0.11 in this sitting? | Yes, together, after steps 1-4 of §3, if those were clean, you are at the machine with about an hour and a USB keyboard, and PyPI is reachable. Otherwise stop after step 4. Never Moonraker alone, and never an API key in `KlipperScreen.conf` (Moonraker's file API serves the config tree). |
| Mainsail 2.19 now? | Yes, and patch two selectors (§3 step 4). The mainsail row's Rollback returns to 2.17. |
| apt holds (xserver/mesa, kernel, rpi-eeprom)? | None. Repack the X/mesa set first (§3 step 3); the kernel forces the reboot test anyway. |
| A staged bootloader update after apt? | Apply it during an attended reboot, with a Pi 5 bootloader recovery SD card ready (Raspberry Pi Imager > Misc utility images > Bootloader). No card: `sudo rpi-eeprom-update -r` and defer it. A flash on a rail that browns out is the one step that can leave the Pi unbootable. |
| Keep `managed_services: KlipperScreen`? | Keep it: the handover after a KlipperScreen update is its test. CUTOVER.md says how to turn it off. |

### 0. Before anything — on the printer

```bash
~/voron-backup/backup.sh                    # commits and pushes: the only copy that is not on this SD card
ls ~/voron-backup/system/systemd ~/voron-backup/databases/moonraker | grep -i carbon   # the carbon-* units and namespace
dpkg --audit                                # must print nothing
vcgencmd get_throttled                      # 0x0 or 0x50000 (past events only); bit 0 set = under-voltage NOW: stop
df -h /boot/firmware                        # at least 150 MB free: two kernels and two initramfs images
command -v tmux dpkg-repack || { sudo apt update && sudo apt install -y tmux dpkg-repack; }
```

Install tmux and dpkg-repack now, while dpkg is healthy: once it is broken they can no longer be
installed. Long root work goes in `tmux new -A -s upd`, after `sudo -v`. (No network for them: use
`sudo systemd-run --unit=<name> --collect <cmd>` and `journalctl -fu <name>` instead, and skip the
repack.) If the backup push fails, copy it off from the Mac: `scp -r olitetu@voron.local:voron-backup ~/voron-backup-copy`.

### 1. Preflight — on the printer

```bash
cd ~/voron-carbon && git pull --ff-only
bash tools/update_preflight.sh              # dry run: shows what it would do
bash tools/update_preflight.sh --apply      # takes the backups
```

No sudo; `--apply` writes ~30-60 MB plus a DB copy into `~/update-preflight-<stamp>/`; exit 3 = modified
tracked files.

Refuses while printing or paused, while a macro runs, and while a SAVE_CONFIG is pending. Backs up the
config tree and the Moonraker database (which holds UI state the config tree does not: Mainsail layouts
and macro groups, webcams, Carbon's prefs, Happy Hare's `lane_data`). Records the Happy Hare and
Cartographer footprint (expect 21 files and 3 of 3 links), every checkout's HEAD and the three venvs'
`pip freeze`.

**It also checks the one thing that genuinely blocks a pull:** modified *tracked* files. Untracked files
never block. Klipper's version always reads `-dirty` here. `klippy.py` marks it at every start when
`klippy/extras` holds untracked or ignored modules, so the script checks for modified tracked files
instead. If it reports any, do not update that repo until they are resolved.

Then, from the Mac:

```bash
mkdir -p ~/voron-update && scp -r 'olitetu@voron.local:update-preflight-*' ~/voron-update/
```

### 2. Baseline the API — same machine for --save and --check

```bash
# on the Mac, from this checkout
python3 tools/update_verify.py --printer voron.local:8767
python3 tools/update_verify.py --printer voron.local:8767 --save ~/voron-update/baseline

# or on the Pi, from ~/voron-carbon
OUT=$(ls -d ~/update-preflight-* | tail -n1)
python3 tools/update_verify.py --printer 127.0.0.1:8767
python3 tools/update_verify.py --printer 127.0.0.1:8767 --save "$OUT"
```

`--printer` is Carbon's own :8767 site. `/helper/` answers 200 on the Pi and 403 from the LAN, which is
why `--save` and `--check` must run on the same machine. It refuses to save unless Klippy is `ready`. A
failure already present here is written into the baseline and makes `--save` exit 1; `--check` still
shows it later, but only a NEW failure fails the check. Write it down so it is not blamed on the update.

### 3. Update, in this order

Press REFRESH once and read the list. A component not named below that now has an update: leave it
alone this run.

1. **klipper.** Klipper restarts, and the first start rebuilds `c_helper.so`. Afterwards the four MCUs
   are ready with unchanged `mcu_version`s. One `MCU ... kconfig: None` line per MCU in klippy.log is
   normal (§5), and there is one `Building C code module c_helper.so`. The 21-file count holds, with three
   links:
   ```bash
   git -C ~/klipper ls-files --others --exclude-standard -- 'klippy/extras/mmu_*.py' klippy/extras/mmu/ | wc -l
   ls -l ~/klipper/klippy/extras/{idm,cartographer,scanner}.py
   ```
2. **Klipper-Adaptive-Meshing-Purging.** Comments only, but one more Klipper restart.
3. **system.** First see what apt will really install, then repack the installed X/mesa set so it can
   be rolled back (in tmux):
   ```bash
   OUT=$(ls -d ~/update-preflight-* | tail -n1)
   sudo apt update && apt list --upgradable 2>/dev/null | tee "$OUT/apt-upgradable.txt" | grep -vc '^Listing'
   grep -E '^(network-manager|wpasupplicant|openssh|systemd|udev|dbus|polkit|libc6|chromium|rpi-chromium-mods|xinit|xserver-xorg-input)' "$OUT/apt-upgradable.txt"
   apt-cache policy xserver-xorg-core libgl1-mesa-dri | sed -n '1,14p'
   mkdir -p ~/pre-apt-debs && cd ~/pre-apt-debs && for p in xserver-common xserver-xorg-core xserver-xorg-legacy libxfont2 libegl-mesa0 libgbm1 libgbm-dev libgl1-mesa-dri libglapi-mesa libglx-mesa0 mesa-libgallium mesa-va-drivers mesa-vdpau-drivers mesa-vulkan-drivers libnss3; do dpkg -s "$p" >/dev/null 2>&1 && sudo dpkg-repack "$p"; done; ls -la ~/pre-apt-debs
   ```
   The sensitive-package grep should print nothing. network-manager or wpasupplicant listed: be at the
   machine, wifi may blip. An X/mesa candidate from security.debian.org replacing a `+rpt` build: stop
   and ask, it would drop Raspberry Pi's patches.

   Then the System row: 10-25 min, nginx restarts once and every UI reconnects. If the UI reports an
   error when its websocket drops, do not retry. Wait until `pgrep -a dpkg` finds nothing and
   moonraker.log says the update finished, then, before rebooting:
   ```bash
   dpkg --audit                                               # must print nothing
   systemctl is-active nginx carbon-helper carbon-kiosk moonraker klipper
   sudo nginx -t && curl -sI http://127.0.0.1:8767/screen.html | head -1
   cat /etc/X11/Xwrapper.config                               # allowed_users=anybody, needs_root_rights=yes
   sudo rpi-eeprom-update                                     # a staged bootloader update: see Decide first
   sudo reboot
   ```
   If `nginx -t` fails, do not reboot: regenerate the site with `bash ~/voron-carbon/tools/install.sh
   --root <current root>` (not the pre-cutover copy in voron-backup, which lacks `/helper/`). If
   Xwrapper.config changed: `printf 'allowed_users=anybody\nneeds_root_rights=yes\n' | sudo tee
   /etc/X11/Xwrapper.config`.

   After the reboot, check Carbon on the panel (temperatures update, the MMU screen opens, touch
   works) and from SSH:
   ```bash
   uname -r; systemctl is-active carbon-kiosk carbon-helper nginx moonraker klipper; systemctl is-active KlipperScreen
   curl -s http://127.0.0.1:8767/helper/health; echo; cat /sys/class/drm/card*-HDMI-A-*/status; vcgencmd get_throttled
   ```
   The five are active and KlipperScreen is inactive, the helper answers ok (and 403 from the Mac), HDMI
   reads connected. An applied EEPROM update may add a second, automatic reboot.

   Then prove the fallback with `sudo systemctl start KlipperScreen` (temperatures must change, not only
   paint), then the come-back line. The journal (`journalctl -t carbon-kiosk -n 3`) then reads
   `KlipperScreen already has the panel`: xinit 1.4.0 exits 1 on SIGTERM, so OnFailure= runs, harmlessly.
4. **mainsail.** Hard-reload the browser. Then in `.theme/custom.css` on the printer, lines 467 and 471,
   change `.text--disabled.body-2` to `.text--disabled.body-1:not(.text-center)` and keep the
   `.v-card.mmu-panel .row:has(svg.svg-colors) > .col >` prefix. The badge block at 550-620 is now dead CSS.

**Gate.** Go on to 5 and 6 only if 1-4 were clean, you are at the machine with about an hour and a USB
keyboard, and PyPI answers (`curl -sI https://pypi.org/simple/pycairo/ | head -1`). Otherwise stop here
and run §4: Moonraker 0.10 with KlipperScreen v3 is a consistent, working state. Before 6, make the
slicer's API key field empty or equal to `curl -s http://127.0.0.1:7125/access/api_key` on the Pi.

5. **KlipperScreen**, at the machine and online. Moonraker pulls 311 commits, pip-upgrades the venv
   (pycairo builds from source), then restarts KlipperScreen, which takes the panel from Carbon: the
   handover is the v4 test. Check live temperatures, the MMU screen and the gate map, and that
   moonraker.log has no `Error updating python requirements`. Copy v4's renamed icons into the theme
   (the theme's icons are a z-bolt copy), then run the come-back line:
   ```bash
   grep -n 'Error updating python requirements' ~/printer_data/logs/moonraker.log | tail -3
   cp -n ~/KlipperScreen/styles/z-bolt/images/* ~/KlipperScreen/styles/voron-carbon/images/
   ```
6. **moonraker**, at the machine, straight after 5. All UIs drop for 30-60 s and reconnect by themselves.
   `server/info` must show `v0.11.0-1`, `mmu_server` in `components` and no `failed_components`, and a
   REFRESH shows every row valid. Then re-test the fallback and check that the `Revoking trusted
   authentication` count is unchanged:
   ```bash
   N0=$(grep -c 'Revoking trusted authentication' ~/printer_data/logs/moonraker.log); sudo systemctl start KlipperScreen; sleep 20
   echo "before $N0 after $(grep -c 'Revoking trusted authentication' ~/printer_data/logs/moonraker.log)"
   # then the come-back line
   ```

Steps 5 and 6 go together or not at all. If v4 fails, roll it back and skip 6.

### 4. Verify

```bash
python3 tools/update_verify.py --printer voron.local:8767 --check ~/voron-update/baseline   # Mac
python3 tools/update_verify.py --printer 127.0.0.1:8767 --check "$OUT"                     # or the Pi
```

Exits non-zero if anything Carbon needs stopped resolving, so it can gate a deploy. It prints what moved
(versions, MCU firmware, objects, gcode commands) and then checks Carbon's dependencies.

The single most important line after the Moonraker update is `mmu_server` still being in
`server.info`'s `components` with `failed_components` empty — that is Happy Hare's Moonraker component
surviving the version bump. `update_verify.py` checks it explicitly.

Then run `~/voron-backup/backup.sh` again on the Pi, and upload one file from the slicer without printing.

### 5. MCU firmware

Not a prerequisite. This machine already runs a full minor version of skew and works:

```
mcu          v0.12.0-267     host: v0.13.0-745
mcu mmu      v0.12.0-290
mcu can0     v0.13.0-288
mcu scanner  CARTOGRAPHER 5.0.0   (vendor firmware, separate lifecycle)
```

The new host reads the firmware's embedded build config as optional. v0.12 boards report `mcu_kconfig`
null and connect as before. Reflash when convenient, not for this update.

---

## Rollback

`<out>` is the newest `~/update-preflight-*` folder.

| what broke | how to get back |
| --- | --- |
| Klipper won't start | `tail` klippy.log. If an HH or Cartographer file is missing, re-run its installer (see the footprint). Otherwise use the klipper row's Rollback, or `curl -X POST 'http://127.0.0.1:7125/machine/update/rollback?name=klipper'`. Never `git checkout <sha>`: HEAD detaches and the repo reads invalid (`git_deploy.py:748-753, 86-89`). |
| Moonraker 0.11 won't start (both UIs down, panel OFFLINE) | Get in over SSH, or a USB keyboard, Ctrl+Alt+F1, `olitetu`. Run `journalctl -u moonraker -b -n 60 --no-pager; tail -n 60 ~/printer_data/logs/moonraker.log`. Then `OUT=$(ls -d ~/update-preflight-* \| tail -n1); git -C ~/moonraker reset --hard "$(cat "$OUT/moonraker-HEAD.txt")"`; `~/moonraker-env/bin/pip install -r ~/moonraker/scripts/moonraker-requirements.txt` (or `-r "$OUT/pip-moonraker-env.txt"` for the exact set); `sudo systemctl restart moonraker`; `curl -s http://127.0.0.1:7125/server/info \| grep -o mmu_server`. The panel reconnects by itself. |
| Moonraker 0.11 runs but misbehaves | `curl -X POST 'http://127.0.0.1:7125/machine/update/rollback?name=moonraker'` |
| The panel shows KlipperScreen | Expected after a KlipperScreen update, a KlipperScreen RECOVER, or a fallback. Run the come-back line. Never `systemctl stop KlipperScreen` alone: it leaves the panel dark. |
| KlipperScreen v4 unusable | Come-back line first. Then `curl -X POST 'http://127.0.0.1:7125/machine/update/rollback?name=KlipperScreen'`; it puts v3 on the panel, so check it, then the come-back line. v3 needs Moonraker 0.10. |
| KlipperScreen pip step failed | In tmux: `~/.KlipperScreen-env/bin/pip install -r ~/KlipperScreen/scripts/KlipperScreen-requirements.txt`, then `sudo systemctl restart KlipperScreen`, check, come-back line. A soft RECOVER does not re-run pip. |
| Panel dark after the post-apt reboot | Wait 3 min. KlipperScreen appeared: Chromium or kiosk problem; read `journalctl -u carbon-kiosk -b` and `journalctl -t carbon-kiosk`. Both dark: X, mesa or kernel; `grep '(EE)'` in `~/.local/share/xorg/Xorg.0.log*` and `/var/log/Xorg.0.log*`, and `cat /etc/X11/Xwrapper.config`. Roll back with `sudo apt install --allow-downgrades ~/pre-apt-debs/*.deb`, reboot, come-back line. The printer stays controllable from the LAN. |
| dpkg interrupted (brownout) | `sudo systemd-run --unit=apt-fix --collect sh -c 'dpkg --configure -a && apt-get -f install -y'; journalctl -fu apt-fix`. Do not reboot until `dpkg --audit` prints nothing. |
| Config mangled | `tar -xzf <out>/printer_data-config.tar.gz -C ~/printer_data` |
| UI state lost | `curl -X POST "http://127.0.0.1:7125/server/database/restore?filename=<name in db-backup-response.json>"`. The file must be in `~/printer_data/backup/database/`, and Moonraker restarts. Or `python3 ~/voron-backup/restore/moonraker_db.py --apply carbon mainsail`. |
| Mainsail 2.19 breaks the theme | The mainsail row's Rollback, or `curl -X POST 'http://127.0.0.1:7125/machine/update/rollback?name=mainsail'` |
