import pLimit from 'p-limit'

import {
  AuditLogResponseSchema,
  EvaluationsResponseSchema,
  FlagsResponseSchema,
  FlagStatusesResponseSchema,
  MembersResponseSchema,
} from './types.js'
import { LdApiError } from './errors.js'
import type { PlatformFlag } from '../interface.js'

const DEFAULT_API_BASE = 'https://app.launchdarkly.com'
const LD_API_VERSION = '20240415'

// Audit-log fetching parameters.
//
//   AUDIT_LOG_WINDOW_DAYS controls the lookback window. A flag with NO
//   audit entries in the window is considered "untouched" → emit the
//   platform-untouched-stale signal. 90 days is the default — long
//   enough that quarterly review cycles still mark genuinely-stale
//   permanent flags, short enough that rarely-toggled but ACTIVE
//   flags don't false-positive.
//
//   AUDIT_LOG_MAX_PAGES caps pagination. LD's audit-log endpoint has a
//   max page size of 20; 30 pages × 20 entries = 600-event budget per
//   scan. For projects with more than 600 audit events in the window
//   we hit the cap before exhausting the window, and the lastTouched
//   field stays undefined for every flag — better than false
//   positives on heavily-active projects.
const AUDIT_LOG_WINDOW_DAYS = 90
const AUDIT_LOG_MAX_PAGES = 30
const AUDIT_LOG_LIMIT = 20 // LD's hard ceiling per page

// Concurrency cap on the per-flag evaluation-counts fetch fan-out.
// LD's per-token rate limit is documented at "thousands of requests per
// minute"; 5 in-flight keeps us comfortably under any reasonable cap
// even on 200-flag projects. Higher = faster scans, more rate-limit
// risk. Kept private (not configurable) because tuning this should be
// a deliberate change visible in code review.
const EVALUATIONS_CONCURRENCY = 5

export interface FetchAllFlagsConfig {
  project: string
  environment: string
  token: string
}

