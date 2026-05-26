/**
 * Integration tests for fetchAllFlags against a real local HTTP server.
 *
 * Why: every other LD client test injects a fake `fetch`, which is great
 * for the contract but never exercises Node.js's real `fetch` /
 * `Headers` / `URL` resolution. This file fills the gap by standing up
 * a tiny `node:http` server that mimics the shape of LD's
 * `GET /api/v2/flags/{project}` response and points the client at it
 * via `apiBase`.
 *
 * Routes the server handles (each test sets the response per route):
 *   /api/v2/flags/...?archived=true   → archivedResponses[]
 *   /api/v2/flags/...                  → activeResponses[]
 *   /api/v2/members?...                → membersResponse
 *   /api/v2/flag-statuses/{p}/{env}    → flagStatusesResponse
 *
 * activeResponses and archivedResponses are arrays so a single test
 * can drive pagination by queueing multiple bodies; the response served
 * for the Nth matching request is responses[N]. Falls back to an empty
 * page when the array is exhausted (keeps unrelated tests valid even
 * though the new aux calls fire on every fetchAllFlags invocation).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { fetchAllFlags } from '../../../src/providers/launchdarkly/client.js'
import { LdApiError } from '../../../src/providers/launchdarkly/errors.js'

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
}

interface RouteResponse {
  status: number
  body: unknown
}

let server: Server
let apiBase: string
let recorded: RecordedRequest[] = []
let activeResponses: RouteResponse[] = []
let archivedResponses: RouteResponse[] = []
let membersResponse: RouteResponse = { status: 200, body: { items: [] } }
let flagStatusesResponse: RouteResponse = { status: 200, body: { items: [] } }
// Evaluation counts are PER-FLAG, so we route by flag key. The fallback
// (empty series → 0 evaluations) keeps existing tests stable without
// each needing to declare evaluation responses.
let evaluationsResponses: Map<string, RouteResponse> = new Map()
let evaluationsDefault: RouteResponse = { status: 200, body: { series: [] } }
let evaluationRequests: string[] = []
// Audit-log uses a single endpoint with paginated responses. We model
// it as a queue (`auditLogResponses[N]` for the Nth page); empty queue
// = single empty-items page (= confirmed-no-activity in the window).
let auditLogResponses: RouteResponse[] = []
let auditLogCursor = 0
let auditLogRequests: string[] = []
let activeCursor = 0
let archivedCursor = 0

const EMPTY_FLAGS: RouteResponse = { status: 200, body: { items: [], totalCount: 0 } }

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    recorded.push({
      method: req.method ?? '',
      url,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(',') : v ?? '',
        ]),
      ),
    })
    let r: RouteResponse
    if (url.startsWith('/api/v2/flag-statuses/')) {
      r = flagStatusesResponse
    } else if (url.startsWith('/api/v2/members')) {
      r = membersResponse
    } else if (url.startsWith('/api/v2/usage/evaluations/')) {
      // Path: /api/v2/usage/evaluations/{project}/{env}/{flagKey}
      // Decode the flag key + record the request so tests can assert
      // which flags were probed.
      const flagKey = decodeURIComponent(url.split('/').pop() ?? '')
      evaluationRequests.push(flagKey)
      r = evaluationsResponses.get(flagKey) ?? evaluationsDefault
    } else if (url.startsWith('/api/v2/auditlog')) {
      // Audit-log endpoint, single URL, paginated by `_links.next.href`.
      // Serve responses from the queue; empty queue = empty page.
      auditLogRequests.push(url)
      r = auditLogResponses[auditLogCursor++] ?? {
        status: 200,
        body: { items: [] },
      }
    } else if (url.includes('archived=true')) {
      r = archivedResponses[archivedCursor++] ?? EMPTY_FLAGS
    } else {
      r = activeResponses[activeCursor++] ?? EMPTY_FLAGS
    }
    res.writeHead(r.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(r.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  apiBase = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  recorded = []
  activeResponses = []
  archivedResponses = []
  membersResponse = { status: 200, body: { items: [] } }
  flagStatusesResponse = { status: 200, body: { items: [] } }
  evaluationsResponses = new Map()
  evaluationsDefault = { status: 200, body: { series: [] } }
  evaluationRequests = []
  auditLogResponses = []
  auditLogCursor = 0
  auditLogRequests = []
  activeCursor = 0
  archivedCursor = 0
})

describe('fetchAllFlags — real HTTP integration', () => {
  it('200 happy path: sends Authorization + LD-API-Version headers verbatim', async () => {
    activeResponses = [
      {
        status: 200,
        body: {
          items: [
            { key: 'show-new-checkout', archived: false },
            { key: 'experimental-search', archived: true },
          ],
          totalCount: 2,
        },
      },
    ]
    const flags = await fetchAllFlags(
      { project: 'my-project', environment: 'production', token: 'api-real-token-xyz' },
      { apiBase },
    )

    expect(flags).toHaveLength(2)
    expect(flags[0]).toMatchObject({ key: 'show-new-checkout', archived: false })
    expect(flags[1]).toMatchObject({ key: 'experimental-search', archived: true })

    const firstFlagsReq = recorded.find((r) => r.url.startsWith('/api/v2/flags/'))!
    expect(firstFlagsReq.method).toBe('GET')
    expect(firstFlagsReq.url).toBe(
      '/api/v2/flags/my-project?env=production&limit=100&offset=0&summary=1',
    )
    // Auth header is raw (no Bearer prefix); LD-API-Version is the pinned date.
    expect(firstFlagsReq.headers.authorization).toBe('api-real-token-xyz')
    expect(firstFlagsReq.headers['ld-api-version']).toBe('20240415')
  })

  it('extracts lastModified from per-environment metadata', async () => {
    const ts = 1715200000000
    activeResponses = [
      {
        status: 200,
        body: {
          items: [
            {
              key: 'staleness-flag',
              archived: false,
              environments: {
                production: { lastModified: ts, _summary: { variations: {} } },
                staging: { lastModified: 999 },
              },
            },
          ],
          totalCount: 1,
        },
      },
    ]
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags[0].lastModified).toEqual(new Date(ts))
  })

  it('paginates via _links.next.href (relative path → resolved against apiBase)', async () => {
    activeResponses = [
      {
        status: 200,
        body: {
          items: [{ key: 'page-1-flag', archived: false }],
          totalCount: 2,
          _links: { next: { href: '/api/v2/flags/p?offset=1&limit=100&summary=1' } },
        },
      },
      {
        status: 200,
        body: { items: [{ key: 'page-2-flag', archived: false }], totalCount: 2 },
      },
    ]
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags.map((f) => f.key)).toEqual(['page-1-flag', 'page-2-flag'])
    // 4 requests: active page 1 + page 2 + archived (empty) + flag-statuses.
    // /members is skipped because no flag has a maintainerId.
    const flagRequests = recorded.filter((r) => r.url.startsWith('/api/v2/flags/'))
    expect(flagRequests).toHaveLength(3)
    expect(flagRequests[1].url).toBe('/api/v2/flags/p?offset=1&limit=100&summary=1')
    expect(flagRequests[2].url).toContain('archived=true')
  })

  // Regression coverage for the real-LD bug discovered during pre-launch
  // validation: LD's list endpoint excludes archived flags by default, so
  // fetchAllFlags now makes a second pass with archived=true and unions
  // the results.
  it('unions active and archived flags from two separate API passes', async () => {
    activeResponses = [
      {
        status: 200,
        body: {
          items: [
            { key: 'active-flag', archived: false },
            { key: 'another-active', archived: false },
          ],
          totalCount: 2,
        },
      },
    ]
    archivedResponses = [
      { status: 200, body: { items: [{ key: 'archived-flag', archived: true }], totalCount: 1 } },
    ]
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags.map((f) => f.key).sort()).toEqual([
      'active-flag',
      'another-active',
      'archived-flag',
    ])
    expect(flags.find((f) => f.key === 'archived-flag')?.archived).toBe(true)
    const flagRequests = recorded.filter((r) => r.url.startsWith('/api/v2/flags/'))
    expect(flagRequests).toHaveLength(2)
    expect(flagRequests[0].url).not.toContain('archived=true')
    expect(flagRequests[1].url).toContain('archived=true')
  })

  it('401 from LD surfaces as LdApiError with status: 401', async () => {
    activeResponses = [{ status: 401, body: { message: 'invalid token' } }]
    await expect(
      fetchAllFlags(
        { project: 'p', environment: 'e', token: 'wrong-token' },
        { apiBase },
      ),
    ).rejects.toThrow(LdApiError)
  })

  it('403 from LD (project-scoped token, wrong project) surfaces with status: 403', async () => {
    activeResponses = [{ status: 403, body: { message: 'forbidden for this project' } }]
    try {
      await fetchAllFlags(
        { project: 'unauthorized', environment: 'e', token: 't' },
        { apiBase },
      )
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(LdApiError)
      expect((err as LdApiError).status).toBe(403)
    }
  })

  it('URL-encodes a project key with reserved characters', async () => {
    await fetchAllFlags(
      { project: 'team/my project', environment: 'e', token: 't' },
      { apiBase },
    )
    const flagsUrl = recorded.find((r) => r.url.startsWith('/api/v2/flags/'))!.url
    expect(flagsUrl).toContain('team%2Fmy%20project')
  })

  it('accepts a response with unknown extra fields (schema is permissive)', async () => {
    activeResponses = [
      {
        status: 200,
        body: {
          items: [
            {
              key: 'flag-a',
              archived: false,
              kind: 'boolean',
              tags: ['ux', 'experiment'],
              maintainer: { firstName: 'Jane', lastName: 'Doe' },
            },
          ],
          totalCount: 1,
          _links: { self: { href: '/api/v2/flags/p' } },
        },
      },
    ]
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { apiBase },
    )
    expect(flags[0].key).toBe('flag-a')
    expect(flags[0].tags).toEqual(['ux', 'experiment'])
  })

  it('extracts creationDate, populates createdAt, fetches flag-statuses + members', async () => {
    activeResponses = [
      {
        status: 200,
        body: {
          items: [
            {
              key: 'flag-with-everything',
              archived: false,
              temporary: false,
              creationDate: 1700000000000,
              tags: ['kill-switch'],
              maintainerId: 'mem-abc',
            },
          ],
          totalCount: 1,
        },
      },
    ]
    membersResponse = {
      status: 200,
      body: {
        items: [
          { _id: 'mem-abc', email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' },
        ],
      },
    }
    flagStatusesResponse = {
      status: 200,
      body: {
        items: [
          {
            name: 'inactive',
            lastRequested: '2024-01-15T10:00:00Z',
            _links: { parent: { href: '/api/v2/flags/p/flag-with-everything' } },
          },
        ],
      },
    }

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({
      key: 'flag-with-everything',
      archived: false,
      permanent: true,
      tags: ['kill-switch'],
      maintainer: 'Jane Doe <jane@example.com>',
      status: 'inactive',
    })
    expect(flags[0].createdAt).toEqual(new Date(1700000000000))
    expect(flags[0].lastRequested).toEqual(new Date('2024-01-15T10:00:00Z'))
  })

  it('catches schema-parse failure from /members and returns unresolved maintainer', () => {
    // Hits the catch block in fetchMembersMap: /members returns 200
    // but with a body the schema rejects (no `items` field). The
    // try/catch should swallow it and downstream code should drop
    // the opaque maintainerId.
    activeResponses = [
      {
        status: 200,
        body: {
          items: [{ key: 'flag-a', archived: false, maintainerId: 'mem-x' }],
          totalCount: 1,
        },
      },
    ]
    membersResponse = { status: 200, body: { not_an_items_array: true } }
    return fetchAllFlags({ project: 'p', environment: 'e', token: 't' }, { apiBase }).then(
      (flags) => {
        expect(flags[0].maintainer).toBeUndefined()
      },
    )
  })

  it('catches schema-parse failure from /flag-statuses and returns no status', () => {
    activeResponses = [
      { status: 200, body: { items: [{ key: 'flag-a', archived: false }], totalCount: 1 } },
    ]
    flagStatusesResponse = { status: 200, body: { wrong: 'shape' } }
    return fetchAllFlags({ project: 'p', environment: 'e', token: 't' }, { apiBase }).then(
      (flags) => {
        expect(flags[0].status).toBeUndefined()
      },
    )
  })

  it('falls back to email-only display when a member has no first/last name', () => {
    // Test the `name ? '${name} <${email}>' : email` branch for members
    // whose firstName + lastName are both empty (newly-invited members
    // who haven't completed their profile).
    activeResponses = [
      {
        status: 200,
        body: {
          items: [{ key: 'flag-a', archived: false, maintainerId: 'noname' }],
          totalCount: 1,
        },
      },
    ]
    membersResponse = {
      status: 200,
      body: {
        items: [
          { _id: 'noname', email: 'unnamed@example.com', firstName: '', lastName: '' },
        ],
      },
    }
    return fetchAllFlags({ project: 'p', environment: 'e', token: 't' }, { apiBase }).then(
      (flags) => {
        expect(flags[0].maintainer).toBe('unnamed@example.com')
      },
    )
  })

  it('leaves lastRequested as null when the status item has no timestamp', () => {
    // status='new' flags have lastRequested: null in the API response.
    activeResponses = [
      { status: 200, body: { items: [{ key: 'fresh', archived: false }], totalCount: 1 } },
    ]
    flagStatusesResponse = {
      status: 200,
      body: {
        items: [
          {
            name: 'new',
            lastRequested: null,
            _links: { parent: { href: '/api/v2/flags/p/fresh' } },
          },
        ],
      },
    }
    return fetchAllFlags({ project: 'p', environment: 'e', token: 't' }, { apiBase }).then(
      (flags) => {
        expect(flags[0].status).toBe('new')
        expect(flags[0].lastRequested).toBeNull()
      },
    )
  })

  it('drops opaque maintainerId when /members returns successfully but lacks the id', async () => {
    // Realistic edge: a deactivated member's flag retains the old
    // maintainerId. /members lookup succeeds but returns a list that
    // doesn't include that id. Producer should drop the orphan rather
    // than display the opaque ID.
    activeResponses = [
      {
        status: 200,
        body: {
          items: [{ key: 'orphan-flag', archived: false, maintainerId: 'ghost-id' }],
          totalCount: 1,
        },
      },
    ]
    membersResponse = {
      status: 200,
      body: {
        items: [
          { _id: 'someone-else', email: 'live@example.com', firstName: 'Live', lastName: 'User' },
        ],
      },
    }
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { apiBase },
    )
    expect(flags[0].maintainer).toBeUndefined()
  })

  it('gracefully degrades when members lookup fails (e.g. Reader role lacks scope)', async () => {
    // Same setup as previous test, but /members returns 403. Producer
    // should drop the opaque maintainerId rather than display garbage.
    activeResponses = [
      {
        status: 200,
        body: {
          items: [
            {
              key: 'lonely-flag',
              archived: false,
              maintainerId: 'mem-abc',
            },
          ],
          totalCount: 1,
        },
      },
    ]
    membersResponse = { status: 403, body: { message: 'forbidden' } }

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags[0].key).toBe('lonely-flag')
    // Opaque ID dropped because we couldn't resolve it; the field is
    // undefined so downstream formatters skip the column entirely.
    expect(flags[0].maintainer).toBeUndefined()
  })

  it('gracefully degrades when flag-statuses lookup fails', async () => {
    activeResponses = [
      { status: 200, body: { items: [{ key: 'flag-x', archived: false }], totalCount: 1 } },
    ]
    flagStatusesResponse = { status: 500, body: { message: 'oops' } }

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { apiBase },
    )
    expect(flags[0].key).toBe('flag-x')
    // Status + lastRequested are simply absent — cross-reference treats
    // these as "no platform-side activity signal".
    expect(flags[0].status).toBeUndefined()
    expect(flags[0].lastRequested).toBeUndefined()
  })

  // 30-day evaluation-count enrichment (Tier 1.1 feature).
  describe('evaluation counts enrichment', () => {
    it('sums every variation across every series point to the total', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'live-flag', archived: false }], totalCount: 1 },
        },
      ]
      evaluationsResponses.set('live-flag', {
        status: 200,
        body: {
          series: [
            // Boolean flag → variations keyed "0" and "1". Sum: 100+50 + 200+25 = 375.
            { time: 1, '0': 100, '1': 50 },
            { time: 2, '0': 200, '1': 25 },
          ],
        },
      })
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].evaluations30d).toBe(375)
    })

    it('handles multivariate flags (3+ variation keys)', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'multi', archived: false }], totalCount: 1 },
        },
      ]
      evaluationsResponses.set('multi', {
        status: 200,
        body: {
          series: [
            { time: 1, '0': 10, '1': 20, '2': 30 },
            { time: 2, '0': 5, '1': 15, '2': 25 },
          ],
        },
      })
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // 10+20+30 + 5+15+25 = 105
      expect(flags[0].evaluations30d).toBe(105)
    })

    it('reports 0 evaluations when LD returns an empty series', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'unused', archived: false }], totalCount: 1 },
        },
      ]
      // evaluationsDefault is already {series: []} from beforeEach.
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].evaluations30d).toBe(0)
    })

    it('skips evaluation fetch entirely for archived flags', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'active-one', archived: false }], totalCount: 1 },
        },
      ]
      archivedResponses = [
        {
          status: 200,
          body: { items: [{ key: 'archived-one', archived: true }], totalCount: 1 },
        },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // Active flag was probed; archived was NOT.
      expect(evaluationRequests).toEqual(['active-one'])
      expect(flags.find((f) => f.key === 'active-one')?.evaluations30d).toBe(0)
      expect(flags.find((f) => f.key === 'archived-one')?.evaluations30d).toBeUndefined()
    })

    it('short-circuits the fan-out after the first 404 (feature unavailable)', async () => {
      activeResponses = [
        {
          status: 200,
          body: {
            items: [
              { key: 'flag-a', archived: false },
              { key: 'flag-b', archived: false },
              { key: 'flag-c', archived: false },
            ],
            totalCount: 3,
          },
        },
      ]
      // Make the default 404 — feature off project-wide.
      evaluationsDefault = { status: 404, body: { message: 'not found' } }
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // The first request 404s and disables the feature. Concurrency=5
      // means all 3 may go in flight together, but evaluations30d
      // remains undefined for every one of them (no Number was assigned).
      for (const f of flags) {
        expect(f.evaluations30d).toBeUndefined()
      }
    })

    it('handles 401 and 403 the same way as 404 (feature gate)', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'gated', archived: false }], totalCount: 1 },
        },
      ]
      evaluationsDefault = { status: 403, body: { message: 'forbidden' } }
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].evaluations30d).toBeUndefined()
    })

    it('tolerates a 5xx on one flag without affecting siblings', async () => {
      activeResponses = [
        {
          status: 200,
          body: {
            items: [
              { key: 'flaky', archived: false },
              { key: 'fine', archived: false },
            ],
            totalCount: 2,
          },
        },
      ]
      evaluationsResponses.set('flaky', { status: 500, body: {} })
      evaluationsResponses.set('fine', {
        status: 200,
        body: { series: [{ time: 1, '0': 42 }] },
      })
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // 'flaky' had a transient 5xx — its evaluations stay undefined,
      // but 'fine' still got its count.
      expect(flags.find((f) => f.key === 'flaky')?.evaluations30d).toBeUndefined()
      expect(flags.find((f) => f.key === 'fine')?.evaluations30d).toBe(42)
    })

    it('short-circuits later flags when an earlier one already hit a feature-gate', async () => {
      // Once the concurrency window saturates and the first returned 404
      // sets featureAvailable=false, subsequent queued flags should
      // observe it and bail. We force this by sending more flags than
      // the concurrency cap (5) and making EVERY response 404.
      activeResponses = [
        {
          status: 200,
          body: {
            items: Array.from({ length: 10 }, (_, i) => ({
              key: `flag-${i}`,
              archived: false,
            })),
            totalCount: 10,
          },
        },
      ]
      evaluationsDefault = { status: 404, body: { message: 'not found' } }
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // Every flag should have evaluations30d undefined (no data).
      for (const f of flags) {
        expect(f.evaluations30d).toBeUndefined()
      }
      // Strictly speaking we should see fewer than 10 evaluation requests
      // because later ones short-circuit before sending. Concurrency=5
      // means the first ~5 will be in flight when the first 404 returns;
      // queued ones (>5) hit the early-return.
      expect(evaluationRequests.length).toBeLessThan(10)
    })

    it('catches a JSON parse failure on the evaluations response', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'malformed', archived: false }], totalCount: 1 },
        },
      ]
      // Inject a malformed body — the schema parse will throw and the
      // catch block should swallow it.
      evaluationsResponses.set('malformed', {
        status: 200,
        // Send a body that fails Zod parsing (series should be array).
        body: { series: 'not-an-array' },
      })
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // No evaluations recorded for this flag, but the scan as a whole
      // didn't fail.
      expect(flags[0].evaluations30d).toBeUndefined()
    })

    it('ignores non-numeric values in the series payload', async () => {
      activeResponses = [
        {
          status: 200,
          body: { items: [{ key: 'mixed', archived: false }], totalCount: 1 },
        },
      ]
      evaluationsResponses.set('mixed', {
        status: 200,
        body: {
          series: [
            // LD's contract is numeric, but we don't trust it absolutely.
            // String / null / undefined entries on a series point must
            // not poison the sum or throw.
            { time: 1, '0': 10, '1': 'not-a-number', extra: null },
            { time: 2, '0': 5 },
          ],
        },
      })
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].evaluations30d).toBe(15)
    })
  })

  // Audit-log last-touched enrichment (issue #21 item 1).
  describe('audit-log last-touched enrichment', () => {
    it('populates lastTouched from a recent audit entry', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'recent-flag', archived: false }], totalCount: 1 } },
      ]
      const eventDate = Date.now() - 7 * 86_400_000 // 7 days ago
      auditLogResponses = [
        {
          status: 200,
          body: {
            items: [
              {
                date: eventDate,
                target: { resources: ['proj/p:env/e:flag/recent-flag'] },
              },
            ],
          },
        },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toEqual(new Date(eventDate))
    })

    it('confirms-untouched (lastTouched: null) when audit log returns no entries for a flag', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'untouched', archived: false }], totalCount: 1 } },
      ]
      // Default empty audit-log response → no events match this flag.
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toBeNull()
    })

    it('skips lastTouched population on archived flags', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'active', archived: false }], totalCount: 1 } },
      ]
      archivedResponses = [
        { status: 200, body: { items: [{ key: 'arc', archived: true }], totalCount: 1 } },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      const arc = flags.find((f) => f.key === 'arc')
      expect(arc?.lastTouched).toBeUndefined()
      const active = flags.find((f) => f.key === 'active')
      expect(active?.lastTouched).toBeNull()
    })

    it('keeps the LATEST timestamp when a flag has multiple audit entries', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'changed', archived: false }], totalCount: 1 } },
      ]
      const oldDate = Date.now() - 30 * 86_400_000
      const newDate = Date.now() - 3 * 86_400_000
      auditLogResponses = [
        {
          status: 200,
          body: {
            items: [
              // Order in the API response doesn't matter — we keep the max.
              { date: oldDate, target: { resources: ['proj/p:env/e:flag/changed'] } },
              { date: newDate, target: { resources: ['proj/p:env/e:flag/changed'] } },
            ],
          },
        },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toEqual(new Date(newDate))
    })

    it('paginates through _links.next.href until exhausted', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'flag-a', archived: false }, { key: 'flag-b', archived: false }], totalCount: 2 } },
      ]
      const date = Date.now() - 5 * 86_400_000
      auditLogResponses = [
        {
          status: 200,
          body: {
            items: [{ date, target: { resources: ['proj/p:env/e:flag/flag-a'] } }],
            _links: { next: { href: '/api/v2/auditlog?cursor=page-2' } },
          },
        },
        {
          status: 200,
          body: {
            items: [{ date, target: { resources: ['proj/p:env/e:flag/flag-b'] } }],
          },
        },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags.find((f) => f.key === 'flag-a')?.lastTouched).toEqual(new Date(date))
      expect(flags.find((f) => f.key === 'flag-b')?.lastTouched).toEqual(new Date(date))
      expect(auditLogRequests.length).toBe(2)
    })

    it('leaves lastTouched undefined on every flag when audit log returns 401/403/404', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'tier-gated', archived: false }], totalCount: 1 } },
      ]
      auditLogResponses = [{ status: 403, body: { message: 'forbidden' } }]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toBeUndefined()
    })

    it('leaves lastTouched undefined on transient 5xx as well', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'flaky', archived: false }], totalCount: 1 } },
      ]
      auditLogResponses = [{ status: 500, body: { message: 'oops' } }]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toBeUndefined()
    })

    it('catches a JSON parse failure on the audit-log response', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'flag-x', archived: false }], totalCount: 1 } },
      ]
      auditLogResponses = [
        // Malformed body — items should be array.
        { status: 200, body: { items: 'not-an-array' } },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toBeUndefined()
    })

    it('returns lastTouched: undefined for every flag when pagination hits the page cap', async () => {
      // Page cap is 30. Construct 31 pages, each with a `_links.next`
      // pointer so we never naturally exhaust. fetchAllFlags must stop
      // at the cap and return null, leaving every flag's lastTouched
      // undefined (incomplete data → no signal).
      activeResponses = [
        { status: 200, body: { items: [{ key: 'will-stay-undefined', archived: false }], totalCount: 1 } },
      ]
      auditLogResponses = Array.from({ length: 31 }, () => ({
        status: 200,
        body: {
          items: [],
          _links: { next: { href: '/api/v2/auditlog?cursor=more' } },
        },
      }))
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      expect(flags[0].lastTouched).toBeUndefined()
      // Cap is 30, so we expect exactly 30 hits before stopping.
      expect(auditLogRequests.length).toBe(30)
    })

    it('ignores entries whose resources do not match the flag pattern', async () => {
      activeResponses = [
        { status: 200, body: { items: [{ key: 'flag-x', archived: false }], totalCount: 1 } },
      ]
      auditLogResponses = [
        {
          status: 200,
          body: {
            items: [
              // Wrong shape — should be silently ignored, not crash.
              { date: Date.now(), target: { resources: ['proj/p:env/e'] } },
              { date: Date.now(), target: { resources: [] } },
              { date: Date.now() },
            ],
          },
        },
      ]
      const flags = await fetchAllFlags(
        { project: 'p', environment: 'e', token: 't' },
        { apiBase },
      )
      // No entries matched flag-x → confirmed-untouched.
      expect(flags[0].lastTouched).toBeNull()
    })
  })
})
