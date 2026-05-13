import { describe, it, expect } from 'vitest'
import { platformRegistry, findPlatform } from '../../src/providers/registry.js'
import type { PlatformDefinition } from '../../src/providers/interface.js'
import { z } from 'zod'

const dummy: PlatformDefinition = {
  name: 'dummy',
  displayName: 'Dummy',
  defaultTokenEnv: 'DUMMY_TOKEN',
  configSchema: z.object({}),
  createClient: () => ({ name: 'dummy', displayName: 'Dummy', listFlags: async () => [] }),
}

describe('platform registry', () => {
  it('platformRegistry is a readonly array', () => {
    expect(Array.isArray(platformRegistry)).toBe(true)
  })

  it('findPlatform returns undefined for unknown names', () => {
    expect(findPlatform('does-not-exist')).toBeUndefined()
  })

  it('findPlatform handles a miss (registry has no dummy entry)', () => {
    // Will be strengthened in Task 2.4 to assert findPlatform('launchdarkly') works.
    expect(findPlatform(dummy.name)).toBeUndefined()
  })
})
