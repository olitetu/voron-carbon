#!/usr/bin/env python3
"""
Carbon Screen host helper — the small set of things a browser page cannot do.

WHY THIS EXISTS
    Moonraker has no wifi API, and a web page cannot set a display backlight or
    blank a screen. KlipperScreen did these over D-Bus and by writing to sysfs.
    When KlipperScreen goes, they go with it, so Carbon Screen needs its own.

TRUST BOUNDARY
    Binds 127.0.0.1 ONLY and is proxied at /helper/ by the Carbon nginx site with
    `allow 127.0.0.1; deny all;`. These actions belong to the person standing at
    the printer, not to anyone on the LAN.
    => Chromium on the panel MUST load http://127.0.0.1:8767/screen.html.
       Loading it as http://voron.local:8767/ makes the requests arrive from the
       LAN address and nginx will (correctly) refuse them.

    Runs as the login user. No sudo anywhere. NetworkManager access comes from a
    polkit rule for the `network` group -- see 60-carbon-network.rules. Note that
    KlipperScreen's installer wrote an equivalent rule; removing KlipperScreen
    removes it, which is why we ship our own.

ONE LIVE LINK, SO: AUTO-REVERT
    wlan0 is the only interface that carries traffic. The Pi's eth0 exists but
    has no cable: Moonraker's proc_stats shows 0 bytes in and out on it after
    18 h up, and system_info lists no address on it (read 2026-09-23). A wifi
    change that fails therefore takes SSH with it and leaves the printer
    reachable only from its own panel. Every connect is a two-phase commit:
    remember the active profile, try the new one, verify we actually got an
    address, and if not, put the old one back before answering. When nmcli
    cannot say which profile is up, the change is refused: that guard must fail
    closed, not open.

HOW LONG A CONNECT CAN TAKE
    Every nmcli call here has a timeout, and one connect's steps add up to
    CONNECT_CEILING (182 s) from the moment it holds the lock. The panel's abort
    (CONNECT_TIMEOUT_MS in src/screen/helper.js) and nginx's /helper/
    proxy_read_timeout (tools/install.sh, nginx-helper.conf) are both 210 s, so
    the panel always gets this helper's answer rather than an unknown outcome.
    Change any of these numbers and check the others.

Python 3 standard library only -- nothing to pip install on the printer.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("CARBON_HELPER_PORT", "8770"))
IFACE = os.environ.get("CARBON_HELPER_IFACE", "wlan0")
CONNECT_TIMEOUT = 35        # seconds to wait for an address on the new network
REVERT_TIMEOUT = 40         # seconds to allow the rollback to take
NM_TIMEOUT = 45             # one nmcli run that changes something, or a rescan
NM_CONNECT_TIMEOUT = CONNECT_TIMEOUT + 10   # one `nmcli device wifi connect`
QUERY_TIMEOUT = 10          # one read-only nmcli query; they answer in well under 1 s
# Worst case of one /wifi/connect once it holds the lock, the sum of its bounds:
#   which profile is up            QUERY_TIMEOUT
#   attempt + argv retry + wait    NM_CONNECT_TIMEOUT + CONNECT_TIMEOUT (one shared
#                                  window) + 1 (wait_online's last look)
#   rollback + its address wait    REVERT_TIMEOUT + REVERT_TIMEOUT + 1
#   the state sent back            QUERY_TIMEOUT
# = 182 s. src/screen/helper.js mirrors it as CONNECT_CEILING_MS.
CONNECT_CEILING = (QUERY_TIMEOUT
                   + NM_CONNECT_TIMEOUT + CONNECT_TIMEOUT + 1
                   + REVERT_TIMEOUT + REVERT_TIMEOUT + 1
                   + QUERY_TIMEOUT)
# Worst case of a forget or radio change: the active-profile check, then one
# nmcli run. = 55 s; src/screen/helper.js mirrors it as CHANGE_CEILING_MS.
QUICK_CEILING = QUERY_TIMEOUT + NM_TIMEOUT
MAX_BODY = 8192

NMCLI = shutil.which("nmcli")

_lock = threading.Lock()    # NetworkManager operations are serialised
PSK_VIA_ARGV = False        # set if this nmcli would not take the secret on stdin


# --------------------------------------------------------------------------- nmcli
class NmError(Exception):
    """nmcli failed, is missing, or gave an answer we cannot read. str() says why."""


def nm_why(rc, out, err):
    """nmcli's last line of complaint, e.g. 'Error: NetworkManager is not running.'"""
    lines = (err or out or "").strip().splitlines()
    return lines[-1].strip() if lines else f"nmcli exited {rc}"


