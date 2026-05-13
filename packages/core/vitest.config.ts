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
      exclude: ['src/detection/detectors/*.ts', 'src/detection/index.ts'],
      thresholds: {
        lines: 75,
        branches: 75,
        functions: 65,
        statements: 75,
      },
    },
  },
})
