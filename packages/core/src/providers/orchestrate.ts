import { findPlatform } from './registry.js'
import { crossReference, mergePlatformSignals } from './cross-reference.js'
import { computeCacheKey, loadPlatformFlagsCached } from './cache.js'
import type { PlatformSignal, PlatformFlag } from './interface.js'
import type { FeatureFlag } from '../detection/feature-flag.js'
import type { ScanLogger } from '../scan-repo.js'

export interface OrchestratePlatformsOptions {
  /** Raw .flagshark.yml `platforms:` block, before per-platform Zod validation. */
  platformsConfig: Record<string, unknown> | undefined
  /** Detected flag keys from the analyzer. */
  detectedFlags: Map<string, FeatureFlag[]>
  logger: ScanLogger
  /** When true, skip cache for this run. */
  noCache?: boolean
  signal?: AbortSignal
  /**
   * @internal — test seam. When set, used instead of platform.listFlags().
   * Allows tests to bypass network without monkey-patching globalThis.fetch.
   */
  listFlagsOverride?: (signal?: AbortSignal) => Promise<PlatformFlag[]>
}

/**
 * Runs each configured platform integration. Logs warnings on individual
 * platform failures and continues. Returns merged signals keyed by flag name.
 */
export async function orchestratePlatforms(
  opts: OrchestratePlatformsOptions,
): Promise<Map<string, PlatformSignal[]>> {
  const out = new Map<string, PlatformSignal[]>()
  if (!opts.platformsConfig) return out

  for (const [name, rawConfig] of Object.entries(opts.platformsConfig)) {
    const def = findPlatform(name)
    if (!def) {
      opts.logger.warn(`Unknown platform '${name}' — skipping`)
      continue
    }

    const parsed = def.configSchema.safeParse(rawConfig)
    if (!parsed.success) {
      opts.logger.warn(`Invalid config for platform '${name}': ${parsed.error.message}`)
      continue
    }

    const tokenEnv = (rawConfig as { token_env?: string }).token_env ?? def.defaultTokenEnv
    const token = process.env[tokenEnv]
    if (!token) {
      opts.logger.warn(`${def.displayName}: missing ${tokenEnv}; skipping platform integration`)
      continue
    }

    try {
      const client = def.createClient(parsed.data, token)
      const cacheKey = computeCacheKey(name, parsed.data, token)
      const flags = opts.listFlagsOverride
        ? await opts.listFlagsOverride(opts.signal)
        : await loadPlatformFlagsCached(client, cacheKey, { noCache: opts.noCache, signal: opts.signal })
      const signals = crossReference(opts.detectedFlags, flags, def.displayName)
      mergePlatformSignals(out, signals)
    } catch (err) {
      opts.logger.warn(`${def.displayName}: ${(err as Error).message}. Continuing with code-only signals.`)
    }
  }

  return out
}
