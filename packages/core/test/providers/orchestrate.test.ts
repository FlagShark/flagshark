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
    expect(result.size).toBe(0)
  })

  it('warns and skips unknown platform names', async () => {
    const logger = silentLogger()
    const result = await orchestratePlatforms({
      platformsConfig: { unknown: { foo: 'bar' } } as Record<string, unknown>,
      detectedFlags: detected(['A']),
      logger,
    })
    expect(result.size).toBe(0)
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
      expect(result.size).toBe(0)
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
      expect(result.size).toBe(0)
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
      expect(result.size).toBe(0)
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
      expect(result.get('MISSING_FLAG')?.[0].type).toBe('missing-in-platform')
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
      expect(result.get('FLAG_X')?.[0].type).toBe('missing-in-platform')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })
})
