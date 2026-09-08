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

# Auto-detect where Carbon's files are, if not told.
if [ -z "$ROOT" ]; then
  for cand in \
      "$HOME/printer_data/carbon" \
      "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" \
      "$HOME/carbon" ; do
    if [ -f "$cand/index.html" ]; then ROOT="$cand"; break; fi
  done
  [ -n "$ROOT" ] || fail "Could not find Carbon's index.html. Pass --root /path/to/carbon"
fi
ROOT="$(cd "$ROOT" && pwd)"
[ -f "$ROOT/index.html" ] || fail "$ROOT/index.html does not exist — is --root right?"
say "Carbon files: $ROOT"
[ -f "$ROOT/app.js" ] || say "WARNING: $ROOT/app.js is missing — the app will not load."

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
    location ^~ /fonts/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        access_log off;
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
[ "$LAYOUT" = sites ] && say "symlink $LINK_FILE  (only after nginx -t passes)"
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

if [ -e "$SITE_FILE" ]; then
  BACKUP="$SITE_FILE.bak-$(date +%Y%m%d%H%M%S)"
  sudo cp "$SITE_FILE" "$BACKUP"
  say "backed up existing site → $BACKUP"
fi

printf '%s\n' "$CONF" | sudo tee "$SITE_FILE" >/dev/null
sudo chmod 0644 "$SITE_FILE"
say "wrote $SITE_FILE"

# Validate BEFORE enabling. A broken config that is already symlinked takes down every other site
# on the next reload — including the UI the operator is reading this in.
if [ "$LAYOUT" = sites ]; then
  if ! sudo nginx -t 2>/tmp/carbon-nginx-test.log; then
    say "nginx -t FAILED with the new site written but NOT enabled:"
    sed 's/^/       /' /tmp/carbon-nginx-test.log >&2
    sudo rm -f "$SITE_FILE"
    fail "Removed $SITE_FILE. Nothing was enabled; your existing sites are untouched."
  fi
  say "nginx -t passed (site written, not yet enabled)"
  sudo ln -sfn "$SITE_FILE" "$LINK_FILE"
  say "enabled $LINK_FILE"
fi

if ! sudo nginx -t 2>/tmp/carbon-nginx-test.log; then
  say "nginx -t FAILED after enabling — backing out:"
  sed 's/^/       /' /tmp/carbon-nginx-test.log >&2
  [ -n "$LINK_FILE" ] && sudo rm -f "$LINK_FILE"
  sudo rm -f "$SITE_FILE"
  sudo nginx -t >/dev/null 2>&1 && say "nginx config is valid again"
  fail "Backed out completely. Nothing is left behind."
fi
say "nginx -t passed"

sudo systemctl reload nginx
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
  say "Remove with: sudo rm -f $LINK_FILE $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  exit 1
fi
