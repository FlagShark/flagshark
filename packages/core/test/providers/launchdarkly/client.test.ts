import { describe, it, expect } from 'vitest'
import { fetchAllFlags } from '../../../src/providers/launchdarkly/client.js'
import { LdApiError } from '../../../src/providers/launchdarkly/errors.js'

function makeFakeFetch(responses: Array<{ status: number; body: unknown } | Error>): typeof globalThis.fetch {
  let i = 0
  return async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[i++]
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
      { key: 'A', archived: false, lastModified: null },
      { key: 'B', archived: true, lastModified: null },
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
    let capturedUrl: string | undefined
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      capturedUrl = url.toString()
      return new Response(JSON.stringify({ items: [], totalCount: 0 }))
    }
    await fetchAllFlags(
      { project: 'has spaces/slash', environment: 'e', token: 't' },
      { fetch: fakeFetch },
    )
    expect(capturedUrl).toContain('has%20spaces%2Fslash')
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
})
