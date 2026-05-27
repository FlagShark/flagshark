import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeCacheKey,
  readCache,
  writeCache,
  loadPlatformFlagsCached,
} from '../../src/providers/cache.js'
import type { PlatformClient, PlatformFlag } from '../../src/providers/interface.js'

let cacheDir: string
beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'flagshark-cache-')) })
afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }) })

function fakeClient(flags: PlatformFlag[], opts: { calls?: { count: number } } = {}): PlatformClient {
  return {
    name: 'fake',
    displayName: 'Fake',
    listFlags: async () => {
      if (opts.calls) opts.calls.count++
      return flags
    },
  }
}

describe('computeCacheKey', () => {
  it('produces stable hash for same inputs', () => {
    const a = computeCacheKey('launchdarkly', { project: 'p', environment: 'e' }, 'tok')
    const b = computeCacheKey('launchdarkly', { project: 'p', environment: 'e' }, 'tok')
    expect(a).toBe(b)
  })

  it('produces different hashes for different tokens', () => {
    const a = computeCacheKey('launchdarkly', { project: 'p', environment: 'e' }, 'tok1')
    const b = computeCacheKey('launchdarkly', { project: 'p', environment: 'e' }, 'tok2')
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different config', () => {
    const a = computeCacheKey('launchdarkly', { project: 'p1' }, 'tok')
    const b = computeCacheKey('launchdarkly', { project: 'p2' }, 'tok')
    expect(a).not.toBe(b)
  })

  it('starts with v1- prefix and contains platform name', () => {
    const k = computeCacheKey('launchdarkly', {}, 'tok')
    expect(k).toMatch(/^v1-launchdarkly-/)
  })

  it('produces different cache keys for different env lists', () => {
    const single  = computeCacheKey('launchdarkly', { project: 'p', environments: ['prod'] }, 'tok')
    const double  = computeCacheKey('launchdarkly', { project: 'p', environments: ['prod', 'staging'] }, 'tok')
    const reversed = computeCacheKey('launchdarkly', { project: 'p', environments: ['staging', 'prod'] }, 'tok')
    expect(single).not.toBe(double)
    expect(double).not.toBe(reversed)  // env order is part of the cache identity
  })

  it('produces different cache keys for the same env list but different synthesized env (orchestrator loop)', () => {
    // The orchestrator synthesizes `environment: env` per loop iteration
    // while keeping the rest of the config identical. Two synthesized
    // configs differing only in environment value must produce
    // different keys (so each env has its own cache slot).
    const prod    = computeCacheKey('launchdarkly', { project: 'p', environment: 'prod', environments: ['prod', 'staging'] }, 'tok')
    const staging = computeCacheKey('launchdarkly', { project: 'p', environment: 'staging', environments: ['prod', 'staging'] }, 'tok')
    expect(prod).not.toBe(staging)
  })
})

