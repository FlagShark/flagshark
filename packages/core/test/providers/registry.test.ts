import { describe, it, expect } from 'vitest'
import { platformRegistry, findPlatform } from '../../src/providers/registry.js'

describe('platform registry', () => {
  it('platformRegistry is a readonly array', () => {
    expect(Array.isArray(platformRegistry)).toBe(true)
  })

  it('findPlatform returns undefined for unknown names', () => {
    expect(findPlatform('does-not-exist')).toBeUndefined()
  })

  it('findPlatform returns the launchdarkly definition', () => {
    const def = findPlatform('launchdarkly')
    expect(def).toBeDefined()
    expect(def?.name).toBe('launchdarkly')
    expect(def?.displayName).toBe('LaunchDarkly')
  })
})
