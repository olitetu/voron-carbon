#!/usr/bin/env python3
"""Push a development build to a printer over Moonraker's file API — no SSH, no git on the printer.

    python3 tools/deploy.py http://myprinter.local
    CARBON_PRINTER=http://myprinter.local python3 tools/deploy.py

This is the DEVELOPMENT path: it uploads into Moonraker's `config` root, where the files are served
(with the wrong Content-Type for browsing, but fine for a quick look) at

    <printer>/server/files/config/<remote-dir>/dist/index.html

For a real install use a GitHub release plus `tools/install.sh`, which serves Carbon on its own port
with Moonraker proxied alongside. Don't point this script at a directory registered with Moonraker's
update_manager — Moonraker makes those read-only to the file API and every upload will 403.
"""
import os
import sys
import pathlib
import subprocess

USAGE = __doc__


def resolve_base() -> str:
    """Printer URL from argv, else $CARBON_PRINTER. No default: guessing someone's hostname is worse
    than asking, and a shared tool must not carry its author's printer name."""
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        return sys.argv[1].rstrip("/")
    env = os.environ.get("CARBON_PRINTER", "").strip()
    if env:
        return env.rstrip("/")
    sys.exit(
        USAGE
        + "\nNo printer given. Pass it as an argument, or set it once in your shell:\n"
          "    export CARBON_PRINTER=http://myprinter.local\n"
    )


if any(a in ("-h", "--help") for a in sys.argv[1:]):
    print(USAGE)          # not an error: sys.exit(str) would print to stderr and exit 1
    sys.exit(0)

base = resolve_base()
# Where the files land under Moonraker's `config` root. Override if you keep several checkouts.
remote_dir = os.environ.get("CARBON_REMOTE_DIR", "voron-ui/carbon").strip("/")
here = pathlib.Path(__file__).resolve().parent
root = here.parent / "dist"

if not (root / "index.html").exists():
    sys.exit(f"{root}/index.html is missing — run `npm run build` first.")


def put(local: pathlib.Path, sub: str, label: str) -> bool:
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "-F", "root=config", "-F", f"path={sub}",
         "-F", f"file=@{local};filename={local.name}",
         f"{base}/server/files/upload"],
        capture_output=True, text=True,
    )
    code = r.stdout.strip()
    ok = code in ("200", "201")
    print(("  ok   " if ok else "  FAIL ") + f"{label}  ({local.stat().st_size} B)"
          + ("" if ok else f"  -> HTTP {code or 'no response'}"))
    return ok


sent = failed = 0
for p in sorted(root.rglob("*")):
    if p.is_dir() or p.name.endswith(".map"):        # source maps are 5.9 MB and never read remotely
        continue
    rel = p.relative_to(root)
    sub = (f"{remote_dir}/dist/" + str(rel.parent)).rstrip("/.").rstrip("/")
    if put(p, sub, str(rel)):
        sent += 1
    else:
        failed += 1

# install.sh has to BE on the printer to be run there, and it is not part of dist/ — shipping it
# alongside keeps the copy you SSH to in sync with this checkout.
for name in ("install.sh",):
    f = here / name
    if f.exists():
        if put(f, f"{remote_dir}/tools", f"tools/{name}"):
            sent += 1
        else:
            failed += 1

print(f"\nuploaded {sent} file(s) to {base}/server/files/config/{remote_dir}/"
      + (f" — {failed} FAILED" if failed else ""))
if failed:
    print("  A 403 usually means this directory is registered with Moonraker's update_manager,\n"
          "  which makes it read-only to the file API. Deploy somewhere else, or use a release.")
sys.exit(1 if failed else 0)
