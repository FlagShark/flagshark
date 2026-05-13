import { describe, it, expect } from 'vitest'
import { FlagsResponseSchema } from '../../../src/providers/launchdarkly/types.js'

describe('LaunchDarkly FlagsResponseSchema', () => {
  it('accepts a minimal valid response', () => {
    const r = FlagsResponseSchema.parse({
      items: [{ key: 'A', archived: false }],
      totalCount: 1,
    })
    expect(r.items[0].key).toBe('A')
  })

  it('accepts response with environments.lastModified', () => {
    const r = FlagsResponseSchema.parse({
      items: [{
        key: 'A',
        archived: false,
        environments: { production: { lastModified: 1715200000000 } },
      }],
      totalCount: 1,
    })
    expect(r.items[0].environments?.production?.lastModified).toBe(1715200000000)
  })

  it('accepts _links.next pagination cursor', () => {
    const r = FlagsResponseSchema.parse({
      items: [],
      totalCount: 0,
      _links: { next: { href: '/api/v2/flags/p?offset=100' } },
    })
    expect(r._links?.next?.href).toContain('offset=100')
  })

  it('rejects response missing items array', () => {
    expect(() => FlagsResponseSchema.parse({ totalCount: 0 })).toThrow()
  })

  it('rejects item missing key', () => {
    expect(() => FlagsResponseSchema.parse({
      items: [{ archived: false }],
      totalCount: 1,
    })).toThrow()
  })
})
