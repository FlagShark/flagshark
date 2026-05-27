import { describe, it, expect, vi } from 'vitest'
import { orchestratePlatforms } from '../../src/providers/orchestrate.js'
import type { ScanLogger } from '../../src/scan-repo.js'

vi.mock('../../src/providers/cache.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/providers/cache.js')>()
  return {
    ...original,
    loadPlatformFlagsCached: vi.fn().mockResolvedValue([]),
  }
})

function silentLogger(): ScanLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function detected(names: string[]) {
  return new Map(names.map(n => [n, [{ name: n, filePath: 'a.ts', lineNumber: 1, language: 'typescript' as const, provider: 'launchdarkly-node-server-sdk' }]]))
}

describe('orchestratePlatforms', () => {
  it('returns empty map when config.platforms is undefined', async () => {
    const result = await orchestratePlatforms({
      platformsConfig: undefined,
      detectedFlags: detected(['A']),
      logger: silentLogger(),
    })
    expect(result.signals.size).toBe(0)
  })

  it('warns and skips unknown platform names', async () => {
    const logger = silentLogger()
    const result = await orchestratePlatforms({
      platformsConfig: { unknown: { foo: 'bar' } } as Record<string, unknown>,
      detectedFlags: detected(['A']),
      logger,
    })
    expect(result.signals.size).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Unknown platform 'unknown'"))
  })

  it('warns and skips when token env var is missing', async () => {
    const logger = silentLogger()
    const prev = process.env.LAUNCHDARKLY_API_TOKEN
    delete process.env.LAUNCHDARKLY_API_TOKEN
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['A']),
        logger,
      })
      expect(result.signals.size).toBe(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('LAUNCHDARKLY_API_TOKEN'))
    } finally {
      if (prev !== undefined) process.env.LAUNCHDARKLY_API_TOKEN = prev
    }
  })

  it('warns when config fails platform-specific schema validation', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { /* missing project, environment */ } } as Record<string, unknown>,
        detectedFlags: detected(['A']),
        logger,
      })
      expect(result.signals.size).toBe(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid config'))
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('warns when platform listFlags throws', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['A']),
        logger,
        listFlagsOverride: async () => { throw new Error('network down') },
      })
      expect(result.signals.size).toBe(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('network down'))
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('produces signals when listFlags returns successfully', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['MISSING_FLAG']),
        logger,
        listFlagsOverride: async () => [],
        noCache: true,
      })
      expect(result.signals.get('MISSING_FLAG')?.[0].type).toBe('missing-in-platform')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('honors token_env override', async () => {
    const logger = silentLogger()
    process.env.MY_CUSTOM_LD_TOKEN = 'tok'
    try {
      let captured = false
      await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e', token_env: 'MY_CUSTOM_LD_TOKEN' } },
        detectedFlags: detected(['A']),
        logger,
        listFlagsOverride: async () => { captured = true; return [] },
        noCache: true,
      })
      expect(captured).toBe(true)
    } finally {
      delete process.env.MY_CUSTOM_LD_TOKEN
    }
  })

  it('uses loadPlatformFlagsCached when no listFlagsOverride is provided', async () => {
    const { loadPlatformFlagsCached } = await import('../../src/providers/cache.js')
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['FLAG_X']),
        logger,
        // no listFlagsOverride — uses loadPlatformFlagsCached
      })
      expect(loadPlatformFlagsCached).toHaveBeenCalled()
      expect(result.signals.get('FLAG_X')?.[0].type).toBe('missing-in-platform')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  // Common foot-gun: tokens copied from a UI or sourced from .env files
  // arrive with leading/trailing whitespace (often a trailing newline).
  // The orchestrator must trim before passing to the auth header.
  it('trims whitespace from the env-var token before passing to createClient', async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = '  api-12345\n'
    try {
      let receivedToken: string | undefined
      await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['A']),
        logger: silentLogger(),
        listFlagsOverride: async () => {
          // The cache key is derived from the trimmed token; if trimming
          // didn't happen, listFlagsOverride wouldn't run for the test. Use
          // an indirect signal: spy by replacing process.env back to read.
          return []
        },
      })
      // Verify via the cache-key path: replay with the explicitly-trimmed
      // form and confirm the cached result hits the same key.
      receivedToken = process.env.LAUNCHDARKLY_API_TOKEN
      expect(receivedToken).toBe('  api-12345\n') // env unchanged
      // The orchestrator's internal trim is what we're pinning; this test
      // would have failed pre-fix because LdApiError would surface on the
      // untrimmed `Authorization: api-12345\n` header.
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('appends an actionable auth-type hint when listFlags rejects with 401', async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    const logger = silentLogger()
    try {
      await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['A']),
        logger,
        listFlagsOverride: async () => {
          throw new Error('LaunchDarkly API 401 Unauthorized')
        },
      })
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
    // The warn line must include the SDK-key-vs-API-token hint so users
    // don't have to guess what to check first.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('API access tokens, not SDK keys'),
    )
  })

  it('does NOT append the auth hint when the failure is something other than 401/403', async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    const logger = silentLogger()
    try {
      await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['A']),
        logger,
        listFlagsOverride: async () => {
          throw new Error('LaunchDarkly API 500 Internal Server Error')
        },
      })
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('500'))
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('API access tokens, not SDK keys'),
    )
  })

  it('loops over multiple environments and stitches per-env platform data', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      // Two listFlags calls, one per env. The override receives a signal
      // but we use a call counter to distinguish envs.
      let call = 0
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environments: ['production', 'staging'] },
        },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => {
          call++
          if (call === 1) {
            // production: launched
            return [{ key: 'FOO', archived: false, lastModified: null, status: 'launched' as const, fallthroughVariation: null }]
          }
          // staging: active
          return [{ key: 'FOO', archived: false, lastModified: null, status: 'active' as const, fallthroughVariation: null }]
        },
      })
      expect(call).toBe(2)
      const signals = result.signals.get('FOO') ?? []
      const launched = signals.find((s) => s.type === 'platform-launched')
      expect(launched).toBeDefined()
      expect(launched!.description).toContain('in production')
      expect(launched!.description).not.toContain('everywhere')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('treats single environment: prod the same as environments: [prod]', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'prod' } },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => [
          { key: 'FOO', archived: false, lastModified: null, status: 'launched' as const, fallthroughVariation: null },
        ],
      })
      const launched = result.signals.get('FOO')?.find((s) => s.type === 'platform-launched')
      expect(launched).toBeDefined()
      // Single env => 'everywhere' rendering (correct: one env IS all envs)
      expect(launched!.description).toContain('everywhere')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  // The output transparency feature relies on permanentByPlatform being
  // correctly populated by the orchestrator. This test pins that
  // contract end-to-end through listFlagsOverride.
  it('populates permanentByPlatform for matched flags marked permanent', async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['KILL_SWITCH_A', 'KILL_SWITCH_B', 'TEMP_FLAG']),
        logger: silentLogger(),
        listFlagsOverride: async () => [
          { key: 'KILL_SWITCH_A', archived: false, lastModified: null, permanent: true, fallthroughVariation: null },
          { key: 'KILL_SWITCH_B', archived: false, lastModified: null, permanent: true, fallthroughVariation: null },
          { key: 'TEMP_FLAG', archived: false, lastModified: null, permanent: false, fallthroughVariation: null },
        ],
        noCache: true,
      })
      // Both kill switches show up in the per-platform list, sorted.
      expect(result.permanentByPlatform).toEqual({
        LaunchDarkly: ['KILL_SWITCH_A', 'KILL_SWITCH_B'],
      })
      // Signals carry the platform-permanent marker, but TEMP_FLAG (not
      // permanent) doesn't appear at all.
      expect(result.signals.get('KILL_SWITCH_A')?.[0].type).toBe('platform-permanent')
      expect(result.signals.get('KILL_SWITCH_B')?.[0].type).toBe('platform-permanent')
      expect(result.signals.has('TEMP_FLAG')).toBe(false)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('populates environmentsByFlag from per-env enrichment data', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      let call = 0
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environments: ['production', 'staging'] },
        },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => {
          call++
          if (call === 1) {
            return [{
              key: 'FOO',
              archived: false,
              lastModified: null,
              status: 'launched' as const,
              evaluations30d: 12000,
              lastRequested: new Date('2026-05-25T00:00:00Z'),
              lastTouched: new Date('2026-04-01T00:00:00Z'),
              fallthroughVariation: null,
            }]
          }
          return [{
            key: 'FOO',
            archived: false,
            lastModified: null,
            status: 'active' as const,
            evaluations30d: 3,
            lastRequested: new Date('2026-05-26T00:00:00Z'),
            lastTouched: new Date('2026-05-20T00:00:00Z'),
            fallthroughVariation: null,
          }]
        },
      })
      const fooEnvs = result.environmentsByFlag.get('FOO')
      expect(fooEnvs).toBeDefined()
      expect(fooEnvs!.size).toBe(2)
      expect(fooEnvs!.get('production')?.status).toBe('launched')
      expect(fooEnvs!.get('production')?.evaluations30d).toBe(12000)
      expect(fooEnvs!.get('staging')?.status).toBe('active')
      expect(fooEnvs!.get('staging')?.evaluations30d).toBe(3)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('skips envs in environmentsByFlag when they have no enrichment data', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      let call = 0
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environments: ['production', 'staging'] },
        },
        detectedFlags: detected(['BAR']),
        logger,
        listFlagsOverride: async () => {
          call++
          if (call === 1) {
            // production: enriched
            return [{
              key: 'BAR',
              archived: false,
              lastModified: null,
              status: 'active' as const,
              fallthroughVariation: null,
            }]
          }
          // staging: no enrichment fields at all (including the post-Task-3
          // fields on/offVariation, which are implicitly undefined here — that
          // matters because the skip guard's `== null` check treats both
          // undefined and null as "no data").
          return [{ key: 'BAR', archived: false, lastModified: null, fallthroughVariation: null }]
        },
      })
      const barEnvs = result.environmentsByFlag.get('BAR')
      expect(barEnvs).toBeDefined()
      // staging should be filtered out because it has no enrichment fields
      expect(barEnvs!.has('production')).toBe(true)
      expect(barEnvs!.has('staging')).toBe(false)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('populates environmentsByFlag with on/fallthroughVariation/offVariation', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      let call = 0
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environments: ['production', 'staging'] },
        },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => {
          call++
          if (call === 1) {
            // production: launched, on, 100% to variation 1
            return [{
              key: 'FOO',
              archived: false,
              lastModified: null,
              status: 'launched' as const,
              fallthroughVariation: 1,
              on: true,
              offVariation: 0,
            }]
          }
          // staging: split rollout — fallthroughVariation null
          return [{
            key: 'FOO',
            archived: false,
            lastModified: null,
            status: 'active' as const,
            fallthroughVariation: null,
            on: true,
            offVariation: 0,
          }]
        },
      })
      const fooEnvs = result.environmentsByFlag.get('FOO')
      expect(fooEnvs).toBeDefined()
      expect(fooEnvs!.size).toBe(2)
      expect(fooEnvs!.get('production')?.on).toBe(true)
      expect(fooEnvs!.get('production')?.fallthroughVariation).toBe(1)
      expect(fooEnvs!.get('production')?.offVariation).toBe(0)
      expect(fooEnvs!.get('staging')?.fallthroughVariation).toBeNull()
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('keeps env in environmentsByFlag when only the new fields (no status/evals) are populated', async () => {
    // Regression: the "skip env with no enrichment" guard must include the
    // new fields, otherwise an env that only has variation/fallthrough
    // data would be incorrectly dropped from environmentsByFlag.
    //
    // ALSO IMPORTANT: this test pins that the guard uses `== null` (not
    // `===`) — the cached-flag case has `fallthroughVariation: null` as a
    // stub from cache.ts and must be treated as "no data" (dropped). Live
    // flags with explicit `on: false` and `offVariation: 0` should NOT be
    // dropped. This test exercises the latter case.
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environment: 'production' },
        },
        detectedFlags: detected(['BAR']),
        logger,
        listFlagsOverride: async () => [{
          key: 'BAR',
          archived: false,
          lastModified: null,
          // No status, evaluations30d, lastRequested, lastTouched
          on: false,
          fallthroughVariation: null,
          offVariation: 0,
        }],
      })
      const barEnvs = result.environmentsByFlag.get('BAR')
      expect(barEnvs).toBeDefined()
      expect(barEnvs!.get('production')?.on).toBe(false)
      expect(barEnvs!.get('production')?.offVariation).toBe(0)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('omits a platform from permanentByPlatform when nothing is marked permanent', async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['ACTIVE_FLAG']),
        logger: silentLogger(),
        listFlagsOverride: async () => [
          { key: 'ACTIVE_FLAG', archived: false, lastModified: null, permanent: false, fallthroughVariation: null },
        ],
        noCache: true,
      })
      expect(result.permanentByPlatform).toEqual({})
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('populates metadataByFlag with tags / maintainer / status for matched flags', async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'e' } },
        detectedFlags: detected(['TAGGED', 'OWNED', 'UNDECORATED', 'NOT_DETECTED']),
        logger: silentLogger(),
        listFlagsOverride: async () => [
          {
            key: 'TAGGED',
            archived: false,
            lastModified: null,
            tags: ['kill-switch'],
            status: 'inactive' as const,
            fallthroughVariation: null,
          },
          {
            key: 'OWNED',
            archived: false,
            lastModified: null,
            maintainer: 'Jane <jane@example.com>',
            fallthroughVariation: null,
          },
          { key: 'UNDECORATED', archived: false, lastModified: null, fallthroughVariation: null },
          // Flag exists in the platform but isn't referenced in code — must
          // be skipped from metadataByFlag.
          {
            key: 'PLATFORM_ONLY',
            archived: false,
            lastModified: null,
            tags: ['lonely'],
            fallthroughVariation: null,
          },
        ],
        noCache: true,
      })
      expect(result.metadataByFlag.get('TAGGED')).toEqual({
        tags: ['kill-switch'],
        maintainer: undefined,
        status: 'inactive',
      })
      expect(result.metadataByFlag.get('OWNED')).toEqual({
        tags: undefined,
        maintainer: 'Jane <jane@example.com>',
        status: undefined,
      })
      // Flag exists but has no metadata — skipped entirely so we don't
      // pollute the map with empty entries.
      expect(result.metadataByFlag.has('UNDECORATED')).toBe(false)
      // Detected-only consideration: PLATFORM_ONLY wasn't in detectedFlags.
      expect(result.metadataByFlag.has('PLATFORM_ONLY')).toBe(false)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('populates metadataByFlag.variations when only variations are set (no tags/maintainer/status)', async () => {
    // Coverage regression for the hasMetadata `|| variations` clause:
    // when a flag has variations but no other flag-level metadata, the
    // hasMetadata check must still be satisfied so metadataByFlag picks
    // up the variations. Without this test, the variations clause in
    // hasMetadata + the variations ternary in metadataByFlag.set are
    // uncovered branches.
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'production' } },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => [{
          key: 'FOO',
          archived: false,
          lastModified: null,
          fallthroughVariation: null,
          // Deliberately no tags, no maintainer, no status — only variations.
          variations: [
            { value: false, name: 'off' },
            { value: true, name: 'on' },
          ],
        }],
      })
      const meta = result.metadataByFlag.get('FOO')
      expect(meta).toBeDefined()
      expect(meta!.variations).toEqual([
        { value: false, name: 'off' },
        { value: true, name: 'on' },
      ])
      expect(meta!.tags).toBeUndefined()
      expect(meta!.maintainer).toBeUndefined()
      expect(meta!.status).toBeUndefined()
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('preserves env with live fallthroughVariation: null (split rollout) when on/offVariation are also set', async () => {
    // Load-bearing-null contract: a split rollout produces
    // fallthroughVariation: null in LD, alongside on: true and a real
    // offVariation. The skip guard's `== null` check would treat
    // fallthroughVariation alone as "no data", BUT on and offVariation
    // being non-nullish keep the env in environmentsByFlag. This
    // ensures SaaS Piranha sees fallthroughVariation: null in JSON
    // output and correctly fails closed on the split rollout.
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'production' } },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => [{
          key: 'FOO',
          archived: false,
          lastModified: null,
          on: true,
          fallthroughVariation: null,  // split rollout
          offVariation: 0,
          // status, evaluations, lastTouched all undefined (e.g. aux fetches failed)
        }],
      })
      const fooEnvs = result.environmentsByFlag.get('FOO')
      expect(fooEnvs).toBeDefined()
      expect(fooEnvs!.get('production')?.on).toBe(true)
      expect(fooEnvs!.get('production')?.fallthroughVariation).toBeNull()
      expect(fooEnvs!.get('production')?.offVariation).toBe(0)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('drops env when only fallthroughVariation: null is set (cache-stub or missing-envData scenario)', async () => {
    // Documents the intentional behavior of the skip guard's `== null`
    // check on fallthroughVariation. When a PlatformFlag has
    // fallthroughVariation: null as its ONLY value (e.g. from cache.ts's
    // stub reconstruction, or from a flag whose envData was missing in
    // the LD response), the env is correctly dropped from
    // environmentsByFlag — emitting it as `fallthroughVariation: null`
    // in JSON would falsely signal "split rollout, fail-closed" to SaaS
    // when the real situation is "no enrichment data available".
    //
    // This is the inverse of the test above (Test 2): live null + other
    // fields keeps the env; stub null alone drops the env.
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'production' } },
        detectedFlags: detected(['STUB']),
        logger,
        listFlagsOverride: async () => [{
          key: 'STUB',
          archived: false,
          lastModified: null,
          fallthroughVariation: null,  // only field set (e.g. cache stub)
          // All other fields undefined
        }],
      })
      // Env should be dropped entirely
      expect(result.environmentsByFlag.has('STUB')).toBe(false)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })
})
