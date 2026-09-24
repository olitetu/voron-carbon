#!/usr/bin/env python3
"""
    tools/update_verify.py --save  snapshots/pre      # BEFORE you update anything
    tools/update_verify.py --check snapshots/pre      # AFTER, to see what moved
    tools/update_verify.py                            # standalone: does Carbon still resolve?

Answers one question: after updating Klipper / Moonraker / everything, does Voron Carbon still have
the API it was built against?

Carbon is a static bundle with no runtime dependency on the printer's software — no Node, no Python,
no venv, no service. Its ENTIRE compatibility surface is two lists, and this script derives both FROM
THE SOURCE rather than restating them, so it cannot drift out of date:

    the printer objects it subscribes to   <- CORE_SUBS in src/lib/boot.js
    the Moonraker methods it calls         <- the "namespace.method" literals across src/

WHAT IT WILL NOT DO
    It never calls a mutating method. `machine.update.full`, `printer.gcode.script`, `printer.restart`
    and friends are reported as "declared, not probed" — the only way to test a setter is to fire it,
    and firing one to see whether it exists is how you learn it did. Their absence would be a Moonraker
    breaking change loud enough to be in the changelog.

Exit status is 0 when everything Carbon needs resolves, 1 otherwise, so it can gate a deploy.
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
# but deliberately left unprobed — see WHAT IT WILL NOT DO above.
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
    "server.history.totals":     "/server/history/totals",
    "server.webcams.list":       "/server/webcams/list",
    "server.temperature_store":  "/server/temperature_store",
    "server.gcode_store":        "/server/gcode_store?count=1",
    "server.announcements.list": "/server/announcements/list",
    "server.spoolman.status":    "/server/spoolman/status",
}

C_OK, C_BAD, C_WARN, C_DIM, C_OFF = "\033[38;5;71m", "\033[38;5;203m", "\033[38;5;214m", "\033[38;5;245m", "\033[0m"


def die(msg):
    print(f"{C_BAD}xxx{C_OFF} {msg}", file=sys.stderr)
    sys.exit(2)


# ── deriving Carbon's surface from its own source ────────────────────────────────────────────────

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
    keys = [a or b for a, b in re.findall(r'(?:^|,)\s*(?:"([^"]+)"|([A-Za-z_]\w*))\s*:', body)]
    if len(keys) < 10:
        die(f"only parsed {len(keys)} objects out of CORE_SUBS — the parser is wrong, not the config")
    return keys


def rpc_methods():
    """Every "namespace.method" literal Carbon mentions anywhere under src/."""
    found = set()
    pat = re.compile(r'"((?:printer|server|machine|access)\.[a-z_][a-z_.]*)"')
    for root, _dirs, files in os.walk(os.path.join(HERE, "src")):
        for f in files:
            if not f.endswith((".js", ".jsx")):
                continue
            with open(os.path.join(root, f), encoding="utf-8") as fh:
                found.update(pat.findall(fh.read()))
    # printer.cfg is a filename that happens to match the shape; it is not a method.
    found.discard("printer.cfg")
    if len(found) < 20:
        die(f"only found {len(found)} rpc methods under src/ — the scanner is wrong")
    return sorted(found)


# ── talking to the printer ───────────────────────────────────────────────────────────────────────

def get(base, path, timeout=20):
    try:
        with urllib.request.urlopen(base + path, timeout=timeout) as r:
            return json.load(r).get("result"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 - any transport failure is equally fatal here
        return None, type(e).__name__


def collect(base):
    """Everything worth comparing across an update, in one dict."""
    snap = {}
    info, err = get(base, "/server/info")
    if err:
        die(f"{base} is not answering ({err}). Is the printer up?")
    snap["server_info"] = {k: info.get(k) for k in
                           ("moonraker_version", "api_version_string", "klippy_state",
                            "components", "failed_components", "warnings")}

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
    return snap


# ── the actual verdict ───────────────────────────────────────────────────────────────────────────

def verify(base, snap):
    """Does everything Carbon needs resolve? Returns a list of failures (empty means good)."""
    fails = []
    print(f"\n{C_DIM}── Carbon's dependencies ──────────────────────────────────{C_OFF}")

    subs, have = core_subs(), set(snap["objects"])
    missing = [o for o in subs if o not in have]
    mark = C_BAD if missing else C_OK
    print(f"  {mark}printer objects{C_OFF}  {len(subs) - len(missing)}/{len(subs)} resolve")
    for o in missing:
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
          f"{C_DIM}, {len(unprobed)} declared but not probed (mutating){C_OFF}")
    for m, err in bad:
        print(f"      {C_BAD}FAILED{C_OFF} {m} -> {err}")
        fails.append(f"moonraker method {m} returned {err}")

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
        fails.append("mmu_server component missing (re-run ~/Happy-Hare/install.sh)")
    if si.get("warnings"):
        for w in si["warnings"]:
            print(f"      {C_WARN}warning{C_OFF} {w}")
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

    gone = sorted(set(old.get("objects", [])) - set(new.get("objects", [])))
    added = sorted(set(new.get("objects", [])) - set(old.get("objects", [])))
    if gone:
        print(f"  {C_WARN}printer objects GONE{C_OFF}   {', '.join(gone)}")
    if added:
        print(f"  {C_DIM}printer objects added  {', '.join(added)}{C_OFF}")

    cgone = sorted(set(old.get("gcode_commands", [])) - set(new.get("gcode_commands", [])))
    if cgone:
        print(f"  {C_WARN}gcode commands GONE{C_OFF}    {', '.join(cgone)}")
    # Objects and commands disappearing is not automatically a Carbon failure — verify() decides that.
    # It is always worth seeing, because it is how a config regression announces itself.


def main():
    ap = argparse.ArgumentParser(add_help=True, description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--printer", default=os.environ.get("CARBON_PRINTER", "voron.local"),
                    help="printer host or base URL (default: voron.local)")
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
        os.makedirs(args.save, exist_ok=True)
        path = os.path.join(args.save, "snapshot.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(snap, fh, indent=2, sort_keys=True)
        print(f"\n{C_OK}==>{C_OFF} baseline written to {path}")
        print(f"    after updating:  {sys.argv[0]} --check {args.save}")
        return 0

    if args.check:
        path = os.path.join(args.check, "snapshot.json")
        if not os.path.isfile(path):
            die(f"no snapshot at {path} — run --save {args.check} BEFORE updating")
        diff(json.load(open(path, encoding="utf-8")), snap)

    fails = verify(base, snap)
    print()
    if fails:
        print(f"{C_BAD}xxx {len(fails)} problem(s) — Carbon will not work correctly:{C_OFF}")
        for f in fails:
            print(f"    - {f}")
        return 1
    print(f"{C_OK}==>{C_OFF} Carbon's entire dependency surface resolves. Nothing to do.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
