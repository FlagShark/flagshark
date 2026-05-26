import { describe, it, expect } from 'vitest'
import { crossReference, mergePlatformSignals } from '../../src/providers/cross-reference.js'
import type { FeatureFlag } from '../../src/detection/feature-flag.js'
import type { PlatformFlag, PlatformSignal } from '../../src/providers/interface.js'
import type { PerEnvFlags } from '../../src/providers/cross-reference.js'

function flag(name: string): FeatureFlag {
  return { name, filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' }
}

function detected(names: string[]): Map<string, FeatureFlag[]> {
  return new Map(names.map((n) => [n, [flag(n)]]))
}

function platformFlag(key: string, archived = false): PlatformFlag {
  return { key, archived, lastModified: null }
}

/**
 * Helper: wrap an array of PlatformFlag (the v1 single-env shape) into the
 * new PerEnvFlags map shape, using a default env name. Existing tests
 * call this to keep their assertions identical post-refactor.
 */
function singleEnv(flags: PlatformFlag[], env = 'production'): PerEnvFlags {
  const out = new Map<string, Map<string, PlatformFlag>>()
  for (const f of flags) {
    out.set(f.key, new Map([[env, f]]))
  }
  return out
}

describe('crossReference', () => {
  it('emits missing-in-platform when flag is in code but not platform', () => {
    const result = crossReference(detected(['CHECKOUT_V2']), new Map(), 'LaunchDarkly')
    expect(result.get('CHECKOUT_V2')).toEqual([{
      type: 'missing-in-platform',
      severity: 'error',
      description: 'referenced in code but not found in LaunchDarkly',
    }])
  })

  it('emits archived-in-platform when flag exists and is archived', () => {
    const result = crossReference(detected(['OLD_FLAG']), singleEnv([platformFlag('OLD_FLAG', true)]), 'LaunchDarkly')
    expect(result.get('OLD_FLAG')).toEqual([{
      type: 'archived-in-platform',
      severity: 'warning',
      description: 'archived in LaunchDarkly',
    }])
  })

  it('emits no signal when flag exists and is active', () => {
    const result = crossReference(detected(['ACTIVE_FLAG']), singleEnv([platformFlag('ACTIVE_FLAG', false)]), 'LaunchDarkly')
    expect(result.has('ACTIVE_FLAG')).toBe(false)
  })

  it('handles multiple detected flags with mixed status', () => {
    const result = crossReference(
      detected(['A', 'B', 'C']),
      singleEnv([platformFlag('A', false), platformFlag('B', true)]),
      'LaunchDarkly',
    )
    expect(result.get('A')).toBeUndefined()
    expect(result.get('B')?.[0].type).toBe('archived-in-platform')
    expect(result.get('C')?.[0].type).toBe('missing-in-platform')
  })

  it('does not surface platform flags that have no code reference', () => {
    const result = crossReference(detected(['A']), singleEnv([platformFlag('A'), platformFlag('B')]), 'LaunchDarkly')
    expect(result.size).toBe(0)
  })

  it('uses platformDisplayName in descriptions', () => {
    const result = crossReference(detected(['X']), new Map(), 'Unleash')
    expect(result.get('X')?.[0].description).toContain('Unleash')
  })

  it('returns empty map when no detected flags', () => {
    const result = crossReference(new Map(), singleEnv([platformFlag('A')]), 'LaunchDarkly')
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
    const result = crossReference(detected(['KILL_SWITCH']), singleEnv([permanentFlag]), 'LaunchDarkly')
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
      singleEnv([archivedPermanent]),
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
    const result = crossReference(detected(['TEMP_TOGGLE']), singleEnv([active]), 'LaunchDarkly')
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
        singleEnv([oldFlag]),
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
        singleEnv([newFlag]),
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
      const result = crossReference(detected(['OLD_FLAG']), singleEnv([oldFlag]), 'LaunchDarkly')
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
        singleEnv([oldButNoCreatedAt]),
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
        singleEnv([oldPermanent]),
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
      const result = crossReference(detected(['ROLLED_OUT']), singleEnv([launched]), 'LaunchDarkly')
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
      const result = crossReference(detected(['DORMANT']), singleEnv([inactive]), 'LaunchDarkly')
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
      const result = crossReference(detected(['NORMAL']), singleEnv([active]), 'LaunchDarkly')
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
      const result = crossReference(detected(['BRAND_NEW']), singleEnv([fresh]), 'LaunchDarkly')
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
        singleEnv([both]),
        'LaunchDarkly',
        { thresholdDays: 30 },
      )
      const types = result.get('OLD_AND_LAUNCHED')?.map((s) => s.type) ?? []
      expect(types).toContain('platform-launched')
      expect(types).toContain('platform-too-old')
    })
  })

  // Tier 1.1: real evaluation data signals.
  describe('platform-zero-evaluations + platform-low-evaluations (Tier 1.1)', () => {
    it('emits platform-zero-evaluations (error) when evaluations30d is 0', () => {
      const unused: PlatformFlag = {
        key: 'UNUSED',
        archived: false,
        lastModified: null,
        evaluations30d: 0,
      }
      const result = crossReference(detected(['UNUSED']), singleEnv([unused]), 'LaunchDarkly')
      const sig = result.get('UNUSED')?.[0]
      expect(sig?.type).toBe('platform-zero-evaluations')
      expect(sig?.severity).toBe('error')
      expect(sig?.description).toContain('0 evaluations')
      expect(sig?.description).toContain('last 30 days')
    })

    it('emits platform-low-evaluations (warning) when below default threshold (10)', () => {
      const rare: PlatformFlag = {
        key: 'RARELY_USED',
        archived: false,
        lastModified: null,
        evaluations30d: 3,
      }
      const result = crossReference(detected(['RARELY_USED']), singleEnv([rare]), 'LaunchDarkly')
      const sig = result.get('RARELY_USED')?.[0]
      expect(sig?.type).toBe('platform-low-evaluations')
      expect(sig?.severity).toBe('warning')
      expect(sig?.description).toContain('only 3 evaluations')
    })

    it('uses singular "evaluation" when the count is exactly 1', () => {
      const justOne: PlatformFlag = {
        key: 'ONE',
        archived: false,
        lastModified: null,
        evaluations30d: 1,
      }
      const result = crossReference(detected(['ONE']), singleEnv([justOne]), 'LaunchDarkly')
      expect(result.get('ONE')?.[0].description).toContain('only 1 evaluation')
    })

    it('honors a custom evaluationThreshold', () => {
      const wouldPassDefault: PlatformFlag = {
        key: 'BORDERLINE',
        archived: false,
        lastModified: null,
        evaluations30d: 50, // > 10 default, < 100 custom
      }
      const result = crossReference(
        detected(['BORDERLINE']),
        singleEnv([wouldPassDefault]),
        'LaunchDarkly',
        { evaluationThreshold: 100 },
      )
      expect(result.get('BORDERLINE')?.[0].type).toBe('platform-low-evaluations')
    })

    it('emits no evaluations signal when count meets the threshold', () => {
      const healthy: PlatformFlag = {
        key: 'HEALTHY',
        archived: false,
        lastModified: null,
        evaluations30d: 5_000,
      }
      const result = crossReference(detected(['HEALTHY']), singleEnv([healthy]), 'LaunchDarkly')
      expect(result.has('HEALTHY')).toBe(false)
    })

    it('emits no evaluations signal when evaluations30d is undefined (feature unavailable)', () => {
      const noData: PlatformFlag = {
        key: 'NO_DATA',
        archived: false,
        lastModified: null,
        // evaluations30d intentionally absent
      }
      const result = crossReference(detected(['NO_DATA']), singleEnv([noData]), 'LaunchDarkly')
      expect(result.has('NO_DATA')).toBe(false)
    })

    it('emits no evaluations signal when evaluations30d is null (no window data yet)', () => {
      const noWindow: PlatformFlag = {
        key: 'NO_WINDOW',
        archived: false,
        lastModified: null,
        evaluations30d: null,
      }
      const result = crossReference(detected(['NO_WINDOW']), singleEnv([noWindow]), 'LaunchDarkly')
      expect(result.has('NO_WINDOW')).toBe(false)
    })

    it('suppresses evaluations signals on permanent flags', () => {
      const permanentButUnused: PlatformFlag = {
        key: 'KILL_SWITCH',
        archived: false,
        lastModified: null,
        permanent: true,
        evaluations30d: 0,
      }
      const result = crossReference(
        detected(['KILL_SWITCH']),
        singleEnv([permanentButUnused]),
        'LaunchDarkly',
      )
      const types = result.get('KILL_SWITCH')?.map((s) => s.type) ?? []
      expect(types).toContain('platform-permanent')
      expect(types).not.toContain('platform-zero-evaluations')
      expect(types).not.toContain('platform-low-evaluations')
    })

    it('stacks platform-zero-evaluations with platform-launched (both apply)', () => {
      // A "launched" flag that also has 0 recent evaluations is the
      // ideal cleanup candidate — both signals reinforce each other.
      const ideal: PlatformFlag = {
        key: 'CLEANUP_CANDIDATE',
        archived: false,
        lastModified: null,
        status: 'launched',
        evaluations30d: 0,
      }
      const result = crossReference(
        detected(['CLEANUP_CANDIDATE']),
        singleEnv([ideal]),
        'LaunchDarkly',
      )
      const types = result.get('CLEANUP_CANDIDATE')?.map((s) => s.type) ?? []
      expect(types).toContain('platform-launched')
      expect(types).toContain('platform-zero-evaluations')
    })
  })

  it("emits platform-launched 'in <env>' when only one env reports launched", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'active' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const signals = result.get('FOO') ?? []
    const launched = signals.find((s) => s.type === 'platform-launched')
    expect(launched).toBeDefined()
    expect(launched!.description).toContain('in production')
    expect(launched!.description).not.toContain('everywhere')
  })

  it("emits platform-launched 'everywhere' when all envs report launched", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const launched = result.get('FOO')?.find((s) => s.type === 'platform-launched')
    expect(launched!.description).toContain('everywhere')
  })

  it("emits platform-launched with comma-separated envs in config order", () => {
    // Build a perEnv map where production and test are launched, staging is
    // active. The user's configured order is [production, staging, test]
    // — the perEnv Map's insertion order is what determines render
    // order in fmtEnvs (since we have no other source of truth here, the
    // insertion order IS the config-declared order).
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'active' }],
      ['test',       { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const launched = result.get('FOO')?.find((s) => s.type === 'platform-launched')
    expect(launched!.description).toContain('in production, test')
  })

  it("emits platform-inactive 'in <env>' when one env reports inactive", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'active' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const inactive = result.get('FOO')?.find((s) => s.type === 'platform-inactive')
    expect(inactive).toBeDefined()
    expect(inactive!.description).toContain('in staging')
  })

  it("emits platform-inactive 'everywhere' when all envs are inactive", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const inactive = result.get('FOO')?.find((s) => s.type === 'platform-inactive')
    expect(inactive!.description).toContain('everywhere')
  })

  it('suppresses platform-inactive when any env reports launched', () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const signals = result.get('FOO') ?? []
    expect(signals.find((s) => s.type === 'platform-launched')).toBeDefined()
    expect(signals.find((s) => s.type === 'platform-inactive')).toBeUndefined()
  })

  it("emits platform-zero-evaluations 'in <env>' when one env reports 0 evals", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 5000 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const zero = result.get('FOO')?.find((s) => s.type === 'platform-zero-evaluations')
    expect(zero).toBeDefined()
    expect(zero!.description).toContain('in staging')
  })

  it("emits platform-zero-evaluations 'everywhere' when all envs are 0", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const zero = result.get('FOO')?.find((s) => s.type === 'platform-zero-evaluations')
    expect(zero!.description).toContain('everywhere')
  })

  it('suppresses platform-low-evaluations when any env reports zero', () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 3 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const signals = result.get('FOO') ?? []
    expect(signals.find((s) => s.type === 'platform-zero-evaluations')).toBeDefined()
    expect(signals.find((s) => s.type === 'platform-low-evaluations')).toBeUndefined()
  })

  it("emits platform-low-evaluations 'in <env>' with the lowest count", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 9 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 50 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', { evaluationThreshold: 10 })
    const low = result.get('FOO')?.find((s) => s.type === 'platform-low-evaluations')
    expect(low).toBeDefined()
    expect(low!.description).toContain('in production')
    expect(low!.description).toContain('9 evaluations')
  })

  it("emits platform-low-evaluations with 'as few as' when multiple envs are low", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 7 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 9 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', { evaluationThreshold: 10 })
    const low = result.get('FOO')?.find((s) => s.type === 'platform-low-evaluations')
    expect(low).toBeDefined()
    expect(low!.description).toContain('as few as 7')
    expect(low!.description).toContain('everywhere')
  })

  // Audit-log signal (issue #21 item 1).
  describe('platform-untouched-stale', () => {
    it('emits when lastTouched is null (audit log confirmed no activity)', () => {
      const dormant: PlatformFlag = {
        key: 'OLD_KILLSWITCH',
        archived: false,
        lastModified: null,
        lastTouched: null,
      }
      const result = crossReference(detected(['OLD_KILLSWITCH']), singleEnv([dormant]), 'LaunchDarkly')
      const sig = result.get('OLD_KILLSWITCH')?.[0]
      expect(sig?.type).toBe('platform-untouched-stale')
      expect(sig?.severity).toBe('warning')
      expect(sig?.description).toContain('no activity')
      expect(sig?.description).toContain('90+ days')
    })

    it('does NOT emit when lastTouched is a Date (flag was touched recently)', () => {
      const touched: PlatformFlag = {
        key: 'ACTIVE_FLAG',
        archived: false,
        lastModified: null,
        lastTouched: new Date(),
      }
      const result = crossReference(detected(['ACTIVE_FLAG']), singleEnv([touched]), 'LaunchDarkly')
      expect(result.has('ACTIVE_FLAG')).toBe(false)
    })

    it('does NOT emit when lastTouched is undefined (audit log unavailable)', () => {
      const unknown: PlatformFlag = {
        key: 'UNKNOWN_ACTIVITY',
        archived: false,
        lastModified: null,
        // lastTouched intentionally undefined
      }
      const result = crossReference(detected(['UNKNOWN_ACTIVITY']), singleEnv([unknown]), 'LaunchDarkly')
      expect(result.has('UNKNOWN_ACTIVITY')).toBe(false)
    })

    it('STILL fires on permanent flags (unlike most signals)', () => {
      // Audit-log untouched is the one signal that's MORE useful on
      // permanent flags. A kill switch untouched for 3 years is worth
      // reviewing even though the user explicitly opted into permanence.
      const oldPermanent: PlatformFlag = {
        key: 'OLD_PERMANENT',
        archived: false,
        lastModified: null,
        permanent: true,
        lastTouched: null,
      }
      const result = crossReference(detected(['OLD_PERMANENT']), singleEnv([oldPermanent]), 'LaunchDarkly')
      const types = result.get('OLD_PERMANENT')?.map((s) => s.type) ?? []
      // Both signals fire: platform-permanent (control) and untouched-stale.
      expect(types).toContain('platform-permanent')
      expect(types).toContain('platform-untouched-stale')
    })

    it('stacks with platform-zero-evaluations (both apply)', () => {
      // The ideal cleanup candidate: not touched AND not evaluated.
      // Both signals should fire to reinforce confidence.
      const idealCandidate: PlatformFlag = {
        key: 'DOUBLE_DEAD',
        archived: false,
        lastModified: null,
        evaluations30d: 0,
        lastTouched: null,
      }
      const result = crossReference(detected(['DOUBLE_DEAD']), singleEnv([idealCandidate]), 'LaunchDarkly')
      const types = result.get('DOUBLE_DEAD')?.map((s) => s.type) ?? []
      expect(types).toContain('platform-zero-evaluations')
      expect(types).toContain('platform-untouched-stale')
    })

    it('emits platform-untouched-stale when ALL envs have lastTouched=null', () => {
      const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
        ['production', { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
        ['staging',    { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
      ])]])
      const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
      const untouched = result.get('FOO')?.find((s) => s.type === 'platform-untouched-stale')
      expect(untouched).toBeDefined()
      expect(untouched!.description).toContain('everywhere')
    })

    it('does NOT emit platform-untouched-stale when ANY env has activity', () => {
      const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
        ['production', { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
        ['staging',    { key: 'FOO', archived: false, lastModified: null, lastTouched: new Date('2026-05-20') }],
      ])]])
      const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
      expect(result.get('FOO')?.find((s) => s.type === 'platform-untouched-stale')).toBeUndefined()
    })

    it('does NOT emit platform-untouched-stale when ANY env audit-log is unavailable', () => {
      // Mixing null (confirmed untouched) and undefined (couldn't fetch) =>
      // we can't claim "untouched in all envs" because one env's audit log
      // is unknown. Strict rule.
      const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
        ['production', { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
        ['staging',    { key: 'FOO', archived: false, lastModified: null /* lastTouched undefined */ }],
      ])]])
      const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
      expect(result.get('FOO')?.find((s) => s.type === 'platform-untouched-stale')).toBeUndefined()
    })
  })

  it('does NOT emit missing-in-platform when flag is present in at least one env', () => {
    // Flag is missing from staging but present in production — should
    // NOT be reported as missing.
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null }],
      // 'staging' intentionally not in the inner Map
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'missing-in-platform')).toBeUndefined()
  })

  it('emits missing-in-platform when flag is absent from every env', () => {
    const result = crossReference(detected(['FOO']), new Map(), 'LaunchDarkly', {})
    expect(result.get('FOO')?.[0].type).toBe('missing-in-platform')
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
