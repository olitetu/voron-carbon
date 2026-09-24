#!/usr/bin/env bash
#
#   tools/enable_updates.sh [--port 8767] [--repo owner/name] [--relocate DIR] [--apply]
#
# Registers Carbon with Moonraker's update_manager, so the UI can be updated AND
# ROLLED BACK from the printer itself.
#
# WHY THIS IS A CUTOVER PREREQUISITE
#     Once KlipperScreen is disabled, this panel is the only local UI on the
#     machine. If a bad Carbon build lands and there is no update path, fixing it
#     means SSH — and on this printer SSH runs over the only wifi interface. Wire
#     the update path BEFORE you take the old panel away, not after.
#
# THE TWO THINGS THAT MAKE IT FAIL, BOTH LEARNED THE HARD WAY
#     1. The served root may not be inside a git checkout. `type: web` replaces the
#        directory wholesale on every update, so Moonraker refuses to manage a
#        working tree — it logs "is within a git repo … Failed to validate
#        installation" on every start and the entry does nothing. Fix it with
#        --relocate, which moves the served copy out of the checkout for good.
#     2. The repo needs at least one release. `type: web` fetches a release asset;
#        with none published there is nothing to find, and an Update button that can
#        never offer an update is worse than no button. Cut one first:
#        tools/release.sh v1.0.0
#
# WHAT IT COSTS
#     A directory registered with update_manager becomes READ-ONLY to Moonraker's
#     file API. That is fine here — tools/deploy.py pushes dev builds into the
#     config root, never into the served directory — but it does mean the served
#     copy is only ever changed by a release from now on.
#
# Reads the served root out of the running nginx config rather than assuming it,
# because the repo docs and moonraker.conf have disagreed about it before.
set -euo pipefail

PORT=8767
REPO="${CARBON_REPO:-olitetu/voron-carbon}"
RELOCATE=""
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port)     PORT="${2:?}"; shift 2 ;;
    --repo)     REPO="${2:?}"; shift 2 ;;
    --relocate) RELOCATE="${2:?}"; shift 2 ;;
    --apply)    APPLY=1; shift ;;
    -h|--help)  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*"; }
