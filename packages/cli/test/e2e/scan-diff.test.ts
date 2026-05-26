import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — --diff', () => {
  it('only scans changed files since ref', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    const body =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFixtureFile(dir, 'src/old.ts', body + `client.variation('OLD', user, false)\n`)
    // Old commit date so single-file NEW flag (added in the second
    // commit) has the age signal — v2.1.1's low-usage demotion means
    // single-file alone no longer makes a flag stale.
    commitAll(dir, 'first', '2022-01-01T00:00:00')

    writeFixtureFile(dir, 'src/new.ts', body + `client.variation('NEW', user, false)\n`)
    commitAll(dir, 'second', '2022-06-01T00:00:00')

    const r = runCli(['--diff', 'HEAD~1', '--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"NEW"')
    expect(r.stdout).not.toContain('"OLD"')
  })

  it('--diff stderr info log includes the ref', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli(['--diff', 'HEAD'], { cwd: dir })
    expect(r.stderr).toContain('HEAD')
  })
})
