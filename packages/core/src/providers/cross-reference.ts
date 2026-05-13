import type { FeatureFlag } from '../detection/feature-flag.js'
import type { PlatformFlag, PlatformSignal } from './interface.js'

/**
 * Pure function: joins detected flag keys against a platform's flag list,
 * emits PlatformSignals for keys that are missing (error) or archived (warning).
 *
 * Does NOT surface platform flags with no code reference — that's a separate
 * "orphan platform flags" feature, out of scope.
 */
export function crossReference(
  detectedFlags: Map<string, FeatureFlag[]>,
  platformFlags: PlatformFlag[],
  platformDisplayName: string,
): Map<string, PlatformSignal[]> {
  const platformByKey = new Map(platformFlags.map((f) => [f.key, f]))
  const out = new Map<string, PlatformSignal[]>()

  for (const key of detectedFlags.keys()) {
    const platform = platformByKey.get(key)
    if (!platform) {
      out.set(key, [{
        type: 'missing-in-platform',
        severity: 'error',
        description: `referenced in code but not found in ${platformDisplayName}`,
      }])
    } else if (platform.archived) {
      out.set(key, [{
        type: 'archived-in-platform',
        severity: 'warning',
        description: `archived in ${platformDisplayName}`,
      }])
    }
  }

  return out
}

/**
 * Merge platform signals from multiple platforms into a single per-flag map.
 * If both LaunchDarkly and Unleash say a flag is missing, the flag's entry
 * gets two signals (one per platform).
 *
 * Source arrays are cloned — subsequent mutations to source don't affect into.
 */
export function mergePlatformSignals(
  into: Map<string, PlatformSignal[]>,
  source: Map<string, PlatformSignal[]>,
): void {
  for (const [key, signals] of source) {
    const existing = into.get(key)
    if (existing) {
      existing.push(...signals)
    } else {
      into.set(key, [...signals])
    }
  }
}
