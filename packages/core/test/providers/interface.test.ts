import { describe, it, expect } from 'vitest'
import type { PlatformFlag, PlatformClient, PlatformDefinition, PlatformSignal } from '../../src/providers/interface.js'

describe('providers/interface types', () => {
  it('PlatformFlag can be constructed', () => {
    const f: PlatformFlag = { key: 'A', archived: false, lastModified: null, fallthroughVariation: null }
    expect(f.key).toBe('A')
  })

  it('PlatformSignal has type and severity', () => {
    const s: PlatformSignal = {
      type: 'missing-in-platform',
      severity: 'error',
      description: 'test',
    }
    expect(s.severity).toBe('error')
  })
})
