import type { PlatformDefinition } from './interface.js'
import { launchdarklyDefinition } from './launchdarkly/definition.js'

/**
 * Static registry of platform integrations. Adding a new platform appends an
 * import + an entry here. No other central code changes.
 */
// Use any in the array type to accommodate concrete-config definitions. Each
// definition's specific TConfig is preserved through findPlatform() because
// callers re-parse the raw config through definition.configSchema anyway.
export const platformRegistry: ReadonlyArray<PlatformDefinition<any>> = [
  launchdarklyDefinition,
]

export function findPlatform(name: string): PlatformDefinition<unknown> | undefined {
  return platformRegistry.find((p) => p.name === name)
}
