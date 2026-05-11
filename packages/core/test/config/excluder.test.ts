import { describe, it, expect } from 'vitest'

import { buildExcluder } from '../../src/config/excluder.js'
import { buildDefaultConfig } from '../../src/config/defaults.js'

describe('buildExcluder', () => {
  it('excludes nothing for an empty config', () => {
    const ex = buildExcluder({ config: buildDefaultConfig(), ignoreFilePatterns: [] })
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
    expect(ex.shouldExclude('examples/demo.ts')).toBe(false)
  })

  it('applies excludes.paths', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    expect(ex.shouldExclude('examples/demo.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('applies excludes.files', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.files = ['**/*.test.ts']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    expect(ex.shouldExclude('src/app.test.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('applies excludes.presets', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.presets = ['test-files']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    expect(ex.shouldExclude('src/app.test.ts')).toBe(true)
    expect(ex.shouldExclude('foo_test.go')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('applies .flagsharkignore patterns', () => {
    const ex = buildExcluder({
      config: buildDefaultConfig(),
      ignoreFilePatterns: ['examples/', '**/*.test.ts'],
    })
    expect(ex.shouldExclude('examples/demo.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.test.ts')).toBe(true)
  })

  it('honors !-negation from .flagsharkignore', () => {
    const ex = buildExcluder({
      config: buildDefaultConfig(),
      ignoreFilePatterns: ['examples/', '!examples/important.ts'],
    })
    expect(ex.shouldExclude('examples/demo.ts')).toBe(true)
    expect(ex.shouldExclude('examples/important.ts')).toBe(false)
  })

  it('unions config and .flagsharkignore (either excludes → excluded)', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['src/legacy/**']
    const ex = buildExcluder({
      config: cfg,
      ignoreFilePatterns: ['examples/'],
    })
    expect(ex.shouldExclude('src/legacy/x.ts')).toBe(true)
    expect(ex.shouldExclude('examples/x.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('exposes effectiveRules for verbose output', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    cfg.excludes.presets = ['snapshots']
    const ex = buildExcluder({
      config: cfg,
      ignoreFilePatterns: ['legacy/'],
    })
    expect(ex.effectiveRules).toEqual({
      paths: ['examples/**'],
      files: [],
      presets: ['snapshots'],
      presetPatterns: ['**/*.snap', '**/__snapshots__/**'],
      ignoreFile: ['legacy/'],
    })
  })

  it('treats absolute and repo-relative paths consistently', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    // The excluder normalises input — relative paths only.
    expect(ex.shouldExclude('examples/x.ts')).toBe(true)
    expect(ex.shouldExclude('./examples/x.ts')).toBe(true)
  })
})
