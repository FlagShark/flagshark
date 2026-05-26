import type { FeatureFlag } from '../detection/feature-flag.js'
import type { PlatformFlag, PlatformSignal } from './interface.js'

export interface CrossReferenceOptions {
  /**
   * Staleness threshold in days. When set, cross-reference can emit
   * `platform-too-old` for matched flags whose platform-side
   * `createdAt` exceeds the threshold — a code-independent staleness
   * signal that's stronger than either code-age or platform-age alone.
   * When unset, the platform-too-old signal is never emitted.
   */
  thresholdDays?: number

  /**
   * Minimum evaluation count over the platform's reporting window
   * (30 days for LD) below which a flag is considered "rarely used"
   * and emits `platform-low-evaluations`. The `platform-zero-evaluations`
   * signal (count exactly 0) is independent of this — it always fires
   * regardless of threshold when the platform reports a real zero.
   *
   * Default: 10. Tuned for "small project, real usage" — set higher
   * for high-traffic prod environments where 10 evaluations/30d is
   * still effectively dead.
   */
  evaluationThreshold?: number
}

/**
 * Pure function: joins detected flag keys against a platform's flag list,
 * emits PlatformSignals based on the platform's view of each flag.
 *
 * Signal precedence (most-specific wins; only one primary signal per flag):
 *   1. missing-in-platform   — flag not in platform at all (error)
 *   2. archived-in-platform  — flag archived (warning)
 *   3. platform-launched     — LD says single variation for 7+ days (error)
 *   4. platform-inactive     — LD says no eval events for 7+ days (warning)
 *   5. platform-permanent    — user marked permanent (control signal)
 *   6. platform-too-old      — created > thresholdDays ago (warning)
 *
 * Permanent + too-old can coexist; permanent + inactive can coexist;
 * permanent is the strongest CONTROL signal (it suppresses code-side
 * heuristics) but doesn't displace platform-side activity signals.
 *
 * Does NOT surface platform flags with no code reference — that's a separate
 * "orphan platform flags" feature, out of scope.
 */
export function crossReference(
  detectedFlags: Map<string, FeatureFlag[]>,
  platformFlags: PlatformFlag[],
  platformDisplayName: string,
  options: CrossReferenceOptions = {},
): Map<string, PlatformSignal[]> {
  const platformByKey = new Map(platformFlags.map((f) => [f.key, f]))
  const out = new Map<string, PlatformSignal[]>()
  const now = Date.now()
  const thresholdMs = options.thresholdDays != null ? options.thresholdDays * 86_400_000 : null

  for (const key of detectedFlags.keys()) {
    const platform = platformByKey.get(key)
    if (!platform) {
      out.set(key, [
        {
          type: 'missing-in-platform',
          severity: 'error',
          description: `referenced in code but not found in ${platformDisplayName}`,
        },
      ])
      continue
    }
    if (platform.archived) {
      out.set(key, [
        {
          type: 'archived-in-platform',
          severity: 'warning',
          description: `archived in ${platformDisplayName}`,
        },
      ])
      continue
    }

    // Stack-able signals: platform-permanent (control), platform-too-old,
    // platform-inactive/launched. A single flag can carry multiple.
    const signals: PlatformSignal[] = []

    if (platform.status === 'launched') {
      signals.push({
        type: 'platform-launched',
        severity: 'error',
        description: `${platformDisplayName} reports this flag has served one variation for 7+ days — likely ready for removal`,
      })
    } else if (platform.status === 'inactive') {
      signals.push({
        type: 'platform-inactive',
        severity: 'warning',
        description: `no evaluations recorded in ${platformDisplayName} in the last 7+ days`,
      })
    }

    if (platform.permanent) {
      // Control signal: tells staleness.ts to suppress age + low-usage
      // signals. Filtered out of the user-facing StaleFlag.signals array
      // before display. Kill-switches and other intentionally permanent
      // flags should not be flagged as stale by code-side heuristics.
      signals.push({
        type: 'platform-permanent',
        severity: 'info',
        description: `marked permanent in ${platformDisplayName}`,
      })
    }

    // platform-too-old: platform-side staleness independent of code age.
    // Only fires when caller provided a threshold AND the platform
    // exposed a createdAt timestamp. Permanent flags suppress this too —
    // the user explicitly chose to keep a long-lived flag, so don't
    // contradict them with a too-old warning.
    if (
      !platform.permanent &&
      thresholdMs != null &&
      platform.createdAt &&
      now - platform.createdAt.getTime() > thresholdMs
    ) {
      const ageDays = Math.floor((now - platform.createdAt.getTime()) / 86_400_000)
      signals.push({
        type: 'platform-too-old',
        severity: 'warning',
        description: `created in ${platformDisplayName} ${ageDays} days ago — past the ${options.thresholdDays}-day threshold`,
      })
    }

    // Real evaluation counts beat every heuristic above when present.
    // `evaluations30d === 0` is a hard signal: the platform itself
    // confirms the code path is unused. Suppressed on permanent flags
    // because the user explicitly opted into keeping the flag — same
    // logic as too-old.
    //
    // `undefined` means the feature isn't available for this account
    // (tier-gated / endpoint 404'd); `null` means available but no
    // window data yet. Both fall through to no signal.
    if (!platform.permanent && typeof platform.evaluations30d === 'number') {
      if (platform.evaluations30d === 0) {
        signals.push({
          type: 'platform-zero-evaluations',
          severity: 'error',
          description: `0 evaluations in ${platformDisplayName} over the last 30 days — code path is unused`,
        })
      } else {
        const threshold = options.evaluationThreshold ?? 10
        if (platform.evaluations30d < threshold) {
          signals.push({
            type: 'platform-low-evaluations',
            severity: 'warning',
            description: `only ${platform.evaluations30d} evaluation${platform.evaluations30d === 1 ? '' : 's'} in ${platformDisplayName} over the last 30 days (below threshold ${threshold})`,
          })
        }
      }
    }

    if (signals.length > 0) {
      out.set(key, signals)
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
