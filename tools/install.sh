#!/usr/bin/env bash
#
# Voron Carbon — installer. Run ON the printer host.
#
#   bash install.sh                       # auto-detect everything, ask before changing anything
#   bash install.sh --port 8767           # pick the port Carbon is served on
#   bash install.sh --dry-run             # print what it WOULD do and exit
#   bash install.sh --help
#
# Serves Carbon on its own port with Moonraker proxied alongside it, so the app is same-origin with
# the API. It does NOT touch your existing web UI: Mainsail/Fluidd on port 80 are left exactly as
# they are, and this script never edits a config file it did not create.
#
# Why its own port rather than a sub-path under your existing UI: Mainsail ships a root-scoped
# service worker whose navigation fallback denylist covers only /access /api /printer /server
# /websocket /webcam, so a sub-path like /carbon/ gets served Mainsail's cached shell instead of
# Carbon. A separate port is a separate origin, which sidesteps that completely.
#
# Requires: nginx, and a Moonraker instance on this host. Needs sudo only to write into
# /etc/nginx and reload the service.

set -euo pipefail

# ── defaults ────────────────────────────────────────────────────────────────────────────────────
PORT=8767
HELPER_PORT=8770
MOONRAKER_PORT=7125
WEBCAM_PORT=8080          # crowsnest/ustreamer default; --webcam-port 0 disables the webcam proxy
ROOT=""                   # where Carbon's files live; auto-detected if not given
SITE_NAME="carbon"
DRY_RUN=0
ASSUME_YES=0

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --root PATH            Directory holding Carbon's index.html (default: auto-detect)
  --port N               Port to serve Carbon on (default: $PORT)
  --moonraker-port N     Moonraker's port on this host (default: $MOONRAKER_PORT)
  --webcam-port N        Webcam stream port; 0 to skip the webcam proxy (default: $WEBCAM_PORT)
  --site-name NAME       nginx site filename (default: $SITE_NAME)
  --helper-port N        loopback port of the host helper (default: $HELPER_PORT)
  --dry-run              Show the plan and the generated config, change nothing
  --yes                  Don't prompt for confirmation
  --help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root)           ROOT="${2:?--root needs a path}"; shift 2 ;;
    --port)           PORT="${2:?}"; shift 2 ;;
    --moonraker-port) MOONRAKER_PORT="${2:?}"; shift 2 ;;
    --webcam-port)    WEBCAM_PORT="${2:?}"; shift 2 ;;
    --site-name)      SITE_NAME="${2:?}"; shift 2 ;;
    --helper-port)    HELPER_PORT="${2:?}"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --yes|-y)         ASSUME_YES=1; shift ;;
    --help|-h)        usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

echo
echo "Voron Carbon installer"
echo

# ── preflight ───────────────────────────────────────────────────────────────────────────────────
echo "Checking the host…"

