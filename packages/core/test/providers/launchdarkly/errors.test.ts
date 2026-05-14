import { describe, it, expect } from 'vitest'
import { LdApiError } from '../../../src/providers/launchdarkly/errors.js'

describe('LdApiError', () => {
  it('carries status code', () => {
    const e = new LdApiError('msg', 401)
    expect(e.status).toBe(401)
  })

  it('is identifiable via name', () => {
    const e = new LdApiError('msg', 500)
    expect(e.name).toBe('LdApiError')
  })

  it('instanceof Error', () => {
    const e = new LdApiError('msg', 404)
    expect(e instanceof Error).toBe(true)
  })
})
