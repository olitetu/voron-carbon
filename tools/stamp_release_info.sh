#!/usr/bin/env bash
#
#   tools/stamp_release_info.sh v1.2.0 [dist-dir]
#
# Writes the version file Moonraker's update_manager reads to decide whether an update is available.
# Run against a built dist/ just before zipping it.
#
# Moonraker compares the GitHub release's NAME to the `version` field here. If they ever disagree the
# printer either never sees the update or offers the same one forever — so the release name, the git
# tag and this value must all be the same string. tools/release.sh enforces that; if you build a
# release by hand, you are the one enforcing it.
set -euo pipefail

VERSION="${1:?usage: stamp_release_info.sh <version> [dist-dir]}"
DIST="${2:-dist}"
REPO="${CARBON_REPO:-olitetu/voron-carbon}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

[ -d "$DIST" ] || { echo "no such directory: $DIST" >&2; exit 1; }
[ -f "$DIST/index.html" ] || { echo "$DIST/index.html missing — run npm run build first" >&2; exit 1; }

cat > "$DIST/release_info.json" <<EOF
{
  "project_name": "$NAME",
  "project_owner": "$OWNER",
  "version": "$VERSION"
}
EOF

# Some tooling looks for a bare .version; harmless to provide and costs nothing.
printf '%s' "$VERSION" > "$DIST/.version"

echo "stamped $DIST/release_info.json → $VERSION ($REPO)"
