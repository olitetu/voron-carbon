#!/usr/bin/env python3
"""
Carbon Screen host helper -- the small set of things a browser page cannot do.

WHY THIS EXISTS
    Moonraker has no wifi API, and a web page cannot set a display backlight or
    blank a screen. KlipperScreen did these over D-Bus and by writing to sysfs.
    When KlipperScreen goes, they go with it, so Carbon Screen needs its own.

TRUST BOUNDARY
    Three layers keep the LAN out. Each is described by what it actually checks.

    1. The socket. The server binds 127.0.0.1:8770 only, so no other machine can
       connect to it. carbon-helper.service adds IPAddressAllow=localhost and
       IPAddressDeny=any (systemd.resource-control(5)), so the kernel also drops
       non-loopback traffic for this unit, even if HOST is edited. That needs cgroup
       BPF: without it systemd logs "BPF firewalling not supported" and the filter
       is not applied (install_helper.sh looks for that line).
    2. nginx. The Carbon site that tools/install.sh generates proxies /helper/ here
       with `allow 127.0.0.1; allow ::1; deny all;`, and sets X-Carbon-Local-Addr to
       $server_addr: the local address of the socket nginx accepted the connection
       on. A client on this machine that dialled a loopback address gets 127.0.0.1
       or ::1. A LAN client arrives on the Pi's LAN or fe80:: address. The realip
       module rewrites $remote_addr (and so what allow/deny test), not
       $server_addr, and proxy_set_header replaces any header of that name that the
       client sent.
    3. _guard(), here. 403 unless the TCP peer is loopback, AND X-Carbon-Local-Addr
       is exactly 127.0.0.1 or ::1 (a missing one is refused too), AND any X-Real-IP
       is loopback. Every request nginx forwards comes from 127.0.0.1, so the peer
       check alone says nothing about the LAN. The header is what still refuses a
       LAN client if the allow/deny lines are ever lost from the nginx block.

    What these do NOT stop is a caller on this machine. The API has no
    authentication: anything that can open a TCP connection to 127.0.0.1 can call it
    directly and send the header itself. It is then held to the guards below (it
    cannot forget the live profile or switch the radio off under it, and a failed
    connect is rolled back), but it CAN move wlan0 to another network. Such callers
    include Moonraker, and so, plausibly (not tested), anything that can configure
    Moonraker: while [authorization] trusted_clients covers the LAN, a LAN client can
    edit moonraker.conf and restart it, and a [power] device of type http then
    reaches 127.0.0.1 with any headers it likes. Nothing in this file or in nginx can
    tell that from the panel. That boundary is Moonraker's ([server] host,
    [authorization] trusted_clients), not this file's.

    => Chromium on the panel MUST load http://127.0.0.1:8767/screen.html. Loaded as
       http://voron.local:8767/ its requests arrive on the LAN address and nginx
       refuses them, correctly.

WHO IT RUNS AS
    The system user carbon-net, from root-owned code in /usr/local/lib/carbon-helper
    (install_helper.sh), never root (main() refuses). No sudo anywhere. NetworkManager
    rights come from polkit: 60-carbon-network.rules grants carbon-net, and no other
    user or group, the four NetworkManager action ids this file needs, by exact id.
    It does not depend on KlipperScreen's rule. Screen-off runs xset against X on :0,
    which must admit carbon-net (`xhost +SI:localuser:carbon-net` in the kiosk
    session). Until it does, /display reports blank_supported: false.

SECRETS
    The wifi PSK reaches nmcli on stdin (`nmcli --ask`), never in argv, so no local
    user can read it from `ps`. There is no fallback that puts it in argv. Nothing
    here logs a request.

ONE LIVE LINK, SO: AUTO-REVERT
    wlan0 is the only interface that carries traffic. The Pi's eth0 exists but
    has no cable: Moonraker's proc_stats shows 0 bytes in and out on it after
    18 h up, and system_info lists no address on it (read 2026-09-23). A wifi
    change that fails therefore takes SSH with it and leaves the printer
    reachable only from its own panel. Every connect is a two-phase commit:
      - before it, note which profile is up on wlan0 (by UUID) and which exist;
      - try the new network, and verify it actually gave an address;
      - if not, delete any profile the attempt itself created (a rejected first
        join must not stay behind as a SAVED network), then look at wlan0. If it
        is still on the previous profile with an address, leave it alone: an
        `nmcli connection up` of a live profile re-activates it, which drops the
        link. Otherwise bring the previous profile back, by UUID;
      - only then answer.
    When nmcli cannot say which profile is up, the change is refused: that guard
    must fail closed, not open.

HOW LONG A CONNECT CAN TAKE
    Every nmcli call here has a timeout, and one connect's steps add up to
    CONNECT_CEILING (217 s) from the moment it holds the lock. A second change never
    waits for the lock: it is refused at once with 409. The panel's abort
    (CONNECT_TIMEOUT_MS in src/screen/helper.js) and nginx's /helper/
    proxy_read_timeout (tools/install.sh) are both 240 s, so the panel always gets
    this helper's answer rather than an unknown outcome. Change any of these
    numbers and check the others.

Python 3 standard library only -- nothing to pip install on the printer.
"""

