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
   * Staleness threshold in days. Passed through to cross-reference so it
   * can emit `platform-too-old` for flags whose platform-side creationDate
   * exceeds the threshold. When omitted, the platform-too-old signal is
   * never emitted.
   */
  thresholdDays?: number
  /**
   * @internal — test seam. When set, used instead of platform.listFlags().
   * Allows tests to bypass network without monkey-patching globalThis.fetch.
   */
  listFlagsOverride?: (signal?: AbortSignal) => Promise<PlatformFlag[]>
}

/**
 * Returned alongside platform signals: the names of flags excluded from
 * staleness checks because a platform marked them permanent, indexed by
 * the platform's displayName. Output formatters surface this directly
 * so users see WHY a permanent flag isn't in the stale table.
 */
export interface OrchestrateResult {
  signals: Map<string, PlatformSignal[]>
  permanentByPlatform: Record<string, string[]>
  /**
   * Per-flag platform-side metadata (tags, maintainer, status). Keyed
   * by detected flag name. Populated only for flags that matched a
   * platform integration AND the platform exposed the data. When
   * multiple platforms report different metadata for the same flag,
   * the LAST platform processed wins — the typical case is one
   * platform per project anyway.
   */
  metadataByFlag: Map<
    string,
    { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
  >
}

/**
 * Runs each configured platform integration. Logs warnings on individual
 * platform failures and continues. Returns merged signals keyed by flag name
 * plus a per-platform record of flags marked permanent (suppressed from
 * staleness; surfaced separately so users see what was excluded and why).
 */
export async function orchestratePlatforms(
  opts: OrchestratePlatformsOptions,
): Promise<OrchestrateResult> {
  const out = new Map<string, PlatformSignal[]>()
  const permanentByPlatform: Record<string, string[]> = {}
  const metadataByFlag = new Map<
    string,
    { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
  >()
  if (!opts.platformsConfig) {
    return { signals: out, permanentByPlatform, metadataByFlag }
  }

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
    // Trim whitespace before passing to the auth header. A common foot-gun:
    // tokens copied from a UI or sourced via `.env`/`export` end up with a
    // trailing newline or leading space, which fetch propagates verbatim
    // into `Authorization:` and the platform rejects as 401. Trim once
    // here so every platform's createClient sees a clean string.
    const rawToken = process.env[tokenEnv]
    const token = rawToken?.trim() ?? ''
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
      const signals = crossReference(opts.detectedFlags, flags, def.displayName, {
        thresholdDays: opts.thresholdDays,
      })
      mergePlatformSignals(out, signals)

      // Track which flags this platform marked permanent so output
      // formatters can show 'N flag(s) excluded as permanent in
      // <Platform>: a, b, c'. Read the signals MAP we just merged in
      // (not `signals` directly — same content, but consistent source).
      const platformPermanent: string[] = []
      for (const [flagName, sigList] of signals) {
        if (sigList.some((s) => s.type === 'platform-permanent')) {
          platformPermanent.push(flagName)
        }
      }
      if (platformPermanent.length > 0) {
        permanentByPlatform[def.displayName] = platformPermanent.sort()
      }

      // Surface platform-side metadata (tags, maintainer, activity
      // status) for every detected flag that matched this platform.
      // Output formatters consume this to enrich the per-row display
      // without re-querying the platform.
      for (const flag of flags) {
        if (!opts.detectedFlags.has(flag.key)) continue
        const hasMetadata = (flag.tags && flag.tags.length > 0) || flag.maintainer || flag.status
        if (!hasMetadata) continue
        metadataByFlag.set(flag.key, {
          tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
          maintainer: flag.maintainer,
          status: flag.status,
        })
      }
    } catch (err) {
      // 401/403 are by far the most common failure mode here and the cause
      // is almost always confusable token shapes (SDK key vs. API access
      // token, project-scoped token pointed at the wrong project, project
      // KEY vs. project NAME in the YAML). Surface a hint inline so users
      // don't have to guess.
      const message = (err as Error).message
      const isAuthError = /\b(401|403|Unauthorized|Forbidden)\b/i.test(message)
      const hint = isAuthError
        ? ` (check token type — API access tokens, not SDK keys, and the project key matches a project the token can read)`
        : ''
      opts.logger.warn(
        `${def.displayName}: ${message}${hint}. Continuing with code-only signals.`,
      )
    }
  }

  return { signals: out, permanentByPlatform, metadataByFlag }
}
