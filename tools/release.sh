#!/usr/bin/env bash
#
#   tools/release.sh v1.2.0
#
# Ships a new version to anyone running Carbon. It does not build anything locally — it checks that what
# you have is what GitHub has, then asks CI to build a release from a clean checkout.
#
# The guards exist because of one specific trap: CI checks out the branch as GitHub has it, so an
# unpushed commit means you silently ship the PREVIOUS state with no error anywhere. Don't skip this
# script by calling `gh workflow run` directly.
#
# Afterwards, on the printer: MACHINE → check for updates → Update.
set -euo pipefail

VERSION="${1:-}"
BRANCH="${CARBON_BRANCH:-main}"

if [ -z "$VERSION" ] || [ "$VERSION" = "-h" ] || [ "$VERSION" = "--help" ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

case "$VERSION" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "version must look like v1.2.3 (got '$VERSION')" >&2; exit 1 ;;
esac

command -v gh >/dev/null 2>&1 || { echo "the GitHub CLI (gh) is required: https://cli.github.com" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

fail() { echo; echo "REFUSING: $*" >&2; exit 1; }

cur="$(git branch --show-current)"
[ "$cur" = "$BRANCH" ] || fail "you are on '$cur', not '$BRANCH'. Switch with: git switch $BRANCH"

[ -z "$(git status --porcelain)" ] || {
  git status --short | sed 's/^/    /'
  fail "the working tree has uncommitted changes. Commit them, or park them with: git stash push -u"
}

git fetch -q origin "$BRANCH"
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"
[ "$local_sha" = "$remote_sha" ] || fail "$BRANCH differs from origin/$BRANCH — CI builds what GitHub has. Run: git push"

if gh release view "$VERSION" >/dev/null 2>&1; then
  fail "release $VERSION already exists. Versions are immutable — cut $VERSION+1 instead of re-tagging."
fi

echo "Releasing $VERSION from $BRANCH @ ${local_sha:0:8}"
echo
gh workflow run release.yml --ref "$BRANCH" -f version="$VERSION"

echo "  workflow dispatched; waiting for it to appear…"
sleep 6
run_id="$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
if [ -n "${run_id:-}" ]; then
  gh run watch "$run_id" --exit-status || fail "the build failed. Nothing was released; fix and re-run."
fi

echo
gh release view "$VERSION" --json name,tagName,isPrerelease,assets \
  --jq '"  name: \(.name)\n  tag:  \(.tagName)\n  pre:  \(.isPrerelease)\n  assets: \(.assets | map(.name) | join(", "))"'
echo
echo "  Now on the printer: MACHINE → check for updates → Update"
