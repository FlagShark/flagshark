import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PlatformClient, PlatformFlag } from './interface.js'
import type { ScanLogger } from '../scan-repo.js'

export interface CacheOptions {
  /** Override the cache directory. Default: XDG-spec resolution. */
  cacheDir?: string
  /** Time-to-live in milliseconds. Default: 24h. */
  ttlMs?: number
  /** When true, skip the cache entirely. */
  noCache?: boolean
}

interface CacheFile {
  fetchedAt: string  // ISO timestamp
  flags: Array<{ key: string; archived: boolean; lastModified: string | null }>
}

interface CacheReadResult {
  fetchedAt: Date
  flags: PlatformFlag[]
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function resolveCacheDir(override?: string): string {
  if (override) return override
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache')
  return join(base, 'flagshark')
}

/**
 * Build a stable cache key from platform name + non-secret config + token hash.
 * The raw token is never written to disk.
 */
export function computeCacheKey(
  platformName: string,
  config: unknown,
  token: string,
): string {
  const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 8)
  const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 8)
  return `v1-${platformName}-${configHash}-${tokenHash}`
}

/** Returns parsed cache contents, or null on miss / corruption / TTL expiry. */
export function readCache(key: string, opts: CacheOptions = {}): CacheReadResult | null {
  const dir = resolveCacheDir(opts.cacheDir)
  const path = join(dir, `${key}.json`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: CacheFile
  try {
    parsed = JSON.parse(raw) as CacheFile
  } catch {
    return null
  }
  if (typeof parsed?.fetchedAt !== 'string' || !Array.isArray(parsed.flags)) {
    return null
  }
  const fetchedAt = new Date(parsed.fetchedAt)
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS
  if (Date.now() - fetchedAt.getTime() >= ttl) return null

  const flags: PlatformFlag[] = parsed.flags.map((f) => ({
    key: f.key,
    archived: f.archived,
    lastModified: f.lastModified ? new Date(f.lastModified) : null,
    // Stub for the non-optional field. The enriched value is not persisted
    // to disk (writeCache only stores key/archived/lastModified). On cache
    // hits, the orchestrator's skip-empty-env guard uses `== null` for all
    // enrichment fields, so this `null` is treated the same as the
    // `undefined` of the other per-env fields — the env block is omitted
    // from output, preserving the load-bearing-null semantics
    // (`fallthroughVariation: null` in JSON output should ONLY mean "split
    // rollout, fail closed", never "cached scan without fresh data").
    fallthroughVariation: null,
  }))
  return { fetchedAt, flags }
}

/** Writes the cache file, creating directories as needed. Silent on error. */
export function writeCache(key: string, flags: PlatformFlag[], opts: CacheOptions = {}): void {
  const dir = resolveCacheDir(opts.cacheDir)
  try {
    mkdirSync(dir, { recursive: true })
    const body: CacheFile = {
      fetchedAt: new Date().toISOString(),
      flags: flags.map((f) => ({
        key: f.key,
        archived: f.archived,
        lastModified: f.lastModified ? f.lastModified.toISOString() : null,
      })),
    }
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(body))
  } catch {
    // Cache write failure is non-fatal — data is still in memory for this run.
  }
}

/** Reads from cache if fresh; otherwise calls the client and writes the result. */
export async function loadPlatformFlagsCached(
  client: PlatformClient,
  cacheKey: string,
  opts: CacheOptions & { signal?: AbortSignal; logger?: ScanLogger } = {},
): Promise<PlatformFlag[]> {
  if (!opts.noCache) {
    const cached = readCache(cacheKey, opts)
    if (cached) return cached.flags
  }
  const flags = await client.listFlags({ signal: opts.signal, logger: opts.logger })
  writeCache(cacheKey, flags, opts)
  return flags
}
