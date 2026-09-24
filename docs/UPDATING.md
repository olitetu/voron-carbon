# Updating the printer without breaking Carbon

Runbook for updating Klipper, Moonraker, Happy Hare and the system packages on `voron.local`.

**Carbon needs no changes to survive any of it.** This document exists to prove that rather than assert
it, and to protect the two things that *are* fragile: Happy Hare's files, and KlipperScreen.

---

## Why Carbon is insulated

Carbon is a static esbuild bundle with React vendored in. There is no Node on the printer, no Python, no
venv, no service of its own — nothing in an apt upgrade or a Klipper pull links against it. Its entire
compatibility surface is two lists:

| surface | source of truth | size |
| --- | --- | --- |
| printer objects it subscribes to | `CORE_SUBS` in `src/lib/boot.js` | 26 hardcoded + a dynamic sweep |
| Moonraker methods it calls | `"namespace.method"` literals across `src/` | 56 |

`tools/update_verify.py` derives both **from the source** rather than restating them, so it cannot drift
out of date with the app.

Two findings worth keeping, because they are why the surface is more robust than it looks:

- **A missing printer object does not break the subscription.** Klipper returns `{}` for an unknown
  object rather than an error, so a disappeared object degrades one panel instead of blanking the app.
- **Carbon sends no credentials at all** — bare `new WebSocket(…/websocket)`, no API key, no token, no
  Authorization header. It authenticates purely as a trusted client, which is why Moonraker 0.11's
  credential-validation changes cannot touch it.

---

## What is actually at risk

| component | risk | why |
| --- | --- | --- |
| **Happy Hare** | **high, if you press RECOVER** | Its files are untracked *inside* the klipper and moonraker checkouts. A pull leaves them alone; a hard recover deletes them. |
| **KlipperScreen** | **high** | v3.0.1 → v4.0.0 is a major version, arriving alongside new GTK3, mesa and xserver. Your home menu is a v3-era config. |
| Mainsail theme | medium | The bespoke `.theme/custom.css` targets Mainsail's DOM; v2.17 → v2.19 is two minor versions of component churn. |
| Klipper / Moonraker | low | See below. |
| **Carbon** | **none** | Verified by `tools/update_verify.py`. |

Both high-risk items are software you are replacing with Carbon, which is an argument for doing this
update *before* the cutover rather than after.

### Happy Hare's footprint

```
~/klipper/klippy/extras/mmu_encoder.py  mmu_espooler.py  mmu_led_effect.py
                        mmu_leds.py     mmu_machine.py   mmu_sensors.py  mmu_servo.py
~/moonraker/moonraker/components/mmu_server.py
```

Moonraker reports these as `anomalies` on both repos. That is expected and not a problem to fix.
**Never press RECOVER on klipper or moonraker** — it re-clones and deletes exactly these files. Carbon
already guards this: the RECOVER button only renders when a repo is genuinely broken, and the dialog
inlines Moonraker's anomaly list so the files are named before you confirm. If it ever does happen, the
fix is `~/Happy-Hare/install.sh`, not git.

### Klipper

Nothing in the pending commits removes or renames anything Carbon reads. The only one touching a
configured module is `motion_report: Don't report stale velocity if no move found`, which makes
`live_extruder_velocity` *more* accurate at idle — Carbon's EMA smoothing in
`adapters/common.js` already handles both behaviours, and it makes `nozzle_idle.cfg`'s movement check
more reliable rather than less.

`probe_eddy_current`, `temperature_probe` and `load_cell` all have changes pending — including one
formal `Config_Changes.md` entry renaming `METHOD` to `MANUAL_METHOD` — but **none of them are
configured on this machine**. Cartographer runs its own klippy module, not Klipper's built-in eddy
probe. Re-check this if you ever add one.

### Moonraker 0.11

Three authorization commits target proxied setups like Carbon's. All three pass:

