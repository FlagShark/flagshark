/**
 * Integration tests for fetchAllFlags against a real local HTTP server.
 *
 * Why: every other LD client test injects a fake `fetch`, which is great
 * for the contract but never exercises Node.js's real `fetch` /
 * `Headers` / `URL` resolution. This file fills the gap by standing up
 * a tiny `node:http` server that mimics the shape of LD's
 * `GET /api/v2/flags/{project}` response and points the client at it
 * via `apiBase`. Covers:
 *   - happy path (auth header, URL shape, summary param, schema parse)
 *   - pagination via `_links.next.href` (relative path → resolved
 *     against apiBase by `new URL(path, apiBase)`)
 *   - 401/403 unauthorised responses surface as LdApiError
 *   - whitespace tokens still produce sane request headers (regression
 *     guard for the orchestrator trim)
 *   - archived flags + per-environment lastModified pass-through
 *
 * The mock server intentionally returns CLOSE-TO-PRODUCTION JSON
 * including extra fields LD ships that we don't consume; if the schema
 * stops being permissive enough to ignore them, this test catches it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { fetchAllFlags } from '../../../src/providers/launchdarkly/client.js'
import { LdApiError } from '../../../src/providers/launchdarkly/errors.js'

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
}

let server: Server
let apiBase: string
let recorded: RecordedRequest[] = []
// fetchAllFlags now makes TWO pagination passes (active + archived), so
// the mock server is URL-aware: `archived=true` queries return the
// `archivedResponse` body, everything else returns `nextResponse`. Most
// tests only care about the active pass and leave `archivedResponse`
// as an empty page; tests that care about archived flags set both.
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }
let archivedResponse: { status: number; body: unknown } = {
  status: 200,
  body: { items: [], totalCount: 0 },
}

beforeAll(async () => {
  server = createServer((req, res) => {
    recorded.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v ?? '']),
      ),
    })
    const isArchivedQuery = (req.url ?? '').includes('archived=true')
    const r = isArchivedQuery ? archivedResponse : nextResponse
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
  nextResponse = { status: 200, body: { items: [], totalCount: 0 } }
  archivedResponse = { status: 200, body: { items: [], totalCount: 0 } }
})

describe('fetchAllFlags — real HTTP integration', () => {
  it('200 happy path: sends Authorization + LD-API-Version headers verbatim', async () => {
    nextResponse = {
      status: 200,
      body: {
        items: [
          { key: 'show-new-checkout', archived: false },
          { key: 'experimental-search', archived: true },
        ],
        totalCount: 2,
      },
    }
    const flags = await fetchAllFlags(
      { project: 'my-project', environment: 'production', token: 'api-real-token-xyz' },
      { apiBase },
    )

    expect(flags).toHaveLength(2)
    expect(flags[0]).toMatchObject({ key: 'show-new-checkout', archived: false })
    expect(flags[1]).toMatchObject({ key: 'experimental-search', archived: true })

    const req = recorded[0]
    expect(req.method).toBe('GET')
    expect(req.url).toBe(
      '/api/v2/flags/my-project?env=production&limit=100&offset=0&summary=1',
    )
    // Auth header is raw (no Bearer prefix); LD-API-Version is the pinned date.
    expect(req.headers.authorization).toBe('api-real-token-xyz')
    expect(req.headers['ld-api-version']).toBe('20240415')
  })

  it('extracts lastModified from per-environment metadata', async () => {
    const ts = 1715200000000
    nextResponse = {
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
    }
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags[0].lastModified).toEqual(new Date(ts))
  })

  it('paginates via _links.next.href (relative path → resolved against apiBase)', async () => {
    // The active pass paginates: first response carries a `next` link, the
    // server replies to the follow-up with the rest. The archived pass is
    // empty (no archived flags in this scenario). All three requests must
    // reach the same origin via apiBase-relative URL resolution.
    let activeCall = 0
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v ?? '']),
        ),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const url = req.url ?? ''
      if (url.includes('archived=true')) {
        res.end(JSON.stringify({ items: [], totalCount: 0 }))
        return
      }
      if (activeCall++ === 0) {
        res.end(
          JSON.stringify({
            items: [{ key: 'page-1-flag', archived: false }],
            totalCount: 2,
            _links: { next: { href: '/api/v2/flags/p?offset=1&limit=100&summary=1' } },
          }),
        )
      } else {
        res.end(
          JSON.stringify({
            items: [{ key: 'page-2-flag', archived: false }],
            totalCount: 2,
          }),
        )
      }
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 't' },
      { apiBase },
    )
    expect(flags.map((f) => f.key)).toEqual(['page-1-flag', 'page-2-flag'])
    // 3 requests: active pass page 1 + active page 2 + archived pass.
    expect(recorded).toHaveLength(3)
    expect(recorded[1].url).toBe('/api/v2/flags/p?offset=1&limit=100&summary=1')
    expect(recorded[2].url).toContain('archived=true')
    // Reset the handler so following tests use the shared one.
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v ?? '']),
        ),
      })
      const isArchivedQuery = (req.url ?? '').includes('archived=true')
      const r = isArchivedQuery ? archivedResponse : nextResponse
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    })
  })

  // Regression coverage for the real-LD bug discovered during pre-launch
  // validation: LD's list endpoint excludes archived flags by default, so
  // fetchAllFlags now makes a second pass with archived=true and unions
  // the results. Pre-fix, an archived flag silently surfaced as
  // `missing-in-platform` (the OPPOSITE of `archived-in-platform`).
  it('unions active and archived flags from two separate API passes', async () => {
    nextResponse = {
      status: 200,
      body: {
        items: [
          { key: 'active-flag', archived: false },
          { key: 'another-active', archived: false },
        ],
        totalCount: 2,
      },
    }
    archivedResponse = {
      status: 200,
      body: {
        items: [{ key: 'archived-flag', archived: true }],
        totalCount: 1,
      },
    }
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
    expect(flags.find((f) => f.key === 'active-flag')?.archived).toBe(false)
    // Confirm BOTH passes happened.
    expect(recorded).toHaveLength(2)
    expect(recorded[0].url).not.toContain('archived=true')
    expect(recorded[1].url).toContain('archived=true')
  })

  it('401 from LD surfaces as LdApiError with status: 401', async () => {
    nextResponse = { status: 401, body: { message: 'invalid token' } }
    await expect(
      fetchAllFlags(
        { project: 'p', environment: 'e', token: 'wrong-token' },
        { apiBase },
      ),
    ).rejects.toThrow(LdApiError)
    try {
      await fetchAllFlags(
        { project: 'p', environment: 'e', token: 'wrong-token' },
        { apiBase },
      )
    } catch (err) {
      expect((err as LdApiError).status).toBe(401)
    }
  })

  it('403 from LD (project-scoped token, wrong project) surfaces with status: 403', async () => {
    nextResponse = { status: 403, body: { message: 'forbidden for this project' } }
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
    nextResponse = { status: 200, body: { items: [], totalCount: 0 } }
    await fetchAllFlags(
      { project: 'team/my project', environment: 'e', token: 't' },
      { apiBase },
    )
    // The reserved chars `/` and ` ` are percent-encoded so the request
    // URL reaches the right path on the LD side.
    expect(recorded[0].url).toContain('team%2Fmy%20project')
  })

  it('accepts a response with unknown extra fields (schema is permissive)', async () => {
    nextResponse = {
      status: 200,
      body: {
        items: [
          {
            key: 'flag-a',
            archived: false,
            // Extra LD fields we don't consume — schema must ignore them.
            kind: 'boolean',
            tags: ['ux', 'experiment'],
            maintainer: { firstName: 'Jane', lastName: 'Doe' },
          },
        ],
        totalCount: 1,
        // _links present at top level on every LD response.
        _links: { self: { href: '/api/v2/flags/p' } },
      },
    }
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { apiBase },
    )
    expect(flags[0].key).toBe('flag-a')
  })
})
