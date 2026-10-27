#!/usr/bin/env bash
#
# Voron Carbon — move Mainsail's nginx site off port 80, so Carbon can be the printer's default UI.
# Run ON the printer host, as your normal user: it calls sudo itself.
#
#   bash tools/move_mainsail_port.sh --dry-run     # show the checks and the exact edit, change nothing
#   bash tools/move_mainsail_port.sh               # Mainsail: 80 -> 81
#   bash tools/move_mainsail_port.sh 8081          # ... or another free port
#   bash tools/move_mainsail_port.sh --back        # Mainsail back on 80 (Carbon must give 80 up first)
#
# It edits one file, /etc/nginx/sites-available/mainsail, and in it only the listen lines: the
# `listen 80;` line, and the IPv6 line, which KIAUH ships commented out and which stays commented,
# on the new port. The rest of Mainsail's site is left byte for byte. A dated backup is taken first,
# nginx reloads only once `nginx -t` passes, and a failed test puts the backup back without a reload.
#
# Mainsail does not care which port it is on: with "port": null in its config.json (the default)
# it reaches Moonraker through whatever origin it was loaded from. KIAUH's own layout for a second
# web UI on port 81 is this same edit. Moonraker, KlipperScreen and Home Assistant's sensors use port
# 7125 and never notice. HA's camera entity loads http://<printer>/webcam/ (port 80): it is dark until
# install.sh gives port 80 to Carbon, whose site proxies /webcam/ too.
#
# Then give port 80 to Carbon:  bash tools/install.sh --port 80 --also-port 8767   (docs/PORT80.md)

set -euo pipefail

TO=""                     # the port Mainsail moves to: 81 by default, 80 with --back
BACK=0
DRY_RUN=0
ASSUME_YES=0
FORCE=0
MOONRAKER_PORT=7125
# Tests point this at a scratch tree (it moves /etc/nginx under it). Never set it on the printer.
ETC="${CARBON_TEST_ETC:-/etc}"

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  PORT                   Port to move Mainsail to (default: 81)
  --back                 Move Mainsail back to port 80
  --dry-run              Show the checks and the edit, change nothing
  --yes                  Don't prompt for confirmation
  --moonraker-port N     Moonraker's port on this host (default: $MOONRAKER_PORT)
  --force                Go on when Moonraker cannot say whether a print is running.
                         It never overrides a printer Moonraker reports printing or paused.
  --help
EOF
}

# || true: a write error (hung-up SSH tty) inside a function exits under -e WITHOUT the ERR trap (no -E).
say()  { printf '  %s\n' "$*" || true; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
# A TCP port nginx can listen on: digits only, no leading zero, 1-65535.
is_port() { case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 5 ] && [ "$1" -le 65535 ]; }

while [ $# -gt 0 ]; do
  case "$1" in
    --back)           BACK=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --yes|-y)         ASSUME_YES=1; shift ;;
    --force)          FORCE=1; shift ;;
    --moonraker-port) MOONRAKER_PORT="${2:?--moonraker-port needs a number}"; shift 2 ;;
    --help|-h)        usage; exit 0 ;;
    -*)               echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)                [ -z "$TO" ] || fail "One port only (got $TO and $1)."
                      is_port "$1" || fail "$1 is not a port number (1-65535)."
                      TO="$1"; shift ;;
  esac
done
if [ "$BACK" = 1 ]; then
  [ -z "$TO" ] || fail "--back always means port 80; drop the $TO."
  TO=80
fi
TO="${TO:-81}"

