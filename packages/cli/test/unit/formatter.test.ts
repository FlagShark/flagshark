import { describe, it, expect } from 'vitest'

describe('formatter shim', () => {
  it('re-exports formatText and formatJson', async () => {
    const mod = await import('../../src/formatter.js')
    expect(typeof mod.formatText).toBe('function')
    expect(typeof mod.formatJson).toBe('function')
  })
})
