import { describe, it, expect } from 'vitest'
import { crossReference, mergePlatformSignals } from '../../src/providers/cross-reference.js'
import type { FeatureFlag } from '../../src/detection/feature-flag.js'
import type { PlatformFlag } from '../../src/providers/interface.js'

function flag(name: string): FeatureFlag {
  return { name, filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' }
}

function detected(names: string[]): Map<string, FeatureFlag[]> {
  return new Map(names.map((n) => [n, [flag(n)]]))
}

function platformFlag(key: string, archived = false): PlatformFlag {
  return { key, archived, lastModified: null }
}

describe('crossReference', () => {
  it('emits missing-in-platform when flag is in code but not platform', () => {
    const result = crossReference(detected(['CHECKOUT_V2']), [], 'LaunchDarkly')
    expect(result.get('CHECKOUT_V2')).toEqual([{
      type: 'missing-in-platform',
      severity: 'error',
      description: 'referenced in code but not found in LaunchDarkly',
    }])
  })

  it('emits archived-in-platform when flag exists and is archived', () => {
    const result = crossReference(detected(['OLD_FLAG']), [platformFlag('OLD_FLAG', true)], 'LaunchDarkly')
    expect(result.get('OLD_FLAG')).toEqual([{
      type: 'archived-in-platform',
      severity: 'warning',
      description: 'archived in LaunchDarkly',
    }])
  })

  it('emits no signal when flag exists and is active', () => {
    const result = crossReference(detected(['ACTIVE_FLAG']), [platformFlag('ACTIVE_FLAG', false)], 'LaunchDarkly')
    expect(result.has('ACTIVE_FLAG')).toBe(false)
  })

  it('handles multiple detected flags with mixed status', () => {
    const result = crossReference(
      detected(['A', 'B', 'C']),
      [platformFlag('A', false), platformFlag('B', true)],
      'LaunchDarkly',
    )
    expect(result.get('A')).toBeUndefined()
    expect(result.get('B')?.[0].type).toBe('archived-in-platform')
    expect(result.get('C')?.[0].type).toBe('missing-in-platform')
  })

  it('does not surface platform flags that have no code reference', () => {
    const result = crossReference(detected(['A']), [platformFlag('A'), platformFlag('B')], 'LaunchDarkly')
    expect(result.size).toBe(0)
  })

  it('uses platformDisplayName in descriptions', () => {
    const result = crossReference(detected(['X']), [], 'Unleash')
    expect(result.get('X')?.[0].description).toContain('Unleash')
  })

  it('returns empty map when no detected flags', () => {
    const result = crossReference(new Map(), [platformFlag('A')], 'LaunchDarkly')
    expect(result.size).toBe(0)
  })
})

describe('mergePlatformSignals', () => {
  it('adds new keys', () => {
    const into = new Map()
    const src = new Map([['A', [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'x' }]]])
    mergePlatformSignals(into, src)
    expect(into.get('A')?.length).toBe(1)
  })

  it('appends to existing keys', () => {
    const into = new Map([['A', [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'from-ld' }]]])
    const src = new Map([['A', [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'from-unleash' }]]])
    mergePlatformSignals(into, src)
    expect(into.get('A')?.length).toBe(2)
  })

  it('clones to avoid shared-array mutation', () => {
    const into = new Map()
    const srcArr = [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'x' }]
    const src = new Map([['A', srcArr]])
    mergePlatformSignals(into, src)
    srcArr.push({ type: 'archived-in-platform', severity: 'warning', description: 'y' })
    expect(into.get('A')?.length).toBe(1)
  })
})
