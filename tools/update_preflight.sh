#!/usr/bin/env bash
#
#   bash tools/update_preflight.sh [--out DIR] [--apply]
#
# Run this ON THE PRINTER, as your user (no sudo), before updating Klipper / Moonraker / everything. It
# changes nothing on the machine except writing backups; without --apply it does not even do that.
#
# WHAT IT IS ACTUALLY PROTECTING
#     Happy Hare and Cartographer do not live in their own directories. They put files UNTRACKED INSIDE
#     the klipper and moonraker checkouts:
#         ~/klipper/klippy/extras/mmu_*.py                        (7 files)
#         ~/klipper/klippy/extras/mmu/                            (14 files, Happy Hare's core)
#         ~/klipper/klippy/extras/{idm,cartographer,scanner}.py   (Cartographer's 3 links, hidden
#                                                                  via ~/klipper/.git/info/exclude)
#         ~/moonraker/moonraker/components/mmu_server.py
#     A pull or a soft RECOVER (checkout + reset --hard) leaves untracked files alone, so updating is
#     safe. A HARD RECOVER re-clones the repo and deletes exactly those, and the MMU and the scanner are
#     dead until ~/cartographer-klipper/install.sh and ~/Happy-Hare/install.sh -z are re-run. This script
#     writes down what is there now, so you can tell at a glance whether an update ate it.
#
#     It also catches the one thing that genuinely blocks a pull: a MODIFIED TRACKED file. Untracked
#     files never block; a locally edited tracked file makes Moonraker refuse the update. Klipper's
#     version always reads "-dirty" here: klippy.py marks it at every start when klippy/extras holds
#     untracked or ignored modules, so this checks for modified tracked files instead.
#
# Exit status: 0 when done, 1 on a refusal, 3 when the backups were taken but a checkout has modified
# tracked files.
#
# Pairs with tools/update_verify.py, which does the API-level half. Run that one's --save and --check on
# the same machine.
set -euo pipefail

OUT="$HOME/update-preflight-$(date +%Y%m%d-%H%M%S)"
APPLY=0
MOONRAKER="${CARBON_MOONRAKER:-http://127.0.0.1:7125}"   # override to dry-run the checks from a workstation
while [ $# -gt 0 ]; do
  case "$1" in
    --out)   OUT="${2:?}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[38;5;71m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;214m /!\\\033[0m %s\n' "$*"; }
fail() { printf '\033[38;5;203mxxx\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required."
[ "$(id -u)" != 0 ] || fail "run as your user, not with sudo"
curl -fs -m 5 -o /dev/null "$MOONRAKER/server/info" 2>/dev/null || fail "Moonraker is not answering on $MOONRAKER — run this on the printer."

# ── 1. never do this mid-print ──────────────────────────────────────────────────────────────────
Q="$(curl -sS -m 10 "$MOONRAKER/printer/objects/query?print_stats&idle_timeout&configfile=save_config_pending" 2>/dev/null || true)"
jget() {
  printf '%s' "$Q" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin)["result"]["status"][sys.argv[1]][sys.argv[2]])
except Exception:
    pass
' "$1" "$2" 2>/dev/null || true
}
STATE="$(jget print_stats state)"; IDLE="$(jget idle_timeout state)"; PENDING="$(jget configfile save_config_pending)"
case "$STATE" in
  printing|paused) fail "print_stats.state is '$STATE'. Finish or cancel first (Moonraker itself refuses only 'printing')." ;;
  "") warn "could not read print_stats (Klippy not ready?): check klippy.log and that the printer is idle." ;;
  *) ok "printer is '$STATE'" ;;
esac
[ "$IDLE" != "Printing" ] || fail "idle_timeout is 'Printing': a macro is running. Wait for it."
[ "$PENDING" != "True" ] || fail "SAVE_CONFIG is pending; a Klipper restart would discard it."

# ── 2. the only thing that blocks a pull: modified TRACKED files ────────────────────────────────
BLOCKED=0
for repo in "$HOME"/{klipper,moonraker,KlipperScreen,Happy-Hare,Klipper-Adaptive-Meshing-Purging,cartographer-klipper,crowsnest,sonar,belay_klippy_module}; do
  [ -d "$repo/.git" ] || { warn "$repo is not a git checkout — skipping"; continue; }
  dirty="$(git -C "$repo" status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    BLOCKED=1
    warn "$repo has MODIFIED TRACKED files. Moonraker will refuse to update it (Update aborted, repo has been modified):"
    printf '%s\n' "$dirty" | sed 's/^/        /'
  else
    ok "$(basename "$repo"): no modified tracked files (pull is safe)"
  fi
done

# ── 3. Happy Hare's and Cartographer's footprint inside those checkouts ─────────────────────────
HH_KLIPPER="$(git -C "$HOME/klipper" ls-files --others --exclude-standard -- 'klippy/extras/mmu_*.py' 'klippy/extras/mmu/' 2>/dev/null || true)"
HH_MOON="$(git -C "$HOME/moonraker" ls-files --others --exclude-standard 'moonraker/components/mmu_server.py' 2>/dev/null || true)"
n_k=$(printf '%s' "$HH_KLIPPER" | grep -c . || true)
n_m=$(printf '%s' "$HH_MOON" | grep -c . || true)
# Cartographer's links are in .git/info/exclude, so ls-files --exclude-standard never lists them.
n_c=0
for f in idm.py cartographer.py scanner.py; do
  if [ -e "$HOME/klipper/klippy/extras/$f" ]; then n_c=$((n_c + 1)); fi