describe('writeCache + readCache', () => {
  it('round-trips flags', () => {
    const flags: PlatformFlag[] = [{ key: 'A', archived: false, lastModified: new Date('2026-01-01') }]
    writeCache('test-key', flags, { cacheDir })
    const out = readCache('test-key', { cacheDir })
    expect(out?.flags).toEqual(flags)
  })

  it('returns null when no cache file exists', () => {
    expect(readCache('missing-key', { cacheDir })).toBeNull()
  })

  it('returns null when cache file is corrupted', () => {
    const path = join(cacheDir, 'test-key.json')
    writeFileSync(path, 'not json {{{')
    expect(readCache('test-key', { cacheDir })).toBeNull()
  })

  it('returns null when cache file is past TTL', () => {
    writeCache('expired-key', [], { cacheDir })
    expect(readCache('expired-key', { cacheDir, ttlMs: 0 })).toBeNull()
  })

  it('returns null when cache file has invalid shape (missing flags array)', () => {
    const path = join(cacheDir, 'bad-shape.json')
    writeFileSync(path, JSON.stringify({ fetchedAt: new Date().toISOString() }))
    expect(readCache('bad-shape', { cacheDir })).toBeNull()
  })

  it('returns null when cache file has invalid shape (missing fetchedAt)', () => {
    const path = join(cacheDir, 'bad-shape2.json')
    writeFileSync(path, JSON.stringify({ flags: [] }))
    expect(readCache('bad-shape2', { cacheDir })).toBeNull()
  })

  it('honors XDG_CACHE_HOME via env when cacheDir not provided', () => {
    const prev = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = cacheDir
    try {
      writeCache('xdg-test', [{ key: 'A', archived: false, lastModified: null }])
      expect(existsSync(join(cacheDir, 'flagshark', 'xdg-test.json'))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = prev
    }
  })

  it('falls back to ~/.cache/flagshark when XDG_CACHE_HOME is unset', () => {
    // Uses option 1: temporarily redirect HOME to the temp dir so homedir()
    // resolves there, avoiding any writes to the user's real ~/.cache.
    const prevXdg = process.env.XDG_CACHE_HOME
    const prevHome = process.env.HOME
    delete process.env.XDG_CACHE_HOME
    process.env.HOME = cacheDir
    try {
      const key = 'xdg-fallback-test-' + Date.now()
      writeCache(key, [])
      expect(existsSync(join(cacheDir, '.cache', 'flagshark', `${key}.json`))).toBe(true)
    } finally {
      if (prevXdg !== undefined) process.env.XDG_CACHE_HOME = prevXdg
      if (prevHome !== undefined) process.env.HOME = prevHome
      else delete process.env.HOME
    }
  })

  it('handles empty XDG_CACHE_HOME by falling back to ~/.cache', () => {
    // Uses option 1: redirect HOME to the temp dir to avoid touching real ~/.cache.
    const prevXdg = process.env.XDG_CACHE_HOME
    const prevHome = process.env.HOME
    process.env.XDG_CACHE_HOME = ''
    process.env.HOME = cacheDir
    try {
      const key = 'xdg-empty-test-' + Date.now()
      writeCache(key, [])
      expect(existsSync(join(cacheDir, '.cache', 'flagshark', `${key}.json`))).toBe(true)
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = prevXdg
      if (prevHome !== undefined) process.env.HOME = prevHome
      else delete process.env.HOME
    }
  })

  it('writeCache silently handles directory creation failure', () => {
    // Path that can't exist: a file masquerading as a directory
    const blocker = join(cacheDir, 'blocker')
    writeFileSync(blocker, 'x')
    expect(() => writeCache('key', [], { cacheDir: join(blocker, 'sub') })).not.toThrow()
  })

  it('preserves null lastModified across round-trip', () => {
    writeCache('null-mod', [{ key: 'A', archived: false, lastModified: null }], { cacheDir })
    const out = readCache('null-mod', { cacheDir })
    expect(out?.flags[0].lastModified).toBeNull()
  })
})

describe('loadPlatformFlagsCached', () => {
  it('calls the client on cache miss', async () => {
    const calls = { count: 0 }
    const client = fakeClient([{ key: 'A', archived: false, lastModified: null }], { calls })
    const flags = await loadPlatformFlagsCached(client, 'key1', { cacheDir })
    expect(flags).toHaveLength(1)
    expect(calls.count).toBe(1)
  })

  it('serves cache hit without calling client', async () => {
    const calls = { count: 0 }
    const client = fakeClient([{ key: 'A', archived: false, lastModified: null }], { calls })
    await loadPlatformFlagsCached(client, 'key1', { cacheDir })
    await loadPlatformFlagsCached(client, 'key1', { cacheDir })
    expect(calls.count).toBe(1)
  })

  it('bypasses cache when noCache: true', async () => {
    const calls = { count: 0 }
    const client = fakeClient([], { calls })
    await loadPlatformFlagsCached(client, 'key1', { cacheDir })
    await loadPlatformFlagsCached(client, 'key1', { cacheDir, noCache: true })
    expect(calls.count).toBe(2)
  })

  it('propagates AbortSignal to listFlags', async () => {
    const controller = new AbortController()
    const client: PlatformClient = {
      name: 'fake',
      displayName: 'Fake',
      listFlags: async ({ signal } = {}) => {
        if (signal?.aborted) throw new Error('aborted')
        return []
      },
    }
    controller.abort()
    await expect(
      loadPlatformFlagsCached(client, 'key-signal', { cacheDir, noCache: true, signal: controller.signal }),
    ).rejects.toThrow('aborted')
  })
})
