import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — scan with PR context', () => {
  it('with stale flags and PR context, posts a markdown comment', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const { core, octokit } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', threshold: '6', 'fail-threshold': '0', 'output-format': 'markdown' },
      pullRequest: { number: 7, baseRef: 'main', headSha: 'sha-abc' },
      env: { GITHUB_TOKEN: 'fake-token' },
    })

    expect(octokit.state.calls.create).toBe(1)
    expect(octokit.state.comments[0].body).toContain('flagshark-action')
    expect(octokit.state.comments[0].body).toContain('OLD_FLAG')
    expect(core.state.outputs['stale-count']).toBe('1')
    expect(core.state.outputs['health-score']).toBeDefined()
  })

  it('scan: changed with PR context uses origin/<base> diff ref', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    const body =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFixtureFile(dir, 'src/a.ts', body + `client.variation('FOO', user, false)\n`)
    commitAll(dir, 'init')

    let capturedDiff: string | undefined
    const fakeScan = async (opts: Parameters<typeof import('@flagshark/core').scanRepo>[0]) => {
      capturedDiff = opts.diff
      return {
        totalFlags: 0,
        filesScanned: 1,
        staleFlags: [],
        detectedProviders: [],
        languageBreakdown: {},
        healthScore: 100,
        scanDuration: 1,
      }
    }

    await runAction({
      cwd: dir,
      inputs: { scan: 'changed' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'sha' },
      env: { GITHUB_TOKEN: 'tok' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(capturedDiff).toBe('origin/main')
  })
})
