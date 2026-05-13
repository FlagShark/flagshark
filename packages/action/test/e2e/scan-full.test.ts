import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — no PR context', () => {
  it('scan: changed without PR logs info and runs full scan', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'changed' },
    })

    expect(core.state.infos.some((s) => s.includes('no pull_request context'))).toBe(true)
    expect(core.state.failed).toBeNull()
  })

  it('scan: full with no PR context just runs', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core, octokit } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(core.state.failed).toBeNull()
    expect(octokit.state.calls.create).toBe(0)
  })
})
