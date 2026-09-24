#!/usr/bin/env bash
#
#   bash tools/update_preflight.sh [--out DIR] [--apply]
#
# Run this ON THE PRINTER before updating Klipper / Moonraker / everything. It changes nothing on the
# machine except writing backups; without --apply it does not even do that.
#
# WHAT IT IS ACTUALLY PROTECTING
#     Happy Hare does not live in its own directory. It installs files UNTRACKED INSIDE the klipper and
#     moonraker checkouts:
#         ~/klipper/klippy/extras/mmu_*.py          (7 files)
#         ~/moonraker/moonraker/components/mmu_server.py
#     A normal `git pull` leaves untracked files alone, so updating is safe. A HARD RECOVER re-clones the
#     repo and deletes exactly those, and the MMU is dead until ~/Happy-Hare/install.sh is re-run. This
#     script writes down what is there now, so you can tell at a glance whether an update ate it.
#
#     It also catches the one thing that genuinely blocks a pull: a MODIFIED TRACKED file. Untracked
#     files never block; a locally edited tracked file makes git refuse or clobber. Klipper reports
#     "-dirty" in its version string from whenever klipper.service last started, which is a stale
#     snapshot — this checks the trees live instead of trusting it.
#
# Pairs with tools/update_verify.py, which does the API-level half and can run from anywhere.
set -euo pipefail

OUT="$HOME/update-preflight-$(date +%Y%m%d-%H%M%S)"
APPLY=0
MOONRAKER="${CARBON_MOONRAKER:-http://127.0.0.1:7125}"   # override to dry-run the checks from a workstation
while [ $# -gt 0 ]; do
  case "$1" in
    --out)   OUT="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[38;5;71m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*"; }
fail() { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required."
curl -fs -m 5 -o /dev/null "$MOONRAKER/server/info" 2>/dev/null || fail "Moonraker is not answering on $MOONRAKER — run this on the printer."

# ── 1. never do this mid-print ──────────────────────────────────────────────────────────────────
STATE="$(curl -fsS -m 10 "$MOONRAKER/printer/objects/query?print_stats" \
         | sed -n 's/.*"state": *"\([a-z]*\)".*/\1/p')"
case "$STATE" in
  printing|paused) fail "print_stats.state is '$STATE'. Updating restarts Klipper and Moonraker — finish or cancel first." ;;
  "") warn "could not read print_stats; continuing, but check the printer is idle." ;;
  *) ok "printer is '$STATE'" ;;
esac

# ── 2. the only thing that blocks a pull: modified TRACKED files ────────────────────────────────
BLOCKED=0
for repo in "$HOME/klipper" "$HOME/moonraker"; do
  [ -d "$repo/.git" ] || { warn "$repo is not a git checkout — skipping"; continue; }
  dirty="$(git -C "$repo" status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    BLOCKED=1
    warn "$repo has MODIFIED TRACKED files — a pull will refuse or clobber them:"
    printf '%s\n' "$dirty" | sed 's/^/        /'
  else
    ok "$(basename "$repo"): no modified tracked files (pull is safe)"
  fi
done

# ── 3. Happy Hare's footprint inside those checkouts ────────────────────────────────────────────
HH_KLIPPER="$(git -C "$HOME/klipper" ls-files --others --exclude-standard 'klippy/extras/mmu_*.py' 2>/dev/null || true)"
HH_MOON="$(git -C "$HOME/moonraker" ls-files --others --exclude-standard 'moonraker/components/mmu_server.py' 2>/dev/null || true)"
n_k=$(printf '%s' "$HH_KLIPPER" | grep -c . || true)
n_m=$(printf '%s' "$HH_MOON" | grep -c . || true)
ok "Happy Hare files: $n_k in klipper, $n_m in moonraker"
[ "$n_k" -gt 0 ] || warn "no mmu_*.py found under ~/klipper/klippy/extras — is Happy Hare installed from elsewhere?"

# ── 4. what the update is about to do ───────────────────────────────────────────────────────────
say "pending updates"
curl -fsS -m 30 "$MOONRAKER/machine/update/status?refresh=false" > /tmp/_pf_upd.json 2>/dev/null || true
python3 - <<'PY' 2>/dev/null || warn "could not summarise update status"
import json
d=json.load(open('/tmp/_pf_upd.json'))["result"]["version_info"]
for n,v in d.items():
    cur,rem = v.get("version"), v.get("remote_version")
    if n=="system":
        c=v.get("package_count")
        if c: print(f"      system            {c} apt packages")
        continue
    if cur and rem and cur!=rem: print(f"      {n:34s}{cur:14s} ->  {rem}")
PY

# ── 5. backups ──────────────────────────────────────────────────────────────────────────────────
echo
if [ "$APPLY" != 1 ]; then
  say "Dry run — nothing written. Re-run with --apply to take the backups into:"
  say "    $OUT"
  [ "$BLOCKED" = 1 ] && warn "and deal with those modified tracked files first."
  exit 0
fi

mkdir -p "$OUT"
say "writing to $OUT"

tar -czf "$OUT/printer_data-config.tar.gz" -C "$HOME/printer_data" config
ok "config tree      -> printer_data-config.tar.gz  ($(du -h "$OUT/printer_data-config.tar.gz" | cut -f1))"

# The Moonraker DB holds UI state that is NOT in the config tree: mainsail's dashboard layouts and
# macro groups, webcams, Carbon's prefs, Happy Hare's lane_data.
if curl -fsS -m 30 -X POST "$MOONRAKER/server/database/backup" -o "$OUT/db-backup-response.json" 2>/dev/null; then
  ok "moonraker db     -> backed up (response in db-backup-response.json)"
else
  warn "POST /server/database/backup failed; dumping namespaces over the API instead"
  for ns in mainsail webcams lane_data maintenance; do
    curl -fsS -m 20 "$MOONRAKER/server/database/item?namespace=$ns" -o "$OUT/db-$ns.json" 2>/dev/null \
      && ok "  namespace $ns" || warn "  namespace $ns could not be read"
  done
fi

cp /tmp/_pf_upd.json "$OUT/update-status.json" 2>/dev/null || true
{ printf '%s\n' "$HH_KLIPPER"; printf '%s\n' "$HH_MOON"; } | grep . > "$OUT/happy-hare-files.txt" || true
ok "HH file list     -> happy-hare-files.txt"

for repo in klipper moonraker; do
  git -C "$HOME/$repo" rev-parse HEAD > "$OUT/$repo-HEAD.txt" 2>/dev/null || true
done
ok "repo HEADs       -> klipper-HEAD.txt / moonraker-HEAD.txt"

echo
say "Baseline the API surface too, from your Mac or here:"
say "    python3 tools/update_verify.py --save $OUT"
echo
say "Then update, in this order:"
say "    1. klipper      (smallest blast radius; verify the MMU still loads)"
say "    2. moonraker    (do this one while you are AT the machine)"
say "    3. system + the rest"
echo
say "Afterwards:"
say "    python3 tools/update_verify.py --check $OUT"
echo
warn "If anything looks broken, do NOT press RECOVER on klipper or moonraker — it re-clones and"
warn "deletes the $((n_k + n_m)) Happy Hare files listed in happy-hare-files.txt. Re-run"
warn "~/Happy-Hare/install.sh instead."
