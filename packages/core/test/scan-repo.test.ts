import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { scanRepo } from '../src/scan-repo.js'

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flagshark-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  return dir
}

describe('scanRepo', () => {
  it('returns a ScanRepoResult for a repo with one flag', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    // Use the flag in two files so the low-usage signal doesn't fire,
    // keeping the flag non-stale for a fresh commit.
    const sharedHeader =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      sharedHeader + `if (await client.variation('NEW_CHECKOUT', user, false)) {}\n`,
    )
    writeFileSync(
      join(dir, 'src', 'page.ts'),
      sharedHeader + `const v = await client.variation('NEW_CHECKOUT', user, false)\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, threshold: 6 })

    expect(result.totalFlags).toBe(1)
    expect(result.filesScanned).toBe(2)
    expect(result.detectedProviders.length).toBeGreaterThan(0)
    expect(result.healthScore).toBe(100)
    expect(result.staleFlags).toEqual([])
  })

  it('marks an old flag as stale', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'old.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `if (await client.variation('OLD_FLAG', user, false)) {}\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync(
      'git',
      ['commit', '-qm', 'old'],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2024-01-01T00:00:00',
          GIT_COMMITTER_DATE: '2024-01-01T00:00:00',
        },
      },
    )

    const result = await scanRepo({ cwd: dir, threshold: 6 })
    expect(result.staleFlags.length).toBeGreaterThan(0)
    expect(result.staleFlags[0].name).toBe('OLD_FLAG')
  })
})
