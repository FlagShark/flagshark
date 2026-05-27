import { describe, it, expect, vi } from 'vitest'
import { fetchAllFlags } from '../../../src/providers/launchdarkly/client.js'
import { LdApiError } from '../../../src/providers/launchdarkly/errors.js'

// Tests written before the archived-flag fix returned one fake response
// per test, expecting fetchAllFlags to make one request. The fix added a
// SECOND pagination pass (archived=true) so every call now makes at least
// two requests. The helper auto-returns an empty page for any request
// beyond the queued list, which keeps existing single-response tests
// valid and lets new tests opt in to the second-pass shape explicitly.
function makeFakeFetch(responses: Array<{ status: number; body: unknown } | Error>): typeof globalThis.fetch {
  let i = 0
  return async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[i++] ?? { status: 200, body: { items: [], totalCount: 0 } }
    if (r instanceof Error) throw r
    return new Response(JSON.stringify(r.body), { status: r.status, statusText: `Code ${r.status}` })
  }
}

describe('fetchAllFlags', () => {
  it('returns single-page response', async () => {
    const fakeFetch = makeFakeFetch([{
      status: 200,
      body: {
        items: [{ key: 'A', archived: false }, { key: 'B', archived: true }],
        totalCount: 2,
      },
    }])
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { fetch: fakeFetch },
    )
    expect(flags).toEqual([
      // `permanent` defaults to `false` because the LD schema defaults
      // `temporary` to `true` (the field is set on every modern flag;
      // when missing we treat the flag as temporary, i.e. NOT permanent).
      // `tags` defaults to []; `createdAt` is null when LD didn't send
      // `creationDate`; `maintainer` is undefined because no maintainerId
      // was present in the mocked response. `evaluations30d` is 0 for the
      // active flag because the fake-fetch fallback returns an empty
      // series; archived flags are excluded from the evaluation fetch
      // entirely so `evaluations30d` stays undefined on key 'B'.
      // `variations`/`on`/`offVariation` are undefined (not in this
      // fixture); `fallthroughVariation` is null because there is no
      // fallthrough in the fixture (missing fallthrough → null per the
      // normalization rule introduced in Task 1 of #31).
      // `codeReferences` is null for the active flag because the fake-fetch
      // fallback returns empty items for the code-refs endpoint (feature
      // available, no references found). Archived flag 'B' is skipped.
      {
        key: 'A',
        archived: false,
        lastModified: null,
        permanent: false,
        createdAt: null,
        tags: [],
        maintainer: undefined,
        evaluations30d: 0,
        // Audit-log fetch returned empty items → confirmed-untouched.
        // Archived flags don't get lastTouched populated (skipped from
        // the population loop) so key 'B' below has no field at all.
        lastTouched: null,
        variations: undefined,
        on: undefined,
        fallthroughVariation: null,
        offVariation: undefined,
        codeReferences: null,
      },
      {
        key: 'B',
        archived: true,
        lastModified: null,
        permanent: false,
        createdAt: null,
        tags: [],
        maintainer: undefined,
        variations: undefined,
        on: undefined,
        fallthroughVariation: null,
        offVariation: undefined,
      },
    ])
  })

  it('paginates via _links.next.href', async () => {
    const fakeFetch = makeFakeFetch([
      {
        status: 200,
        body: {
          items: [{ key: 'A', archived: false }],
          totalCount: 2,
          _links: { next: { href: '/api/v2/flags/p?offset=1' } },
        },
      },
      {
        status: 200,
        body: {
          items: [{ key: 'B', archived: false }],
          totalCount: 2,
        },
      },
    ])
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { fetch: fakeFetch },
    )
    expect(flags.map((f) => f.key)).toEqual(['A', 'B'])
  })

  it('extracts lastModified from per-environment metadata', async () => {
    const ts = 1715200000000
    const fakeFetch = makeFakeFetch([{
      status: 200,
      body: {
        items: [{ key: 'A', archived: false, environments: { prod: { lastModified: ts } } }],
        totalCount: 1,
      },
    }])
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'prod', token: 't' },
      { fetch: fakeFetch },
    )
    expect(flags[0].lastModified).toEqual(new Date(ts))
  })

  it('lastModified is null when environment missing in response', async () => {
    const fakeFetch = makeFakeFetch([{
      status: 200,
      body: {
        items: [{ key: 'A', archived: false, environments: { other: { lastModified: 1 } } }],
        totalCount: 1,
      },
    }])
    const flags = await fetchAllFlags(
      { project: 'p', environment: 'prod', token: 't' },
      { fetch: fakeFetch },
    )
    expect(flags[0].lastModified).toBeNull()
  })

  it('throws LdApiError on 401', async () => {
    const fakeFetch = makeFakeFetch([{ status: 401, body: {} }])
    await expect(fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { fetch: fakeFetch },
    )).rejects.toThrow(LdApiError)
  })

  it('LdApiError carries status code', async () => {
    const fakeFetch = makeFakeFetch([{ status: 403, body: {} }])
    try {
      await fetchAllFlags({ project: 'p', environment: 'e', token: 't' }, { fetch: fakeFetch })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as LdApiError).status).toBe(403)
    }
  })

  it('throws on Zod validation failure (malformed response)', async () => {
    const fakeFetch = makeFakeFetch([{ status: 200, body: { wrong_shape: true } }])
    await expect(fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { fetch: fakeFetch },
    )).rejects.toThrow()
  })

  it('sends Authorization header without Bearer prefix', async () => {
    let capturedHeaders: Headers | undefined
    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ items: [], totalCount: 0 }))
    }
    await fetchAllFlags({ project: 'p', environment: 'e', token: 'mytoken' }, { fetch: fakeFetch })
    expect(capturedHeaders?.get('authorization')).toBe('mytoken')
  })

  it('sends LD-API-Version header', async () => {
    let capturedHeaders: Headers | undefined
    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ items: [], totalCount: 0 }))
    }
    await fetchAllFlags({ project: 'p', environment: 'e', token: 't' }, { fetch: fakeFetch })
    expect(capturedHeaders?.get('ld-api-version')).toBe('20240415')
  })

  it('honors apiBase override', async () => {
    let capturedUrl: string | undefined
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      capturedUrl = url.toString()
      return new Response(JSON.stringify({ items: [], totalCount: 0 }))
    }
    await fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { fetch: fakeFetch, apiBase: 'https://launchdarkly.example.com' },
    )
    expect(capturedUrl).toContain('launchdarkly.example.com')
  })

  it('URL-encodes project key', async () => {
    // Capture EVERY URL hit (auxiliary endpoints — members, statuses,
    // audit log — also fire from fetchAllFlags) and assert the primary
    // /flags URL contains the encoded project key. Aux endpoints use
    // URLSearchParams which encodes spaces as `+` instead of `%20`,
    // so we have to scope this to the path-style /flags request.
    const captured: string[] = []
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      captured.push(url.toString())
      return new Response(JSON.stringify({ items: [], totalCount: 0 }))
    }
    await fetchAllFlags(
      { project: 'has spaces/slash', environment: 'e', token: 't' },
      { fetch: fakeFetch },
    )
    const flagsUrl = captured.find((u) => u.includes('/api/v2/flags/'))
    expect(flagsUrl).toContain('has%20spaces%2Fslash')
  })

  it('propagates AbortSignal', async () => {
    const controller = new AbortController()
    controller.abort()
    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.signal?.aborted) throw new Error('aborted')
      return new Response(JSON.stringify({ items: [], totalCount: 0 }))
    }
    await expect(fetchAllFlags(
      { project: 'p', environment: 'e', token: 't' },
      { fetch: fakeFetch, signal: controller.signal },
    )).rejects.toThrow()
  })

  it('falls back to globalThis.fetch when no fetch option is provided', async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ items: [], totalCount: 0 }))
      const flags = await fetchAllFlags({ project: 'p', environment: 'e', token: 't' })
      expect(flags).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it('extracts variations, on, fallthroughVariation, offVariation from summary=0 response', async () => {
    // Mock LD returning a flag with the full (summary=0) shape — variations
    // at top level, plus fallthrough/on/offVariation inside the environments block.
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        items: [{
          key: 'FOO',
          archived: false,
          temporary: true,
          creationDate: 1700000000000,
          tags: [],
          variations: [
            { value: false, name: 'off' },
            { value: true, name: 'on' },
          ],
          environments: {
            production: {
              lastModified: 1700000000000,
              on: true,
              fallthrough: { variation: 1 },
              offVariation: 0,
            },
          },
        }],
        totalCount: 1,
      }),
    })
      // The aux endpoints (members, flag-statuses, evaluations, audit-log)
      // need stubs that return ok with empty payloads so the run completes.
      // totalCount: 0 is required by FlagsResponseSchema for the second
      // flag-list pass (archived=true); aux endpoints don't parse via
      // FlagsResponseSchema so its presence is harmless there.
      .mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags).toHaveLength(1)
    expect(flags[0].variations).toEqual([
      { value: false, name: 'off' },
      { value: true, name: 'on' },
    ])
    expect(flags[0].on).toBe(true)
    expect(flags[0].fallthroughVariation).toBe(1)
    expect(flags[0].offVariation).toBe(0)
  })

  it('normalizes fallthrough.rollout (split rollout) to fallthroughVariation: null', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        items: [{
          key: 'BAR',
          archived: false,
          temporary: true,
          tags: [],
          variations: [{ value: false }, { value: true }],
          environments: {
            production: {
              lastModified: 1700000000000,
              on: true,
              // Split rollout: rollout present, variation absent.
              fallthrough: { rollout: { variations: [
                { variation: 0, weight: 50000 },
                { variation: 1, weight: 50000 },
              ]}},
              offVariation: 0,
            },
          },
        }],
        totalCount: 1,
      }),
    }).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [], totalCount: 0 }),
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].fallthroughVariation).toBeNull()
  })

  it('normalizes missing fallthrough to fallthroughVariation: null', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        items: [{
          key: 'BAZ',
          archived: false,
          temporary: true,
          tags: [],
          variations: [{ value: false }, { value: true }],
          environments: {
            production: {
              lastModified: 1700000000000,
              on: true,
              // fallthrough intentionally omitted
              offVariation: 0,
            },
          },
        }],
        totalCount: 1,
      }),
    }).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [], totalCount: 0 }),
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].fallthroughVariation).toBeNull()
  })

  it('flag-list URL uses summary=0 to get full flag objects', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      // totalCount: 0 required by FlagsResponseSchema for both flag-list passes.
      json: async () => ({ items: [], totalCount: 0 }),
    })

    await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    // The very first call should be the flag-list call; assert its URL.
    const firstCallUrl = fetchFn.mock.calls[0][0]
    const url = firstCallUrl instanceof URL ? firstCallUrl.toString() : String(firstCallUrl)
    expect(url).toContain('summary=0')
    expect(url).not.toContain('summary=1')
  })

  it('populates codeReferences from /code-refs/statistics response (per-flag hunkCount sum)', async () => {
    const responses = new Map<string, () => unknown>()
    responses.set('/api/v2/flags/p', () => ({ items: [{
      key: 'FOO', archived: false, temporary: true, tags: [],
      variations: [{ value: false }, { value: true }],
      environments: { production: { lastModified: 1700000000000 } },
    }], totalCount: 1 }))
    responses.set('/api/v2/code-refs/statistics/p', () => ({
      flags: {
        FOO: [
          { name: 'frontend', hunkCount: 8 },
          { name: 'mobile-app', hunkCount: 4 },
        ],
      },
    }))

    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      for (const [path, body] of responses) {
        if (url.includes(path)) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => body(),
          } as unknown as Response
        }
      }
      // Default: 200 with empty items (covers members, flag-statuses,
      // evaluations, audit-log, and the archived=true flag pass).
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].codeReferences).toEqual({ count: 12 })
  })

  it('sets codeReferences to null when code-refs response has empty flags map', async () => {
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p') && !url.includes('archived=true')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            items: [{
              key: 'BAR', archived: false, temporary: true, tags: [],
              variations: [{ value: false }, { value: true }],
              environments: { production: { lastModified: 1700000000000 } },
            }],
            totalCount: 1,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ flags: {} }),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].codeReferences).toBeNull()
  })

  it('sets codeReferences to null when a flag is absent from the code-refs response', async () => {
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p') && !url.includes('archived=true')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            items: [{
              key: 'BAR', archived: false, temporary: true, tags: [],
              variations: [{ value: false }, { value: true }],
              environments: { production: { lastModified: 1700000000000 } },
            }],
            totalCount: 1,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ flags: { OTHER: [{ name: 'r', hunkCount: 5 }] } }),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].codeReferences).toBeNull()
  })

  it('leaves codeReferences undefined and logs advisory when code-refs returns 404', async () => {
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    }
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p') && !url.includes('archived=true')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            items: [{
              key: 'BAR', archived: false, temporary: true, tags: [],
              variations: [{ value: false }, { value: true }],
              environments: { production: { lastModified: 1700000000000 } },
            }],
            totalCount: 1,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: false, status: 404, statusText: 'Not Found',
          json: async () => ({}),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch, logger },
    )

    expect(flags[0].codeReferences).toBeUndefined()
    expect(logger.info).toHaveBeenCalledOnce()
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('code-references not available')
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('launchdarkly.com/docs')
  })

  it('leaves codeReferences undefined for archived flags', async () => {
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p')) {
        if (url.includes('archived=true')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({
              items: [{
                key: 'OLD', archived: true, temporary: true, tags: [],
                variations: [{ value: false }, { value: true }],
                environments: { production: { lastModified: 1700000000000 } },
              }],
              totalCount: 1,
            }),
          } as unknown as Response
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ items: [], totalCount: 0 }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ flags: { OLD: [{ name: 'r', hunkCount: 7 }] } }),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].key).toBe('OLD')
    expect(flags[0].archived).toBe(true)
    expect(flags[0].codeReferences).toBeUndefined()
  })
})