# The ports a config's `listen` directives use, in order, each once (stdin -> stdout). Same parser as
# tools/install.sh: comments dropped first, an address alone means 80.
listen_ports() {
  awk '
    { sub(/#.*/, "") }
    $1 == "listen" {
      a = $2; sub(/;.*/, "", a)
      if (a ~ /^unix:/) next
      if (a ~ /^[0-9]+$/) p = a
      else if (a ~ /:[0-9]+$/) { p = a; sub(/.*:/, "", p) }
      else p = 80
      if (!(p in seen)) { seen[p] = 1; out = out (out == "" ? "" : " ") p }
    }
    END { print out }'
}
url_for() { if [ "$2" = 80 ]; then printf 'http://%s/' "$1"; else printf 'http://%s:%s/' "$1" "$2"; fi; }
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" 2>/dev/null || true; }

# A reason the real run must stop. A dry run reports it and carries on, so the edit is still shown.
BLOCKED=0
block() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '\n  BLOCKED: %s\n\n' "$*" || true
    BLOCKED=1
  else
    fail "$*"
  fi
}

echo
echo "Voron Carbon — move Mainsail's port"
echo

# ── preflight ───────────────────────────────────────────────────────────────────────────────────
echo "Checking the host…"

# Where this script runs from. It calls sudo and rewrites an nginx site, so it must not run from
# anywhere Moonraker's file API can write: every trusted LAN client can edit ~/printer_data.
REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PD="$(cd "$HOME/printer_data" 2>/dev/null && pwd -P || true)"
if [ -n "$PD" ]; then
  case "$REAL/" in
    "$PD"/*) fail "Refusing to run from $REAL: Moonraker lets every trusted LAN client write there. Run it from your git checkout:  cd ~/voron-carbon && bash tools/move_mainsail_port.sh" ;;
  esac
fi
if TOP="$(git -C "$REAL" rev-parse --show-toplevel 2>/dev/null)"; then
  DIRTY="$(git --no-optional-locks -C "$TOP" status --porcelain -- tools/move_mainsail_port.sh 2>/dev/null || echo '?? git status failed')"
  [ -z "$DIRTY" ] || fail "tools/move_mainsail_port.sh has local changes. Review them (git -C $TOP diff -- tools/move_mainsail_port.sh), commit or discard them, and re-run."
  say "script: $TOP at $(git -C "$TOP" rev-parse --short HEAD 2>/dev/null)"
else
  say "script: $REAL (not a git checkout)"
fi

command -v nginx >/dev/null 2>&1 || fail "nginx is not installed — run this on the printer."
command -v curl  >/dev/null 2>&1 || fail "curl is missing (sudo apt install -y curl): the print-state check and the checks after the reload need it."
HOST_NAME="$(hostname 2>/dev/null || echo PRINTER_HOST)"

# KIAUH / MainsailOS layout only: the site in sites-available, enabled by a link in sites-enabled.
NGINX_DIR="$ETC/nginx"
SITE="$NGINX_DIR/sites-available/mainsail"
LINK="$NGINX_DIR/sites-enabled/mainsail"
[ -f "$SITE" ] || fail "No Mainsail site at $SITE. This script knows the KIAUH / MainsailOS layout only; change your Mainsail site's listen line by hand."
if [ ! -e "$LINK" ]; then
  fail "Mainsail's site is not enabled ($LINK is missing), so there is nothing serving it to move."
elif [ ! "$LINK" -ef "$SITE" ]; then
  fail "$LINK is not a link to $SITE (a copy?), so editing $SITE would change nothing nginx loads. Make it a link first:  sudo ln -sfn $SITE $LINK"
fi
say "Mainsail's site: $SITE (enabled)"

# The port it is on now: its one plain `listen N;` line. Anything fancier is left to a human.
FROM="$(awk '{ sub(/#.*/, "") }
             $1 == "listen" && NF == 2 && $2 ~ /^[0-9]+;$/ {
               p = $2; sub(/;/, "", p); if (!(p in s)) { s[p] = 1; o = o (o == "" ? "" : " ") p } }
             END { print o }' "$SITE" 2>/dev/null || true)"
case "$FROM" in
  "")    fail "$SITE has no plain 'listen <port>;' line, so this script cannot tell what to move. Change its listen line by hand." ;;
  *" "*) fail "$SITE listens on several plain ports ($FROM). This script moves exactly one; change it by hand." ;;
esac
say "Mainsail listens on: $FROM"
if [ "$FROM" = "$TO" ]; then
  echo
  echo "Mainsail is already on port $TO. Nothing to do."
  exit 0
fi

