import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { collectFiles } from '../src/scanner.js'
import { buildExcluder } from '../src/config/excluder.js'
import { buildDefaultConfig } from '../src/config/defaults.js'

describe('collectFiles with excluder', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'flagshark-scanner-ex-'))
    execFileSync('git', ['init', '-q'], { cwd: workDir })
    mkdirSync(join(workDir, 'src'))
    mkdirSync(join(workDir, 'examples'))
    writeFileSync(join(workDir, 'src', 'app.ts'), 'export const x = 1\n')
    writeFileSync(join(workDir, 'src', 'app.test.ts'), 'export const t = 1\n')
    writeFileSync(join(workDir, 'examples', 'demo.ts'), 'export const d = 1\n')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('excludes files matching excluder when one is supplied', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    cfg.excludes.presets = ['test-files']
    const excluder = buildExcluder({ config: cfg, ignoreFilePatterns: [] })

    const { files, excludedCount } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
      excluder,
    })

    const paths = [...files.keys()].sort()
    expect(paths).toEqual([join(workDir, 'src', 'app.ts')])
    expect(excludedCount).toBe(2)  // app.test.ts + demo.ts
  })

  it('returns excludedCount: 0 when no excluder is provided', () => {
    const { files, excludedCount } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
    })

    expect(files.size).toBe(3)
    expect(excludedCount).toBe(0)
  })

  it('collects excluded paths when collectExcludedPaths is set', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const excluder = buildExcluder({ config: cfg, ignoreFilePatterns: [] })

    const { files, excludedCount, excludedPaths } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
      excluder,
      collectExcludedPaths: true,
    })

    expect(excludedCount).toBe(1)
    expect(excludedPaths).toEqual(['examples/demo.ts'])
  })

  it('does not collect excluded paths by default', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const excluder = buildExcluder({ config: cfg, ignoreFilePatterns: [] })

    const { excludedPaths } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
      excluder,
    })

    expect(excludedPaths).toBeUndefined()
  })

  it('honors excluder in --diff mode (regression: repo-relative paths)', () => {
    // Commit initial files, then modify both to appear in git diff HEAD
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir })
    execFileSync('git', ['add', '.'], { cwd: workDir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: workDir })
    writeFileSync(join(workDir, 'src', 'app.ts'), 'export const x = 2\n')
    writeFileSync(join(workDir, 'examples', 'demo.ts'), 'export const d = 2\n')

    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const excluder = buildExcluder({ config: cfg, ignoreFilePatterns: [] })

    const { files, excludedCount } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
      excluder,
      diffRef: 'HEAD',
    })

    // examples/demo.ts should be excluded; src/app.ts should remain.
    const paths = [...files.keys()].sort()
    expect(paths.some(p => p.endsWith('examples/demo.ts'))).toBe(false)
    expect(paths.some(p => p.endsWith('src/app.ts'))).toBe(true)
    expect(excludedCount).toBe(1)
  })
})
