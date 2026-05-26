#!/usr/bin/env bash
# Bump the version of all three FlagShark packages in lockstep.
#
# Usage:
#   ./scripts/bump-version.sh 2.3.0
#
# What it does:
#   1. Updates `version` in packages/{core,cli,action}/package.json
#   2. Re-runs `bun install` to sync bun.lock to the new versions (the
#      release.yml's `bun install` step uses --frozen-lockfile, so a
#      stale lockfile fails CI; this avoids the lockfile-sync foot-gun
#      we hit earlier on PR #25)
#   3. Verifies all three packages now report the requested version
#
# What it does NOT do:
#   - git commit / git tag / gh release: kept manual so you can review
#     the bumped state before tagging. Standard followup is:
#       git add packages/*/package.json bun.lock
#       git commit -m "chore(release): bump to vX.Y.Z"
#       git push
#       git tag vX.Y.Z -a -m "Release vX.Y.Z"
#       git push origin vX.Y.Z
#       gh release create vX.Y.Z --notes-file <notes>.md

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>" >&2
  echo "Example: $0 2.3.0" >&2
  exit 2
fi

NEW_VERSION="$1"

# Strict semver validation. Reject "v2.3.0" (leading v), "2.3" (missing
# patch), "2.3.0.dev" (extra segments), etc. Pre-release tags like
# "2.3.0-rc.1" are allowed.
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: '$NEW_VERSION' is not a valid semver (e.g. 2.3.0 or 2.3.0-rc.1)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Read the current version from core (the source of truth) so we can
# print a clear before→after diff.
CURRENT_VERSION="$(node -p "require('./packages/core/package.json').version")"

if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
  echo "ERROR: already at $NEW_VERSION — nothing to bump" >&2
  exit 2
fi

echo "→ Bumping $CURRENT_VERSION → $NEW_VERSION"

# Use Python to rewrite the JSON in place — preserves field order and
# formatting (jq reformats, sed risks matching the wrong line).
for pkg in packages/core packages/cli packages/action; do
  python3 - "$pkg/package.json" "$NEW_VERSION" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path, 'r') as f:
    text = f.read()
# Targeted replace: only the top-level "version" field, not any
# nested version-looking strings (e.g. inside scripts.build).
import re
new_text, count = re.subn(
    r'("version"\s*:\s*)"[^"]+"',
    f'\\1"{version}"',
    text,
    count=1,
)
if count != 1:
    raise SystemExit(f'expected to replace exactly 1 occurrence in {path}, got {count}')
with open(path, 'w') as f:
    f.write(new_text)
print(f'  ✓ {path}')
PY
done

echo "→ Syncing bun.lock"
bun install >/dev/null
echo "  ✓ bun install"

echo "→ Verifying"
for pkg in packages/core packages/cli packages/action; do
  v="$(node -p "require('./$pkg/package.json').version")"
  if [[ "$v" != "$NEW_VERSION" ]]; then
    echo "  ✗ $pkg/package.json reports $v (expected $NEW_VERSION)" >&2
    exit 1
  fi
done
echo "  ✓ all three packages report $NEW_VERSION"

echo ""
echo "Done. Next steps (verbatim):"
echo "  git add packages/core/package.json packages/cli/package.json packages/action/package.json bun.lock"
echo "  git commit -m \"chore(release): bump to v$NEW_VERSION\""
echo "  git push"
echo "  git tag v$NEW_VERSION -a -m \"Release v$NEW_VERSION\""
echo "  git push origin v$NEW_VERSION"
echo "  gh release create v$NEW_VERSION --notes-file <your-notes>.md"
