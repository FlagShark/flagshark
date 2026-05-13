import type { PlatformDefinition } from './interface.js'

/**
 * Static registry of platform integrations. Adding a new platform appends an
 * import + an entry here. No other central code changes.
 */
export const platformRegistry: ReadonlyArray<PlatformDefinition> = [
  // launchdarklyDefinition lands in Phase 2 (Task 2.4)
]

export function findPlatform(name: string): PlatformDefinition | undefined {
  return platformRegistry.find((p) => p.name === name)
}