export interface FetchAllFlagsOptions {
  apiBase?: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

/**
 * Fetches every flag in `config.project` (active + archived), then enriches
 * the result with platform-side signals from two auxiliary LD endpoints:
 *
 *   /api/v2/flag-statuses/{project}/{env}     → status + lastRequested
 *   /api/v2/members?limit=500                 → maintainer name resolution
 *
 * Both auxiliary calls are best-effort: if they fail (e.g. token lacks
 * permission, network blip), we log via thrown LdApiError only for the
 * primary /flags request. Aux failures are swallowed so the core
 * cross-reference path still functions with partial data.
 */
export async function fetchAllFlags(
  config: FetchAllFlagsConfig,
  opts: FetchAllFlagsOptions = {},
): Promise<PlatformFlag[]> {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE
  const out: PlatformFlag[] = []

  // LD's list endpoint EXCLUDES archived flags by default; passing
  // `archived=true` flips it to return ONLY archived flags. There is no
  // "both" mode in the v2 API. So we make two pagination passes — one
  // for active, one for archived — and union the results. Without this,
  // any flag archived in LD silently surfaces as `missing-in-platform`
  // (the exact opposite of `archived-in-platform`), defeating the
  // archived-flag signal entirely.
  const headers = { Authorization: config.token, 'LD-API-Version': LD_API_VERSION }
  const maintainerIds = new Set<string>()
  for (const archivedOnly of [false, true]) {
    let path: string | undefined = buildFirstPath(
      config.project,
      config.environment,
      archivedOnly,
    )
    while (path) {
      const res = await fetchFn(new URL(path, apiBase), { headers, signal: opts.signal })
      if (!res.ok) {
        throw new LdApiError(`LaunchDarkly API ${res.status} ${res.statusText}`, res.status)
      }
      const json = await res.json()
      const parsed = FlagsResponseSchema.parse(json)
      for (const item of parsed.items) {
        const envData = item.environments?.[config.environment]
        if (item.maintainerId) maintainerIds.add(item.maintainerId)
        out.push({
          key: item.key,
          archived: item.archived,
          lastModified: envData?.lastModified != null ? new Date(envData.lastModified) : null,
          // LD's `temporary` is true when the user wants the flag removed
          // eventually, false when it's permanent. We invert so downstream
          // logic doesn't have to re-reason the polarity every time.
          permanent: !item.temporary,
          createdAt: item.creationDate != null ? new Date(item.creationDate) : null,
          tags: item.tags,
          // Resolved below from the /members lookup; left as the opaque id
          // for now so the producer/consumer split stays clean.
          maintainer: item.maintainerId,
          // The cast narrows the inferred type from `VariationSchema.passthrough()`
          // (which infers `Record<string, unknown>` for extra fields) back to the
          // declared `PlatformFlag.variations` shape. The runtime data is
          // identical; the cast is a structural type-narrowing only.
          variations: item.variations as Array<{ value: unknown; name?: string }> | undefined,
          on: envData?.on,
          fallthroughVariation: envData?.fallthrough?.variation ?? null,
          offVariation: envData?.offVariation,
        })
      }
      path = parsed._links?.next?.href
    }
  }

  // Aux 1: resolve maintainer IDs → "First Last <email>" display strings.
  // Single batch request, best-effort. If the token lacks /members read
  // permission (Reader role doesn't include it on some LD orgs), we
  // leave the opaque ID in place rather than fail the whole scan.
  if (maintainerIds.size > 0) {
    const members = await fetchMembersMap(apiBase, headers, fetchFn, opts.signal)
    if (members) {
      for (const flag of out) {
        if (flag.maintainer && members.has(flag.maintainer)) {
          flag.maintainer = members.get(flag.maintainer)
        } else if (flag.maintainer) {
          // Couldn't resolve — drop the opaque ID rather than display it.
          flag.maintainer = undefined
        }
      }
    } else {
      // Members lookup failed entirely — strip the opaque IDs so they
      // don't leak into output as garbled-looking strings.
      for (const flag of out) {
        if (flag.maintainer) flag.maintainer = undefined
      }
    }
  }

  // Aux 2: fetch the per-environment flag-status verdict (LD's own
  // staleness: 'new' / 'active' / 'inactive' / 'launched'). Cross-reference
  // turns these into platform-inactive / platform-launched signals.
  const statuses = await fetchFlagStatuses(
    config.project,
    config.environment,
    apiBase,
    headers,
    fetchFn,
    opts.signal,
  )
  if (statuses) {
    for (const flag of out) {
      const s = statuses.get(flag.key)
      if (s) {
        flag.status = s.name
        flag.lastRequested = s.lastRequested
      }
    }
  }

  // Aux 3: 30-day evaluation counts per flag. Per-flag endpoint, so we
  // fan out with a concurrency cap. The endpoint is tier-gated; the
  // first 404/403/401 short-circuits the rest so we don't make N
  // pointless requests on accounts that don't have this feature.
  // Active flags only — archived flags have no evaluation activity by
  // definition, and probing them wastes API calls.
  await enrichWithEvaluations(out, config, apiBase, headers, fetchFn, opts.signal)

  // Aux 4: per-flag last-touched timestamp from the audit log. Single
  // paginated endpoint, scoped to the project+env, windowed to the
  // last AUDIT_LOG_WINDOW_DAYS. Builds a Map<flagKey, lastEventDate>
  // from up to AUDIT_LOG_MAX_PAGES of entries. Flags absent from the
  // map after a successful fetch get `lastTouched: null` (confirmed
  // untouched in the window); flags present get the latest event date.
  // On failure / page-cap-hit / unavailable endpoint, lastTouched
  // stays undefined for every flag.
  const lastTouched = await fetchLastTouchedMap(config, apiBase, headers, fetchFn, opts.signal)
  if (lastTouched !== null) {
    for (const flag of out) {
      if (flag.archived) continue
      flag.lastTouched = lastTouched.get(flag.key) ?? null
    }
  }

  return out
}

/**
 * Fan-out fetch of 30-day evaluation counts per (active, non-archived)
 * flag. Mutates the input PlatformFlag[] in place — sets
 * `evaluations30d` to a number on success, leaves it undefined when
 * the endpoint isn't available. The first request that returns 401 /
 * 403 / 404 disables the feature for the rest of the batch (assumed
 * to be tier-gated or feature-off project-wide).
 *
 * Network errors on individual flags are tolerated: that single flag's
 * `evaluations30d` stays undefined and the rest of the scan continues.
 * Cross-reference treats `undefined` as "no data, no signal".
 */
async function enrichWithEvaluations(
  flags: PlatformFlag[],
  config: FetchAllFlagsConfig,
  apiBase: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<void> {
  const candidates = flags.filter((f) => !f.archived)
  if (candidates.length === 0) return

  let featureAvailable = true
  const limiter = pLimit(EVALUATIONS_CONCURRENCY)

  await Promise.all(
    candidates.map((flag) =>
      limiter(async () => {
        if (!featureAvailable) return
        try {
          const url = new URL(
            `/api/v2/usage/evaluations/${encodeURIComponent(config.project)}/${encodeURIComponent(config.environment)}/${encodeURIComponent(flag.key)}`,
            apiBase,
          )
          const res = await fetchFn(url, { headers, signal })
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            // Disable for the rest of the batch — assume tier-gated /
            // feature off for this project. Leave already-set
            // evaluations30d alone (no rollback).
            featureAvailable = false
            return
          }
          if (!res.ok) {
            // 5xx / 429 — transient. Skip this flag, keep the feature
            // enabled for others.
            return
          }
          const parsed = EvaluationsResponseSchema.parse(await res.json())
          flag.evaluations30d = sumEvaluationSeries(parsed.series)
        } catch {
          // Network error / JSON parse failure — same treatment as 5xx,
          // skip this flag, keep going.
        }
      }),
    ),
  )
}

/**
 * The /usage/evaluations response is a time-series of variation-keyed
 * counts: each series point is `{ time, "0": N, "1": M, ... }`. We
 * don't care which variation served — only the total. Sum every
 * numeric field on every series point.
 */
function sumEvaluationSeries(series: Array<Record<string, unknown>>): number {
  let total = 0
  for (const point of series) {
    for (const [key, value] of Object.entries(point)) {
      if (key === 'time') continue
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value
      }
    }
  }
  return total
}

