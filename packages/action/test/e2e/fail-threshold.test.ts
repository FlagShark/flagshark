import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — fail-threshold', () => {
  function setupStaleRepo() {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')
    return dir
  }

  it('health < threshold → setFailed', async () => {
    const dir = setupStaleRepo()
    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-threshold': '99' },
    })
    expect(core.state.failed).toMatch(/below threshold 99/)
  })

  it('fail-threshold: 0 never fails', async () => {
    const dir = setupStaleRepo()
    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-threshold': '0' },
    })
    expect(core.state.failed).toBeNull()
  })

  it('health >= threshold → does not fail', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-threshold': '50' },
    })
    expect(core.state.failed).toBeNull()
  })
})
