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
  // createClient operates on ONE environment at a time. The orchestrator
  // synthesizes a per-iteration `environment: env` config before calling
  // createClient, so cfg.environment is normally set at this point. The
  // cfg.environments[0] fallback below covers two cases: tests that
  // bypass the orchestrator and call createClient directly with the raw
  // post-transform config (where environment may be undefined for the
  // array form), and any future caller that uses the same pattern.
  // Keeping the client single-env preserves the fetchAllFlags contract.
  createClient: (cfg, token) => ({
    name: 'launchdarkly',
    displayName: 'LaunchDarkly',
    listFlags: ({ signal, logger } = {}) => {
      // env is whatever the orchestrator synthesized for this iteration
      // (set on every per-env call), with environments[0] as fallback
      // for direct callers (mainly tests) that pass the raw post-transform
      // config without re-injecting an `environment` field.
      const env = cfg.environment ?? cfg.environments[0]
      return fetchAllFlags({
        project: cfg.project,
        environment: env,
        token,
      }, { apiBase: cfg.api_base, signal, logger })
    },
  }),
}