fail() { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

in_git_repo() { git -C "${1:?}" rev-parse --show-toplevel 2>/dev/null; }

# ── 1. where is Carbon actually served from? ────────────────────────────────────
command -v nginx >/dev/null || fail "nginx not found — run this on the printer."
ROOT="$(sudo nginx -T 2>/dev/null | awk -v p="listen $PORT" '
  $0 ~ p {inblk=1} inblk && $1=="root" {gsub(/;/,"",$2); print $2; exit}')"
[ -n "$ROOT" ] || fail "Could not find a server block listening on $PORT in the running nginx config."
say "served root : $ROOT"
[ -d "$ROOT" ] || fail "$ROOT does not exist."

# ── 2. move the served copy out of the checkout, if asked ───────────────────────
if [ -n "$RELOCATE" ]; then
  DEST="${RELOCATE/#\~/$HOME}"
  case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac
  [ -z "$(in_git_repo "$(dirname "$DEST")")" ] \
    || fail "$DEST is itself inside a git repo ($(in_git_repo "$(dirname "$DEST")")). Pick a path outside every checkout, e.g. ~/carbon_web."
  [ "$DEST" != "$ROOT" ] || fail "--relocate $DEST is already the served root; drop the flag."
  [ -f "$ROOT/index.html" ] || fail "$ROOT/index.html is missing — nothing to relocate. Build first: npm ci && npm run build"

  say "relocating  : $ROOT  ->  $DEST"
  if [ "$APPLY" != 1 ]; then
    say "Dry run. Re-run with --apply to actually copy, re-point nginx and register."
    exit 0
  fi
  mkdir -p "$DEST"
  cp -a "$ROOT/." "$DEST/"
  say "copied $(find "$DEST" -type f | wc -l | tr -d ' ') file(s)"

  # install.sh owns the nginx site it created; let it re-point the root rather than
  # editing /etc/nginx from here.
  [ -f tools/install.sh ] || fail "tools/install.sh not found — run this from the repo root."
  say "re-pointing nginx via install.sh"
  bash tools/install.sh --root "$DEST" --port "$PORT" --yes
  ROOT="$DEST"
fi

# ── 3. update_manager will not manage a directory inside a checkout ─────────────
GITTOP="$(in_git_repo "$ROOT" || true)"
if [ -n "$GITTOP" ]; then
  warn "$ROOT is inside the git checkout at $GITTOP."
  warn "Moonraker's web deploy replaces the served directory wholesale on every update"
  warn "and refuses to do that to a working tree. Registering it as-is only produces:"
  warn "    Location at option 'path: $ROOT' is within a git repo."
  warn "    Found .git folder at '$GITTOP' — Failed to validate installation"
  warn ""
  fail "Move the served copy out of the checkout first:  bash tools/enable_updates.sh --relocate ~/carbon_web --apply"
fi

# ── 4. is there anything to update TO? ──────────────────────────────────────────
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  latest="$(gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null || true)"
  if [ -z "$latest" ]; then
    warn "$REPO has no releases. type:web fetches a release ASSET, so the entry would"
    warn "validate and then never offer anything."
    fail "Cut the first release first:  tools/release.sh v1.0.0"
  fi
  say "latest release: $latest"
else
  warn "gh unavailable — cannot confirm $REPO has a release. If it has none, the entry will"
  warn "register cleanly and never offer an update."
fi

# ── 5. release_info.json is what update_manager actually reads ──────────────────
if [ -f "$ROOT/release_info.json" ]; then
  say "release_info : $(tr -d '\n ' < "$ROOT/release_info.json")"
else
  warn "$ROOT/release_info.json is MISSING."
  warn "update_manager cannot determine the installed version without it, and will"
  warn "log a warning on every start. It is written by tools/stamp_release_info.sh,"
  warn "which tools/release.sh runs in CI — so this root was populated by hand or by"
  warn "deploy.py rather than from a release."
  warn ""
  warn "Fix it properly: install the release you just cut."
  warn "Or, to register what is already here as that version:"
  warn "    bash tools/stamp_release_info.sh ${latest:-vX.Y.Z} $ROOT"
fi

# ── 6. the moonraker.conf entry ─────────────────────────────────────────────────
MOON_CONF="$(ls "$HOME"/printer_data/config/moonraker.conf 2>/dev/null || true)"
[ -n "$MOON_CONF" ] || fail "moonraker.conf not found under ~/printer_data/config/."
say "moonraker    : $MOON_CONF"

if grep -q '^\[update_manager voron-carbon\]' "$MOON_CONF"; then
  have="$(awk '/^\[update_manager voron-carbon\]/{f=1;next} f&&/^\[/{exit} f&&$1=="path:"{print $2;exit}' "$MOON_CONF")"
  have="${have/#\~/$HOME}"
  if [ "$have" = "$ROOT" ]; then
    say "Already registered against $ROOT. Nothing to do."
    exit 0
  fi
  warn "Registered, but against the wrong path:"
  warn "    in moonraker.conf : ${have:-(none)}"
  warn "    served by nginx   : $ROOT"
  [ "$APPLY" = 1 ] || { say "Dry run. Re-run with --apply to correct it."; exit 0; }
  BAK="$MOON_CONF.bak-$(date +%Y%m%d%H%M%S)"
  cp "$MOON_CONF" "$BAK"; say "backed up  -> $BAK"
  awk -v new="$ROOT" '
    /^\[update_manager voron-carbon\]/{f=1}
    f&&/^path:/{print "path: " new; f=0; next}
    {print}' "$BAK" > "$MOON_CONF"
  say "path corrected to $ROOT"
else
  BLOCK="$(cat <<EOF

# Voron Carbon — the web UI and the touchscreen panel.
# Registered so the UI can be updated and rolled back from the printer itself,
# which matters because after the KlipperScreen cutover this panel is the only
# local UI. \`path\` must stay OUTSIDE the git checkout: update_manager replaces
# the directory wholesale and refuses to manage a working tree. Written by
# tools/enable_updates.sh; dev builds go to the config root via tools/deploy.py.
[update_manager voron-carbon]
type: web
channel: stable
repo: $REPO
path: $ROOT
EOF
)"

  echo
  echo "──── to be appended to $MOON_CONF ────"
  printf '%s\n' "$BLOCK"
  echo "──────────────────────────────────────────────────────────"
  echo

  if [ "$APPLY" != 1 ]; then
    say "Dry run. Re-run with --apply to append it (a dated backup is made first)."
    exit 0
  fi

  BAK="$MOON_CONF.bak-$(date +%Y%m%d%H%M%S)"
  cp "$MOON_CONF" "$BAK"
  say "backed up  -> $BAK"
  printf '%s\n' "$BLOCK" >> "$MOON_CONF"
  say "appended to $MOON_CONF"
fi

echo
say "Restart Moonraker for it to take effect:"
say "    sudo systemctl restart moonraker"
say "Then confirm it validated — this must print nothing:"
say "    curl -s http://127.0.0.1:7125/machine/update/status?refresh=false | grep -o 'Failed to validate'"
echo
say "To undo:  cp ${BAK:-<backup>} $MOON_CONF && sudo systemctl restart moonraker"
