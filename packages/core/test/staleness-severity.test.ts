import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { analyzeStaleness } from '../src/staleness.js'
import { makeTempRepo, writeFixtureFile, commitAll } from './fixtures/repo-builder.js'
import type { FeatureFlag } from '../src/detection/feature-flag.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function detectedMap(flags: FeatureFlag[]): Map<string, FeatureFlag[]> {
  const m = new Map<string, FeatureFlag[]>()
  for (const f of flags) {
    const arr = m.get(f.name) ?? []
    arr.push(f)
    m.set(f.name, arr)
  }
  return m
}

describe('analyzeStaleness — severity on existing signals', () => {
  it('age signal has severity warning', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'OLD_FLAG'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'OLD_FLAG'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const flags: FeatureFlag[] = [
      { name: 'OLD_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'OLD_FLAG', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), { thresholdMonths: 6, repoRoot: dir })
    const stale = result.find((s) => s.name === 'OLD_FLAG')
    const ageSignal = stale?.signals.find((s) => s.type === 'age')
    expect(ageSignal?.severity).toBe('warning')
  })

  it('low-usage signal has severity warning', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'SOLO_FLAG'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'SOLO_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), { thresholdMonths: 6, repoRoot: dir })
    const stale = result.find((s) => s.name === 'SOLO_FLAG')
    const lowUsage = stale?.signals.find((s) => s.type === 'low-usage')
    expect(lowUsage?.severity).toBe('warning')
  })
})

describe('analyzeStaleness — platform signals', () => {
  it('platform signal alone is enough to mark flag stale', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'PRESENT'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'PRESENT'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'PRESENT', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'PRESENT', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['PRESENT', [{
      type: 'missing-in-platform' as const,
      severity: 'error' as const,
      description: 'not in LD',
    }]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdMonths: 6, repoRoot: dir, platformSignals },
    )
    const stale = result.find((s) => s.name === 'PRESENT')
    expect(stale).toBeDefined()
    expect(stale?.signals[0].type).toBe('missing-in-platform')
    expect(stale?.signals[0].severity).toBe('error')
  })

  it('platform signal stacks with age signal', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'OLD_AND_ARCHIVED'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'OLD_AND_ARCHIVED'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const flags: FeatureFlag[] = [
      { name: 'OLD_AND_ARCHIVED', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'OLD_AND_ARCHIVED', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['OLD_AND_ARCHIVED', [{
      type: 'archived-in-platform' as const,
      severity: 'warning' as const,
      description: 'archived in LD',
    }]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdMonths: 6, repoRoot: dir, platformSignals },
    )
    const stale = result.find((s) => s.name === 'OLD_AND_ARCHIVED')
    const types = stale?.signals.map((s) => s.type) ?? []
    expect(types).toContain('age')
    expect(types).toContain('archived-in-platform')
  })

  it('does not affect flags without platform signals', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'FRESH'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'FRESH'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'FRESH', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'FRESH', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdMonths: 6, repoRoot: dir, platformSignals: new Map() },
    )
    expect(result.find((s) => s.name === 'FRESH')).toBeUndefined()
  })
})