# Never while printing. A reload does not touch Klipper, but every browser on Mainsail drops and
# reconnects, and the moment to find out that something else used port $FROM is not mid-print.
STATE_JSON="$(curl -fsS -m 5 "http://127.0.0.1:$MOONRAKER_PORT/printer/objects/query?print_stats=state" 2>/dev/null || true)"
STATE="$(printf '%s\n' "$STATE_JSON" | sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([a-z_]*\)".*/\1/p' || true)"
case "$STATE" in
  printing|paused)
    block "The printer is $STATE. Run this when it is idle: nginx reloads, and every browser on Mainsail reconnects." ;;
  "")
    if [ "$FORCE" = 1 ]; then
      say "Printer: state unknown (no answer from Moonraker on 127.0.0.1:$MOONRAKER_PORT); going on because of --force"
    else
      block "Moonraker on 127.0.0.1:$MOONRAKER_PORT did not say whether a print is running. Start it (or pass --moonraker-port), or, if you are sure the printer is idle, re-run with --force."
    fi ;;
  *) say "Printer: $STATE" ;;
esac

# The target port must be free. ss alone cannot say whose a port is, so the enabled sites are read too.
SS_OUT=""
HAVE_SS=0
if command -v ss >/dev/null 2>&1; then
  HAVE_SS=1
  SS_OUT="$(ss -ltn 2>/dev/null || true)"   # captured once: `ss | grep -q` can lose to SIGPIPE under pipefail
fi
listening() { grep -qE ":$1[[:space:]]" <<<"$SS_OUT"; }
port_holder() {   # $1 port -> the first enabled nginx file, other than Mainsail's, that listens on it
  local f ports
  for f in "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf; do
    [ -e "$f" ] || continue                     # an unmatched glob, or a dangling link
    if [ "$f" -ef "$SITE" ]; then continue; fi
    ports=" $(listen_ports 2>/dev/null < "$f" || true) "
    case "$ports" in *" $1 "*) printf '%s\n' "$f"; return 0 ;; esac
  done
  return 0
}
carbon_site() {   # the enabled site tools/install.sh generated, if any
  local f
  for f in "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf; do
    [ -e "$f" ] || continue
    if grep -q 'generated by tools/install.sh' "$f" 2>/dev/null; then printf '%s\n' "$f"; return 0; fi
  done
  return 0
}
# `bash .../install.sh --port A --also-port B ...` for a port list "A B ..."
install_cmd() {
  local first="${1%% *}" p cmd
  cmd="bash $REAL/install.sh --port $first"
  for p in ${1#"$first"}; do cmd="$cmd --also-port $p"; done
  printf '%s\n' "$cmd"
}
if [ "$BACK" = 1 ]; then RERUN="bash $REAL/move_mainsail_port.sh --back"; else RERUN="bash $REAL/move_mainsail_port.sh $TO"; fi

holder="$(port_holder "$TO")"
if [ -n "$holder" ]; then
  if [ "$TO" = 80 ] && grep -q 'generated by tools/install.sh' "$holder" 2>/dev/null; then
    # Carbon has port 80. Say exactly how to give it back: the same site minus port 80, or 8767 alone.
    keep=""
    for p in $(listen_ports 2>/dev/null < "$holder" || true); do
      if [ "$p" != "$TO" ]; then keep="$keep $p"; fi
    done
    keep="${keep# }"
    block "Carbon serves port $TO ($holder). Give it back first, then re-run this:
      $(install_cmd "${keep:-8767}")
      $RERUN"
  else
    block "Port $TO is already served by another nginx site: $holder. Pick another port."
  fi
elif [ "$HAVE_SS" = 1 ] && listening "$TO"; then
  block "Port $TO is already in use, and not by an enabled nginx site. See what holds it:  sudo ss -ltnp 'sport = :$TO'"
elif [ "$HAVE_SS" = 1 ]; then
  say "Port $TO: free"
else
  say "Port $TO: NOT verified (ss missing); no other enabled nginx site claims it"
fi

# ── the edit, computed before anything is touched ───────────────────────────────────────────────
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/mainsail-port.XXXXXX")" || fail "Could not create a temporary directory."
trap 'rm -rf "$TMPD"' EXIT
NEW="$TMPD/mainsail"
# Only `listen FROM;` and the IPv6 line `[#] listen [::]:FROM;`, commented or not, keeping its #.
sed -E \
  -e "s/^([[:space:]]*listen[[:space:]]+)$FROM;/\\1$TO;/" \
  -e "s/^([[:space:]]*#?[[:space:]]*listen[[:space:]]+\\[::\\]:)$FROM;/\\1$TO;/" \
  "$SITE" > "$NEW" || fail "Could not read $SITE. Nothing was written."
CHANGED="$(diff "$SITE" "$NEW" 2>/dev/null | grep -c '^>' || true)"
NOT_LISTEN="$(diff "$SITE" "$NEW" 2>/dev/null | grep '^[<>]' | grep -vc 'listen' || true)"
LEFT=" $(listen_ports 2>/dev/null < "$NEW" || true) "
[ "${CHANGED:-0}" -ge 1 ] || fail "The edit changed nothing in $SITE. Nothing was written."
[ "${NOT_LISTEN:-0}" = 0 ] || fail "The edit touched a line that is not a listen line. Nothing was written."
case "$LEFT" in
  *" $FROM "*) fail "$SITE has a listen line on $FROM that this script does not rewrite (an address, or extra parameters). Change it by hand. Nothing was written." ;;
