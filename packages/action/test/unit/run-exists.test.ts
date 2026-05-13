import { describe, it, expect } from 'vitest'

describe('action run() export', () => {
  it('is exported from run.ts', async () => {
    const mod = await import('../../src/run.js')
    expect(typeof mod.run).toBe('function')
  })
})
