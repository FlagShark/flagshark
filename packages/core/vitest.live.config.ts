/**
 * Separate vitest config for the live LaunchDarkly integration tests.
 *
 * The default config (vitest.config.ts) deliberately EXCLUDES *.live.test.ts
 * so the standard CI run never hits a real LD account. This config only
 * picks those tests up — invoke via `bun run test:live`.
 *
 * Required env vars:
 *   LIVE_LAUNCHDARKLY_API_TOKEN  API access token with Reader role for
 *                                LIVE_LD_PROJECT. The test gracefully
 *                                skips when this is unset.
 *   LIVE_LD_PROJECT              Project key (defaults to "default").
 *   LIVE_LD_ENVIRONMENT          Environment key (defaults to "test").
 *
 * No coverage threshold — these tests exercise paths already at 100% in
 * the default run; the value here is end-to-end contract verification
 * against LD's actual API, not coverage delta.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.live.test.ts'],
    // Live LD calls are network-bound; give individual tests a wider
    // timeout than the unit default (5s).
    testTimeout: 30_000,
  },
})