def nm(*args, timeout=NM_TIMEOUT, stdin=None):
    """Run nmcli. Returns (rc, stdout, stderr). Never raises on non-zero."""
    if not NMCLI:
        return 127, "", "nmcli not installed"
    try:
        p = subprocess.run(
            [NMCLI, *args],
            capture_output=True, text=True, timeout=timeout,
            input=stdin, env={"LC_ALL": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        )
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:                                    # noqa: BLE001
        return 1, "", str(e)


def nm_fields(fields, *args, timeout=NM_TIMEOUT):
    """`nmcli -t -f a,b,c ...` -> list of dicts. Handles ':' escaped as '\\:'.
    Raises NmError when nmcli fails: an empty list would read as "nothing is up"
    or "no networks", and the first of those would switch off the guards below."""
    rc, out, err = nm("-t", "-f", ",".join(fields), *args, timeout=timeout)
    if rc != 0:
        raise NmError(nm_why(rc, out, err))
    rows = []
    for raw in out.splitlines():
        if not raw.strip():
            continue
        parts = re.split(r"(?<!\\):", raw)
        parts = [p.replace("\\:", ":") for p in parts]
        parts += [""] * (len(fields) - len(parts))
        rows.append(dict(zip(fields, parts[:len(fields)])))
    return rows


# --------------------------------------------------------------------------- network state
def active_wifi_profile():
    """Name of the wifi connection profile currently up on IFACE, or None when
    none is. Raises NmError when nmcli cannot say -- see nm_fields."""
    for r in nm_fields(["NAME", "TYPE", "DEVICE"], "connection", "show", "--active",
                       timeout=QUERY_TIMEOUT):
        if r["DEVICE"] == IFACE and "wireless" in r["TYPE"]:
            return r["NAME"]
    return None


def net_state(timeout=QUERY_TIMEOUT):
    rc, out, err = nm("-t", "-f",
                      "GENERAL.STATE,GENERAL.CONNECTION,GENERAL.HWADDR,"
                      "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS",
                      "device", "show", IFACE, timeout=timeout)
    # One shape, always: the client renders from these keys and must never get a
    # missing one just because nmcli is absent or the interface is down. `error`
    # is set when nmcli failed, so "no address" is never reported when the truth
    # is "could not read": the panel would then tell you a change cuts nothing.
    info = {"iface": IFACE, "state": "unknown", "ssid": None, "mac": None,
            "ip": None, "prefix": None, "gateway": None, "dns": [], "online": False,
            "error": None}
    if rc != 0:
        info["error"] = nm_why(rc, out, err)
        return info
    for line in out.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if k == "GENERAL.STATE":
            info["state"] = v
        elif k == "GENERAL.CONNECTION":
            info["ssid"] = v if v and v != "--" else None
        elif k == "GENERAL.HWADDR":
            info["mac"] = v or None
        elif k.startswith("IP4.ADDRESS"):
            if "/" in v:
                info["ip"], info["prefix"] = v.split("/", 1)
            else:
                info["ip"] = v
        elif k == "IP4.GATEWAY":
            info["gateway"] = v if v and v != "--" else None
        elif k.startswith("IP4.DNS"):
            if v:
                info["dns"].append(v)
    info["online"] = bool(info["ip"])
    return info


def known_profiles():
    return {r["NAME"] for r in nm_fields(["NAME", "TYPE"], "connection", "show",
                                         timeout=QUERY_TIMEOUT)
            if "wireless" in r["TYPE"]}


def radio_on():
    """True/False from `nmcli radio wifi`. Raises NmError when nmcli cannot say:
    answering False then would have the panel offer RADIO ON for a radio that
    may well be on."""
    rc, out, err = nm("radio", "wifi", timeout=QUERY_TIMEOUT)
    v = out.strip()
    if rc == 0 and v in ("enabled", "disabled"):
        return v == "enabled"
    raise NmError(nm_why(rc, out, err) if rc != 0 else f"unexpected radio state {v!r}")


def scan(rescan=True):
    args = ["device", "wifi", "list", "ifname", IFACE]
    if rescan:
        args += ["--rescan", "yes"]
    rows = nm_fields(["IN-USE", "SSID", "BSSID", "SIGNAL", "SECURITY", "FREQ", "CHAN"], *args)
    known = known_profiles()
    seen, aps = {}, []
    for r in rows:
        ssid = r["SSID"].strip()
        if not ssid or ssid == "--":
            continue                                   # hidden networks have no name to show
        try:
            sig = int(r["SIGNAL"] or 0)
        except ValueError:
            sig = 0
        prev = seen.get(ssid)
        if prev is not None and aps[prev]["signal"] >= sig:
            continue                                   # keep only the strongest BSSID per SSID
        sec = (r["SECURITY"] or "").strip()
        ap = {
            "ssid": ssid,
            "bssid": r["BSSID"],
            "signal": sig,
            "security": sec or "open",
            "open": sec in ("", "--", "none"),
            "freq": r["FREQ"],
            "chan": r["CHAN"],
            "band": "5 GHz" if r["FREQ"].startswith("5") else "2.4 GHz",
            "known": ssid in known,
            "active": r["IN-USE"].strip() == "*",
        }
        if prev is None:
            seen[ssid] = len(aps)
            aps.append(ap)
        else:
            aps[prev] = ap
    aps.sort(key=lambda a: (not a["active"], -a["signal"]))
    return aps


def wait_online(deadline):
    """Poll until the interface has an IPv4 address, or the deadline passes.
    Always looks at least once, even past the deadline, and returns the last
    state read. No look runs more than 1 s past the deadline, which is the +1 in
    CONNECT_CEILING."""
    while True:
        st = net_state(timeout=max(1.0, min(QUERY_TIMEOUT, deadline - time.time())))
        if st["ip"] or time.time() + 1.0 >= deadline:
            return st
        time.sleep(1.0)


# --------------------------------------------------------------------------- actions
def do_connect(ssid, psk, hidden=False):
    """
    Two-phase: try the new network, verify an address, roll back if it fails.
    The PSK is fed on stdin via `nmcli --ask`, so it never appears in argv and
    never reaches `ps`, the journal or this file's logs.
    Answers within CONNECT_CEILING of taking the lock.
    """
    if not ssid:
        return 400, {"error": "ssid required"}

    with _lock:
        try:
            previous = active_wifi_profile()
        except NmError as e:
            # Nothing known to roll back to, on the only live link: do not try.
            return 502, {"error": f"could not read which network is up, so a failed "
                                  f"connect could not be undone: {e}",
                         "reverted": False, "previous": None, "net": net_state()}
        args = ["device", "wifi", "connect", ssid, "ifname", IFACE]
        if hidden:
            args += ["hidden", "yes"]
        # The attempt, its argv retry and the address wait share one window, so a
        # retry cannot push the whole connect past CONNECT_CEILING. The first run
        # leaves at least CONNECT_TIMEOUT of it. The address wait is still at most
        # CONNECT_TIMEOUT, as before the window existed: after a quick nmcli success
        # with no address, the rollback starts 35 s later, not at the window's end.
        attempt_end = time.time() + NM_CONNECT_TIMEOUT + CONNECT_TIMEOUT

        if psk:
            rc, out, err = nm("--ask", *args, stdin=psk + "\n", timeout=NM_CONNECT_TIMEOUT)
            # Fallback: if this nmcli build did not take the secret on stdin, retry
            # with it in argv. Worse (it is briefly visible in `ps` to local users)
            # but a wifi panel that cannot connect is useless. Which path ran is
            # reported so install_helper.sh's smoke test can tell you.
            if rc != 0 and re.search(r"secret|password|key", (err or "") + (out or ""), re.I):
                rc, out, err = nm(*args, "password", psk,
                                  timeout=max(1.0, min(NM_CONNECT_TIMEOUT, attempt_end - time.time())))
                if rc == 0:
                    globals()["PSK_VIA_ARGV"] = True
        else:
            rc, out, err = nm(*args, timeout=NM_CONNECT_TIMEOUT)

        if rc == 0:
            st = wait_online(min(attempt_end, time.time() + CONNECT_TIMEOUT))
            if st["ip"]:
                return 200, {"ok": True, "net": st}
            err = err or "connected but no address was assigned"

        # ---- failed. Put the old network back before anything else.
        reverted = False
        if previous and previous != ssid:
            nm("connection", "up", previous, timeout=REVERT_TIMEOUT)
            reverted = bool(wait_online(time.time() + REVERT_TIMEOUT)["ip"])

        detail = nm_why(rc, out, err)
        low = detail.lower()
        status = 401 if ("secrets" in low or "password" in low or "key" in low) else 502
        return status, {
            "error": detail,
            "reverted": reverted,
            "previous": previous,
            "net": net_state(),
        }


def do_forget(ssid):
    """Refuse to delete the profile we are standing on -- see the module docstring."""
    if not ssid:
        return 400, {"error": "ssid required"}
    with _lock:
        try:
            active = active_wifi_profile()
        except NmError as e:
            return 502, {"error": f"could not read which network is up, so it may be "
                                  f"this one; not forgetting it: {e}"}
        if ssid == active:
            return 409, {"error": "refusing to forget the active network: "
                                  f"{IFACE} is this machine's only live link"}
        rc, _, err = nm("connection", "delete", ssid)
        if rc != 0:
            return 502, {"error": (err or "delete failed").strip()}
        return 200, {"ok": True}


def do_radio(on):
    with _lock:
        try:
            active = None if on else active_wifi_profile()
        except NmError as e:
            return 502, {"error": f"could not read which network is up, so wifi may be "
                                  f"in use; not switching it off: {e}"}
        if active:
            return 409, {"error": "refusing to switch wifi off while it is the "
                                  "only connection to this machine"}
        rc, _, err = nm("radio", "wifi", "on" if on else "off")
        if rc != 0:
            return 502, {"error": (err or "radio failed").strip()}
        return 200, {"ok": True, "radio": on}


# --------------------------------------------------------------------------- display
def backlight_dev():
    base = "/sys/class/backlight"
    try:
        entries = sorted(os.listdir(base))
    except OSError:
        return None
    return os.path.join(base, entries[0]) if entries else None


def dpms_available():
    """True when the X DPMS extension is present, i.e. screen-off is possible."""
    xset = shutil.which("xset")
    if not xset:
        return False
    try:
        env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
        p = subprocess.run([xset, "q"], capture_output=True, text=True, timeout=5, env=env)
        return "DPMS" in (p.stdout or "")
    except Exception:                                          # noqa: BLE001
        return False


def display_state():
    """
    What this host can actually do to its screen.

    This panel is HDMI. HDMI exposes no /sys/class/backlight node, so software
    brightness does not exist -- the only screen control available is DPMS, which
    signals the display to sleep. The client reads `brightness_supported` and hides
    the brightness control rather than offering one that answers 501.

    (A DSI panel would populate `backlight` here and both controls would appear.)
    """
    dev = backlight_dev()
    out = {"backlight": None, "brightness_supported": False,
           "blank_supported": dpms_available(), "method": "dpms"}
    if dev:
        def rd(f):
            try:
                with open(os.path.join(dev, f)) as fh:
                    return int(fh.read().strip())
            except (OSError, ValueError):
                return None
        cur, mx = rd("brightness"), rd("max_brightness")
        writable = os.access(os.path.join(dev, "brightness"), os.W_OK)
        out["backlight"] = {
            "dev": os.path.basename(dev), "brightness": cur, "max": mx,
            "pct": round(cur / mx * 100) if cur is not None and mx else None,
            "writable": writable,
        }
        out["brightness_supported"] = bool(mx and writable)
        out["method"] = "backlight"
    return out


def set_brightness(pct):
    dev = backlight_dev()
    if not dev:
        # Expected on HDMI. Not a fault, and the UI should not have offered this.
        return 501, {"error": "no software brightness on this display (HDMI has no "
                              "backlight device); screen-off via DPMS still works",
                     "brightness_supported": False}
    try:
        with open(os.path.join(dev, "max_brightness")) as fh:
            mx = int(fh.read().strip())
        # Never allow 0: a panel the user cannot see is a panel they cannot fix.
        val = max(int(mx * 0.05), min(mx, round(mx * max(0, min(100, pct)) / 100)))
        with open(os.path.join(dev, "brightness"), "w") as fh:
            fh.write(str(val))
        return 200, {"ok": True, "brightness": val, "max": mx}
    except PermissionError:
        return 403, {"error": "no write permission on the backlight -- "
                              "the udev rule is not installed"}
    except (OSError, ValueError) as e:
        return 502, {"error": str(e)}


def set_blank(on):
    """
    Screen off/on via DPMS. X on :0 (KlipperScreen logged `Wayland: False`).

    This is the only screen-power control an HDMI panel has, so it matters that the
    kiosk session leaves DPMS *enabled* with zero timeouts (`xset dpms 0 0 0`)
    rather than disabling it (`xset -dpms`) -- with the extension off, `force off`
    reports success and does nothing. carbon-kiosk-session.sh does this correctly.
    """
    xset = shutil.which("xset")
    if not xset:
        return 501, {"error": "xset not installed"}
    if not dpms_available():
        return 501, {"error": "the X server reports no DPMS extension, so the screen "
                              "cannot be switched off on this display"}
    env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
    try:
        subprocess.run([xset, "dpms", "force", "off" if on else "on"],
                       capture_output=True, timeout=10, env=env, check=False)
        return 200, {"ok": True, "blank": on}
    except Exception as e:                                     # noqa: BLE001
        return 502, {"error": str(e)}


# --------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "CarbonHelper/1.0"

    def log_message(self, fmt, *args):
        # Deliberately quiet: request paths would otherwise land in the journal,
        # and one of them carries an SSID.
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _guard(self):
        """Belt and braces: nginx restricts /helper/, and so does this."""
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._send(403, {"error": "loopback only"})
            return False
        return True

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if n <= 0 or n > MAX_BODY:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, OSError):
            return {}

    def do_GET(self):
        if not self._guard():
            return
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path in ("/", "/health"):
            self._send(200, {"ok": True, "nmcli": bool(NMCLI), "iface": IFACE,
                             "psk_via_argv": PSK_VIA_ARGV,
                             "version": self.server_version})
        elif path == "/net":
            self._send(200, net_state())
        elif path == "/wifi":
            # A failed nmcli is an error, not "radio off" or "no networks": both of
            # those would be shown as facts.
            try:
                radio = radio_on()
                self._send(200, {"radio": radio, "aps": scan() if radio else []})
            except NmError as e:
                self._send(502, {"error": f"nmcli: {e}"})
        elif path == "/display":
            self._send(200, display_state())
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._guard():
            return
        path = self.path.split("?")[0].rstrip("/") or "/"
        b = self._body()
        if path == "/wifi/connect":
            st, r = do_connect(str(b.get("ssid", "")), b.get("psk") or "", bool(b.get("hidden")))
        elif path == "/wifi/forget":
            st, r = do_forget(str(b.get("ssid", "")))
        elif path == "/wifi/radio":
            st, r = do_radio(bool(b.get("on")))
        elif path == "/display/brightness":
            try:
                st, r = set_brightness(int(b.get("pct", 100)))
            except (TypeError, ValueError):
                st, r = 400, {"error": "pct must be a number"}
        elif path == "/display/blank":
            st, r = set_blank(bool(b.get("on")))
        else:
            st, r = 404, {"error": "not found"}
        self._send(st, r)


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"carbon-helper on http://{HOST}:{PORT} iface={IFACE} nmcli={bool(NMCLI)}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
