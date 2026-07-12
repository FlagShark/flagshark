#!/usr/bin/env bash
# Bump the version of all four FlagShark packages in lockstep.
#
# Usage:
#   ./scripts/bump-version.sh 2.3.0
#
# What it does:
#   1. Updates `version` in packages/{core,assessment-client,cli,action}/package.json
#   2. Re-runs `bun install` to sync bun.lock to the new versions (the
#      CI workflow uses --frozen-lockfile, so a stale lockfile fails
#      before release; this avoids the lockfile-sync foot-gun we hit
#      earlier on PR #25)
#   3. Rebuilds the committed GitHub Action bundles with that version
#   4. Verifies all four packages now report the requested version
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
for pkg in packages/core packages/assessment-client packages/cli packages/action; do
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
# `bun install` against an existing lockfile treats a workspace package.json
# version change as "no structural change" and leaves the lockfile's
# workspaces section (which stores each workspace's resolved version)
# pointing at the OLD version. `bun pm pack` then reads that stale stored
# version when rewriting `workspace:*`, so the published tarball ends up
# depending on the previous release's core (e.g. flagshark@2.3.1 shipped
# depending on @flagshark/core@2.2.1 — see issue #36 follow-up).
#
# Delete the lockfile and regenerate from scratch so the workspaces
# section is rebuilt from the current package.json files. Slightly slower
# but the only reliable way to keep packed artifacts honest.
rm -f bun.lock
bun install >/dev/null
echo "  ✓ bun install (fresh lockfile)"

echo "→ Rebuilding committed Action bundles"
# The subdirectory Action embeds @flagshark/action's version at build time.
# Rebuild before tagging so the tag executes the versioned source that was
# reviewed, rather than whatever bundle happened to be committed previously.
bun run build >/dev/null
echo "  ✓ packages/action/dist/action.cjs"
echo "  ✓ assess/dist/index.cjs"

echo "→ Verifying"
for pkg in packages/core packages/assessment-client packages/cli packages/action; do
  v="$(node -p "require('./$pkg/package.json').version")"
  if [[ "$v" != "$NEW_VERSION" ]]; then
    echo "  ✗ $pkg/package.json reports $v (expected $NEW_VERSION)" >&2
    exit 1
  fi
done
echo "  ✓ all four packages report $NEW_VERSION"

# Defense in depth: verify bun.lock's workspaces section now reflects the
# new version. The lockfile is checked into the repo, so a stale entry
# here would re-introduce the publish bug on the next release.
if ! grep -A2 '"name": "@flagshark/core"' bun.lock | grep -q "\"version\": \"$NEW_VERSION\""; then
  echo "  ✗ bun.lock workspaces section did not pick up @flagshark/core@$NEW_VERSION" >&2
  echo "    bun.lock workspace metadata is stale; publish would ship wrong core dep" >&2
  exit 1
fi
echo "  ✓ bun.lock workspaces[@flagshark/core] reports $NEW_VERSION"

if ! grep -A2 '"name": "@flagshark/assessment-client"' bun.lock | grep -q "\"version\": \"$NEW_VERSION\""; then
  echo "  ✗ bun.lock workspaces section did not pick up @flagshark/assessment-client@$NEW_VERSION" >&2
  echo "    bun.lock workspace metadata is stale; committed bundles would have ambiguous provenance" >&2
  exit 1
fi
echo "  ✓ bun.lock workspaces[@flagshark/assessment-client] reports $NEW_VERSION"

echo ""
echo "Done. Next steps (verbatim):"
echo "  git add CHANGELOG.md packages/core/package.json packages/assessment-client/package.json packages/cli/package.json packages/action/package.json packages/action/dist assess/dist bun.lock"
echo "  git commit -m \"chore(release): bump to v$NEW_VERSION\""
echo "  git push"
echo "  git tag v$NEW_VERSION -a -m \"Release v$NEW_VERSION\""
echo "  git push origin v$NEW_VERSION"
echo "  gh release create v$NEW_VERSION --notes-file <your-notes>.md"
