import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — comment lifecycle', () => {
  function setupRepoWithFlag() {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FLAG_X', user, false)\n`)
    commitAll(dir, 'init')
    return dir
  }

  it('first run creates a new comment', async () => {
    const { octokit } = await runAction({
      cwd: setupRepoWithFlag(),
      inputs: { scan: 'full' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(octokit.state.calls.create).toBe(1)
    expect(octokit.state.calls.update).toBe(0)
  })

  it('second run updates the existing marker-tagged comment', async () => {
    const { octokit } = await runAction({
      cwd: setupRepoWithFlag(),
      inputs: { scan: 'full' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
      initialComments: [
        { id: 99, body: 'previous body <!-- flagshark-action -->' },
      ],
    })
    expect(octokit.state.calls.create).toBe(0)
    expect(octokit.state.calls.update).toBe(1)
    expect(octokit.state.comments[0].body).not.toBe('previous body <!-- flagshark-action -->')
    expect(octokit.state.comments[0].body).toContain('FLAG_X')
  })

  it('ignores comments without the marker', async () => {
    const { octokit } = await runAction({
      cwd: setupRepoWithFlag(),
      inputs: { scan: 'full' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
      initialComments: [{ id: 50, body: 'unrelated reviewer comment' }],
    })
    expect(octokit.state.calls.create).toBe(1)
    expect(octokit.state.calls.update).toBe(0)
  })
})
