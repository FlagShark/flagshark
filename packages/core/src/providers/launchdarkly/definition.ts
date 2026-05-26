import { z } from 'zod'
import { fetchAllFlags } from './client.js'
import type { PlatformDefinition } from '../interface.js'

/**
 * Two accepted config shapes:
 *
 *   environment: 'prod'              # legacy single-env (still supported)
 *   environments: ['prod', 'staging'] # preferred multi-env form
 *
 * Exactly one must be set. After .transform, downstream code sees
 * `environments: string[]` (length >= 1) — the single-env form is
 * normalized to a one-element array.
 */
const launchdarklyConfigSchema = z.object({
  project: z.string(),
  environment: z.string().min(1).optional(),
  environments: z.array(z.string().min(1)).nonempty().optional(),
  api_base: z.string().url().optional(),
  token_env: z.string().optional(),
}).refine(
  (cfg) => !!cfg.environment !== !!cfg.environments,
  { message: "set exactly one of 'environment' or 'environments'" },
).transform((cfg) => ({
  ...cfg,
  environments: cfg.environments ?? [cfg.environment!],
}))

type LdConfig = z.infer<typeof launchdarklyConfigSchema>

export const launchdarklyDefinition: PlatformDefinition<LdConfig> = {
  name: 'launchdarkly',
  displayName: 'LaunchDarkly',
  defaultTokenEnv: 'LAUNCHDARKLY_API_TOKEN',
  configSchema: launchdarklyConfigSchema,
  // createClient operates on ONE environment at a time. Today the
  // orchestrator passes the post-transform LdConfig directly, so
  // `cfg.environment` is whatever the user's YAML had (or undefined
  // when they used the `environments: [...]` array form, in which
  // case we fall back to environments[0] below). The multi-env
  // orchestration loop arrives in a later task; when it lands, it
  // will synthesize a per-iteration `environment: env` at the call
  // site so each iteration scans exactly one env. Keeping the
  // client single-env preserves the fetchAllFlags contract.
  createClient: (cfg, token) => ({
    name: 'launchdarkly',
    displayName: 'LaunchDarkly',
    listFlags: ({ signal } = {}) => {
      // Today's orchestrator passes the post-transform config directly,
      // so cfg.environment is set only when the user supplied the legacy
      // single-env form; the array form leaves it undefined and we use
      // environments[0]. When the multi-env loop lands, it will synthesize
      // a per-iteration `environment: env` so this fallback is rarely
      // hit at the inner-loop level.
      const env = cfg.environment ?? cfg.environments[0]
      return fetchAllFlags({
        project: cfg.project,
        environment: env,
        token,
      }, { apiBase: cfg.api_base, signal })
    },
  }),
}