- *Trusted Client authorization now validates both the forwarded IP and the proxy IP* — Carbon's nginx
  proxies from `127.0.0.1`, and `127.0.0.0/8` is in `trusted_clients`. Forwarded clients are
  `192.168.0.x` and `fe80::`, both covered.
- *Failed API Key comparisons now return 401 instead of falling through* — Carbon sends no key.
- New `use_xheaders` option — **defaults to `True`**, so `X-Forwarded-For` parsing stays on.

Python 3.11.2 on Bookworm, so the dropped 3.7–3.9 packaging support is moot. The venvs survive a
patch-level Python bump; they only break across *minor* versions.

### System packages

Of the ~98 pending, the ones that matter: **nginx** (Carbon's server — Debian preserves
`sites-available/carbon`, you get a few seconds of downtime), **python3.11** (patch bump, venvs fine),
and **linux-image / raspi-firmware / rpi-eeprom** (kernel and bootloader — mandatory reboot, EEPROM
applies at next boot). The GTK/mesa/xserver packages are KlipperScreen's stack.

---

## The run

### 1. Preflight — on the printer

```bash
cd ~/voron-carbon && git pull
bash tools/update_preflight.sh              # dry run: shows what it would do
bash tools/update_preflight.sh --apply      # takes the backups
```

Refuses mid-print. Backs up the config tree and the Moonraker database (which holds UI state the config
tree does not: Mainsail layouts and macro groups, webcams, Carbon's prefs, Happy Hare's `lane_data`).
Records Happy Hare's file inventory and both repo HEADs.

**It also checks the one thing that genuinely blocks a pull:** modified *tracked* files. Untracked files
never block. Klipper reports `-dirty` in its version string from whenever `klipper.service` last
started, which is a stale snapshot — the script checks the trees live instead of trusting it. If it
reports modified tracked files, resolve those before going further.

### 2. Baseline the API — from anywhere

```bash
python3 tools/update_verify.py --save ~/update-preflight-<stamp>
```

### 3. Update, in this order

1. **klipper** — smallest blast radius. Restart, then confirm the MMU still loads.
2. **moonraker** — **do this one while you are at the machine.** If 0.11 fails to start you lose Carbon
   and Mainsail simultaneously, and recovery is SSH over wifi with a password.
3. **system + everything else** — reboot afterwards for the kernel and EEPROM.

### 4. Verify

```bash
python3 tools/update_verify.py --check ~/update-preflight-<stamp>
```

Exits non-zero if anything Carbon needs stopped resolving, so it can gate a deploy. It prints what moved
(versions, MCU firmware, objects, gcode commands) and then checks Carbon's dependencies.

The single most important line after the Moonraker update is `mmu_server` still being in
`server.info`'s `components` with `failed_components` empty — that is Happy Hare's Moonraker component
surviving the version bump. `update_verify.py` checks it explicitly.

### 5. MCU firmware

Not a prerequisite. This machine already runs a full minor version of skew and works:

```
mcu          v0.12.0-267     host: v0.13.0-745
mcu mmu      v0.12.0-290
mcu can0     v0.13.0-288
mcu scanner  CARTOGRAPHER 5.0.0   (vendor firmware, separate lifecycle)
```

But `buildcommands: embed the minimal config in identify data` and `mcu: expose embedded build config in
status` change the host↔MCU identify handshake, so the updated host will look for data your v0.12
firmware does not send. That is the one thing to watch on the first restart after updating Klipper.

---

## Rollback

| what broke | how to get back |
| --- | --- |
| Klipper or Moonraker won't start | `git -C ~/<repo> checkout $(cat <out>/<repo>-HEAD.txt)`, then restart the service |
| Happy Hare gone (you pressed RECOVER) | `~/Happy-Hare/install.sh` — **not** git |
| Config mangled | `tar -xzf <out>/printer_data-config.tar.gz -C ~/printer_data` |
| UI state lost | restore from the database backup in `<out>` |
| KlipperScreen v4 unusable | `sudo systemctl stop KlipperScreen` and live in Carbon until you sort it |