esac

# What to run next, with Carbon's ports as they are now (8767 if Carbon is not installed yet).
NEXT=""
if [ "$FROM" = 80 ]; then
  CSITE="$(carbon_site)"
  CPORTS=""
  if [ -n "$CSITE" ]; then CPORTS="$(listen_ports 2>/dev/null < "$CSITE" || true)"; fi
  rest=""
  for p in ${CPORTS:-8767}; do
    if [ "$p" != 80 ]; then rest="$rest $p"; fi
  done
  NEXT="$(install_cmd "80$rest")"
fi

echo
echo "Plan:"
say "backup  $SITE  ->  $SITE.bak-<date>"
say "edit    $SITE, its listen lines only:"
diff "$SITE" "$NEW" | sed -n 's/^\([<>]\)/        \1/p' || true
say "test    sudo nginx -t  (a failure puts the backup back, and nothing reloads)"
say "reload  nginx (never restart — existing connections are not dropped)"
say "then    Mainsail at $(url_for "$HOST_NAME" "$TO")"
if [ -n "$NEXT" ]; then
  say "        $(url_for "$HOST_NAME" 80) answers nothing until Carbon takes it:  $NEXT"
fi
echo
say "Nothing else is modified. No other file is written."

if [ "$DRY_RUN" = 1 ]; then
  echo
  if [ "$BLOCKED" = 1 ]; then
    echo "Dry run: a real run would stop at the BLOCKED line(s) above."
    exit 1
  fi
  echo "Dry run: nothing changed."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  echo
  # read returns 1 at EOF (^D, or no tty and no --yes): treat that as N instead of exiting silently.
  read -r -p "  Proceed? [y/N] " reply || reply=""
  case "$reply" in [yY]*) ;; *) echo "  Aborted; nothing changed."; exit 0 ;; esac
fi

# ── edit, validating before reloading ───────────────────────────────────────────────────────────
echo
echo "Moving…"
BACKUP="$SITE.bak-$(date +%Y%m%d%H%M%S)"
sudo cp -p "$SITE" "$BACKUP"
say "backed up $SITE → $BACKUP"

# Undo this run ON DISK. Nothing reloads nginx before the end, so putting the file back leaves both
# the running config and the next boot exactly as they were.
restore_site() {
  sudo cp -p "$BACKUP" "$SITE"
  say "restored $SITE from $BACKUP"
  if sudo nginx -t >/dev/null 2>&1; then
    say "on-disk config is valid again. nginx was NOT reloaded: Mainsail is still on port $FROM."
  else
    say "nginx -t STILL FAILS after restoring. The fault is outside $SITE."
    say "Do NOT reboot or 'systemctl restart nginx' until 'sudo nginx -t' passes, or nginx will not start."
  fi
}
# Also covers dying between the write and the test: a failed command, ^C, or a dropped SSH session.
trap 'restore_site; fail "Stopped by a failed command or a signal (see above). Rolled back on disk."' ERR INT TERM HUP

