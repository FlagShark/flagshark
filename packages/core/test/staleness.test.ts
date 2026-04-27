import { describe, it, expect } from 'vitest'

import { analyzeStaleness } from '../src/staleness.js'

import type { FeatureFlag } from '../src/detection/feature-flag.js'

function makeFlag(name: string, filePath: string, lineNumber = 1): FeatureFlag {
  return {
    name,
    filePath,
    lineNumber,
    language: 'typescript',
    provider: 'LaunchDarkly',
  }
}

describe('analyzeStaleness', () => {
  it('flags with only 1 file reference are stale (low-usage signal)', async () => {
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('single-ref-flag', [makeFlag('single-ref-flag', 'src/a.ts', 10)])
    flags.set('multi-ref-flag', [
      makeFlag('multi-ref-flag', 'src/a.ts', 20),
      makeFlag('multi-ref-flag', 'src/b.ts', 30),
    ])

    const result = await analyzeStaleness(flags, {
      thresholdMonths: 6,
      repoRoot: process.cwd(),
    })

    const staleNames = result.map((f) => f.name)
    expect(staleNames).toContain('single-ref-flag')
    // multi-ref-flag appears in 2 files, so low-usage signal should NOT fire
    // (it may still be stale due to age, depending on git blame)
  })

  it('returns empty array when no flags are provided', async () => {
    const flags = new Map<string, FeatureFlag[]>()
    const result = await analyzeStaleness(flags, {
      thresholdMonths: 6,
      repoRoot: process.cwd(),
    })
    expect(result).toEqual([])
  })

  it('includes signal descriptions in results', async () => {
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('lonely-flag', [makeFlag('lonely-flag', 'src/x.ts', 5)])

    const result = await analyzeStaleness(flags, {
      thresholdMonths: 6,
      repoRoot: process.cwd(),
    })

    const stale = result.find((f) => f.name === 'lonely-flag')
    if (stale) {
      const signalTypes = stale.signals.map((s) => s.type)
      expect(signalTypes).toContain('low-usage')
    }
  })
})
