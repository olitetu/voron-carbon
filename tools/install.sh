#!/usr/bin/env bash
#
# Voron Carbon — installer. Run ON the printer host.
#
#   bash install.sh                       # auto-detect everything, ask before changing anything
#   bash install.sh --port 8767           # pick the port Carbon is served on
#   bash install.sh --port 80 --also-port 8767   # Carbon as the printer's default UI, 8767 kept
#   bash install.sh --dry-run             # print what it WOULD do and exit
#   bash install.sh --help
#
# Serves Carbon on its own port with Moonraker proxied alongside it, so the app is same-origin with
# the API. It does NOT touch your existing web UI: Mainsail/Fluidd keep their own site, and this
# script never edits a config file it did not create. A re-run with no --port keeps every port the
# live site already listens on, the way it keeps the root; --also-port on its own adds to them.
#
# Port 80 is Mainsail's until you move it. tools/move_mainsail_port.sh puts Mainsail on 81; only
# then does this script take 80 (docs/PORT80.md). It refuses any port another nginx site holds.
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
EXTRA_PORTS=""            # --also-port, space-separated: more ports the same server block listens on
PORT_GIVEN=0              # 1 once --port is on the command line: it replaces the live site's ports
HELPER_PORT=8770
MOONRAKER_PORT=7125
WEBCAM_PORT=8080          # crowsnest/ustreamer default; --webcam-port 0 disables the webcam proxy
ROOT=""                   # where Carbon's files live; auto-detected if not given
SITE_NAME="carbon"
DRY_RUN=0
ASSUME_YES=0
NGINX_LOG="${TMPDIR:-/tmp}/carbon-nginx-test.log"
# Tests point this at a scratch tree (it moves /etc/nginx and the kiosk's files under it). Never set
# it on the printer.
ETC="${CARBON_TEST_ETC:-/etc}"

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --root PATH            Directory holding Carbon's index.html (default: auto-detect)
  --port N               Port to serve Carbon on (default: the live site's, else $PORT). Replaces
                         the live site's ports.
  --also-port N          Serve on port N as well; repeat for more. Same site, same files. Without
                         --port it adds to the live site's ports.
  --moonraker-port N     Moonraker's port on this host (default: $MOONRAKER_PORT)
  --webcam-port N        Webcam stream port; 0 to skip the webcam proxy (default: $WEBCAM_PORT)
  --site-name NAME       nginx site filename (default: $SITE_NAME)
  --helper-port N        loopback port of the host helper (default: $HELPER_PORT)
  --dry-run              Show the plan and the generated config, change nothing
  --yes                  Don't prompt for confirmation
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
    --root)           ROOT="${2:?--root needs a path}"; shift 2 ;;
    --port)           PORT="${2:?--port needs a number}"; PORT_GIVEN=1
                      is_port "$PORT" || fail "--port $PORT is not a port number (1-65535)."
                      shift 2 ;;
    --also-port)      is_port "${2:?--also-port needs a number}" || fail "--also-port $2 is not a port number (1-65535)."
                      EXTRA_PORTS="$EXTRA_PORTS $2"; shift 2 ;;
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

# The ports a config's `listen` directives use, in order, each once, space-separated (stdin -> stdout).
# `listen 80;`, `listen [::]:80;`, `listen 127.0.0.1:80 default_server;` -> 80. An address alone means
# 80, as it does to nginx. Comments are dropped first, so Mainsail's `# listen [::]:80;` is not a port.
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
NGINX_DIR="$ETC/nginx"
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

# The ports, likewise: with no --port a re-run keeps every port the live site listens on, primary
# first, and --also-port adds to them. The panel kiosk (127.0.0.1:8767), bookmarks and the slicer
# point at them, and a re-run that quietly shrank 80+8767 back to 8767 would hand port 80 to nothing.
EXISTING_PORTS=""
if [ -f "$SITE_FILE" ]; then
  EXISTING_PORTS="$(listen_ports 2>/dev/null < "$SITE_FILE" || true)"
fi
if [ "$PORT_GIVEN" = 0 ] && [ -n "$EXISTING_PORTS" ]; then
  PORT="${EXISTING_PORTS%% *}"
  EXTRA_PORTS="${EXISTING_PORTS#"$PORT"} $EXTRA_PORTS"
  say "Keeping the existing site's ports: $EXISTING_PORTS"
fi
# Every port this run serves, the primary first, each once. The acceptance checks run on the primary.
ALL_PORTS="$PORT"
for p in $EXTRA_PORTS; do
  case " $ALL_PORTS " in *" $p "*) ;; *) ALL_PORTS="$ALL_PORTS $p" ;; esac
