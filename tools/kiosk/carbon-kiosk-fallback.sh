#!/bin/sh
# Run as root by carbon-kiosk-fallback.service, the OnFailure= of carbon-kiosk.service.
# Installed to /usr/local/lib/carbon-kiosk/fallback.sh by install_kiosk.sh.
#
# It decides from LIVE STATE, not from $MONITOR_SERVICE_RESULT. On systemd 252 the
# result is useless for this: when the start limit refuses a start, service_enter_dead()
# keeps the PREVIOUS attempt's result, so a kiosk that gave up because its UI was dead
# (ExecStartPre failing), nginx was down, Xorg would not start or the start timed out
# arrives here as "exit-code" or "timeout", exactly like a one-off failed stop. A
# result-based filter leaves the panel dark in the failures that matter most.
#
# What OnFailure= can mean, and what this script does:
#   - carbon-kiosk gave up (start limit): nothing is starting it, nothing is on the
#     panel -> start KlipperScreen.
#   - a restart whose stop half failed: the restart job is still queued or the unit is
#     already activating -> leave it alone.
#   - KlipperScreen was started on purpose (Conflicts= stopped the kiosk): KlipperScreen
#     is active -> nothing to do.
#   - the machine is shutting down -> nothing to do (a start would be refused anyway).
# Every stop gets here: bookworm's xinit 1.4.0 exits 1 after a caught SIGTERM
# ("unexpected signal 15"), so systemd records a failure and OnFailure= fires.
# left_alone() below is what keeps a restart, a stop followed by a start, or a
# KlipperScreen handover from doing anything. A bare stop that nothing follows
# within ~10 s ends like a kiosk that gave up: KlipperScreen takes the panel.
#
# It waits ~10 s before acting, so a stop followed by a start (two commands, or the
# installer's swap) is not mistaken for a kiosk that gave up.
COME_BACK='sudo systemctl reset-failed carbon-kiosk; sudo systemctl enable --now carbon-kiosk && sudo systemctl disable KlipperScreen'
WHY="${MONITOR_SERVICE_RESULT:-?}/${MONITOR_EXIT_STATUS:-?}"

log() { echo "$2" | systemd-cat -t carbon-kiosk -p "$1"; }

left_alone() {
  case "$(systemctl is-system-running 2>/dev/null)" in
    stopping) log info "carbon-kiosk stopped ($WHY) during shutdown: panel left alone"; return 0 ;;
  esac
  if systemctl is-active --quiet KlipperScreen.service; then
    log info "carbon-kiosk stopped ($WHY): KlipperScreen already has the panel"; return 0
  fi
  case "$(systemctl is-active carbon-kiosk.service 2>/dev/null)" in
    active|activating|reloading)
      log info "carbon-kiosk stopped ($WHY) and is coming back up: panel left alone"; return 0 ;;
  esac
  return 1
}

i=0
while [ "$i" -lt 10 ]; do
  left_alone && exit 0
  sleep 1
  i=$((i + 1))
done
left_alone && exit 0
# A start or stop still queued for the kiosk (waiting on nginx or moonraker, say)
# belongs to whoever queued it. If that start fails too, OnFailure= brings us back.
if [ -n "$(systemctl list-jobs --no-legend carbon-kiosk.service 2>/dev/null)" ]; then
  log info "carbon-kiosk stopped ($WHY); a job is queued for it: panel left alone"
  exit 0
fi

# Conflicts= stops whatever is left of the kiosk before KlipperScreen's Xorg starts.
if systemctl start KlipperScreen.service; then
  # Only for this boot: carbon-kiosk stays enabled, so the next boot tries Carbon
  # again (a transient cause heals itself; a lasting one falls back again). To make
  # KlipperScreen the boot default too, run: sudo carbon-panel-rollback
  log warning "carbon-kiosk gave up ($WHY); KlipperScreen restored for this boot. Fix the cause, then: $COME_BACK"
else
  log err "carbon-kiosk gave up ($WHY) AND KlipperScreen did not start: the panel is dark. See journalctl -u KlipperScreen"
  exit 1
fi
