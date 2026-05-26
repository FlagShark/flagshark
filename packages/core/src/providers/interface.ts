import type { ZodType } from 'zod'

/** A flag entry as reported by a flag-management platform's API. */
export interface PlatformFlag {
  key: string
  /** Each platform maps its concept (archived/disabled/stale) to this boolean. */
  archived: boolean
  lastModified: Date | null
  /**
   * True when the platform considers this flag permanent — i.e. NOT a
   * temporary feature toggle that should ever be removed. Kill-switches,
   * operational config flags, and "long-lived experiments" fall here.
   *
   * Maps from LaunchDarkly's `temporary` field (we invert: `permanent =
   * !temporary`). Other platforms may not have an equivalent concept —
   * leave undefined when unknown, which the staleness engine treats
   * exactly as it always did (no special-case suppression).
   *
   * Why surface this: the staleness engine's age and low-usage signals
   * are false positives on intentionally permanent flags. A
   * personal-access-tokens kill switch shouldn't be flagged as "stale"
   * just because it's three years old and only appears in one place;
   * that's the entire point of a kill switch.
   */
  permanent?: boolean
}

/** Runtime client for a configured platform. Returned by PlatformDefinition.createClient. */
export interface PlatformClient {
  /** Registry key, e.g. 'launchdarkly'. */
  name: string
  /** Human-readable name used in signal descriptions, e.g. 'LaunchDarkly'. */
  displayName: string
  listFlags(opts?: { signal?: AbortSignal }): Promise<PlatformFlag[]>
}

/** Registry entry. Each platform implementation exports exactly one of these. */
export interface PlatformDefinition<TConfig = unknown> {
  /** YAML key under `platforms:` and registry lookup key. */
  name: string
  displayName: string
  /** Env var read for the secret token. User can override via token_env. */
  defaultTokenEnv: string
  /** Zod schema validating this platform's config block. */
  configSchema: ZodType<TConfig>
  /** Factory — validated config + resolved token → runtime client. No IO until listFlags() is called. */
  createClient: (config: TConfig, token: string) => PlatformClient
}

/** Signal type emitted by crossReference(). Merged into StaleFlag.signals[] by staleness.ts. */
export interface PlatformSignal {
  /**
   * `platform-permanent` is a control signal, not a user-facing stale
   * signal: the staleness engine uses it as a hint to suppress age and
   * low-usage signals (those are false positives on intentionally
   * long-lived flags) and then filters it out of the emitted
   * StaleFlag.signals array. Consumers downstream won't see it.
   */
  type: 'missing-in-platform' | 'archived-in-platform' | 'platform-permanent'
  severity: 'error' | 'warning' | 'info'
  description: string
}
