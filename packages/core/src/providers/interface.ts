import type { ZodType, ZodTypeDef } from 'zod'

/** A flag entry as reported by a flag-management platform's API. */
export interface PlatformFlag {
  key: string
  /** Each platform maps its concept (archived/disabled/stale) to this boolean. */
  archived: boolean
  lastModified: Date | null
  /**
   * True when the platform considers this flag permanent — i.e. NOT a
   * temporary feature toggle that should ever be removed. Kill-switches,
   * operational config flags, and "long-lived experiments" fall here.
   *
   * Maps from LaunchDarkly's `temporary` field (we invert: `permanent =
   * !temporary`). Other platforms may not have an equivalent concept —
   * leave undefined when unknown, which the staleness engine treats
   * exactly as it always did (no special-case suppression).
   *
   * Why surface this: the staleness engine's age and low-usage signals
   * are false positives on intentionally permanent flags. A
   * personal-access-tokens kill switch shouldn't be flagged as "stale"
   * just because it's three years old and only appears in one place;
   * that's the entire point of a kill switch.
   */
  permanent?: boolean

  /**
   * When the flag was first created in the platform. Distinct from
   * `lastModified` (which tracks the most recent environment-level
   * edit). The cross-reference layer compares this against the
   * staleness threshold to emit `platform-too-old` — a code-independent
   * staleness signal. A flag that LD created 18 months ago AND still
   * has code references is a stronger candidate for cleanup than either
   * data point alone.
   */
  createdAt?: Date | null

  /**
   * Platform-side classification labels. LaunchDarkly's tag list maps
   * directly; other platforms may map their equivalent concept (Unleash
   * `strategies`, Split.io `traffic_types`, etc.). Surfaced in output
   * so reviewers see the LD-side classification alongside flag names.
   */
  tags?: string[]

  /**
   * Human-readable maintainer label. Producer is responsible for
   * resolving any opaque ID (e.g. LD `maintainerId`) into a display
   * string ('First Last <email>') before populating this field.
   */
  maintainer?: string

  /**
   * Platform-computed activity verdict for this flag in the configured
   * environment. Maps directly from LD's flag-statuses endpoint:
   *
   *   - 'new': created in the last 7 days; not enough data yet → no
   *     staleness verdict, suppresses code-side age signals
   *   - 'active': serving evaluations as expected → no signal
   *   - 'inactive': no evaluation events in 7+ days → emit
   *     `platform-inactive` (warning) — code reference may be dead
   *   - 'launched': single variation served consistently for 7+ days →
   *     emit `platform-launched` (error) — flag is effectively rolled
   *     out and the conditional code can be removed
   *
   * Other platforms may not have an equivalent; leave undefined when
   * unknown.
   */
  status?: 'new' | 'active' | 'inactive' | 'launched'

  /**
   * When this flag was last evaluated, per the platform's runtime
   * telemetry. Null when no evaluations have occurred yet (`status:
   * 'new'`). Surface this in output so reviewers can decide whether
   * "7 days ago" or "9 months ago" before pulling the trigger.
   */
  lastRequested?: Date | null

  /**
   * Total evaluations recorded across all variations in the configured
   * environment over the last 30 days. Distinct from `status` (which is
   * LD's 7-day verdict) — gives a number we can compare against a
   * threshold, and a stronger signal than the status alone.
   *
   *   `0`     → flag definitively unused over the window; emit
   *             `platform-zero-evaluations` (error severity — same as
   *             missing-in-platform: the code path can be removed).
   *   `< N`   → flag rarely evaluated; emit `platform-low-evaluations`
   *             (warning). Threshold N is configurable per-platform.
   *   `>= N`  → no signal — actively used.
   *
   * Set to `null` when the platform supports the field but couldn't
   * resolve a count (e.g. flag just created — no window yet). Set to
   * `undefined` when the platform's evaluation-counts feature isn't
   * available at all (tier-gated, or feature off project-wide). The
   * cross-reference layer treats `undefined` and `null` the same way:
   * no signal emitted.
   */
  evaluations30d?: number | null

