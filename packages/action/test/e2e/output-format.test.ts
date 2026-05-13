import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setupRepo() {
  const dir = makeTempRepo()
  dirs.push(dir)
  writeFixtureFile(dir, 'src/a.ts',
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('FLAG', user, false)\n`)
  commitAll(dir, 'init')
  return dir
}

describe('action E2E — output-format', () => {
  it('output-format: markdown posts a comment with PR context', async () => {
    const { octokit } = await runAction({
      cwd: setupRepo(),
      inputs: { scan: 'full', 'output-format': 'markdown' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(octokit.state.calls.create).toBe(1)
  })

  it('output-format: none suppresses comments even with PR context', async () => {
    const { octokit, core } = await runAction({
      cwd: setupRepo(),
      inputs: { scan: 'full', 'output-format': 'none' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(octokit.state.calls.create).toBe(0)
    expect(core.state.warnings).toEqual([])
  })

  it('unknown output-format warns and does not post a comment', async () => {
    const { octokit, core } = await runAction({
      cwd: setupRepo(),
      inputs: { scan: 'full', 'output-format': 'xml' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(core.state.warnings.some((w) => w.includes('Unknown output-format'))).toBe(true)
    expect(octokit.state.calls.create).toBe(0)
  })
})
