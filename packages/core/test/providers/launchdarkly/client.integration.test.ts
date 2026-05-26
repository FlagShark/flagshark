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
})
