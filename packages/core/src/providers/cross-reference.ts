import type { FeatureFlag } from '../detection/feature-flag.js'
import type { PlatformFlag, PlatformSignal } from './interface.js'

/**
 * Per-flag, per-environment view of platform data. Outer key is the flag
 * key; inner key is the environment name as declared in the user's
 * `environments: [...]` config. Built by the orchestrator (one
 * listFlags() call per env, stitched).
 *
 * Single-env callers wrap their data in a one-entry inner Map. The
 * shape is the same — only env count varies.
 */
export type PerEnvFlags = Map<string, Map<string, PlatformFlag>>

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
 * Render an env attribution suffix for a multi-env signal description.
 *
 *   fmtEnvs(['production'], ['production', 'staging'])  // 'in production'
 *   fmtEnvs(['production', 'staging'], ['production', 'staging'])  // 'everywhere'
 *
 * Order of envs in the output follows the order of `all` (i.e. the
 * config-declared order, since that's the order the orchestrator builds
 * the inner perEnv map in).
 */
function fmtEnvs(triggered: string[], all: string[]): string {
  // Both empty would render 'everywhere' without the second guard, which
  // is semantically wrong. Current call sites all gate on triggered.length > 0
  // before invoking; the guard is defensive insurance for future callers.
  if (triggered.length === all.length && triggered.length > 0) return 'everywhere'
  const ordered = all.filter((e) => triggered.includes(e))
  return `in ${ordered.join(', ')}`
}

/**
 * Pure function: joins detected flag keys against a platform's per-env flag
 * map, emits PlatformSignals based on the platform's view of each flag.
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
  platformFlagsByEnv: PerEnvFlags,
  platformDisplayName: string,
  options: CrossReferenceOptions = {},
): Map<string, PlatformSignal[]> {
  const out = new Map<string, PlatformSignal[]>()
  const now = Date.now()
  const thresholdMs = options.thresholdDays != null ? options.thresholdDays * 86_400_000 : null

  for (const key of detectedFlags.keys()) {
    const envMap = platformFlagsByEnv.get(key)
    if (!envMap || envMap.size === 0) {
      out.set(key, [
        {
          type: 'missing-in-platform',
          severity: 'error',
          description: `referenced in code but not found in ${platformDisplayName}`,
        },
      ])
      continue
    }

    // Flag-level fields (archived, permanent, tags, maintainer, createdAt)
    // are identical across envs in LD's data model. Read them from the
    // first env's entry.
    const firstEntry = envMap.values().next().value as PlatformFlag
    if (firstEntry.archived) {
      out.set(key, [
        {
          type: 'archived-in-platform',
          severity: 'warning',
          description: `archived in ${platformDisplayName}`,
        },
      ])
      continue
    }

    const signals: PlatformSignal[] = []
    const allEnvs = Array.from(envMap.keys())

    // platform-launched: fire-on-any with env attribution. Inactive is
    // handled in a separate block below so we can suppress it when any
    // env is launched (they're contradictory states).
    const launchedEnvs = allEnvs.filter((e) => envMap.get(e)!.status === 'launched')
    if (launchedEnvs.length > 0) {
      const where = fmtEnvs(launchedEnvs, allEnvs)
      signals.push({
        type: 'platform-launched',
        severity: 'error',
        description: `${platformDisplayName} reports this flag has served one variation for 7+ days ${where} — likely ready for removal`,
      })
    }
    // platform-inactive: fire-on-any-env, BUT suppress when any env is
    // launched (they're contradictory; launched is the more severe
    // and more actionable signal).
    if (launchedEnvs.length === 0) {
      const inactiveEnvs = allEnvs.filter((e) => envMap.get(e)!.status === 'inactive')
      if (inactiveEnvs.length > 0) {
        const where = fmtEnvs(inactiveEnvs, allEnvs)
        signals.push({
          type: 'platform-inactive',
          severity: 'warning',
          description: `no evaluations recorded in ${platformDisplayName} ${where} in the last 7+ days`,
        })
      }
    }

    if (firstEntry.permanent) {
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
      !firstEntry.permanent &&
      thresholdMs != null &&
      firstEntry.createdAt &&
      now - firstEntry.createdAt.getTime() > thresholdMs
    ) {
      const ageDays = Math.floor((now - firstEntry.createdAt.getTime()) / 86_400_000)
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
    //
    // platform-zero-evaluations: fire-on-any with env attribution.
    // platform-low-evaluations: fire-on-any with env attribution, BUT
    // suppress when any env reports zero (zero is the stronger signal;
    // emitting both creates noise without adding information).
    if (!firstEntry.permanent) {
      const zeroEnvs: string[] = []
      const lowByEnv: Array<{ env: string; count: number }> = []
      const threshold = options.evaluationThreshold ?? 10
      for (const env of allEnvs) {
        const evals = envMap.get(env)!.evaluations30d
        if (typeof evals !== 'number') continue
        if (evals === 0) {
          zeroEnvs.push(env)
        } else if (evals < threshold) {
          lowByEnv.push({ env, count: evals })
        }
      }
      if (zeroEnvs.length > 0) {
        const where = fmtEnvs(zeroEnvs, allEnvs)
        signals.push({
          type: 'platform-zero-evaluations',
          severity: 'error',
          description: `${platformDisplayName} reports 0 evaluations ${where} over the last 30 days — code path is unused`,
        })
      } else if (lowByEnv.length > 0) {
        // Pick the env with the LOWEST count for the canonical
        // description; render the env list when multiple envs are low.
        const lowEnvs = lowByEnv.map((e) => e.env)
        const lowest = lowByEnv.reduce((a, b) => (a.count <= b.count ? a : b))
        const where = fmtEnvs(lowEnvs, allEnvs)
        // When multiple envs are low with different counts, "only N" is
        // ambiguous (reads as 'each env has N'). "as few as N" makes the
        // minimum-across-envs framing explicit. With one low env, "only N"
        // is the right phrasing — exactly N evaluations in exactly that env.
        const countPhrase = lowByEnv.length > 1
          ? `as few as ${lowest.count}`
          : `only ${lowest.count}`
        signals.push({
          type: 'platform-low-evaluations',
          severity: 'warning',
          description: `${platformDisplayName} reports ${countPhrase} evaluation${lowest.count === 1 ? '' : 's'} ${where} over the last 30 days (below threshold ${threshold})`,
        })
      }
    }

    // platform-untouched-stale: STRICT all-envs rule.
    // Untouched only counts if EVERY env's audit log was successfully
    // fetched AND showed zero activity (lastTouched === null exactly —
    // not undefined, which means the fetch couldn't confirm). A flag
    // toggled in staging counts as touched; a flag whose staging audit
    // log we couldn't read is "unknown", not "untouched".
    //
    // Unlike most signals, this is NOT suppressed for permanent flags —
    // a kill switch untouched for 3 years should still get a periodic
    // review even if the user intends to keep it permanent.
    const allUntouched = allEnvs.length > 0
      && allEnvs.every((e) => envMap.get(e)!.lastTouched === null)
    if (allUntouched) {
      // TODO: '90+ days' is hardcoded to AUDIT_LOG_WINDOW_DAYS in the LD
      // client (packages/core/src/providers/launchdarkly/client.ts). If
      // the window becomes a config knob, plumb the actual value through
      // here so the description doesn't lie.
      signals.push({
        type: 'platform-untouched-stale',
        severity: 'warning',
        description: `no activity in ${platformDisplayName} ${fmtEnvs(allEnvs, allEnvs)} for 90+ days (audit log)`,
      })
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
