import { findPlatform } from './registry.js'
import { crossReference, mergePlatformSignals } from './cross-reference.js'
import { computeCacheKey, loadPlatformFlagsCached } from './cache.js'
import type { PlatformSignal, PlatformFlag, FlagVariation } from './interface.js'
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
   * Per-platform low-evaluations threshold passed through to crossReference.
   * Below this count over the reporting window, platform-low-evaluations fires.
   * Default in crossReference: 10.
   */
  evaluationThreshold?: number
  /**
   * @internal — test seam. When set, used instead of platform.listFlags().
   * Allows tests to bypass network without monkey-patching globalThis.fetch.
   */
  listFlagsOverride?: (signal?: AbortSignal) => Promise<PlatformFlag[]>
}

/**
 * Per-env breakdown of platform data for each detected flag, indexed by
 * flag name then env key. Populated only for flags that matched a platform
 * AND had at least one per-env enrichment field set — currently status,
 * evaluations30d, lastRequested, lastTouched, on, fallthroughVariation,
 * or offVariation. Surfaced to the JSON output formatter so consumers see
 * the full multi-env picture beneath the flat top-level fields.
 */
export interface PerFlagEnvironmentData {
  status?: 'new' | 'active' | 'inactive' | 'launched'
  evaluations30d?: number | null
  lastRequested?: Date | null
  lastTouched?: Date | null
  /**
   * Per-env LD configuration. Surfaced for SaaS-side cleanup pipelines
   * that need to substitute the correct variation value into code.
   * See PlatformFlag for field semantics.
   */
  on?: boolean
  fallthroughVariation?: number | null
  offVariation?: number
}

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
    {
      tags?: string[]
      maintainer?: string
      status?: 'new' | 'active' | 'inactive' | 'launched'
      variations?: FlagVariation[]
      codeReferences?: { count: number } | null
    }
  >
  /**
   * Per-flag, per-env enrichment data. Outer key: detected flag name.
   * Inner key: env name. Empty when no platform integration is configured
   * or when no flag had enrichment data. JSON output uses this to emit
   * the additive `environments` block.
   */
  environmentsByFlag: Map<string, Map<string, PerFlagEnvironmentData>>
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
    {
      tags?: string[]
      maintainer?: string
      status?: 'new' | 'active' | 'inactive' | 'launched'
      variations?: FlagVariation[]
      codeReferences?: { count: number } | null
    }
  >()
  const environmentsByFlag = new Map<string, Map<string, PerFlagEnvironmentData>>()
  if (!opts.platformsConfig) {
    return { signals: out, permanentByPlatform, metadataByFlag, environmentsByFlag }
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

    // Preflight token-shape check (LaunchDarkly only). LD ships two token
    // families with distinct prefixes: SDK keys (`sdk-…`, mobile keys
    // `mob-…`) are for the runtime SDK and rejected by the REST API; API
    // access tokens (`api-…`) are what FlagShark needs. The mistake is
    // common because LD shows both in adjacent UI surfaces. We still
    // attempt the request (in case LD ever changes formats) but emit a
    // pointed warning up-front so the 401 below isn't the only signal.
    if (name === 'launchdarkly' && /^(sdk-|mob-)/.test(token)) {
      opts.logger.warn(
        `${def.displayName}: ${tokenEnv} looks like an SDK key (${token.slice(0, 4)}…). ` +
        `FlagShark needs an API access token (api-…). ` +
        `Create one at Account settings → Authorization → API access tokens ` +
        `(needs Reader role on the project at minimum).`,
      )
    }

    try {
      // Multi-env: parsed.data.environments is always a non-empty array
      // after the Zod transform (both `environment: 'x'` and
      // `environments: ['x']` are normalized to environments[]).
      // Loop serially per env — each iteration runs an isolated
      // listFlags() with its own concurrency budget and its own cache
      // entry (computeCacheKey hashes the full config including env).
      // Serial keeps blast radius constant per env.
      const envs = (parsed.data as { environments: string[] }).environments
      const perEnv = new Map<string, Map<string, PlatformFlag>>()
      let firstEnvFlags: PlatformFlag[] = []

      for (const env of envs) {
        const envConfig = { ...(parsed.data as Record<string, unknown>), environment: env }
        const client = def.createClient(envConfig as typeof parsed.data, token)
        const cacheKey = computeCacheKey(name, envConfig, token)
        const flags = opts.listFlagsOverride
          ? await opts.listFlagsOverride(opts.signal)
          : await loadPlatformFlagsCached(client, cacheKey, {
              noCache: opts.noCache,
              signal: opts.signal,
              logger: opts.logger,
            })
        if (env === envs[0]) firstEnvFlags = flags
        for (const f of flags) {
          if (!perEnv.has(f.key)) perEnv.set(f.key, new Map())
          perEnv.get(f.key)!.set(env, f)
        }
      }

      const signals = crossReference(opts.detectedFlags, perEnv, def.displayName, {
        thresholdDays: opts.thresholdDays,
        evaluationThreshold: opts.evaluationThreshold,
      })
      mergePlatformSignals(out, signals)

      // Track flags marked permanent (LD's temporary=false). Flag-level
      // field — identical across envs — so reading from first env is correct.
      const platformPermanent: string[] = []
      for (const [flagName, sigList] of signals) {
        if (sigList.some((s) => s.type === 'platform-permanent')) {
          platformPermanent.push(flagName)
        }
      }
      if (platformPermanent.length > 0) {
        permanentByPlatform[def.displayName] = platformPermanent.sort()
      }

      // metadataByFlag: surface platform-side metadata. For multi-env,
      // we use the first env's data — matches the JSON output rule
      // (top-level fields source from environments[envs[0]]).
      for (const flag of firstEnvFlags) {
        if (!opts.detectedFlags.has(flag.key)) continue
        const hasMetadata = (flag.tags && flag.tags.length > 0)
          || flag.maintainer
          || flag.status
          || (flag.variations && flag.variations.length > 0)
          || flag.codeReferences !== undefined
        if (!hasMetadata) continue
        metadataByFlag.set(flag.key, {
          tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
          maintainer: flag.maintainer,
          status: flag.status,
          variations: flag.variations && flag.variations.length > 0 ? flag.variations : undefined,
          codeReferences: flag.codeReferences,
        })
      }

      // environmentsByFlag: per-env enrichment for every detected flag
      // that the platform knew about. Outer key = detected flag name.
      // Inner key = env name. Populates from the stitched perEnv map
      // we built above — single source of truth.
      for (const [flagKey, envInnerMap] of perEnv) {
        if (!opts.detectedFlags.has(flagKey)) continue
        const inner = new Map<string, PerFlagEnvironmentData>()
        for (const [env, pf] of envInnerMap) {
          // Skip envs with no enrichment data to keep environmentsByFlag tight.
          //
          // IMPORTANT: uses `== null` (not `===`) deliberately. The cache layer
          // (packages/core/src/providers/cache.ts) stubs fallthroughVariation as
          // literal `null` for cached PlatformFlag entries — that stub MUST be
          // treated as "no data" so cache hits don't emit misleading
          // fallthroughVariation:null in JSON output (which would signal "split
          // rollout, fail-closed" to SaaS Piranha). The == null check matches
          // both the stub null AND the undefined of the other optional fields,
          // preserving the load-bearing-null semantics.
          //
          // If you ever need to distinguish stub null from live null, the right
          // fix is to make the cache stub more honest (don't pretend to know),
          // NOT to change == to ===.
          if (
            pf.status == null
            && pf.evaluations30d == null
            && pf.lastRequested == null
            && pf.lastTouched == null
            && pf.on == null
            && pf.fallthroughVariation == null
            && pf.offVariation == null
          ) continue
          inner.set(env, {
            status: pf.status,
            evaluations30d: pf.evaluations30d,
            lastRequested: pf.lastRequested,
            lastTouched: pf.lastTouched,
            on: pf.on,
            fallthroughVariation: pf.fallthroughVariation,
            offVariation: pf.offVariation,
          })
        }
        if (inner.size > 0) {
          environmentsByFlag.set(flagKey, inner)
        }
      }
    } catch (err) {
      // 401/403 are by far the most common failure mode here and the cause
      // is almost always confusable token shapes (SDK key vs. API access
      // token, project-scoped token pointed at the wrong project, project
      // KEY vs. project NAME in the YAML). Surface a hint inline so users
      // don't have to guess. If we already preflighted the prefix above
      // and it looked correct (`api-…`), the next-most-likely cause is
      // project key vs. name, so steer the hint there instead of repeating
      // the SDK-key warning.
      const message = (err as Error).message
      const isAuthError = /\b(401|403|Unauthorized|Forbidden)\b/i.test(message)
      let hint = ''
      if (isAuthError) {
        if (name === 'launchdarkly' && token.startsWith('api-')) {
          hint =
            ` (token shape is correct — verify the project KEY (not name) in .flagshark.yml ` +
            `matches a project the token can read; the project key is shown in LD under ` +
            `Account settings → Projects, in the second column)`
        } else if (name === 'launchdarkly') {
          hint =
            ` (use an API access token (api-…), not an SDK key; verify the project KEY ` +
            `(not display name) in .flagshark.yml matches a project the token can read)`
        /* v8 ignore start -- defensive fallback for future non-LD platforms;
           launchdarkly is the only registered platform today, and unknown
           platform names bail at the findPlatform() check above. */
        } else {
          hint = ` (check token type and that it has read access to the configured project)`
        }
        /* v8 ignore stop */
      }
      opts.logger.warn(
        `${def.displayName}: ${message}${hint}. Continuing with code-only signals.`,
      )
    }
  }

  return { signals: out, permanentByPlatform, metadataByFlag, environmentsByFlag }
}