sudo tee "$SITE" < "$NEW" >/dev/null
say "wrote $SITE"

if ! sudo nginx -t 2>"$TMPD/nginx-test.log"; then
  trap - ERR INT TERM HUP
  say "nginx -t FAILED with the edit in place:"
  sed 's/^/       /' "$TMPD/nginx-test.log" >&2 || true   # display only: must not skip the rollback
  restore_site
  fail "Rolled back to the previous on-disk state; nothing was reloaded."
fi
say "nginx -t passed"

sudo systemctl reload nginx
trap - ERR INT TERM HUP
say "nginx reloaded"

# ── acceptance ──────────────────────────────────────────────────────────────────────────────────
echo
echo "Checking it works…"
is_mainsail_at() {   # $1 port: does http://127.0.0.1:$1/ serve Mainsail's index page?
  local b
  b="$(curl -s -m 5 "http://127.0.0.1:$1/" 2>/dev/null || true)"
  case "$b" in *"<title>Mainsail</title>"*) return 0 ;; esac
  return 1
}
# `systemctl reload` returns once nginx has the signal, not once the new workers listen.
n=0
until is_mainsail_at "$TO" || [ "$n" -ge 10 ]; do sleep 1; n=$((n + 1)); done
n=0
while is_mainsail_at "$FROM" && [ "$n" -lt 10 ]; do sleep 1; n=$((n + 1)); done

ok=1
if is_mainsail_at "$TO"; then
  printf '  ok    %-18s Mainsail\n' ":$TO/"
else
  printf '  FAIL  %-18s %s, not Mainsail\n' ":$TO/" "$(code "http://127.0.0.1:$TO/")"; ok=0
fi
got="$(code "http://127.0.0.1:$TO/server/info")"
[ "$got" = 200 ] && printf '  ok    %-18s %s\n' ":$TO/server/info" "$got" \
                 || { printf '  FAIL  %-18s %s (expected 200: Mainsail proxies Moonraker here)\n' ":$TO/server/info" "${got:-no answer}"; ok=0; }
WS_HOST="127.0.0.1:$TO"                    # what a browser sends: no :80 on port 80
[ "$TO" != 80 ] || WS_HOST="127.0.0.1"
# A websocket that upgrades stays open: curl ends by its own -m timeout or by SIGPIPE from head,
# either of which fails the pipeline under pipefail. Only the status code matters, hence || true.
WS="$(curl -s -i -m 3 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      -H "Host: $WS_HOST" -H "Origin: http://$WS_HOST" \
      "http://127.0.0.1:$TO/websocket" 2>/dev/null | head -1 | awk '{print $2}' || true)"
[ "$WS" = 101 ] && printf '  ok    %-18s 101 Switching Protocols\n' ":$TO/websocket" \
                || { printf '  FAIL  %-18s %s (expected 101)\n' ":$TO/websocket" "${WS:-no response}"; ok=0; }
if is_mainsail_at "$FROM"; then
  printf '  FAIL  %-18s still Mainsail\n' ":$FROM/"; ok=0
else
  got="$(code "http://127.0.0.1:$FROM/")"
  case "$got" in
    000|"") printf '  ok    %-18s no longer Mainsail (nothing listens there now)\n' ":$FROM/" ;;
    *)      printf '  ok    %-18s no longer Mainsail (%s from whatever else serves it)\n' ":$FROM/" "$got" ;;
  esac
fi

echo
if [ "$ok" = 1 ]; then
  echo "Done.  Mainsail  →  $(url_for "$HOST_NAME" "$TO")"
  echo
  if [ -n "$NEXT" ]; then
    say "Port 80 is free. Give it to Carbon next:"
    say "    $NEXT --dry-run"
    say "    $NEXT"
  fi
  if [ "$TO" != 80 ]; then
    say "To move Mainsail back later:  bash $REAL/move_mainsail_port.sh --back"
  fi
  say "Previous site: $BACKUP"
else
  echo "Moved, but some checks failed — see above."
  say "Logs: /var/log/nginx/mainsail-error.log"
  say "Put the previous site back:  sudo cp -p $BACKUP $SITE && sudo nginx -t && sudo systemctl reload nginx"
  exit 1
fi