import functools
import hashlib
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("CARBON_HELPER_PORT", "8770"))
IFACE = os.environ.get("CARBON_HELPER_IFACE", "wlan0")

CONNECT_TIMEOUT = 35        # seconds to wait for an address on the new network
REVERT_TIMEOUT = 40         # one rollback step: reactivating the previous profile, or waiting for it
NM_TIMEOUT = 45             # one nmcli run that changes something, or a rescan
NM_CONNECT_TIMEOUT = CONNECT_TIMEOUT + 10   # one `nmcli device wifi connect`
QUERY_TIMEOUT = 10          # one read-only nmcli query, or one delete; they answer in well under 1 s
HIDDEN_SCAN_TIMEOUT = 12    # how long a hidden SSID gets to answer a directed probe
CLEANUP_BUDGET = 2 * QUERY_TIMEOUT      # failed: list the profiles, delete the one the attempt saved
ROLLBACK_BUDGET = 2 * REVERT_TIMEOUT    # failed: look at wlan0, bring `previous` back, wait for it

# Worst case of one /wifi/connect once it holds the lock, the sum of its bounds. A step
# clamped to a deadline still gets at least 1 s (see left()), so it can end up to 1 s late:
#   the profiles before: which is up, which exist   QUERY_TIMEOUT
#   hidden only: directed probe, then look for it   QUERY_TIMEOUT + HIDDEN_SCAN_TIMEOUT + 1
#   the attempt, then its address wait              NM_CONNECT_TIMEOUT + CONNECT_TIMEOUT + 1
#   failed: delete what the attempt saved           CLEANUP_BUDGET + 1
#   failed: look, reactivate, wait, confirm         ROLLBACK_BUDGET + 2
# = 217 s (194 s for a network that is not hidden). The answer carries the last state
# read, so no query follows. src/screen/helper.js mirrors it as CONNECT_CEILING_MS.
CONNECT_CEILING = (QUERY_TIMEOUT
                   + QUERY_TIMEOUT + HIDDEN_SCAN_TIMEOUT + 1
                   + NM_CONNECT_TIMEOUT + CONNECT_TIMEOUT + 1
                   + CLEANUP_BUDGET + 1
                   + ROLLBACK_BUDGET + 2)
# Worst case of a forget or radio change: one profile read, then one nmcli run.
# = 55 s; src/screen/helper.js mirrors it as CHANGE_CEILING_MS.
QUICK_CEILING = QUERY_TIMEOUT + NM_TIMEOUT

MAX_BODY = 8192             # bytes; a larger request body is refused with 413, never read
MAX_THREADS = 8             # requests in flight at once; the next one gets 503
SOCKET_TIMEOUT = 15         # seconds per socket read or write, so a silent client cannot hold a thread

LOOPBACK = ("127.0.0.1", "::1")
WIFI_TYPES = ("802-11-wireless", "wifi")    # nmcli -t prints the first; pretty mode the second
# The reason nmcli gives when NetworkManager asked for a secret and got none, or a wrong
# one (nm-client-utils.c NO_SECRETS, printed by devices.c as "Error: Connection
# activation failed: <reason>."; nmcli 1.42.4, per the review). It is 39 bytes, longer
# than any SSID (32), so no network name echoed in nmcli's output can contain it.
NO_SECRETS = "Secrets were required, but not provided"

NMCLI = shutil.which("nmcli")

_lock = threading.Lock()    # NetworkManager changes are serialised; see serialised()


