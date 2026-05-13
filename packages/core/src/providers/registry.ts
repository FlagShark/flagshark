import type { PlatformDefinition } from './interface.js'
import { launchdarklyDefinition } from './launchdarkly/definition.js'

/**
 * Static registry of platform integrations. Adding a new platform appends an
 * import + an entry here. No other central code changes.
 */
export const platformRegistry: ReadonlyArray<PlatformDefinition> = [
  launchdarklyDefinition,
]

export function findPlatform(name: string): PlatformDefinition | undefined {
  return platformRegistry.find((p) => p.name === name)
}
