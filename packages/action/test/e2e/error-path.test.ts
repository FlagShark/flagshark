import { describe, it, expect } from 'vitest'
import { runAction } from '../helpers/run-action.js'

describe('action E2E — error path', () => {
  it('Error thrown by scanRepo becomes setFailed(msg)', async () => {
    const failingScan = async () => { throw new Error('boom from scan') }
    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: failingScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(core.state.failed).toBe('boom from scan')
  })

  it('non-Error thrown becomes generic message', async () => {
    const failingScan = async () => { throw 'string-thrown' }
    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: failingScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(core.state.failed).toBe('An unexpected error occurred')
  })
})