function buildFirstPath(project: string, environment: string, archived = false): string {
  const params = new URLSearchParams({
    env: environment,
    limit: '100',
    offset: '0',
    // summary=0 returns full flag objects with variations + per-env
    // fallthrough/on/offVariation. summary=1 (the previous default) only
    // returned key/tags/lastModified, which was insufficient for SaaS
    // Piranha to substitute the correct value during cleanup. Payload
    // grows ~1-5KB per flag — well within reasonable for paginated fetch.
    summary: '0',
  })
  if (archived) params.set('archived', 'true')
  return `/api/v2/flags/${encodeURIComponent(project)}?${params.toString()}`
}

/**
 * Best-effort fetch of every LD member, returning a map from member ID
 * to "First Last <email>" display string. Returns null when the API
 * rejects the request (typically: token lacks /members read scope).
 * Caller handles null by leaving maintainer fields unresolved.
 */
async function fetchMembersMap(
  apiBase: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<Map<string, string> | null> {
  try {
    const url = new URL('/api/v2/members?limit=500', apiBase)
    const res = await fetchFn(url, { headers, signal })
    if (!res.ok) return null
    const parsed = MembersResponseSchema.parse(await res.json())
    const map = new Map<string, string>()
    for (const m of parsed.items) {
      const name = [m.firstName, m.lastName].filter((s) => s).join(' ').trim()
      const display = name ? `${name} <${m.email}>` : m.email
      map.set(m._id, display)
    }
    return map
  } catch {
    /* v8 ignore start — defensive catch for malformed JSON / schema
       drift; not exercised by current fixtures. */
    return null
    /* v8 ignore stop */
  }
}

/**
 * Best-effort fetch of LD's per-environment flag-status verdicts for
 * every flag in the project. Returns a Map keyed by flag key whose
 * values include LD's own staleness verdict (`name`) and the
 * lastRequested timestamp. Returns null when the API rejects the
 * request — cross-reference falls back to its non-status code paths.
 *
 * The parent-link parsing extracts the flag key from
 * `/api/v2/flags/{project}/{flagKey}` — LD doesn't return the key
 * inline on each status item.
 */
async function fetchFlagStatuses(
  project: string,
  environment: string,
  apiBase: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<Map<string, { name: 'new' | 'active' | 'inactive' | 'launched'; lastRequested: Date | null }> | null> {
  try {
    const url = new URL(
      `/api/v2/flag-statuses/${encodeURIComponent(project)}/${encodeURIComponent(environment)}`,
      apiBase,
    )
    const res = await fetchFn(url, { headers, signal })
    if (!res.ok) return null
    const parsed = FlagStatusesResponseSchema.parse(await res.json())
    const out = new Map<string, { name: 'new' | 'active' | 'inactive' | 'launched'; lastRequested: Date | null }>()
    for (const item of parsed.items) {
      /* v8 ignore start — defensive guards against LD responses without
         a parent link or with malformed hrefs; production LD always
         sends a well-formed href on this endpoint, but we'd rather
         skip a single item than fail the whole batch on contract drift. */
      const href = item._links?.parent?.href ?? ''
      const key = href.includes('/') ? href.slice(href.lastIndexOf('/') + 1) : ''
      if (!key) continue
      /* v8 ignore stop */
      out.set(key, {
        name: item.name,
        lastRequested: item.lastRequested ? new Date(item.lastRequested) : null,
      })
    }
    return out
  } catch {
    /* v8 ignore start — defensive catch for malformed JSON / schema
       drift; not exercised by current fixtures. */
    return null
    /* v8 ignore stop */
  }
}

/**
 * Best-effort fetch of recent audit-log entries for the configured
 * project + environment, scoped to flag events. Returns a Map keyed
 * by flag key whose values are the most recent event timestamp within
 * the lookback window for that flag.
 *
 * `null` return = couldn't fetch (endpoint unavailable, page cap hit
 * before window exhausted, network error). In that case cross-reference
 * skips the untouched-stale signal entirely — better than false
 * positives on heavily-active projects.
 *
 * Pagination: LD's audit-log endpoint caps page size at 20 entries. We
 * paginate up to AUDIT_LOG_MAX_PAGES (30) = 600-entry budget. Audit
 * events older than (now - AUDIT_LOG_WINDOW_DAYS) are filtered out by
 * the `after` query param.
 *
 * Flag-key extraction: each entry's `target.resources` array contains
 * resource specifier strings like
 * `proj/{proj}:env/{env}:flag/{flagKey}`. We extract the trailing
 * flagKey segment.
 */
async function fetchLastTouchedMap(
  config: FetchAllFlagsConfig,
  apiBase: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<Map<string, Date> | null> {
  const lastTouched = new Map<string, Date>()
  const after = Date.now() - AUDIT_LOG_WINDOW_DAYS * 86_400_000
  const spec = `proj/${config.project}:env/${config.environment}:flag/*`
  const flagKeyPattern = /:flag\/([^:]+)$/

  const params = new URLSearchParams({
    spec,
    after: String(after),
    limit: String(AUDIT_LOG_LIMIT),
  })
  let path: string | undefined = `/api/v2/auditlog?${params.toString()}`
  let pages = 0

  while (path && pages < AUDIT_LOG_MAX_PAGES) {
    pages++
    try {
      const res = await fetchFn(new URL(path, apiBase), { headers, signal })
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return null
      }
      if (!res.ok) return null
      const parsed = AuditLogResponseSchema.parse(await res.json())
      for (const item of parsed.items) {
        const resources = item.target?.resources ?? []
        for (const r of resources) {
          const m = flagKeyPattern.exec(r)
          if (!m) continue
          const flagKey = m[1]
          const date = new Date(item.date)
          const existing = lastTouched.get(flagKey)
          if (!existing || date > existing) {
            lastTouched.set(flagKey, date)
          }
        }
      }
      path = parsed._links?.next?.href
    } catch {
      /* v8 ignore start — defensive catch for malformed JSON / schema
         drift; not exercised by current fixtures. */
      return null
      /* v8 ignore stop */
    }
  }

  // Hit the page cap before the API said "no more pages" — we can't
  // be sure we've seen every flag's recent activity. Return null so
  // the caller treats every flag as "lastTouched unknown" rather than
  // emitting false positives.
  if (path) return null

  return lastTouched
}