# Where this script runs from. It calls sudo and writes an nginx site, so it must not run from
# anywhere Moonraker's file API can write: every trusted LAN client can edit ~/printer_data.
REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PD="$(cd "$HOME/printer_data" 2>/dev/null && pwd -P || true)"
if [ -n "$PD" ]; then
  case "$REAL/" in
    "$PD"/*) fail "Refusing to run from $REAL: Moonraker lets every trusted LAN client write there. Run it from your git checkout:  cd ~/voron-carbon && bash tools/install.sh" ;;
  esac
fi
if TOP="$(git -C "$REAL" rev-parse --show-toplevel 2>/dev/null)"; then
  DIRTY="$(git --no-optional-locks -C "$TOP" status --porcelain -- tools/install.sh 2>/dev/null || echo '?? git status failed')"
  [ -z "$DIRTY" ] || fail "tools/install.sh has local changes. Review them (git -C $TOP diff -- tools/install.sh), commit or discard them, and re-run."
  say "installer: $TOP at $(git -C "$TOP" rev-parse --short HEAD 2>/dev/null)"
else
  say "installer: $REAL (not a git checkout)"
fi

command -v nginx >/dev/null 2>&1 || fail "nginx is not installed. Install it first (apt install nginx), then re-run."
say "nginx: $(nginx -v 2>&1 | sed 's|nginx version: ||')"

# nginx layout: Debian-style sites-available/sites-enabled, or conf.d only (RPM-style / minimal).
NGINX_DIR=/etc/nginx
if [ -d "$NGINX_DIR/sites-available" ] && [ -d "$NGINX_DIR/sites-enabled" ]; then
  LAYOUT=sites
  SITE_FILE="$NGINX_DIR/sites-available/$SITE_NAME"
  LINK_FILE="$NGINX_DIR/sites-enabled/$SITE_NAME"
elif [ -d "$NGINX_DIR/conf.d" ]; then
  LAYOUT=confd
  SITE_FILE="$NGINX_DIR/conf.d/$SITE_NAME.conf"
  LINK_FILE=""
else
  fail "Cannot find $NGINX_DIR/sites-available or $NGINX_DIR/conf.d — unrecognised nginx layout."
fi
say "nginx layout: $LAYOUT  →  $SITE_FILE"

# Moonraker must be reachable, or the app has nothing to talk to.
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$MOONRAKER_PORT/server/info"; then
    say "Moonraker: responding on 127.0.0.1:$MOONRAKER_PORT"
  else
    fail "No Moonraker on 127.0.0.1:$MOONRAKER_PORT. Pass --moonraker-port if yours differs."
  fi
else
  say "Moonraker: NOT verified (curl missing) — assuming 127.0.0.1:$MOONRAKER_PORT"
fi

# A re-run keeps the root the live site already serves. The panel kiosk and Moonraker's
# update_manager (path:) both depend on it, and the candidates below never include a relocated
# root, so a bare re-run used to stop, or quietly re-point the whole site at another directory.
EXISTING_ROOT=""
if [ -f "$SITE_FILE" ]; then
  EXISTING_ROOT="$(awk '$1=="root"{gsub(/;/,"",$2);print $2;exit}' "$SITE_FILE" 2>/dev/null || true)"
fi
if [ -z "$ROOT" ] && [ -n "$EXISTING_ROOT" ]; then
  ROOT="$EXISTING_ROOT"
  say "Keeping the existing site's root: $ROOT"
fi

# Auto-detect where Carbon's files are, if not told. <checkout>/dist comes before the checkout
# itself: the build writes index.html there, never to the repo root.
if [ -z "$ROOT" ]; then
  for cand in \
      "$HOME/printer_data/carbon" \
      "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist" \
      "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" \
      "$HOME/carbon" ; do
    if [ -f "$cand/index.html" ]; then ROOT="$cand"; break; fi
  done
  [ -n "$ROOT" ] || fail "Could not find Carbon's index.html. Pass --root /path/to/carbon"
fi
[ -d "$ROOT" ] || fail "$ROOT does not exist. Build Carbon first with: npm ci && npm run build"
ROOT="$(cd "$ROOT" && pwd)"
[ -f "$ROOT/index.html" ] || fail "$ROOT/index.html does not exist — is --root right?"
say "Carbon files: $ROOT"
[ -f "$ROOT/app.js" ] || say "WARNING: $ROOT/app.js is missing — the app will not load."
if [ -n "$EXISTING_ROOT" ] && [ "$EXISTING_ROOT" != "$ROOT" ]; then
  echo
  echo "  ROOT CHANGE   $EXISTING_ROOT  ->  $ROOT"
  echo "  The live site serves the first; this run would serve the second. The panel kiosk and"
  echo "  Moonraker's update_manager (path:) follow whatever nginx serves. If that is not what you"
  echo "  meant, answer N below and re-run without --root: a re-run keeps the existing root."
  echo
fi

# Port must be free. A listener here is almost always a previous install or another UI.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT[[:space:]]"; then
  if [ -e "$SITE_FILE" ]; then
    say "Port $PORT is in use — by this installer's own site, which will be replaced."
  else
    fail "Port $PORT is already in use by something else. Pick another with --port."
  fi
else
  say "Port $PORT: free"
fi

# nginx runs as its own user and must be able to traverse every parent of ROOT. We do NOT chmod
# anyone's home directory behind their back — we report it and let the operator decide.
NGINX_USER="$(awk '$1=="user"{gsub(/;/,"",$2); print $2; exit}' "$NGINX_DIR/nginx.conf" 2>/dev/null || true)"
NGINX_USER="${NGINX_USER:-www-data}"
if id "$NGINX_USER" >/dev/null 2>&1; then
  if sudo -u "$NGINX_USER" test -r "$ROOT/index.html" 2>/dev/null; then
    say "Permissions: $NGINX_USER can read $ROOT/index.html"
  else
    echo
    echo "  PERMISSION PROBLEM"
    echo "  nginx runs as '$NGINX_USER' and cannot read $ROOT/index.html."
    echo "  Every directory above it needs the execute bit for others. Usually this fixes it:"
    echo
    echo "      chmod o+x $HOME"
    echo
    echo "  That lets any local user *traverse* your home directory (not list it). If you would"
    echo "  rather not, put Carbon somewhere world-traversable instead, e.g. /var/www/carbon,"
    echo "  and re-run with --root /var/www/carbon."
    echo
    [ "$DRY_RUN" = 1 ] || fail "Fix the permission above, then re-run."
  fi
else
  say "Permissions: NOT verified (no '$NGINX_USER' user found) — check by hand if it 403s"
fi

# ── generate the config ─────────────────────────────────────────────────────────────────────────
# Upstreams and the connection-upgrade map are declared with names unique to this site, so we never
# collide with — or depend on — the ones your existing web UI defines.
UP_API="carbon_apiserver_${PORT}"
UP_CAM="carbon_webcam_${PORT}"
MAP_VAR="carbon_connection_upgrade_${PORT}"

WEBCAM_BLOCK=""
if [ "$WEBCAM_PORT" != "0" ]; then
  WEBCAM_BLOCK=$(cat <<EOF

    # Webcam. Moonraker hands clients a ROOT-RELATIVE stream path (e.g. /webcam/?action=stream),
    # so it resolves against THIS origin and has to be proxied here too.
    location /webcam/ {
        postpone_output 0;
        proxy_buffering off;
        proxy_ignore_headers X-Accel-Buffering;
        access_log off;
        error_log off;
        proxy_pass http://$UP_CAM/;
    }
EOF
)
fi

CONF=$(cat <<EOF
# Voron Carbon — generated by tools/install.sh on $(date -u '+%Y-%m-%d %H:%M:%SZ')
# Serves Carbon on port $PORT with Moonraker proxied alongside, so the app is same-origin with the
# API. Safe to delete: removing this file and reloading nginx removes Carbon entirely.
#
# Regenerate rather than hand-edit — re-run tools/install.sh with different flags.

upstream $UP_API { server 127.0.0.1:$MOONRAKER_PORT; }
$( [ "$WEBCAM_PORT" != "0" ] && echo "upstream $UP_CAM { server 127.0.0.1:$WEBCAM_PORT; }" )

map \$http_upgrade \$$MAP_VAR {
    default upgrade;
    ''      close;
}

server {
    listen $PORT;
    listen [::]:$PORT;
    server_name _;

    access_log /var/log/nginx/${SITE_NAME}-access.log;
    error_log  /var/log/nginx/${SITE_NAME}-error.log;

    root $ROOT;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 4;
    gzip_min_length 512;
    gzip_types text/plain text/css text/xml text/javascript application/javascript
               application/json application/xml image/svg+xml;
    # woff2 is already compressed — deliberately not listed.

    # G-code uploads go through this server too, and they are large.
    client_max_body_size 0;
    proxy_request_buffering off;
    client_body_timeout 300s;

    # Carbon uses a HASH router, so the fragment never reaches the server and there is no need for
    # an index.html fallback. =404 on purpose: a missing asset should 404 honestly rather than
    # return index.html with status 200.
    location / {
        try_files \$uri \$uri/ =404;
    }

    # Cache-Control. Exact and prefix matches only — a regex like ~* \\.js\$ would also capture
    # Moonraker's own file-API paths below and steal them from the proxy.
    location = /index.html { add_header Cache-Control "no-store, no-cache, must-revalidate"; }
    location = /app.js     { add_header Cache-Control "no-cache"; }
    location = /viewer.js  { add_header Cache-Control "no-cache"; }
    location = /editor.js  { add_header Cache-Control "no-cache"; }
    location = /base.css   { add_header Cache-Control "no-cache"; }
    location ^~ /vendor/   { add_header Cache-Control "no-cache"; }

    # Carbon Screen — the printer's own touch panel. A kiosk has nobody to press
    # reload, so none of these may ever be served stale.
    location = /screen.html { add_header Cache-Control "no-store, no-cache, must-revalidate"; }
    location = /screen.js   { add_header Cache-Control "no-store, no-cache, must-revalidate"; }
    location = /screen.css  { add_header Cache-Control "no-store, no-cache, must-revalidate"; }
    # Safe mode is the fallback when screen.js will not run. It must never come from
    # a cache that might itself be the thing that is broken.
    location = /safe.html   { add_header Cache-Control "no-store, no-cache, must-revalidate"; }
    # Moonraker's update_manager reads this to decide whether an update exists.
    location = /release_info.json { add_header Cache-Control "no-store"; }
    # screen.html loads fonts/fonts.css, whose NAME never changes, so it must not fall under the
    # one-year immutable rule below or a kiosk keeps a stale stylesheet after an update. no-cache
    # revalidates it (a cheap 304 on loopback). An exact = match always beats the ^~ prefix.
    location = /fonts/fonts.css { add_header Cache-Control "no-cache"; }
    location ^~ /fonts/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        access_log off;
    }

    # Host helper — wifi and the panel backlight (tools/helper/). LOOPBACK ONLY:
    # these actions belong to whoever is standing at the printer, not to the LAN.
    # This is why the kiosk must open http://127.0.0.1:$PORT/screen.html and not the
    # hostname — through the hostname the request arrives from the LAN address and
    # is denied here, correctly.
    #
    # Absent helper: nginx answers 502 and the UI hides every control it powers.
    location ^~ /helper/ {
        allow 127.0.0.1;
        allow ::1;
        deny all;

        proxy_pass http://127.0.0.1:$HELPER_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        # The address nginx accepted the connection on: 127.0.0.1 or ::1 only for a client
        # on this machine that dialled loopback. The realip module cannot rewrite it, and
        # this replaces any header of that name the client sent. The helper refuses every
        # request without it (tools/helper/nginx-helper.conf is the reference copy).
        proxy_set_header X-Carbon-Local-Addr \$server_addr;
        proxy_read_timeout 240s;     # above a wifi connect's worst case with cleanup and rollback: CONNECT_CEILING, 217 s
        proxy_buffering off;
    }

    # Moonraker's websocket.
    #
    # \`Host \$http_host\` is LOAD-BEARING, not style: Tornado compares the Origin header's netloc to
    # the request Host *including the port*, so \$host (which strips :$PORT) makes every connection
    # 403. This is the single most common way a working config gets broken.
    location /websocket {
        proxy_pass http://$UP_API/websocket;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$$MAP_VAR;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }

    # Moonraker's HTTP API. /api is the OctoPrint-compatible surface, which is what slicers use —
    # keeping it here means a slicer can point at this port for uploads as well as for the UI.
    location ~ ^/(printer|api|access|machine|server|debug)/ {
        proxy_pass http://$UP_API\$request_uri;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Scheme \$scheme;

        # Don't spool large G-code reads/writes to disk, and survive a slow upload followed by
        # Moonraker's metadata scan (which happens after the last byte, in silence).
        proxy_max_temp_file_size 0;
        proxy_buffering off;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
    }
$WEBCAM_BLOCK
}
EOF
)

# ── plan / confirm ──────────────────────────────────────────────────────────────────────────────
echo
echo "Plan:"
say "write   $SITE_FILE"
if [ "$LAYOUT" = sites ]; then
  if [ -L "$LINK_FILE" ]; then
    say "keep    $LINK_FILE  (already enabled: the live file is replaced, and restored if nginx -t fails)"
  else
    say "symlink $LINK_FILE  (only after nginx -t passes)"
  fi
fi
say "reload  nginx (never restart — existing connections are not dropped)"
say "serve   http://$(hostname):$PORT/  from $ROOT"
echo
say "Nothing else is modified. No other nginx file is read or written. No permissions are changed."

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "──── generated config (dry run, nothing written) ────"
  printf '%s\n' "$CONF"
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  echo
  read -r -p "  Proceed? [y/N] " reply
  case "$reply" in [yY]*) ;; *) echo "  Aborted; nothing changed."; exit 0 ;; esac
fi

# ── install, validating before enabling ─────────────────────────────────────────────────────────
echo
echo "Installing…"

BACKUP=""                                   # set -u: stays empty on a first install
if [ -e "$SITE_FILE" ]; then
  BACKUP="$SITE_FILE.bak-$(date +%Y%m%d%H%M%S)"
  sudo cp -p "$SITE_FILE" "$BACKUP"
  say "backed up existing site → $BACKUP"
fi

# Undo this run ON DISK. The running nginx is never touched here: nothing reloads it before the end,
# so putting the file back leaves both the live config and the next boot as they were. On a re-run
# the site is already enabled, so deleting the file (as this used to) left a dangling sites-enabled
# link, which fails every later `nginx -t`: no nginx at the next boot, and no Mainsail either.
restore_site() {
  if [ -n "$BACKUP" ]; then
    sudo cp -p "$BACKUP" "$SITE_FILE"
    say "restored $SITE_FILE from $BACKUP (enabled link left as it was)"
  else
    sudo rm -f "$SITE_FILE"
    if [ -n "$LINK_FILE" ]; then sudo rm -f "$LINK_FILE"; fi   # no previous file => any link would dangle
  fi
  # belt and braces: never leave a dangling enabled link
  if [ -n "$LINK_FILE" ] && [ -L "$LINK_FILE" ] && [ ! -e "$LINK_FILE" ]; then sudo rm -f "$LINK_FILE"; fi
  if sudo nginx -t >/dev/null 2>&1; then
    say "on-disk config is valid again. nginx was NOT reloaded and still serves the previous config."
  else
    say "nginx -t STILL FAILS after restoring. The fault is outside $SITE_FILE."
    say "Do NOT reboot or 'systemctl restart nginx' until 'sudo nginx -t' passes, or nginx (and Mainsail) will not start."
  fi
}
# Also covers dying between the write and the test: a failed command, ^C, or a dropped SSH session.
trap 'restore_site; exit 1' ERR INT TERM HUP

printf '%s\n' "$CONF" | sudo tee "$SITE_FILE" >/dev/null
sudo chmod 0644 "$SITE_FILE"
say "wrote $SITE_FILE"

# Validate before enabling a new site, and before reloading an existing one. A broken config that is
# enabled takes down every other site on the next reload — including the UI the operator is reading
# this in. On a re-run the site is ALREADY enabled, which is why a failure restores the backup.
if ! sudo nginx -t 2>/tmp/carbon-nginx-test.log; then
  trap - ERR INT TERM HUP
  say "nginx -t FAILED with the new site in place:"
  sed 's/^/       /' /tmp/carbon-nginx-test.log >&2
  restore_site
  fail "Rolled back to the previous on-disk state."
fi
say "nginx -t passed"
if [ "$LAYOUT" = sites ] && [ ! -L "$LINK_FILE" ]; then
  sudo ln -sfn "$SITE_FILE" "$LINK_FILE"
  say "enabled $LINK_FILE"
  if ! sudo nginx -t 2>/tmp/carbon-nginx-test.log; then
    trap - ERR INT TERM HUP
    say "nginx -t FAILED after enabling:"
    sed 's/^/       /' /tmp/carbon-nginx-test.log >&2
    restore_site
    fail "Rolled back to the previous on-disk state."
  fi
  say "nginx -t passed"
fi

sudo systemctl reload nginx
trap - ERR INT TERM HUP
say "nginx reloaded"

# ── acceptance ──────────────────────────────────────────────────────────────────────────────────
echo
echo "Checking it works…"
H="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" 2>/dev/null || echo "---"; }
ok=1
for probe in "/:200" "/app.js:200" "/server/info:200" "/api/version:200"; do
  path="${probe%:*}"; want="${probe##*:}"
  got="$(code "$H$path")"
  [ "$got" = "$want" ] && printf '  ok    %-16s %s\n' "$path" "$got" \
                       || { printf '  FAIL  %-16s %s (expected %s)\n' "$path" "$got" "$want"; ok=0; }
done
# The panel's own files. Only a note for a desktop-only install, where nginx is fine without them;
# a FAIL once the kiosk is installed, because a 404 here is a black panel until it falls back.
for path in /screen.html /screen.js /screen.css /safe.html; do
  got="$(code "$H$path")"
  if [ "$got" = 200 ]; then
    printf '  ok    %-16s %s\n' "$path" "$got"
  elif [ -e /etc/systemd/system/carbon-kiosk.service ]; then
    printf '  FAIL  %-16s %s (expected 200: the panel kiosk loads it)\n' "$path" "$got"; ok=0
  else
    printf '  note  %-16s %s (only the panel kiosk needs it)\n' "$path" "$got"
  fi
done
if [ "$WEBCAM_PORT" != "0" ]; then
  got="$(code "$H/webcam/?action=snapshot")"
  [ "$got" = "200" ] && printf '  ok    %-16s %s\n' "/webcam/" "$got" \
                     || printf '  note  %-16s %s (no camera, or a different webcam port)\n' "/webcam/" "$got"
fi
WS="$(curl -s -i -m 10 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      -H "Host: 127.0.0.1:$PORT" -H "Origin: http://127.0.0.1:$PORT" \
      "$H/websocket" 2>/dev/null | head -1 | awk '{print $2}')"
[ "$WS" = "101" ] && printf '  ok    %-16s 101 Switching Protocols\n' "/websocket" \
                  || { printf '  FAIL  %-16s %s (expected 101)\n' "/websocket" "${WS:-no response}"; ok=0; }

echo
if [ "$ok" = 1 ]; then
  echo "Done.  →  http://$(hostname):$PORT/"
  echo
  say "Your existing web UI is untouched and still on its own port."
  say "To remove Carbon completely:"
  if [ "$LAYOUT" = sites ]; then
    say "    sudo rm $LINK_FILE $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  else
    say "    sudo rm $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  fi
else
  echo "Installed, but some checks failed — see above."
  say "Logs: /var/log/nginx/${SITE_NAME}-error.log"
  if [ -n "$BACKUP" ]; then
    # A re-run: removing the site would take the working desktop UI (and the panel) down with it.
    say "Put the previous site back with: sudo cp -p $BACKUP $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  else
    say "Remove with: sudo rm -f $LINK_FILE $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  fi
  exit 1
fi
