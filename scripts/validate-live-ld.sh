#!/usr/bin/env bash
# Pre-release live LaunchDarkly validation — runs the same contract
# tests the GitHub Actions workflow runs, against a real LD project.
#
# Use this before each release to catch LD API drift locally before it
# trips the post-release workflow.
#
# Usage:
#   LIVE_LAUNCHDARKLY_API_TOKEN=api-... ./scripts/validate-live-ld.sh
#
# Optional:
#   LIVE_LD_PROJECT      (default "default")
#   LIVE_LD_ENVIRONMENT  (default "test")

set -euo pipefail

if [[ -z "${LIVE_LAUNCHDARKLY_API_TOKEN:-}" ]]; then
  echo "ERROR: LIVE_LAUNCHDARKLY_API_TOKEN must be set." >&2
  echo "" >&2
  echo "Provision a Reader-role service token at:" >&2
  echo "  Account settings → Authorization → Access tokens → Create" >&2
  echo "" >&2
  echo "Then re-run:" >&2
  echo "  LIVE_LAUNCHDARKLY_API_TOKEN=api-... $0" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/core"

echo "→ Running live LD validation against:"
echo "    project=${LIVE_LD_PROJECT:-default}"
echo "    environment=${LIVE_LD_ENVIRONMENT:-test}"
echo ""

bun run test:live
