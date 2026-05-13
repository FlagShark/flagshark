import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { summaryText } from '../helpers/fake-actions-core.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — summary', () => {
  it('summary contains heading, health score, metric table', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    const text = summaryText(core)
    expect(text).toMatch(/# 🦈 FlagShark Scan Results/)
    expect(text).toMatch(/Health Score:/)
    expect(text).toMatch(/Files scanned/)
  })

  it('summary "Top stale flags" only renders when stale > 0', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(summaryText(core)).not.toMatch(/Top stale flags/)
  })

  it('summary renders Top stale flags table when stale > 0', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('STALE_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(summaryText(core)).toMatch(/Top stale flags/)
    expect(summaryText(core)).toContain('STALE_FLAG')
  })

  it('summary "and N more" appears when stale > 15', async () => {
    const manyStale = Array.from({ length: 20 }, (_, i) => ({
      name: `FLAG_${i}`,
      filePath: `src/${i}.ts`,
      lineNumber: i + 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      age: '12 months ago',
      signals: [{ type: 'age' as const, description: 'Flag reference last modified 12 months ago (threshold: 6 months)' }],
    }))
    const fakeScan = async () => ({
      totalFlags: 20,
      filesScanned: 20,
      staleFlags: manyStale as never,
      detectedProviders: ['launchdarkly-node-server-sdk'],
      languageBreakdown: { typescript: 20 },
      healthScore: 0,
      scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(summaryText(core)).toMatch(/and 5 more stale flags/)
  })
})
