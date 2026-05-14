import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { scanRepo } from '../src/scan-repo.js'
import { makeTempRepo, writeFixtureFile, commitAll } from './fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const FLAG_FILE_BODY = (flagName: string) =>
  `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
  `const client = LaunchDarkly.init('sdk-key')\n` +
  `client.variation('${flagName}', user, false)\n`

describe('scanRepo — platform integration', () => {
  it('no platforms configured → identical behavior to v1.3 (no error-severity signals)', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', FLAG_FILE_BODY('OLD_FLAG'))
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const result = await scanRepo({ cwd: dir, threshold: 6 })
    expect(result.staleFlags.length).toBeGreaterThan(0)
    const hasError = result.staleFlags.some((s) => s.signals.some((sig) => sig.severity === 'error'))
    expect(hasError).toBe(false)
  })

  it('missing token + platforms configured → warns and continues', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', FLAG_FILE_BODY('A'))
    writeFixtureFile(dir, '.flagshark.yml',
      'platforms:\n  launchdarkly:\n    project: my-proj\n    environment: prod\n')
    commitAll(dir, 'init')

    const prev = process.env.LAUNCHDARKLY_API_TOKEN
    delete process.env.LAUNCHDARKLY_API_TOKEN
    try {
      const warnings: string[] = []
      const result = await scanRepo({
        cwd: dir,
        threshold: 6,
        logger: {
          debug: () => {},
          info: () => {},
          warn: (...args: unknown[]) => { warnings.push(args.join(' ')) },
          error: () => {},
        },
      })
      expect(warnings.some((w) => w.includes('LAUNCHDARKLY_API_TOKEN'))).toBe(true)
      expect(result.totalFlags).toBe(1)
    } finally {
      if (prev !== undefined) process.env.LAUNCHDARKLY_API_TOKEN = prev
    }
  })
})
