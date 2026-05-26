import {
  FlagsResponseSchema,
  FlagStatusesResponseSchema,
  MembersResponseSchema,
} from './types.js'
import { LdApiError } from './errors.js'
import type { PlatformFlag } from '../interface.js'

const DEFAULT_API_BASE = 'https://app.launchdarkly.com'
const LD_API_VERSION = '20240415'

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

  return out
}

function buildFirstPath(project: string, environment: string, archived = false): string {
  const params = new URLSearchParams({
    env: environment,
    limit: '100',
    offset: '0',
    summary: '1',
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
