import { describe, it, expect } from 'vitest'
import { crossReference, mergePlatformSignals } from '../../src/providers/cross-reference.js'
import type { FeatureFlag } from '../../src/detection/feature-flag.js'
import type { PlatformFlag, PlatformSignal } from '../../src/providers/interface.js'

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

  // LD's `temporary: false` → PlatformFlag.permanent: true means the user
  // intentionally wants the flag to stick around (kill-switch, operational
  // config). Cross-reference emits a `platform-permanent` CONTROL signal
  // so the staleness engine can suppress age + low-usage signals. The
  // marker is filtered out before reaching user-facing output.
  it('emits platform-permanent for an active flag the platform marked permanent', () => {
    const permanentFlag: PlatformFlag = {
      key: 'KILL_SWITCH',
      archived: false,
      lastModified: null,
      permanent: true,
    }
    const result = crossReference(detected(['KILL_SWITCH']), [permanentFlag], 'LaunchDarkly')
    expect(result.get('KILL_SWITCH')).toEqual([
      {
        type: 'platform-permanent',
        severity: 'info',
        description: 'marked permanent in LaunchDarkly',
      },
    ])
  })

  it('prioritises archived-in-platform over platform-permanent (archive wins)', () => {
    // If a permanent flag has been archived, the archive signal should
    // win — the user explicitly archived it despite the permanent marker,
    // so they want it out.
    const archivedPermanent: PlatformFlag = {
      key: 'OLD_KILL_SWITCH',
      archived: true,
      lastModified: null,
      permanent: true,
    }
    const result = crossReference(
      detected(['OLD_KILL_SWITCH']),
      [archivedPermanent],
      'LaunchDarkly',
    )
    expect(result.get('OLD_KILL_SWITCH')?.[0].type).toBe('archived-in-platform')
  })

  it('does not emit platform-permanent for an active non-permanent flag', () => {
    const active: PlatformFlag = {
      key: 'TEMP_TOGGLE',
      archived: false,
      lastModified: null,
      permanent: false,
    }
    const result = crossReference(detected(['TEMP_TOGGLE']), [active], 'LaunchDarkly')
    expect(result.has('TEMP_TOGGLE')).toBe(false)
  })

  // P1: platform-too-old. Emitted when the platform reports a
  // creationDate older than the staleness threshold. Independent of
  // code age — a recently-pasted reference to an old flag is just as
  // suspect as an old reference.
  describe('platform-too-old (P1)', () => {
    it('emits platform-too-old when createdAt is older than thresholdDays', () => {
      const oldFlag: PlatformFlag = {
        key: 'OLD_FLAG',
        archived: false,
        lastModified: null,
        permanent: false,
        createdAt: new Date(Date.now() - 60 * 86_400_000), // 60 days ago
      }
      const result = crossReference(
        detected(['OLD_FLAG']),
        [oldFlag],
        'LaunchDarkly',
        { thresholdDays: 30 },
      )
      const sigs = result.get('OLD_FLAG') ?? []
      const tooOld = sigs.find((s) => s.type === 'platform-too-old')
      expect(tooOld).toBeDefined()
      expect(tooOld?.severity).toBe('warning')
      expect(tooOld?.description).toContain('60 days ago')
      expect(tooOld?.description).toContain('30-day threshold')
    })

    it('does not emit platform-too-old when createdAt is within threshold', () => {
      const newFlag: PlatformFlag = {
        key: 'NEW_FLAG',
        archived: false,
        lastModified: null,
        permanent: false,
        createdAt: new Date(Date.now() - 5 * 86_400_000), // 5 days ago
      }
      const result = crossReference(
        detected(['NEW_FLAG']),
        [newFlag],
        'LaunchDarkly',
        { thresholdDays: 30 },
      )
      expect(result.has('NEW_FLAG')).toBe(false)
    })

    it('does not emit platform-too-old when thresholdDays is unset', () => {
      const oldFlag: PlatformFlag = {
        key: 'OLD_FLAG',
        archived: false,
        lastModified: null,
        permanent: false,
        createdAt: new Date(Date.now() - 365 * 86_400_000),
      }
      const result = crossReference(detected(['OLD_FLAG']), [oldFlag], 'LaunchDarkly')
      // No threshold → no platform-too-old signal, no entry at all.
      expect(result.has('OLD_FLAG')).toBe(false)
    })

    it('does not emit platform-too-old when createdAt is missing', () => {
      const oldButNoCreatedAt: PlatformFlag = {
        key: 'NO_CREATED',
        archived: false,
        lastModified: null,
        permanent: false,
      }
      const result = crossReference(
        detected(['NO_CREATED']),
        [oldButNoCreatedAt],
        'LaunchDarkly',
        { thresholdDays: 30 },
      )
      expect(result.has('NO_CREATED')).toBe(false)
    })

    it('does not emit platform-too-old on a permanent flag (suppressed)', () => {
      const oldPermanent: PlatformFlag = {
        key: 'OLD_KILL_SWITCH',
        archived: false,
        lastModified: null,
        permanent: true,
        createdAt: new Date(Date.now() - 365 * 86_400_000),
      }
      const result = crossReference(
        detected(['OLD_KILL_SWITCH']),
        [oldPermanent],
        'LaunchDarkly',
        { thresholdDays: 30 },
      )
      const sigs = result.get('OLD_KILL_SWITCH') ?? []
      const types = sigs.map((s) => s.type)
      // Permanent marker is still emitted; too-old is NOT.
      expect(types).toContain('platform-permanent')
      expect(types).not.toContain('platform-too-old')
    })
  })

  // P2: platform-inactive + platform-launched. Sourced from LD's
  // flag-statuses endpoint, which encodes the platform's own
  // staleness verdict per environment.
  describe('platform-inactive + platform-launched (P2)', () => {
    it('emits platform-launched (error) when status is "launched"', () => {
      const launched: PlatformFlag = {
        key: 'ROLLED_OUT',
        archived: false,
        lastModified: null,
        status: 'launched',
      }
      const result = crossReference(detected(['ROLLED_OUT']), [launched], 'LaunchDarkly')
      const sig = result.get('ROLLED_OUT')?.[0]
      expect(sig?.type).toBe('platform-launched')
      expect(sig?.severity).toBe('error')
      expect(sig?.description).toContain('one variation for 7+ days')
    })

    it('emits platform-inactive (warning) when status is "inactive"', () => {
      const inactive: PlatformFlag = {
        key: 'DORMANT',
        archived: false,
        lastModified: null,
        status: 'inactive',
      }
      const result = crossReference(detected(['DORMANT']), [inactive], 'LaunchDarkly')
      const sig = result.get('DORMANT')?.[0]
      expect(sig?.type).toBe('platform-inactive')
      expect(sig?.severity).toBe('warning')
      expect(sig?.description).toContain('no evaluations recorded')
    })

    it('does not emit a status signal when status is "active"', () => {
      const active: PlatformFlag = {
        key: 'NORMAL',
        archived: false,
        lastModified: null,
        status: 'active',
      }
      const result = crossReference(detected(['NORMAL']), [active], 'LaunchDarkly')
      expect(result.has('NORMAL')).toBe(false)
    })

    it('does not emit a status signal when status is "new"', () => {
      // 'new' means LD doesn't have enough data yet — emitting a stale
      // signal would be a false positive.
      const fresh: PlatformFlag = {
        key: 'BRAND_NEW',
        archived: false,
        lastModified: null,
        status: 'new',
      }
      const result = crossReference(detected(['BRAND_NEW']), [fresh], 'LaunchDarkly')
      expect(result.has('BRAND_NEW')).toBe(false)
    })

    it('stacks platform-launched with platform-too-old (both apply)', () => {
      const both: PlatformFlag = {
        key: 'OLD_AND_LAUNCHED',
        archived: false,
        lastModified: null,
        permanent: false,
        status: 'launched',
        createdAt: new Date(Date.now() - 60 * 86_400_000),
      }
      const result = crossReference(
        detected(['OLD_AND_LAUNCHED']),
        [both],
        'LaunchDarkly',
        { thresholdDays: 30 },
      )
      const types = result.get('OLD_AND_LAUNCHED')?.map((s) => s.type) ?? []
      expect(types).toContain('platform-launched')
      expect(types).toContain('platform-too-old')
    })
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
    const srcArr: PlatformSignal[] = [{ type: 'missing-in-platform', severity: 'error', description: 'x' }]
    const src = new Map([['A', srcArr]])
    mergePlatformSignals(into, src)
    srcArr.push({ type: 'archived-in-platform', severity: 'warning', description: 'y' })
    expect(into.get('A')?.length).toBe(1)
  })
})