done
EXTRA_PORTS="${ALL_PORTS#"$PORT"}"
# Ports a LIVE (enabled) copy of this site holds now. Only these may already be in use below.
OWN_LIVE_PORTS=""
if [ "$LAYOUT" = confd ] || { [ -n "$LINK_FILE" ] && [ "$LINK_FILE" -ef "$SITE_FILE" ]; }; then
  OWN_LIVE_PORTS="$EXISTING_PORTS"
fi

url_for() { if [ "$2" = 80 ]; then printf 'http://%s/' "$1"; else printf 'http://%s:%s/' "$1" "$2"; fi; }
url_port() {   # $1 an http(s) URL -> its port, or the scheme's default when it names none
  local hp="${1#*://}"; hp="${hp%%/*}"
  case "$hp" in
    *\]:*|[!\[]*:*) printf '%s\n' "${hp##*:}" ;;
    *) case "$1" in https:*) printf '443\n' ;; *) printf '80\n' ;; esac ;;
  esac
}

# The panel kiosk opens one fixed URL (/etc/default/carbon-kiosk). A run that stops serving its port
# blacks out the panel until the KlipperScreen fallback takes it, so that is refused, not just noted.
KIOSK_URL=""
KIOSK_PORT=""
if [ -r "$ETC/default/carbon-kiosk" ]; then
  KIOSK_URL="$(awk -v q="'" 'index($0, "KIOSK_URL=") == 1 { v = substr($0, 11); gsub(/[" \t]/, "", v); gsub(q, "", v); print v; exit }' \
               "$ETC/default/carbon-kiosk" 2>/dev/null || true)"
  [ -z "$KIOSK_URL" ] || KIOSK_PORT="$(url_port "$KIOSK_URL")"
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
# Separate variable: `ROOT=$(…) || fail` would already have emptied ROOT when fail prints it.
ROOT_ABS="$(cd "$ROOT" && pwd)" || fail "Cannot cd into $ROOT as $(id -un). Check its permissions, or pass another --root."
ROOT="$ROOT_ABS"
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

if [ -n "$EXISTING_PORTS" ] && [ "$EXISTING_PORTS" != "$ALL_PORTS" ]; then
  echo
  echo "  PORT CHANGE   $EXISTING_PORTS  ->  $ALL_PORTS"
  DROPPED=""
  for p in $EXISTING_PORTS; do
    case " $ALL_PORTS " in *" $p "*) ;; *) DROPPED="$DROPPED $p"; echo "  This run would STOP serving Carbon on port $p." ;; esac
  done
  if [ -n "$DROPPED" ]; then
    echo "  Bookmarks, the slicer and the panel kiosk keep the port they were given. If that is not what"
    echo "  you meant, answer N below and re-run without --port: a re-run keeps the ports."
  else
    echo "  Every port served today stays served."
  fi
  echo
fi

# A reason the real run must stop. A dry run reports it and carries on, so the plan is still shown.
BLOCKED=0
block() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '\n  BLOCKED: %s\n\n' "$*" || true
    BLOCKED=1
  else
    fail "$*"
  fi
}

if [ -n "$KIOSK_PORT" ]; then
  case " $ALL_PORTS " in
    *" $KIOSK_PORT "*) say "Panel kiosk: $KIOSK_URL (port $KIOSK_PORT stays served)" ;;
    *) block "The panel kiosk opens $KIOSK_URL, but this run would not serve port $KIOSK_PORT: the panel would go dark until the KlipperScreen fallback takes it. Keep the port with --also-port $KIOSK_PORT." ;;
  esac
fi

# Every port must be free, or held by this site's own live copy. ss alone cannot say WHOSE a port
# is, and nginx accepts a second site on a port (it only warns "conflicting server name") and then
# quietly serves whichever it loaded first, so the other enabled sites are read too (read only).
SS_OUT=""
HAVE_SS=0
if command -v ss >/dev/null 2>&1; then
  HAVE_SS=1
  SS_OUT="$(ss -ltn 2>/dev/null || true)"   # captured once: `ss | grep -q` can lose to SIGPIPE under pipefail
