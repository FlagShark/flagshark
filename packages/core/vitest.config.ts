import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Live-LD integration tests live in *.live.test.ts files. They hit a
    // real LaunchDarkly trial account via LIVE_LAUNCHDARKLY_API_TOKEN and
    // are deliberately excluded from the default test run (cost, secret
    // management). The dedicated `test:live` script and the live-ld
    // validation GitHub workflow both override this include to pick
    // those files up explicitly.
    exclude: ['test/**/*.live.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // feature-flag.ts is a pure type-only module with no runtime statements;
      // excluding it keeps the threshold math clean.
      exclude: ['src/detection/feature-flag.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
