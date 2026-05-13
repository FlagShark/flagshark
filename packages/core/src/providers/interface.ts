import type { ZodType } from 'zod'

/** A flag entry as reported by a flag-management platform's API. */
export interface PlatformFlag {
  key: string
  /** Each platform maps its concept (archived/disabled/stale) to this boolean. */
  archived: boolean
  lastModified: Date | null
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
  type: 'missing-in-platform' | 'archived-in-platform'
  severity: 'error' | 'warning'
  description: string
}