fi
listening() { grep -qE ":$1[[:space:]]" <<<"$SS_OUT"; }
port_holder() {   # $1 port -> the first enabled nginx file, other than this site, that listens on it
  local f ports
  for f in "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf; do
    [ -e "$f" ] || continue                     # an unmatched glob, or a dangling link
    if [ -e "$SITE_FILE" ] && [ "$f" -ef "$SITE_FILE" ]; then continue; fi
    ports=" $(listen_ports 2>/dev/null < "$f" || true) "
    case "$ports" in *" $1 "*) printf '%s\n' "$f"; return 0 ;; esac
  done
  return 0
}
is_mainsail_site() {   # $1 an enabled nginx file
  local r
  case "${1##*/}" in mainsail|mainsail.conf) return 0 ;; esac
  if [ "$1" -ef "$NGINX_DIR/sites-available/mainsail" ]; then return 0; fi
  r="$(awk '$1=="root"{gsub(/;/,"",$2);print $2;exit}' "$1" 2>/dev/null || true)"
  case "${r%/}" in */mainsail) return 0 ;; esac
  return 1
}
for p in $ALL_PORTS; do
  holder="$(port_holder "$p")"
  if [ -n "$holder" ]; then
    if is_mainsail_site "$holder" && [ "$p" = 80 ]; then
      block "Port $p is Mainsail's ($holder). Move Mainsail to port 81 first, then re-run this installer:
      bash $REAL/move_mainsail_port.sh --dry-run
      bash $REAL/move_mainsail_port.sh"
    elif is_mainsail_site "$holder"; then
      block "Port $p is Mainsail's ($holder). Pick another port."
    else
      block "Port $p is already served by another nginx site: $holder. Free it, or pick another port."
    fi
  elif [ "$HAVE_SS" = 1 ] && listening "$p"; then
    case " $OWN_LIVE_PORTS " in
      *" $p "*) say "Port $p is in use — by Carbon's own site, which will be replaced." ;;
      *) block "Port $p is already in use, and not by an enabled nginx site. See what holds it:  sudo ss -ltnp 'sport = :$p'  Then free it, or pick another port." ;;
    esac
  elif [ "$HAVE_SS" = 1 ]; then
    say "Port $p: free"
  else
    say "Port $p: NOT verified (ss missing); no other enabled nginx site claims it"
  fi
done

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
# Named after the PRIMARY port only: one server block, one set of names, however many ports it has.
UP_API="carbon_apiserver_${PORT}"
UP_CAM="carbon_webcam_${PORT}"
MAP_VAR="carbon_connection_upgrade_${PORT}"

NL='
'
LISTEN=""
for p in $ALL_PORTS; do
  LISTEN="${LISTEN}    listen $p;${NL}    listen [::]:$p;${NL}"
done
PORTS_DESC="port $PORT"
if [ -n "$EXTRA_PORTS" ]; then PORTS_DESC="ports ${ALL_PORTS% *} and ${ALL_PORTS##* }"; fi

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
# Serves Carbon on $PORTS_DESC with Moonraker proxied alongside, so the app is same-origin with the
# API. Safe to delete: removing this file and reloading nginx removes Carbon entirely.
#
# Regenerate rather than hand-edit — re-run tools/install.sh with different flags. A re-run with no
# --port keeps these ports.

upstream $UP_API { server 127.0.0.1:$MOONRAKER_PORT; }
$( [ "$WEBCAM_PORT" != "0" ] && echo "upstream $UP_CAM { server 127.0.0.1:$WEBCAM_PORT; }" )

map \$http_upgrade \$$MAP_VAR {
    default upgrade;
    ''      close;
}

server {
${LISTEN}    server_name _;

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
    # This is why the kiosk must open http://127.0.0.1:<port>/screen.html (any port
    # above) and not the hostname — through the hostname the request arrives from
    # the LAN address and is denied here, correctly. It holds on every port alike.
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
    # the request Host *including the port*, so \$host (which strips a :port) makes every connection
    # on a port other than 80 403. This is the single most common way a working config gets broken.
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
HOST_NAME="$(hostname 2>/dev/null || echo PRINTER_HOST)"
for p in $ALL_PORTS; do
  say "serve   $(url_for "$HOST_NAME" "$p")  from $ROOT"
done
echo
say "Nothing else is modified: no other nginx file is written (the enabled sites are only read, to"
say "see who holds each port), and no permissions are changed."

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "──── generated config (dry run, nothing written) ────"
  printf '%s\n' "$CONF"
  if [ "$BLOCKED" = 1 ]; then
    echo
    echo "Dry run: a real run would stop at the BLOCKED line(s) above."
    exit 1
  fi
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  echo
  # read returns 1 at EOF (^D, or no tty and no --yes): treat that as N instead of exiting silently.
  read -r -p "  Proceed? [y/N] " reply || reply=""
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
if ! sudo nginx -t 2>"$NGINX_LOG"; then
  trap - ERR INT TERM HUP
  say "nginx -t FAILED with the new site in place:"
  sed 's/^/       /' "$NGINX_LOG" >&2 || true   # display only: must not skip the rollback
  restore_site
  fail "Rolled back to the previous on-disk state."
fi
say "nginx -t passed"
if [ "$LAYOUT" = sites ] && [ ! -L "$LINK_FILE" ]; then
  sudo ln -sfn "$SITE_FILE" "$LINK_FILE"
  say "enabled $LINK_FILE"
  if ! sudo nginx -t 2>"$NGINX_LOG"; then
    trap - ERR INT TERM HUP
    say "nginx -t FAILED after enabling:"
    sed 's/^/       /' "$NGINX_LOG" >&2 || true   # display only: must not skip the rollback
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
WS_HOST="127.0.0.1:$PORT"                  # what a browser sends: no :80 on port 80
[ "$PORT" != 80 ] || WS_HOST="127.0.0.1"
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" 2>/dev/null || echo "---"; }
# `systemctl reload` returns once nginx has the signal, not once a newly added port (80, the first
# time) listens. Up to 10 s per port; the probes below still report a port that never comes up.
for p in $ALL_PORTS; do
  n=0
  until [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$p/" 2>/dev/null || true)" = 200 ] \
        || [ "$n" -ge 10 ]; do sleep 1; n=$((n + 1)); done
done
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
  elif [ -e "$ETC/systemd/system/carbon-kiosk.service" ]; then
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
# A websocket that upgrades stays open, so curl only ever ends here by its own -m timeout (exit 28),
# or by SIGPIPE once head has its line. Under pipefail either one used to fail the assignment and
# end the script silently, before this line printed and before "Done". Only the status code matters.
WS="$(curl -s -i -m 3 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      -H "Host: $WS_HOST" -H "Origin: http://$WS_HOST" \
      "$H/websocket" 2>/dev/null | head -1 | awk '{print $2}' || true)"
