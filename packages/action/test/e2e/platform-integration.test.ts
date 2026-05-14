import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function flagSourceBody(flag: string) {
  return (
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('${flag}', user, false)\n`
  )
}

describe('action E2E — platform integration', () => {
  it('error-count output reflects missing-in-platform signals (via fake scanRepoFn)', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', flagSourceBody('MISSING_FLAG'))
    commitAll(dir, 'init')

    const fakeScan = async () => ({
      totalFlags: 1, filesScanned: 1,
      staleFlags: [{
        name: 'MISSING_FLAG', filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
        signals: [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'not in LD' }],
        age: '0 months ago',
      }],
      detectedProviders: ['launchdarkly-node-server-sdk'],
      languageBreakdown: { typescript: 1 },
      healthScore: 0, scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(core.state.outputs['error-count']).toBe('1')
  })

  it('fail-on-error: true (default) calls setFailed when missing-in-platform present', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', flagSourceBody('M'))
    commitAll(dir, 'init')

    const fakeScan = async () => ({
      totalFlags: 1, filesScanned: 1,
      staleFlags: [{
        name: 'M', filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
        signals: [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'not in LD' }],
        age: '0 months ago',
      }],
      detectedProviders: [], languageBreakdown: {},
      healthScore: 0, scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(core.state.failed).toMatch(/M/)
  })

  it('fail-on-error: false does not call setFailed even when missing-in-platform present', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', flagSourceBody('M'))
    commitAll(dir, 'init')

    const fakeScan = async () => ({
      totalFlags: 1, filesScanned: 1,
      staleFlags: [{
        name: 'M', filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
        signals: [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'not in LD' }],
        age: '0 months ago',
      }],
      detectedProviders: [], languageBreakdown: {},
      healthScore: 0, scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-on-error': 'false' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(core.state.failed).toBeNull()
  })

  it('no platform integration in fixture → error-count is 0', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', flagSourceBody('A'))
    writeFixtureFile(dir, 'src/b.ts', flagSourceBody('A'))
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })
    expect(core.state.outputs['error-count']).toBe('0')
  })

  it('no-cache: true is read from input', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    let receivedNoCache = false
    const fakeScan = async (opts: Parameters<typeof import('@flagshark/core').scanRepo>[0]) => {
      receivedNoCache = opts.noCache === true
      return {
        totalFlags: 0, filesScanned: 1, staleFlags: [],
        detectedProviders: [], languageBreakdown: {},
        healthScore: 100, scanDuration: 1,
      }
    }
    await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'no-cache': 'true' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(receivedNoCache).toBe(true)
  })
})
