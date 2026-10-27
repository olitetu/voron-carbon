# Carbon on port 80

How to make Carbon the printer's default UI: `http://voron.local/` opens Carbon, Mainsail moves to
`http://voron.local:81/`, and Carbon **keeps** answering on `:8767` as well.

Two scripts, two steps, each with a dry run and each undone by one command. Nothing is removed:
Mainsail stays installed and updatable, only its port changes.

| address | before | after |
| --- | --- | --- |
| `http://voron.local/` | Mainsail | **Carbon** |
| `http://voron.local:8767/` | Carbon | Carbon (unchanged) |
| `http://voron.local:81/` | nothing | **Mainsail** |
| `:7125` (Moonraker) | KlipperScreen (`127.0.0.1`), Home Assistant (`voron.local`) | unchanged |

---

## Why 8767 stays

Carbon's site gets a second pair of `listen` lines, not a second site. One server block on 80 and
8767: the same files, cache rules and Moonraker proxy, and the same `/helper/` loopback rule. There
is nothing to keep in sync between the two ports.

- **The panel kiosk opens `http://127.0.0.1:8767/screen.html`** (`KIOSK_URL` in
  `/etc/default/carbon-kiosk`). `tools/install.sh` reads that file and refuses a run that would stop
  serving the kiosk's port, so the panel cannot be blacked out by a port change.
- `tools/update_verify.py`, UPDATING.md and CUTOVER.md all name `:8767`, and so may a slicer preset or
  a bookmark. They all keep working.
- `/helper/` stays loopback-only on **both** ports. The rule is by client address, not by port, so a
  LAN client gets 403 on `:80` exactly as on `:8767`.

A re-run of `tools/install.sh` with no `--port` keeps whatever ports the live site listens on, the
way it keeps the root, and `--also-port` on its own adds to them. Passing `--port` replaces the list.
The installer prints `PORT CHANGE` and the ports it would stop serving; answer N if you did not mean it.

---

## Doing it

**Printer idle.** `move_mainsail_port.sh` refuses while Moonraker reports a print printing or paused;
`install.sh` does not check, so confirm the printer is still idle right before it
(`curl -s 'http://127.0.0.1:7125/printer/objects/query?print_stats=state'`). Run them
over SSH as `olitetu`, not with sudo: they call sudo themselves, and sudo asks for the password.
Inside `tmux new -A -s port80`, a dropped SSH session cannot stop one halfway.

```bash
cd ~/voron-carbon && git status --short && git pull --ff-only
bash tools/move_mainsail_port.sh --dry-run      # shows the two-line edit to Mainsail's site
bash tools/move_mainsail_port.sh                # Mainsail 80 -> 81, after a dated backup
bash tools/install.sh --port 80 --also-port 8767 --dry-run
bash tools/install.sh --port 80 --also-port 8767
```

`move_mainsail_port.sh` edits only `/etc/nginx/sites-available/mainsail`, and in it only `listen 80;`
and the commented-out IPv6 line (it stays commented, on 81). It refuses if 81 is taken, runs
`nginx -t` before the reload and restores the backup if that fails. It then checks that `:81` serves
Mainsail, with a working `/server/info` and websocket, and that `:80` no longer does. Between the two
steps `http://voron.local/` answers nothing.

`install.sh` refuses port 80 while an enabled nginx site still listens on it. For Mainsail it prints
the `move_mainsail_port.sh` command. For anything else, a stock `default` site for example, it names
the file. Its acceptance checks run on the primary port (80): every page, the API, the websocket.
Then `/` and `/screen.html` on 8767, the kiosk's own URL, and `/helper/` on both ports, which must
answer on loopback and be refused (403) from the Pi's LAN address.

Then, from the Mac:

```bash
curl -s http://voron.local/ | grep -o '<title>[^<]*'                       # <title>Voron Carbon
curl -s http://voron.local:8767/ | grep -o '<title>[^<]*'                  # <title>Voron Carbon
curl -s http://voron.local:81/ | grep -o '<title>[^<]*'                    # <title>Mainsail
curl -s -o /dev/null -w '%{http_code}\n' http://voron.local/helper/health       # 403
curl -s -o /dev/null -w '%{http_code}\n' http://voron.local:8767/helper/health  # 403
```

And on the panel: nothing changes. It keeps `127.0.0.1:8767`. In Home Assistant, the printer's
camera (if used) shows a live image again.

---

## What else moves with it

- **Bookmarks** to `http://voron.local/` now open Carbon. Mainsail is at `:81`.
- **Mainsail's settings** live in Moonraker's database (namespace `mainsail`), so dashboard layouts and
  macro groups follow it to `:81`. What it keeps in the browser starts fresh, because `:81` is a new
  origin. The same goes for Carbon at `http://voron.local/`: its per-browser state (the last route,
  filters, the selected file) starts fresh, and its prefs (jog steps, macro tiles) come from the
  database as before.
- **Carbon's G-code viewer** opens Mainsail's viewer at `:81` (`MAINSAIL_PORT` in
  `src/pages/viewer/index.jsx`). It needs a build that has it: rsync `dist/` as usual.
- **OrcaSlicer.** A preset whose host is `voron.local` (port 80) keeps uploading: Carbon proxies `/api/`
  exactly as Mainsail's site did. Its Device tab now shows Carbon. Use `http://voron.local:81` there to
  get Mainsail back. Presets on `:8767` are unchanged.
- **Webcam.** `/webcam/` is proxied on Carbon's ports too, so a stream URL on port 80 keeps working.
  Only `/webcam/` is: Mainsail's `/webcam2/` to `/webcam4/` are not, and this printer has one camera.
  Home Assistant's printer camera (if used) goes through port 80 (`http://voron.local/webcam/`): it
  is dark between the two steps, and should show a live image again after the `install.sh` step.
- **KIAUH.** Reinstalling Mainsail with KIAUH rewrites its site and asks for a port. Give it 81, or
  run `move_mainsail_port.sh` again afterwards. Moonraker's own Mainsail updates only replace
  `~/mainsail` and never touch nginx.

---

## Undoing it

Carbon first, then Mainsail. `move_mainsail_port.sh --back` refuses while Carbon holds port 80, and
prints the command below.

```bash
cd ~/voron-carbon
bash tools/install.sh --port 8767            # PORT CHANGE 80 8767 -> 8767; answer y
bash tools/move_mainsail_port.sh --back      # Mainsail 81 -> 80
```

Carbon's viewer then still opens Mainsail at `:81` until `MAINSAIL_PORT` goes back to 80 and the build
is redeployed.

File-level fallback, if a script will not run: each one leaves a dated backup. Restore them in this
order. First Carbon's from the `install.sh` step (`carbon.bak-<stamp>`, named on its `backed up
existing site →` line), then Mainsail's (`mainsail.bak-<stamp>`, named on the move script's `backed
up` and `Previous site:` lines), each with
`sudo cp -p /etc/nginx/sites-available/<site>.bak-<stamp> /etc/nginx/sites-available/<site> && sudo nginx -t && sudo systemctl reload nginx`.
The other order puts Mainsail back on 80 while Carbon still holds it: `nginx -t` only warns, Carbon
keeps answering on 80, and Mainsail is reachable nowhere. After each restore,
`sudo nginx -t 2>&1 | grep -c conflicting` must print 0.