[ "$WS" = "101" ] && printf '  ok    %-16s 101 Switching Protocols\n' "/websocket" \
                  || { printf '  FAIL  %-16s %s (expected 101)\n' "/websocket" "${WS:-no response}"; ok=0; }

# Every other port is the same server block, so a page each proves its listen line took. The panel's
# page is the one that matters there: the kiosk opens it by a fixed URL.
for p in $EXTRA_PORTS; do
  for path in / /screen.html; do
    got="$(code "http://127.0.0.1:$p$path")"
    if [ "$got" = 200 ]; then
      printf '  ok    %-16s %s\n' ":$p$path" "$got"
    elif [ "$path" = / ] || [ -e "$ETC/systemd/system/carbon-kiosk.service" ]; then
      printf '  FAIL  %-16s %s (expected 200)\n' ":$p$path" "$got"; ok=0
    else
      printf '  note  %-16s %s (only the panel kiosk needs it)\n' ":$p$path" "$got"
    fi
  done
done
if [ -n "$KIOSK_URL" ]; then
  got="$(code "$KIOSK_URL")"
  [ "$got" = 200 ] && printf '  ok    %-16s %s  %s\n' "kiosk URL" "$got" "$KIOSK_URL" \
                   || { printf '  FAIL  %-16s %s  %s (expected 200: the panel loads it)\n' "kiosk URL" "$got" "$KIOSK_URL"; ok=0; }
fi

# /helper/ is loopback only, on every port. From 127.0.0.1 nginx passes it on (200 from the helper,
# 502 when the helper is not installed). From this host's own LAN address nginx sees a LAN client and
# must answer 403 itself. A 403 on loopback, or anything but 403 from the LAN, is a broken boundary.
LAN4="$(hostname -I 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9.]+$/) { print $i; exit } }' || true)"
for p in $ALL_PORTS; do
  got="$(code "http://127.0.0.1:$p/helper/health")"
  case "$got" in
    200) printf '  ok    %-16s %s (loopback)\n' ":$p/helper/" "$got" ;;
    502) printf '  note  %-16s %s (loopback: the host helper is not installed)\n' ":$p/helper/" "$got" ;;
    *)   printf '  FAIL  %-16s %s (loopback: expected 200, or 502 without the helper)\n' ":$p/helper/" "$got"; ok=0 ;;
  esac
  if [ -n "$LAN4" ]; then
    got="$(code "http://$LAN4:$p/helper/health")"
    [ "$got" = 403 ] && printf '  ok    %-16s %s (from %s, as the LAN)\n' ":$p/helper/" "$got" "$LAN4" \
                     || { printf '  FAIL  %-16s %s (from %s: expected 403, the loopback-only rule is not in effect)\n' ":$p/helper/" "$got" "$LAN4"; ok=0; }
  fi
done
[ -n "$LAN4" ] || printf '  note  %-16s not checked from the LAN side here (no IPv4 address found)\n' "/helper/"

echo
if [ "$ok" = 1 ]; then
  echo "Done.  →  $(url_for "$HOST_NAME" "$PORT")"
  for p in $EXTRA_PORTS; do echo "         $(url_for "$HOST_NAME" "$p")"; done
  echo
  say "Mainsail/Fluidd keep their own site and port."
  say "To remove Carbon completely:"
  if [ "$LAYOUT" = sites ]; then
    say "    sudo rm $LINK_FILE $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  else
    say "    sudo rm $SITE_FILE && sudo nginx -t && sudo systemctl reload nginx"
  fi
  case " $ALL_PORTS " in
    *" 80 "*) say "    then give port 80 back to Mainsail:  bash $REAL/move_mainsail_port.sh --back" ;;
  esac
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
