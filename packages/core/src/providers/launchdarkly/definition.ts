import { z } from 'zod'
import { fetchAllFlags } from './client.js'
import type { PlatformDefinition } from '../interface.js'

const launchdarklyConfigSchema = z.object({
  project: z.string(),
  environment: z.string(),
  api_base: z.string().url().optional(),
  token_env: z.string().optional(),
})

type LdConfig = z.infer<typeof launchdarklyConfigSchema>

export const launchdarklyDefinition: PlatformDefinition<LdConfig> = {
  name: 'launchdarkly',
  displayName: 'LaunchDarkly',
  defaultTokenEnv: 'LAUNCHDARKLY_API_TOKEN',
  configSchema: launchdarklyConfigSchema,
  createClient: (cfg, token) => ({
    name: 'launchdarkly',
    displayName: 'LaunchDarkly',
    listFlags: ({ signal } = {}) => fetchAllFlags({
      project: cfg.project,
      environment: cfg.environment,
      token,
    }, { apiBase: cfg.api_base, signal }),
  }),
}