  /**
   * Timestamp of the most recent audit-log event for this flag within
   * the configured window (default 90 days). Distinct from
   * `lastModified` (which only tracks env-level edits visible in the
   * flag-list response) — audit log captures EVERY change including
   * toggles, targeting rule edits, prerequisite updates, and approval-
   * workflow events.
   *
   *   `Date`       → most recent activity within the window
   *   `null`       → confirmed NO activity in the window (audit log
   *                  fetched successfully, this flag wasn't in it)
   *   `undefined`  → audit log unavailable (tier-gated, 404, rate
   *                  limit, page cap hit before window exhausted —
   *                  we couldn't confirm)
   *
   * Cross-reference uses the null case to emit
   * `platform-untouched-stale` — particularly valuable for permanent
   * flags where age/usage signals are correctly suppressed but
   * "haven't touched this kill switch in 3 years" is still worth
   * surfacing.
   */
  lastTouched?: Date | null

  /**
   * Variation definitions for this flag — flag-level (identical across envs
   * in LD's data model). Indexed by the same integer the per-env
   * `fallthroughVariation` and `offVariation` fields point at. SaaS-side
   * cleanup pipelines look up the substitute value via these indices
   * instead of guessing from code-side default arguments.
   *
   * Undefined when the platform doesn't expose variation data (other
   * providers without an equivalent concept) or when the flag-list
   * response unexpectedly omits the field.
   */
  variations?: Array<{ value: unknown; name?: string }>

  /**
   * Whether the flag is enabled in the configured env. When false, LD
   * serves `offVariation` regardless of fallthrough/targeting rules.
   * Per-env field — the LD client populates this from the configured env's
   * data on each per-env fetch the orchestrator runs.
   *
   * Undefined when envData itself is absent (archived flags or unexpected
   * API responses).
   */
  on?: boolean

  /**
   * Variation index served by fallthrough when no targeting/rule matches
   * AND `on: true`.
   *   - number → 100% rollout to that variation
   *   - null   → split rollout (`fallthrough.rollout` shape) or fallthrough
   *              absent. **Preserve null literally in output** — SaaS uses
   *              it to detect "can't substitute" and fail closed.
   *
   * Non-optional: the LD client's `?? null` normalization guarantees this
   * field is always set (either a number or null) on every returned flag.
   */
  fallthroughVariation: number | null

  /**
   * Variation index served when `on: false`. Required by LD on every
   * active flag (LD's API rejects flag creation without it). Undefined
   * when the platform omits the field (archived flags or unexpected API
   * responses).
   */
  offVariation?: number
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
  configSchema: ZodType<TConfig, ZodTypeDef, unknown>
  /** Factory — validated config + resolved token → runtime client. No IO until listFlags() is called. */
  createClient: (config: TConfig, token: string) => PlatformClient
}

/** Signal type emitted by crossReference(). Merged into StaleFlag.signals[] by staleness.ts. */
export interface PlatformSignal {
  /**
   * Signal types:
   *
   * - `missing-in-platform` (error): code references a flag that's not
   *   in the platform at all. Almost always a dead reference.
   * - `archived-in-platform` (warning): user archived the flag in the
   *   platform but code still references it — cleanup time.
   * - `platform-permanent` (info, CONTROL signal): user marked the
   *   flag permanent. Tells the staleness engine to suppress age + low-
   *   usage signals; filtered out of user-facing output. See
   *   PlatformFlag.permanent docstring for full reasoning.
   * - `platform-too-old` (warning): the flag was created in the
   *   platform more than `thresholdDays` ago — a code-independent
   *   staleness signal. Survives even when code-age signal is clean
   *   (e.g. flag was copy-pasted into a new file last week, but
   *   originated in LD 2 years ago).
   * - `platform-inactive` (warning): LD's own flag-status verdict —
   *   no evaluations recorded against this flag in the last 7 days.
   *   Sourced from the /flag-statuses endpoint.
   * - `platform-launched` (error): LD's own verdict — flag has been
   *   serving a single variation consistently for the past 7 days.
   *   "Ready for removal" from LD's perspective.
   * - `platform-zero-evaluations` (error): real runtime data — zero
   *   evaluations recorded in the last 30 days. Sourced from LD's
   *   evaluation analytics endpoint. Strongest possible stale signal
   *   because it's based on actual usage, not heuristics.
   * - `platform-low-evaluations` (warning): evaluations below the
   *   configured threshold over the window. Default threshold: 10/30d.
   */
  type:
    | 'missing-in-platform'
    | 'archived-in-platform'
    | 'platform-permanent'
    | 'platform-too-old'
    | 'platform-inactive'
    | 'platform-launched'
    | 'platform-zero-evaluations'
    | 'platform-low-evaluations'
    | 'platform-untouched-stale'
  severity: 'error' | 'warning' | 'info'
  description: string
}
