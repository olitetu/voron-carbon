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

If that fails, stop. Write `sudo carbon-panel-rollback` on a card and tape it
inside the enclosure — the moment you need that command is the moment you cannot
look it up on the printer.

Finally: photograph the KlipperScreen home screen, and tap all four corners of the
panel. If part of the digitiser is already dead you want to know now, not after
the swap.

---

## Phase 1 — serve the new files

Nothing about the panel changes. Carbon keeps running as it does today; three new
files simply start being served beside it.

```bash
cd carbon && npm install && npm run build
```

Install (or re-run, to pick up the new cache rules and the `/helper/` block):

```bash
bash tools/install.sh --port 8767
```

Verify all three:

```bash
for f in screen.html safe.html screen.js; do
  printf '%-12s %s\n' "$f" "$(curl -s -o /dev/null -w '%{http_code}' http://voron.local:8767/$f)"
done
```

Open `http://voron.local:8767/screen.html` in a desktop browser at 1024x600 and
click through it. **Also open `safe.html`** — that is the fallback when the app
bundle will not run, and it is worth knowing it works before you rely on it.

> Rollback: `sudo rm /etc/nginx/sites-enabled/<site> && sudo systemctl reload nginx`

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

> Rollback: `cp moonraker.conf.bak-<stamp> moonraker.conf && sudo systemctl restart moonraker`

---

## Phase 3 — the host helper

Only needed for wifi and screen-off. Skip it and the panel still works; the network
screen just shows read-only SSID/IP/MAC.

**This panel is HDMI, so there is no software brightness.** HDMI exposes no
`/sys/class/backlight` device, the udev rule is skipped, and the app hides the
brightness control rather than offering one that fails. Screen-*off* does work, via
DPMS — which is why the kiosk session sets `xset dpms 0 0 0` (enabled, never
automatic) instead of `xset -dpms` (disabled, and `force off` then silently does
nothing).

Do it **before** Phase 4. The polkit rule that currently lets anything
unprivileged change wifi is `/etc/polkit-1/rules.d/KlipperScreen.rules` — it
belongs to KlipperScreen. Installing ours first means there is never a window
where wifi cannot be reconfigured.

```bash
bash tools/helper/install_helper.sh
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

```bash
bash tools/kiosk/install_kiosk.sh --dry-run     # reads KlipperScreen's unit, changes nothing
bash tools/kiosk/install_kiosk.sh
```

It reads the installed KlipperScreen unit for the user and tty rather than
guessing them, refuses to run if Chromium is missing or the UI is not answering,
and prompts before switching.

The kiosk opens **`http://127.0.0.1:8767/screen.html`**, not the hostname. That is
deliberate: the `/helper/` endpoints are loopback-only, and through the hostname
the request arrives from the LAN address and is correctly denied.

Then, on the panel:

- no cursor, no toolbar, no scrollbars, nothing selectable on a long press
- two-finger pinch does nothing; a swipe in from the left edge does nothing
- buttons do not stay lit after a tap
- every nav destination opens and comes back; no blank screen anywhere
- the emergency stop is one tap from every screen — open its confirm and cancel

**Rehearse the rollback twice, for real:**

```bash
sudo carbon-panel-rollback                 # KlipperScreen repaints on the panel
sudo systemctl disable --now KlipperScreen && sudo systemctl enable --now carbon-kiosk
```

And verify the automatic path once: point `KIOSK_URL` in
`/etc/default/carbon-kiosk` at a dead port, `systemctl restart carbon-kiosk`, and
confirm KlipperScreen comes back by itself via `OnFailure=`. Then put it back.

**The two boot tests are what actually decide whether this shipped:**

1. Reboot from the panel. Carbon returns unattended.
2. Cold boot — shut down, pull power, wait, restore. Carbon returns unattended.

A reboot passes with a warm cache and a settled network. Only the cold boot
catches ordering bugs against nginx, Moonraker and a wifi association that has not
completed yet.

> Rollback: `sudo carbon-panel-rollback`, or `bash tools/kiosk/install_kiosk.sh --uninstall`

---

## Phase 5 — soak before you trust it

Run it beside a real workload before considering the job done.

```bash
systemctl show -p MemoryCurrent carbon-kiosk && free -m
journalctl -u carbon-kiosk --since '1 day ago' | grep -ci 'crash\|renderer.*killed'
```

After an hour, a day, and one multi-day print: Chromium's RSS should settle
(roughly 250–500 MB) rather than climb, available memory should stay above ~1.5 GB
while printing, and the crash count should stay at zero.

Watch the clock on the status bar. **A painted UI with a frozen clock is the
signature of a wedged renderer** — it looks fine in a photograph and is completely
dead.

---

## What is where

| | |
|---|---|
| `tools/install.sh` | nginx site on :8767 — serves the app, the panel, safe mode, and proxies the helper |
| `tools/enable_updates.sh` | registers Carbon with Moonraker's update manager |
| `tools/helper/` | the host helper: wifi, backlight, DPMS — loopback only |
| `tools/kiosk/` | the panel itself: session script, systemd units, installer |
| `sudo carbon-panel-rollback` | one command, puts KlipperScreen back |
| `public/safe.html` | dependency-free fallback UI — e-stop, restarts, console |

## Panel facts

| | |
|---|---|
| Resolution | 1024x600 (from `KlipperScreen.log`, every restart) |
| Connection | **HDMI** — no backlight device, so no software brightness |
| Screen off | DPMS only (`xset dpms force off`) |
| Display server | X11 on `:0` |
| Host | Raspberry Pi 5, 4 GB, Debian 12 |
| Network | `wlan0` only — eth0 unused (0 bytes, no address) |

Nothing here removes KlipperScreen. Its unit, `KlipperScreen.conf`, `ks_menus.conf`
and the staged `theme-voron-carbon` all stay exactly where they are.
