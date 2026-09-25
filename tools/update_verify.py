#!/usr/bin/env python3
"""
    tools/update_verify.py --save  snapshots/pre      # BEFORE you update anything
    tools/update_verify.py --check snapshots/pre      # AFTER, to see what moved
    tools/update_verify.py                            # standalone: does Carbon still resolve?

    Point --printer at Carbon's own site: voron.local:8767 from a Mac, 127.0.0.1:8767 on the Pi. Run
    --save and --check on the same machine: /helper/ answers 200 on loopback and 403 from the LAN.

Answers one question: after updating Klipper / Moonraker / everything, does Voron Carbon still have
the API it was built against?

Carbon's code has no runtime dependency on the printer's software, but since the panel cutover it runs
on it: the kiosk, the helper and the nginx site. This script derives what Carbon asks of the printer
FROM THE SOURCE rather than restating it, so it cannot drift out of date:

    the printer objects it subscribes to   <- CORE_SUBS in src/lib/boot.js, plus every
                                              api.subscribe({...}) / api.query({...}) elsewhere
    the Moonraker methods it calls         <- the "namespace.method" literals across src/
    the G-code it sends                    <- MMU_*, Z_OFFSET_*, CARTOGRAPHER_*, ... across src/
                                              (checked against the baseline, --check only)

and then checks what it runs on: that the site serves Carbon's files, that /helper/ answers the way
it should from where you are, and that carbon-kiosk, not KlipperScreen, owns the panel.

It refuses to run unless Klippy is ready: a not-ready Klippy hides objects and collapses the G-code
catalogue, which would be recorded as a baseline or read as breakage. It does not check Happy Hare
parameter names.

WHAT IT WILL NOT DO
    It never calls a mutating method. `machine.update.full`, `printer.gcode.script`, `printer.restart`
    and friends are reported as "declared, not probed" — the only way to test a setter is to fire it,
    and firing one to see whether it exists is how you learn it did. Their absence would be a Moonraker
    breaking change loud enough to be in the changelog.

Exit status is 0 when everything Carbon needs resolves, 1 otherwise, so it can gate a deploy. --save
exits 1 when the baseline itself already fails, and records those failures; --check then exits 1 only
on failures the baseline did not have.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Read-only REST equivalents of the methods Carbon calls. Anything not in here is declared by Carbon
# but deliberately left unprobed — see WHAT IT WILL NOT DO above. server.spoolman.proxy stays out on
# purpose: it is POST-only and forwards writes to Spoolman.
PROBES = {
    "server.info":               "/server/info",
    "server.config":             "/server/config",
    "printer.info":              "/printer/info",
    "printer.objects.list":      "/printer/objects/list",
    "printer.objects.query":     "/printer/objects/query?toolhead",
    "machine.system_info":       "/machine/system_info",
    "machine.proc_stats":        "/machine/proc_stats",
    "machine.update.status":     "/machine/update/status?refresh=false",
    "server.files.list":         "/server/files/list?root=config",
    "server.files.get_directory": "/server/files/directory?path=gcodes",
    "server.history.totals":     "/server/history/totals",
    "server.history.list":       "/server/history/list?limit=1",
    "server.database.get_item":  "/server/database/item?namespace=carbon",
    "server.webcams.list":       "/server/webcams/list",
    "server.temperature_store":  "/server/temperature_store",
    "server.gcode_store":        "/server/gcode_store?count=1",
    "server.announcements.list": "/server/announcements/list",
    "server.spoolman.status":    "/server/spoolman/status",
    "server.spoolman.get_spool_id": "/server/spoolman/spool_id",   # GET|POST (spoolman.py:99-102); GET only reads
}

# What the :8767 site must serve, and the services whose state says who owns the panel.
CARBON_FILES = ("/", "/app.js", "/screen.html", "/screen.js", "/safe.html")
PANEL_SERVICES = ("carbon-kiosk", "KlipperScreen")
LOOPBACK = ("127.0.0.1", "localhost", "::1")

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = "\033[38;5;71m", "\033[38;5;203m", "\033[38;5;214m", "\033[38;5;245m", "\033[0m"


def die(msg):
    print(f"{C_BAD}xxx{C_OFF} {msg}", file=sys.stderr)
    sys.exit(2)


# ── deriving Carbon's surface from its own source ────────────────────────────────────────────────

# The object keys of a subscription/query literal: `name:` or `"name with space":`.
KEY_RE = re.compile(r'(?:^|,)\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*:')


def src_files(skip=()):
    for root, _dirs, files in os.walk(os.path.join(HERE, "src")):
        for f in files:
            if f.endswith((".js", ".jsx")) and f not in skip:
                with open(os.path.join(root, f), encoding="utf-8") as fh:
                    yield fh.read()


def core_subs():
    """The printer objects Carbon subscribes to unconditionally, read out of boot.js.

    Fails loud rather than returning a short list: a silent empty result here would turn this whole
    script into a green tick that checked nothing.
    """
    path = os.path.join(HERE, "src", "lib", "boot.js")
    src = open(path, encoding="utf-8").read()
    m = re.search(r"const CORE_SUBS = \{(.*?)\n\};", src, re.S)
    if not m:
        die(f"could not find `const CORE_SUBS = {{ … }};` in {path} — did the subscription move?")
    body = re.sub(r"//[^\n]*", "", m.group(1))
    keys = [a or b for a, b in KEY_RE.findall(body)]
    if len(keys) < 10:
        die(f"only parsed {len(keys)} objects out of CORE_SUBS — the parser is wrong, not the config")
    return keys


def extra_objects():
    """Objects named in api.subscribe({...}) / api.query({...}) literals anywhere under src/.

    The panel subscribes to mmu_machine, mmu_leds and manual_probe on top of CORE_SUBS, and some screens
    query objects once (scanner, gcode_macro _Z_OFFSET_VARS). A call with a variable, like boot.js's
    api.subscribe(subs), is not a literal and is covered by core_subs() instead.
    """
    pat = re.compile(r"api\.(?:subscribe|query)\(\s*\{([^}]*)\}")
    found = set()
    for src in src_files():
        for body in pat.findall(src):
            body = re.sub(r"//[^\n]*", "", body)
            found.update(a or b for a, b in KEY_RE.findall(body))
    return sorted(found)


def rpc_methods():
    """Every "namespace.method" literal Carbon mentions anywhere under src/."""
    found = set()
    pat = re.compile(r'"((?:printer|server|machine|access)\.[a-z_][a-z_.]*)"')
    for src in src_files():
        found.update(pat.findall(src))
    # printer.cfg is a filename that happens to match the shape; it is not a method.
    found.discard("printer.cfg")
    if len(found) < 20:
        die(f"only found {len(found)} rpc methods under src/ — the scanner is wrong")
    return sorted(found)


def gcode_tokens():
    """Command-shaped tokens across src/ (icons.js excluded: its names are not commands).

    The scan is deliberately loose, so it also yields prefixes like MMU_, MMU__ or SET_PAUSE_. Only the
    tokens that were real commands in the baseline's catalogue are ever compared, which drops that noise.
    """
    pat = re.compile(r"\b(?:MMU|Z_OFFSET|CARTOGRAPHER|BED_MESH|SET|QUAD|SAVE|FIRMWARE|SDCARD|SHAPER|PROBE"
                     r"|Z_ENDSTOP)_[A-Z0-9_]*\b")
    found = set()
    for src in src_files(skip=("icons.js",)):
        found.update(pat.findall(src))
    if len(found) < 20:
        die(f"only found {len(found)} G-code tokens under src/ — the scanner is wrong")
    return found


# ── talking to the printer ───────────────────────────────────────────────────────────────────────

def get(base, path, timeout=20):
    try:
        with urllib.request.urlopen(base + path, timeout=timeout) as r:
            return json.load(r).get("result"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 - any transport failure is equally fatal here
        return None, type(e).__name__


def status_of(base, path, timeout=10):
    """The HTTP status of a plain GET: an int, or the exception's name when nothing answered."""
    try:
        with urllib.request.urlopen(base + path, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


def collect(base):
    """Everything worth comparing across an update, in one dict."""
    snap = {}
    info, err = get(base, "/server/info")
    if err:
        die(f"{base} is not answering ({err}). Is the printer up?")
    snap["server_info"] = {k: info.get(k) for k in
                           ("moonraker_version", "api_version_string", "klippy_state",
                            "components", "failed_components", "warnings")}
    if info.get("klippy_state") != "ready":
        die(f"Klippy is {info.get('klippy_state')!r}, not ready: fix Klipper first "
            f"(~/printer_data/logs/klippy.log), then re-run. Nothing was saved or compared.")

    pinfo, _ = get(base, "/printer/info")
    snap["klipper_version"] = (pinfo or {}).get("software_version")

    objs, _ = get(base, "/printer/objects/list")
    snap["objects"] = sorted((objs or {}).get("objects", []))

    upd, _ = get(base, "/machine/update/status?refresh=false")
    snap["versions"] = {n: v.get("version") for n, v in ((upd or {}).get("version_info") or {}).items()}

    mcus = [o for o in snap["objects"] if o == "mcu" or o.startswith("mcu ")]
    if mcus:
        q = "&".join(urllib.parse.quote(m) for m in mcus)
        st, _ = get(base, "/printer/objects/query?" + q)
        snap["mcu_firmware"] = {m: ((st or {}).get("status", {}).get(m) or {}).get("mcu_version")
                                for m in mcus}

    cmds, _ = get(base, "/printer/gcode/help")
    snap["gcode_commands"] = sorted(cmds or {})
    # The catalogue Carbon itself reads (boot.js): every registered handler, macros included.
    snap["gcode_catalogue"] = sorted(((((get(base, "/printer/objects/query?gcode=commands")[0] or {})
                                        .get("status") or {}).get("gcode") or {}).get("commands") or {}))

    # service_state values are dicts ({"active_state": ..., "sub_state": ...}); keep active_state.
    ss = (((get(base, "/machine/system_info")[0] or {}).get("system_info") or {}).get("service_state") or {})
    snap["services"] = {n: (ss.get(n) or {}).get("active_state") for n in PANEL_SERVICES}

    snap["carbon_files"] = {p: status_of(base, p) for p in CARBON_FILES}
    snap["helper"] = status_of(base, "/helper/health")
    return snap


# ── the actual verdict ───────────────────────────────────────────────────────────────────────────

def verify(base, snap, old=None):
    """Does everything Carbon needs resolve? Returns a list of failures (empty means good).

    With `old` (a baseline), it also checks that the G-code Carbon sends still exists.
    """
    fails = []
    print(f"\n{C_DIM}── Carbon's dependencies ──────────────────────────────────{C_OFF}")

    subs, have = core_subs(), set(snap["objects"])
    missing = [o for o in subs if o not in have]
    mark = C_BAD if missing else C_OK
    print(f"  {mark}printer objects{C_OFF}  {len(subs) - len(missing)}/{len(subs)} resolve")
    for o in missing:
        print(f"      {C_BAD}MISSING{C_OFF} {o}")
        fails.append(f"printer object {o!r} no longer exists")

    extra = sorted(set(extra_objects()) - set(subs))
    xmissing = [o for o in extra if o not in have]
    mark = C_BAD if xmissing else C_OK
    print(f"  {mark}screen objects{C_OFF}   {len(extra) - len(xmissing)}/{len(extra)} resolve"
          f"{C_DIM} (subscribed or queried outside CORE_SUBS){C_OFF}")
    for o in xmissing:
        print(f"      {C_BAD}MISSING{C_OFF} {o}")
        fails.append(f"printer object {o!r} no longer exists")

    methods = rpc_methods()
    probed = [m for m in methods if m in PROBES]
    unprobed = [m for m in methods if m not in PROBES]
    bad = []
    for m in probed:
        _r, err = get(base, PROBES[m])
        if err:
            bad.append((m, err))
    mark = C_BAD if bad else C_OK
    print(f"  {mark}moonraker rpc{C_OFF}    {len(probed) - len(bad)}/{len(probed)} probed OK"
          f"{C_DIM}, {len(unprobed)} declared (not probed: mutating, websocket-only or needs arguments){C_OFF}")
    for m, err in bad:
        print(f"      {C_BAD}FAILED{C_OFF} {m} -> {err}")
        fails.append(f"moonraker method {m} returned {err}")

    if old is not None:
        catalogue = set(old.get("gcode_catalogue", []))
        sent = gcode_tokens() & catalogue
        gone = sorted(sent - set(snap["gcode_catalogue"]))
        if not catalogue:
            print(f"  {C_WARN}g-code{C_OFF}           the baseline has no catalogue (older script): not compared")
        else:
            mark = C_BAD if gone else C_OK
            print(f"  {mark}g-code{C_OFF}           {len(sent) - len(gone)}/{len(sent)} commands Carbon sends still exist")
        for c in gone:
            print(f"      {C_BAD}GONE{C_OFF} {c}")
            fails.append(f"G-code Carbon sends is gone: {c}")

    si = snap["server_info"]
    failed = si.get("failed_components") or []
    comps = si.get("components") or []
    if failed:
        print(f"  {C_BAD}moonraker components{C_OFF}  failed: {failed}")
        fails.append(f"moonraker components failed to load: {failed}")
    else:
        print(f"  {C_OK}moonraker components{C_OFF}  {len(comps)} loaded, none failed")
    if "mmu_server" not in comps:
        print(f"      {C_BAD}mmu_server is NOT loaded{C_OFF} — Happy Hare's Moonraker component is gone")
        fails.append("mmu_server component missing (re-run ~/Happy-Hare/install.sh -z)")
    if si.get("warnings"):
        for w in si["warnings"]:
            print(f"      {C_WARN}warning{C_OFF} {w}")

    # What Carbon runs on since the cutover: the site, the helper behind it, and who owns the panel.
    files = snap.get("carbon_files") or {}
    badf = [(p, c) for p, c in files.items() if c != 200]
    mark = C_BAD if badf else C_OK
    print(f"  {mark}carbon site{C_OFF}      {len(files) - len(badf)}/{len(files)} files served")
    for p, c in badf:
        print(f"      {C_BAD}FAILED{C_OFF} {p} -> {c}")
        fails.append(f"Carbon's site does not serve {p} ({c}); is --printer Carbon's :8767?")

    local = (urllib.parse.urlsplit(base).hostname or "") in LOOPBACK
    want = 200 if local else 403
    helper = snap.get("helper")
    if helper == 502:
        print(f"  {C_BAD}carbon-helper{C_OFF}    /helper/ -> 502")
        fails.append("carbon-helper is not running")
    elif helper != want:
        print(f"  {C_BAD}carbon-helper{C_OFF}    /helper/health -> {helper}, expected {want}"
              f" from {'loopback' if local else 'the LAN'}")
        fails.append(f"/helper/health answered {helper}, expected {want} from {'loopback' if local else 'the LAN'}")
    else:
        print(f"  {C_OK}carbon-helper{C_OFF}    /helper/health -> {helper}"
              f"{C_DIM} (as expected from {'loopback' if local else 'the LAN'}){C_OFF}")

    svc = snap.get("services") or {}
    kiosk, ks = svc.get("carbon-kiosk"), svc.get("KlipperScreen")
    if kiosk != "active" or ks == "active":
        print(f"  {C_BAD}panel{C_OFF}            carbon-kiosk {kiosk}, KlipperScreen {ks}")
        fails.append("the panel is not on Carbon; run the come-back line")
    else:
        print(f"  {C_OK}panel{C_OFF}            carbon-kiosk {kiosk}, KlipperScreen {ks}")
    return fails


def diff(old, new):
    print(f"\n{C_DIM}── what moved since the snapshot ──────────────────────────{C_OFF}")
    moved = False
    for name in sorted(set(old.get("versions", {})) | set(new.get("versions", {}))):
        a, b = old.get("versions", {}).get(name), new.get("versions", {}).get(name)
        if a != b:
            moved = True
            print(f"  {name:22s} {C_DIM}{a}{C_OFF} -> {b}")
    if old.get("klipper_version") != new.get("klipper_version"):
        moved = True
        print(f"  {'klipper (host)':22s} {C_DIM}{old.get('klipper_version')}{C_OFF} -> {new.get('klipper_version')}")
    for m in sorted(set(old.get("mcu_firmware", {})) | set(new.get("mcu_firmware", {}))):
        a, b = old.get("mcu_firmware", {}).get(m), new.get("mcu_firmware", {}).get(m)
        if a != b:
            moved = True
            print(f"  {m:22s} {C_DIM}{a}{C_OFF} -> {b}")
    a, b = old["server_info"].get("api_version_string"), new["server_info"].get("api_version_string")
    if a != b:
        moved = True
        print(f"  {'moonraker api':22s} {C_DIM}{a}{C_OFF} -> {b}")
    if not moved:
        print(f"  {C_DIM}nothing — same versions as the snapshot{C_OFF}")

    comp_gone = sorted(set(old["server_info"].get("components") or []) - set(new["server_info"].get("components") or []))
    if comp_gone:
        print(f"  {C_WARN}moonraker components GONE{C_OFF}  {', '.join(comp_gone)}")

    gone = sorted(set(old.get("objects", [])) - set(new.get("objects", [])))
    added = sorted(set(new.get("objects", [])) - set(old.get("objects", [])))
    if gone:
        print(f"  {C_WARN}printer objects GONE{C_OFF}   {', '.join(gone)}")
    if added:
        print(f"  {C_DIM}printer objects added  {', '.join(added)}{C_OFF}")

    cgone = sorted(set(old.get("gcode_commands", [])) - set(new.get("gcode_commands", [])))
    if cgone:
        print(f"  {C_WARN}gcode commands GONE{C_OFF}    {', '.join(cgone)}")
    kgone = sorted(set(old.get("gcode_catalogue", [])) - set(new.get("gcode_catalogue", [])))
    if kgone:
        print(f"  {C_WARN}gcode catalogue GONE{C_OFF}   {', '.join(kgone)}")
    # Objects and commands disappearing is not automatically a Carbon failure — verify() decides that.
    # It is always worth seeing, because it is how a config regression announces itself.


def main():
    ap = argparse.ArgumentParser(add_help=True, description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--printer", default=os.environ.get("CARBON_PRINTER", "voron.local:8767"),
                    help="Carbon's own site (default voron.local:8767; on the Pi 127.0.0.1:8767)")
    ap.add_argument("--save", metavar="DIR", help="write a baseline snapshot here and exit")
    ap.add_argument("--check", metavar="DIR", help="compare against a baseline written by --save")
    args = ap.parse_args()

    base = args.printer if args.printer.startswith("http") else "http://" + args.printer
    base = base.rstrip("/")

    snap = collect(base)
    si = snap["server_info"]
    print(f"{C_DIM}printer  {base}{C_OFF}")
    print(f"  moonraker {si.get('moonraker_version')}  api {si.get('api_version_string')}"
          f"  klippy {si.get('klippy_state')}")
    print(f"  klipper   {snap.get('klipper_version')}")

    if args.save:
        # Record what already fails, so --check can tell the update's breakage from what was there.
        snap["baseline_fails"] = verify(base, snap)
        os.makedirs(args.save, exist_ok=True)
        path = os.path.join(args.save, "snapshot.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(snap, fh, indent=2, sort_keys=True)
        print(f"\n{C_OK}==>{C_OFF} baseline written to {path}")
        print(f"    after updating:  {sys.argv[0]} --printer {args.printer} --check {args.save}")
        if snap["baseline_fails"]:
            print(f"\n{C_WARN}/!\\ {len(snap['baseline_fails'])} problem(s) BEFORE the update"
                  f" (recorded; --check will not count them as new):{C_OFF}")
            for f in snap["baseline_fails"]:
                print(f"    - {f}")
            return 1
        return 0

    old = None
    if args.check:
        path = os.path.join(args.check, "snapshot.json")
        if not os.path.isfile(path):
            die(f"no snapshot at {path} — run --save {args.check} BEFORE updating")
        old = json.load(open(path, encoding="utf-8"))
        diff(old, snap)

    fails = verify(base, snap, old)
    print()
    if not fails:
        print(f"{C_OK}==>{C_OFF} Carbon's entire dependency surface resolves. Nothing to do.")
        return 0
    if old is None:
        print(f"{C_BAD}xxx {len(fails)} problem(s) — Carbon will not work correctly:{C_OFF}")
        for f in fails:
            print(f"    - {f}")
        return 1
    # Only what the baseline did not already have is the update's doing.
    known = set(old.get("baseline_fails", []))
    new = [f for f in fails if f not in known]
    color, head = (C_BAD, "xxx") if new else (C_WARN, "/!\\")
    print(f"{color}{head} {len(fails)} problem(s), {len(new)} NEW since the baseline:{C_OFF}")
    for f in fails:
        print(f"    - {'NEW   ' if f in new else 'known '}{f}")
    return 1 if new else 0


if __name__ == "__main__":
    sys.exit(main())