def _code_sha256():
    """This file's own hash, reported by /health, so install_helper.sh can tell that the
    process answering is running the code it just installed rather than an older copy."""
    try:
        with open(os.path.abspath(__file__), "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


CODE_SHA256 = _code_sha256()


# --------------------------------------------------------------------------- nmcli
class NmError(Exception):
    """nmcli failed, is missing, or gave an answer we cannot read. str() says why."""


def nm_why(rc, out, err):
    """nmcli's last line of complaint, e.g. 'Error: NetworkManager is not running.'"""
    lines = (err or out or "").strip().splitlines()
    return lines[-1].strip() if lines else f"nmcli exited {rc}"


def nm(*args, timeout=NM_TIMEOUT, stdin=None):
    """Run nmcli. Returns (rc, stdout, stderr) as text. Never raises on non-zero.

    Bytes in and out, decoded here rather than with text=True: text mode would turn
    every '\\r' in a value into '\\n' (universal newlines) and raise on a name that is
    not valid UTF-8. surrogateescape keeps such a name's bytes, so it goes back to
    nmcli unchanged."""
    if not NMCLI:
        return 127, "", "nmcli not installed"
    try:
        p = subprocess.run(
            [NMCLI, *args],
            capture_output=True, timeout=timeout,
            input=None if stdin is None else stdin.encode("utf-8"),
            env={"LC_ALL": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"},
        )
        return (p.returncode,
                (p.stdout or b"").decode("utf-8", "surrogateescape"),
                (p.stderr or b"").decode("utf-8", "surrogateescape"))
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:                                    # noqa: BLE001
        return 1, "", str(e)


def left(deadline, cap):
    """Timeout for one step: at most `cap` and not past `deadline`, but at least 1 s so
    the step can still run. A step started in the deadline's last second ends at most
    1 s after it; CONNECT_CEILING counts those seconds."""
    return max(1.0, min(cap, deadline - time.time()))


def _split_terse(line):
    """One row of `nmcli -t` tabular output -> its fields, or None when it is malformed.
    In terse tabular mode nmcli escapes ':' and '\\' in a value with a '\\' (nmcli(1),
    --escape), so '\\' plus any character is that character, and only a bare ':'
    ends a field."""
    fields, cur, esc = [], [], False
    for ch in line:
        if esc:
            cur.append(ch)
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            fields.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if esc:
        return None          # a dangling escape: nmcli never writes one
    fields.append("".join(cur))
    return fields


def nm_fields(fields, *args, timeout=NM_TIMEOUT, strict=True):
    """`nmcli -t -f a,b,c ...` -> list of dicts.

    Raises NmError when nmcli fails: an empty list would read as "nothing is up" or
    "no networks", and the first of those would switch off the guards below.
    A row with the wrong number of fields (a value nmcli does not escape, such as a
    newline in a name) is never padded out. With `strict` it is an NmError, for the
    same reason. Without it (the scan, whose rows are only shown) it is dropped."""
    rc, out, err = nm("-t", "-f", ",".join(fields), *args, timeout=timeout)
    if rc != 0:
        raise NmError(nm_why(rc, out, err))
    rows = []
    # split("\n"), not splitlines(): that also splits on \r, \x1c-\x1e, \x85, U+2028...
    for raw in out.split("\n"):
        if raw == "":
            continue
        parts = _split_terse(raw)
        if parts is None or len(parts) != len(fields):
            if strict:
                raise NmError(f"unreadable nmcli output ({len(fields)} fields expected per row)")
            continue
        rows.append(dict(zip(fields, parts)))
    return rows


# --------------------------------------------------------------------------- network state
def profiles(timeout=QUERY_TIMEOUT):
    """Every NetworkManager profile as {name, uuid, type, device}. `device` is '' unless
    the profile is active (or activating) on one. One query, so which profiles exist
    and which one is up come from the same moment. Raises NmError -- see nm_fields."""
    return [{"name": r["NAME"], "uuid": r["UUID"], "type": r["TYPE"],
             "device": "" if r["DEVICE"] in ("", "--") else r["DEVICE"]}
            for r in nm_fields(["NAME", "UUID", "TYPE", "DEVICE"], "connection", "show",
                               timeout=timeout)]


def is_wifi(p):
    return p["type"] in WIFI_TYPES


def on_iface(rows):
    """The wifi profile active (or activating) on IFACE, from profiles(), or None."""
    for p in rows:
        if p["device"] == IFACE and is_wifi(p):
            return p
    return None


def net_state(timeout=QUERY_TIMEOUT):
    # Multi-line `device show` output: per nmcli(1), --escape applies to terse TABULAR
    # mode, so these values are taken as printed, split at the first ':' only.
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
    for line in out.split("\n"):
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


def radio_on():
    """True/False from `nmcli radio wifi`. Raises NmError when nmcli cannot say:
    answering False then would have the panel offer RADIO ON for a radio that
    may well be on."""
    rc, out, err = nm("radio", "wifi", timeout=QUERY_TIMEOUT)
    v = out.strip()
    if rc == 0 and v in ("enabled", "disabled"):
        return v == "enabled"
    raise NmError(nm_why(rc, out, err) if rc != 0 else f"unexpected radio state {v!r}")


def hex_bytes(h):
    """nmcli's SSID-HEX value -> the SSID's bytes, or None (hidden, or not hex)."""
    h = (h or "").strip()
    if h[:2].lower() == "0x":
        h = h[2:]
    h = h.replace(":", "").replace(" ", "")
    if not h or h == "--":
        return None
    try:
        return bytes.fromhex(h)
    except ValueError:
        return None


_BIDI = frozenset("\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")


def printable(s):
    """Control, line/paragraph-separator and bidi-control characters -> U+FFFD, so a
    name broadcast by anyone in radio range cannot break or reorder the list it is
    shown in. The panel renders it as text only, never as HTML."""
    return "".join("\ufffd" if c in _BIDI or unicodedata.category(c) in ("Cc", "Zl", "Zp")
                   else c for c in s)


def scan(rescan=True):
    args = ["device", "wifi", "list", "ifname", IFACE]
    if rescan:
        args += ["--rescan", "yes"]
    # SSID-HEX, not SSID: the name is then never parsed as delimited text, so a ':' or
    # '\\' in it cannot shift the BSSID, SECURITY or IN-USE columns of its row.
    rows = nm_fields(["IN-USE", "SSID-HEX", "BSSID", "SIGNAL", "SECURITY", "FREQ", "CHAN"],
                     *args, strict=False)
    known = {p["name"] for p in profiles() if is_wifi(p)}
    seen, aps = {}, []
    for r in rows:
        raw = hex_bytes(r["SSID-HEX"])
        if not raw or not raw.strip(b"\0"):
            continue                                   # hidden networks have no name to show
        ssid = printable(raw.decode("utf-8", "replace"))
        if not ssid.strip():
            continue
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
        st = net_state(timeout=left(deadline, QUERY_TIMEOUT))
        if st["ip"] or time.time() + 1.0 >= deadline:
            return st
        time.sleep(1.0)


def hidden_ssid_answers(ssid, deadline):
    """After a directed probe: poll the scan list (no new scan) about once a second
    until an AP whose SSID is exactly `ssid` is in it, or the deadline passes. Ends at
    most 1 s after the deadline."""
    want = ssid.encode("utf-8")
    while True:
        try:
            rows = nm_fields(["SSID-HEX"], "device", "wifi", "list", "ifname", IFACE,
                             "--rescan", "no", timeout=left(deadline, QUERY_TIMEOUT),
                             strict=False)
            if any(hex_bytes(r["SSID-HEX"]) == want for r in rows):
                return True
        except NmError:
            pass
        if time.time() + 1.0 >= deadline:
            return False
        time.sleep(1.0)


# --------------------------------------------------------------------------- actions
def serialised(fn):
    """One NetworkManager change at a time. A second one is refused at once with 409
    rather than queued: a queued change would outlive the panel's request, and then
    run unannounced. The 409 carries a JSON `error`, so the panel shows a definite
    "not done" (network.jsx helperAnswered)."""
    @functools.wraps(fn)
    def run(*args, **kwargs):
        if not _lock.acquire(blocking=False):
            return 409, {"error": "busy: another network change is running"}
        try:
            return fn(*args, **kwargs)
        finally:
            _lock.release()
    return run


def drop_new_profiles(ssid, known_uuids, deadline):
    """After a failed attempt: delete the wifi profiles it created, so a rejected first
    join does not stay behind as a SAVED, autoconnecting network with the wrong key.
    Deleting also stops an activation still in progress (after a timeout, say).

    Only a UUID that did not exist before the attempt, named after `ssid` (nmcli names
    a new profile after the SSID, adding " 1", " 2"... when that name is taken), is
    touched, and only by its full UUID, never by name. A profile that existed before
    keeps whatever nmcli wrote to it, so the panel's re-prompt for a rejected saved
    password still works. Returns None, or why the cleanup is incomplete."""
    try:
        rows = profiles(timeout=left(deadline, QUERY_TIMEOUT))
    except NmError as e:
        return f"could not list the profiles to remove the one this attempt saved: {e}"
    named = re.compile(re.escape(ssid) + r"( [0-9]+)?", re.S)
    new = [p for p in rows if is_wifi(p) and p["uuid"] not in known_uuids
           and named.fullmatch(p["name"])]
    problems = []
    for p in new:
        if time.time() >= deadline:
            problems.append(f"no time left to delete profile {p['uuid']}")
            continue
        rc, out, err = nm("connection", "delete", "uuid", p["uuid"],
                          timeout=left(deadline, QUERY_TIMEOUT))
        if rc != 0:
            problems.append(f"could not delete profile {p['uuid']}: {nm_why(rc, out, err)}")
    return "; ".join(problems) or None


def restore(prev, deadline):
    """After a failed attempt: put `prev` (from profiles()) back on IFACE, unless it
    never left. Returns (reverted, untouched, state):
      reverted   IFACE ended on `prev` with an address
      untouched  it never left `prev`: nothing had to be done
    Compared by UUID throughout. `nmcli connection up` of the profile already up
    re-activates it (NetworkManager's nm-manager.c, per the review), which drops the
    link, so that is done only when wlan0 is not on `prev` with an address. nmcli
    often fails before it touches the device at all ("No network with SSID ...
    found"), and NetworkManager's autoconnect may already be bringing `prev` back.
    Ends at most 2 s after `deadline`."""
    try:
        cur, known = on_iface(profiles(timeout=left(deadline, QUERY_TIMEOUT))), True
    except NmError:
        cur, known = None, False        # cannot tell: reactivate, as the only safe choice
    st = net_state(timeout=left(deadline, QUERY_TIMEOUT))
    if known and cur and cur["uuid"] == prev["uuid"] and st["error"] is None:
        if st["ip"]:
            return True, True, st
        st = wait_online(min(deadline, time.time() + REVERT_TIMEOUT))
        if st["ip"]:
            return True, False, st
    rc, _, _ = nm("connection", "up", "uuid", prev["uuid"], "ifname", IFACE,
                  timeout=left(deadline, REVERT_TIMEOUT))
    st = wait_online(deadline)
    if not st["ip"]:
        return False, False, st
    if rc == 0:
        return True, False, st
    # nmcli gave up or was cut off, yet there is an address: whose?
    try:
        cur = on_iface(profiles(timeout=left(deadline, QUERY_TIMEOUT)))
    except NmError:
        cur = None
    return bool(cur and cur["uuid"] == prev["uuid"]), False, st


@serialised
def do_connect(ssid, psk, hidden=False):
    """
    Two-phase: try the new network, verify an address, clean up and roll back if it
    fails (see the module docstring). The PSK goes to `nmcli --ask` on stdin only.
    Answers within CONNECT_CEILING of taking the lock.

    A failure's answer carries `previous` (the profile NAME that was up), `reverted`
    (wlan0 ended on it with an address), `untouched` (it never left it, so nothing
    had to be put back) and, when a saved profile could not be removed, `cleanup`.
    """
    try:
        before = profiles()
    except NmError as e:
        # Nothing known to roll back to, on the only live link: do not try.
        return 502, {"error": f"could not read which network is up, so a failed "
                              f"connect could not be undone: {e}",
                     "reverted": False, "untouched": True, "previous": None, "net": net_state()}
    prev = on_iface(before)
    previous = prev["name"] if prev else None
    known_uuids = {p["uuid"] for p in before}

    def refused(status, error):
        # Refused before anything reached wlan0, so it is where it was.
        return status, {"error": error, "reverted": prev is not None, "untouched": True,
                        "previous": previous, "net": net_state()}

    if hidden:
        # A hidden AP answers only a probe that names it, and nmcli's own lookup of the
        # SSID then fails ("No network with SSID ... found") on a first join. Probe for
        # it and wait until it shows up, before touching the link at all.
        rc, out, err = nm("device", "wifi", "rescan", "ifname", IFACE, "ssid", ssid,
                          timeout=QUERY_TIMEOUT)
        if rc != 0:
            return refused(502, f"could not probe for the hidden network "
                                f"({nm_why(rc, out, err)}). Nothing was changed")
        if not hidden_ssid_answers(ssid, time.time() + HIDDEN_SCAN_TIMEOUT):
            return refused(404, f"no access point answered for hidden SSID {ssid!r} within "
                                f"{HIDDEN_SCAN_TIMEOUT} s: check the exact name, and that it is "
                                f"in range. Nothing was changed")

    args = ["device", "wifi", "connect", ssid, "ifname", IFACE]
    if hidden:
        args += ["hidden", "yes"]
    if psk:
        rc, out, err = nm("--ask", *args, stdin=psk + "\n", timeout=NM_CONNECT_TIMEOUT)
    else:
        rc, out, err = nm(*args, timeout=NM_CONNECT_TIMEOUT)

    if rc == 0:
        st = wait_online(time.time() + CONNECT_TIMEOUT)
        if st["ip"]:
            return 200, {"ok": True, "net": st}
        err = err or "connected but no address was assigned"

    # ---- failed. Remove what the attempt saved, then put the old network back.
    detail = nm_why(rc, out, err)
    # 401 only for NetworkManager's own "no secrets" reason, never for a word such as
    # "key" that may be part of the SSID in "No network with SSID ... found".
    status = 401 if NO_SECRETS in (err or "") + (out or "") else 502
    cleanup = drop_new_profiles(ssid, known_uuids, time.time() + CLEANUP_BUDGET)
    end = time.time() + ROLLBACK_BUDGET
    if prev:
        reverted, untouched, st = restore(prev, end)
    else:
        reverted, untouched, st = False, False, net_state(timeout=left(end, QUERY_TIMEOUT))
    body = {"error": detail, "reverted": reverted, "untouched": untouched,
            "previous": previous, "net": st}
    if cleanup:
        body["cleanup"] = cleanup
    return status, body


@serialised
def do_forget(name):
    """Delete ONE saved wifi profile, chosen by its exact name and removed by its UUID.
    The caller's text never reaches nmcli: nmcli would read it as a name, a UUID (or a
    unique prefix of one) or a D-Bus path. Refuses the profile we are standing on --
    see the module docstring. Answers within QUICK_CEILING of taking the lock."""
    try:
        rows = profiles()
    except NmError as e:
        return 502, {"error": f"could not read which network is up, so it may be "
                              f"this one; not forgetting it: {e}"}
    matches = [p for p in rows if p["name"] == name]
    if not matches:
        return 404, {"error": f"no saved profile is named {name!r}"}
    if len(matches) > 1:
        return 409, {"error": f"{len(matches)} profiles are named {name!r}; not guessing "
                              "which one to delete"}
    target = matches[0]
    if not is_wifi(target):
        return 409, {"error": f"the profile named {name!r} is not a wifi profile"}
    active = on_iface(rows)
    if target["device"] or (active and (active["uuid"] == target["uuid"]
                                        or active["name"] == target["name"])):
        return 409, {"error": "refusing to forget the active network: "
                              f"{IFACE} is this machine's only live link"}
    rc, out, err = nm("connection", "delete", "uuid", target["uuid"])
    if rc != 0:
        return 502, {"error": nm_why(rc, out, err) if (err or out) else "delete failed"}
    return 200, {"ok": True}


@serialised
def do_radio(on):
    if not on:
        try:
            active = on_iface(profiles())
        except NmError as e:
            return 502, {"error": f"could not read which network is up, so wifi may be "
                                  f"in use; not switching it off: {e}"}
        if active:
            return 409, {"error": "refusing to switch wifi off while it is the "
                                  "only connection to this machine"}
    rc, out, err = nm("radio", "wifi", "on" if on else "off")
    if rc != 0:
        return 502, {"error": nm_why(rc, out, err) if (err or out) else "radio failed"}
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
    """True when xset can open X on :0 and it has the DPMS extension, i.e. screen-off
    is possible. False as well when X does not admit this user (carbon-net)."""
    xset = shutil.which("xset")
    if not xset:
        return False
    try:
        env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
        p = subprocess.run([xset, "q"], capture_output=True, text=True, timeout=5, env=env)
        return p.returncode == 0 and "DPMS" in (p.stdout or "")
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
    Screen off/on via DPMS, with xset against X on :0 (KlipperScreen logged
    `Wayland: False`). This is the only screen-power control an HDMI panel has.

    The kiosk session sets `xset dpms 0 0 0` (DPMS enabled, no automatic timeouts),
    so the panel never blanks by itself. That is the right session setting, but not
    because `xset -dpms` would turn `force off` into a no-op: xset's `dpms force`
    calls DPMSEnable itself before it sets the level (xset.c 583-585, per the
    review). X must also admit this helper's user (`xhost +SI:localuser:carbon-net`
    in the kiosk session), or xset cannot open the display at all.
    """
    xset = shutil.which("xset")
    if not xset:
        return 501, {"error": "xset not installed"}
    # Checked first: without the extension xset only prints "server does not have
    # extension for dpms option" and still exits 0 (per the review), so its exit code
    # alone would not show that.
    if not dpms_available():
        return 501, {"error": "screen-off is unavailable: X on :0 did not admit the helper "
                              "(the kiosk session must run xhost +SI:localuser:carbon-net), "
                              "or it has no DPMS extension"}
    env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
    try:
        p = subprocess.run([xset, "dpms", "force", "off" if on else "on"],
                           capture_output=True, text=True, timeout=10, env=env, check=False)
    except Exception as e:                                     # noqa: BLE001
        return 502, {"error": str(e)}
    if p.returncode != 0:
        # xset exits 1 when it cannot open the display and 255 after an X error.
        why = (p.stderr or "").strip().splitlines()
        return 502, {"error": why[-1] if why else f"xset exited {p.returncode}"}
    return 200, {"ok": True, "blank": on}


# --------------------------------------------------------------------------- requests
class Refuse(Exception):
    """An answer to send instead of doing anything: (status, why)."""

    def __init__(self, status, why):
        super().__init__(why)
        self.status, self.why = status, why


def _no_controls(v):
    return not any(unicodedata.category(c) == "Cc" for c in v)


def want_text(v, what, max_bytes):
    """A non-empty string of at most `max_bytes` UTF-8 bytes with no control characters
    (it goes into nmcli's argv, and comes back in its line-based output)."""
    if not isinstance(v, str) or not v:
        raise Refuse(400, f"{what} must be a non-empty string")
    try:
        n = len(v.encode("utf-8"))
    except UnicodeEncodeError:
        raise Refuse(400, f"{what} is not valid text") from None
    if n > max_bytes:
        raise Refuse(400, f"{what} must be at most {max_bytes} bytes of UTF-8")
    if not _no_controls(v):
        raise Refuse(400, f"{what} contains a control character")
    return v


_HEX64 = re.compile(r"[0-9A-Fa-f]{64}")
_WEP_HEX = re.compile(r"[0-9A-Fa-f]{10}|[0-9A-Fa-f]{26}")


def want_psk(v):
    """Empty (open or saved network), 8-63 characters, or 64 hex digits; also the WEP
    keys the panel allows (5 or 13 characters, 10 or 26 hex digits). No control
    character: it is written to nmcli's stdin as one line. Never echoed back."""
    if not isinstance(v, str):
        raise Refuse(400, "psk must be a string")
    if v == "":
        return v
    if not _no_controls(v):
        raise Refuse(400, "psk contains a control character")
    try:
        v.encode("utf-8")
    except UnicodeEncodeError:
        raise Refuse(400, "psk is not valid text") from None
    if 8 <= len(v) <= 63 or _HEX64.fullmatch(v) or len(v) in (5, 13) or _WEP_HEX.fullmatch(v):
        return v
    raise Refuse(400, "psk must be empty, 8-63 characters or 64 hex digits "
                      "(WEP: 5 or 13 characters, or 10 or 26 hex digits)")


def want_bool(b, key, default=None):
    """A real JSON true/false. Missing is an error unless there is a default: a garbled
    request must never read as False, which means radio OFF or screen ON."""
    if key not in b:
        if default is None:
            raise Refuse(400, f"{key} (true or false) is required")
        return default
    if not isinstance(b[key], bool):
        raise Refuse(400, f"{key} must be true or false")
    return b[key]


def post_connect(b):
    return do_connect(want_text(b.get("ssid"), "ssid", 32),
                      want_psk(b.get("psk", "")),
                      want_bool(b, "hidden", default=False))


def post_forget(b):
    return do_forget(want_text(b.get("ssid"), "ssid", 255))


def post_radio(b):
    return do_radio(want_bool(b, "on"))


def post_brightness(b):
    pct = b.get("pct")
    if type(pct) is not int or not 0 <= pct <= 100:     # bool is an int subclass: excluded
        raise Refuse(400, "pct must be a whole number from 0 to 100")
    return set_brightness(pct)


def post_blank(b):
    return set_blank(want_bool(b, "on"))


POST_ROUTES = {
    "/wifi/connect": post_connect,
    "/wifi/forget": post_forget,
    "/wifi/radio": post_radio,
    "/display/brightness": post_brightness,
    "/display/blank": post_blank,
}


def crashed(e):
    """An unexpected exception -> a generic 500, so the panel gets an answer rather than
    nginx's 502 page. The journal gets the exception type and where, never a request
    field or the exception's message (which may quote one)."""
    tb = e.__traceback__
    while tb is not None and tb.tb_next is not None:
        tb = tb.tb_next
    where = (f"{os.path.basename(tb.tb_frame.f_code.co_filename)}:{tb.tb_lineno}"
             if tb is not None else "?")
    print(f"carbon-helper: unhandled {type(e).__name__} at {where}", file=sys.stderr, flush=True)
    return 500, {"error": "internal error in the helper; see: journalctl -u carbon-helper"}


# --------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "CarbonHelper/1.0"
    timeout = SOCKET_TIMEOUT

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
        """Layer 3 of the TRUST BOUNDARY in the module docstring. The peer check alone
        passes everything nginx forwards; X-Carbon-Local-Addr ($server_addr) is what
        tells a loopback client from a LAN one."""
        local = self.headers.get_all("X-Carbon-Local-Addr") or []
        real = self.headers.get_all("X-Real-IP") or []
        if (self.client_address[0] not in LOOPBACK
                or len(local) != 1 or local[0].strip() not in LOOPBACK
                or any(v.strip() not in LOOPBACK for v in real)):
            self._send(403, {"error": "loopback only"})
            return False
        return True

    def _body(self):
        """The request's JSON object. Raises Refuse: 413 over MAX_BODY (not read; the
        connection closes after the answer, HTTP/1.0), 400 for anything else wrong."""
        cl = self.headers.get("Content-Length")
        if cl is None:
            raise Refuse(411 if self.headers.get("Transfer-Encoding") else 400,
                         "a JSON body with a Content-Length is required")
        try:
            n = int(cl)
        except ValueError:
            raise Refuse(400, "bad Content-Length") from None
        if n < 0:
            raise Refuse(400, "bad Content-Length")
        if n > MAX_BODY:
            self.close_connection = True
            raise Refuse(413, f"request body over {MAX_BODY} bytes")
        try:
            data = json.loads(self.rfile.read(n) or b"null")
        except (ValueError, RecursionError, OSError):
            raise Refuse(400, "request body is not valid JSON") from None
        if not isinstance(data, dict):
            raise Refuse(400, "request body must be a JSON object")
        return data

    def _path(self):
        return self.path.split("?")[0].rstrip("/") or "/"

    def _get(self, path):
        if path in ("/", "/health"):
            return 200, {"ok": True, "nmcli": bool(NMCLI), "iface": IFACE,
                         # Always False: the PSK never goes in argv. Kept only because
                         # the panel still reads it (network.jsx confirm text).
                         "psk_via_argv": False,
                         "version": self.server_version, "sha256": CODE_SHA256}
        if path == "/net":
            return 200, net_state()
        if path == "/wifi":
            # A failed nmcli is an error, not "radio off" or "no networks": both of
            # those would be shown as facts.
            try:
                radio = radio_on()
                return 200, {"radio": radio, "aps": scan() if radio else []}
            except NmError as e:
                return 502, {"error": f"nmcli: {e}"}
        if path == "/display":
            return 200, display_state()
        return 404, {"error": "not found"}

    def do_GET(self):
        if not self._guard():
            return
        try:
            st, r = self._get(self._path())
        except Exception as e:                                 # noqa: BLE001
            st, r = crashed(e)
        self._send(st, r)

    def do_POST(self):
        if not self._guard():
            return
        try:
            route = POST_ROUTES.get(self._path())
            if route is None:
                raise Refuse(404, "not found")
            st, r = route(self._body())
        except Refuse as e:
            st, r = e.status, {"error": e.why}
        except Exception as e:                                 # noqa: BLE001
            st, r = crashed(e)
        self._send(st, r)


class Server(ThreadingHTTPServer):
    """At most MAX_THREADS requests in flight. The cap is taken where the thread is
    created, so a flood cannot start threads that then wait inside the handler."""
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self._slots = threading.BoundedSemaphore(MAX_THREADS)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            body = b'{"error": "busy: too many requests in flight"}'
            try:
                request.settimeout(1.0)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\n"
                                b"Content-Type: application/json\r\n"
                                b"Cache-Control: no-store\r\n"
                                b"Content-Length: %d\r\n\r\n" % len(body) + body)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()      # the thread never started, so it will not release
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def main():
    if os.geteuid() == 0:
        sys.exit("carbon-helper: refusing to run as root; run it as carbon-net "
                 "(tools/helper/install_helper.sh)")
    try:
        who = pwd.getpwuid(os.geteuid()).pw_name
    except KeyError:
        who = str(os.geteuid())
    srv = Server((HOST, PORT), Handler)
    print(f"carbon-helper on http://{HOST}:{PORT} iface={IFACE} nmcli={bool(NMCLI)} "
          f"user={who}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
