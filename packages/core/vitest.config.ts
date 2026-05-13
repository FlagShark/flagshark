import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 75,
        branches: 75,
        functions: 65, // actual ~68%; raised to 100 in Phase 2 once detectors are covered
        statements: 75,
      },
    },
  },
})
