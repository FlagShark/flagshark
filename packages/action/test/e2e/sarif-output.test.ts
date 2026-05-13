import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — SARIF', () => {
  it('writes SARIF file when sarif input is set', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FLAG', user, false)\n`)
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', sarif: 'out/scan.sarif' },
    })

    const out = join(dir, 'out/scan.sarif')
    expect(existsSync(out)).toBe(true)
    const parsed = JSON.parse(readFileSync(out, 'utf-8'))
    expect(parsed.$schema).toMatch(/sarif/i)
    expect(core.state.outputs['sarif-path']).toBe(out)
  })

  it('does not write SARIF when input is absent', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(core.state.outputs['sarif-path']).toBeUndefined()
  })
})
