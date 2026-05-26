import { FlagsResponseSchema } from './types.js'
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
  for (const archivedOnly of [false, true]) {
    let path: string | undefined = buildFirstPath(
      config.project,
      config.environment,
      archivedOnly,
    )
    while (path) {
      const res = await fetchFn(new URL(path, apiBase), {
        headers: {
          Authorization: config.token,
          'LD-API-Version': LD_API_VERSION,
        },
        signal: opts.signal,
      })
      if (!res.ok) {
        throw new LdApiError(`LaunchDarkly API ${res.status} ${res.statusText}`, res.status)
      }
      const json = await res.json()
      const parsed = FlagsResponseSchema.parse(json)
      for (const item of parsed.items) {
        const envData = item.environments?.[config.environment]
        out.push({
          key: item.key,
          archived: item.archived,
          lastModified: envData?.lastModified != null ? new Date(envData.lastModified) : null,
        })
      }
      path = parsed._links?.next?.href
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