done
ok "Happy Hare files: $n_k in klipper (expect 21), $n_m in moonraker; Cartographer links: $n_c of 3"
[ "$n_k" -gt 0 ] || warn "no mmu_*.py found under ~/klipper/klippy/extras — is Happy Hare installed from elsewhere?"
[ "$n_c" -eq 3 ] || warn "Cartographer's links are not all in ~/klipper/klippy/extras: [scanner] will not load"

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

# GNU tar exits 1 when a file changed while it was read (Happy Hare rewriting mmu/mmu_vars.cfg, say);
# the archive is still good, so only 2+ is fatal.
tar --warning=no-file-changed -czf "$OUT/printer_data-config.tar.gz" -C "$HOME/printer_data" config || [ $? -eq 1 ] || fail "tar failed"
ok "config tree      -> printer_data-config.tar.gz  ($(du -h "$OUT/printer_data-config.tar.gz" | cut -f1))"

# The Moonraker DB holds UI state that is NOT in the config tree: mainsail's dashboard layouts and
# macro groups, webcams, Carbon's prefs, Happy Hare's lane_data. Moonraker writes the backup under
# ~/printer_data/backup/database/, on this same SD card, so a copy goes into $OUT as well.
if RESP="$(curl -fsS -m 60 -X POST "$MOONRAKER/server/database/backup" 2>/dev/null)"; then
  printf '%s\n' "$RESP" > "$OUT/db-backup-response.json"
  BKP="$(printf '%s' "$RESP" | python3 -c 'import json, sys; print(json.load(sys.stdin)["result"]["backup_path"])' 2>/dev/null || true)"
  if [ -n "$BKP" ] && cp -p "$BKP" "$OUT/"; then
    ok "moonraker db     -> $(basename "$BKP")  (response in db-backup-response.json)"
  else
    warn "moonraker db was backed up to ${BKP:-?} but could not be copied here (response in db-backup-response.json)"
  fi
else
  warn "POST /server/database/backup failed; dumping namespaces over the API instead"
  for ns in carbon mainsail webcams lane_data maintenance; do
    curl -fsS -m 20 "$MOONRAKER/server/database/item?namespace=$ns" -o "$OUT/db-$ns.json" 2>/dev/null \
      && ok "  namespace $ns" || warn "  namespace $ns could not be read"
  done
fi

cp /tmp/_pf_upd.json "$OUT/update-status.json" 2>/dev/null || true
{ printf '%s\n' "$HH_KLIPPER"; printf '%s\n' "$HH_MOON"; } | grep . > "$OUT/happy-hare-files.txt" || true
ls -l "$HOME"/klipper/klippy/extras/{idm,cartographer,scanner}.py > "$OUT/cartographer-links.txt" 2>/dev/null || true
ok "HH file list     -> happy-hare-files.txt, cartographer-links.txt"

for d in "$HOME"/*/; do
  if [ -d "$d.git" ]; then git -C "$d" rev-parse HEAD > "$OUT/$(basename "$d")-HEAD.txt" 2>/dev/null || true; fi
done
for env in klippy-env moonraker-env .KlipperScreen-env; do
  if [ -x "$HOME/$env/bin/pip" ]; then "$HOME/$env/bin/pip" freeze > "$OUT/pip-${env#.}.txt" 2>/dev/null || true; fi
done
ok "repo HEADs       -> <checkout>-HEAD.txt for every checkout in ~; venvs -> pip-*.txt"

echo
say "Baseline the API surface too. Keep --save and --check on the same machine:"
say "    on the Pi:  python3 tools/update_verify.py --printer 127.0.0.1:8767 --save $OUT"
say "    on a Mac:   python3 tools/update_verify.py --printer voron.local:8767 --save ~/voron-update/baseline"
echo
say "Then update one row at a time from a laptop; never UPDATE ALL; never from the panel:"
say "    1. klipper"
say "    2. Klipper-Adaptive-Meshing-Purging"
say "    3. system, then reboot, check Carbon, test the fallback (sudo systemctl start KlipperScreen)"
say "    4. mainsail"
say "    5. KlipperScreen and 6. moonraker: at the machine, in one sitting, or neither"
echo
say "Whenever KlipperScreen has the panel, bring Carbon back with:"
say "    sudo systemctl reset-failed carbon-kiosk; sudo systemctl enable --now carbon-kiosk && sudo systemctl disable KlipperScreen"
echo
say "Afterwards, on the machine that took the baseline:"
say "    python3 tools/update_verify.py --printer 127.0.0.1:8767 --check $OUT"
say "    python3 tools/update_verify.py --printer voron.local:8767 --check ~/voron-update/baseline"
echo
warn "If a row reads INVALID or ?, press REFRESH, never HARD-recover klipper, moonraker or KlipperScreen."
warn "A hard recover re-clones and deletes the $((n_k + n_m)) Happy Hare files listed in happy-hare-files.txt"
warn "and Cartographer's $n_c links. After one on klipper: ~/cartographer-klipper/install.sh, then"
warn "~/Happy-Hare/install.sh -z. On moonraker: ~/Happy-Hare/install.sh -z, then sudo systemctl restart moonraker."

if [ "$BLOCKED" = 1 ]; then warn "Backups taken, but a checkout above has MODIFIED TRACKED files."; exit 3; fi
