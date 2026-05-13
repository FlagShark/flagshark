/**
 * Focused branch-coverage tests for run.ts paths that the E2E tests don't reach:
 *   - `scan` input unset  → `|| 'changed'` default (line 37)
 *   - providers.length > 8 → truncation suffix "+N more" (line 80)
 *   - GITHUB_TOKEN unset but `token` input provided → token fallback (line 99)
 *   - stale flag with no `age` field → `|| 'unknown'` in summary table (line 136)
 *   - logger.warn and logger.error arrow functions in run() (exercised via scanRepoFn)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { summaryText } from '../helpers/fake-actions-core.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'
import type { ScanLogger } from '@flagshark/core'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Minimal fake scan result with no flags and no languages */
function makeEmptyScan() {
  return async () => ({
    totalFlags: 0,
    filesScanned: 1,
    staleFlags: [] as never[],
    detectedProviders: [] as string[],
    languageBreakdown: {} as Record<string, number>,
    healthScore: 100,
    scanDuration: 1,
  })
}

describe('run() branch coverage — scan input default', () => {
  it('omitting scan input defaults to "changed" scan mode', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    // No `scan` input — getInput returns '' → || 'changed' branch taken
    const { core } = await runAction({
      cwd: dir,
      inputs: {},
    })

    // The action falls back to 'changed', finds no PR context, logs the info message
    expect(core.state.infos.some((s) => s.includes('no pull_request context'))).toBe(true)
    expect(core.state.failed).toBeNull()
  })
})

describe('run() branch coverage — providers truncation', () => {
  it('logs "+N more" suffix when more than 8 providers detected', async () => {
    const tenProviders = Array.from({ length: 10 }, (_, i) => `provider-${i}`)
    const fakeScan = async () => ({
      totalFlags: 0,
      filesScanned: 1,
      staleFlags: [] as never[],
      detectedProviders: tenProviders,
      languageBreakdown: { typescript: 1 },
      healthScore: 100,
      scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(core.state.infos.some((s) => s.includes('+2 more'))).toBe(true)
    expect(core.state.failed).toBeNull()
  })
})

describe('run() branch coverage — token input fallback', () => {
  it('uses core.getInput("token") when GITHUB_TOKEN env var is not set', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('TOKEN_FLAG', user, false)\n`)
    commitAll(dir, 'init')

    // GITHUB_TOKEN deliberately NOT in opts.env (so it's unset/whatever the host env has,
    // but we delete it explicitly to be safe)
    const savedToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
    try {
      const { octokit } = await runAction({
        cwd: dir,
        inputs: { scan: 'full', token: 'input-token-value' },
        pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
        // No env: { GITHUB_TOKEN } — token comes from core.getInput('token')
      })

      // A comment should be posted, proving the token fallback path was exercised
      expect(octokit.state.calls.create).toBe(1)
    } finally {
      if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken
    }
  })
})

describe('run() branch coverage — stale flag with no age', () => {
  it('renders "unknown" in summary table when stale flag has no age', async () => {
    const staleNoAge = [
      {
        name: 'AGELESS_FLAG',
        filePath: 'src/x.ts',
        lineNumber: 1,
        language: 'typescript',
        provider: 'launchdarkly-node-server-sdk',
        age: undefined,  // no age — exercises `f.age || 'unknown'`
        signals: [{ type: 'age' as const, description: 'Flag reference last modified long ago' }],
      },
    ]
    const fakeScan = async () => ({
      totalFlags: 1,
      filesScanned: 1,
      staleFlags: staleNoAge as never,
      detectedProviders: ['launchdarkly-node-server-sdk'],
      languageBreakdown: { typescript: 1 },
      healthScore: 50,
      scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(summaryText(core)).toContain('unknown')
    expect(core.state.failed).toBeNull()
  })
})

describe('run() branch coverage — logger.warn and logger.error arrow functions', () => {
  it('logger.warn is exercised when scanRepoFn calls opts.logger.warn', async () => {
    const fakeScan = async (opts: { logger?: ScanLogger }) => {
      opts.logger?.warn('test warning from scan')
      return {
        totalFlags: 0,
        filesScanned: 1,
        staleFlags: [] as never[],
        detectedProviders: [] as string[],
        languageBreakdown: { typescript: 1 },
        healthScore: 100,
        scanDuration: 1,
      }
    }

    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(core.state.warnings.some((w) => w.includes('test warning from scan'))).toBe(true)
  })

  it('logger.error is exercised when scanRepoFn calls opts.logger.error', async () => {
    const fakeScan = async (opts: { logger?: ScanLogger }) => {
      opts.logger?.error('test error from scan')
      return {
        totalFlags: 0,
        filesScanned: 1,
        staleFlags: [] as never[],
        detectedProviders: [] as string[],
        languageBreakdown: { typescript: 1 },
        healthScore: 100,
        scanDuration: 1,
      }
    }

    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(core.state.errors.some((e) => e.includes('test error from scan'))).toBe(true)
  })
})
