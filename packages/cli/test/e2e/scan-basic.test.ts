import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — basic scan', () => {
  it('exits 0 for a repo with no flags', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/empty.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli([], { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FlagShark')
  })

  it('exits 0 for a repo with non-stale flags', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    const body =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFixtureFile(dir, 'src/a.ts', body + `client.variation('FRESH_FLAG', user, false)\n`)
    writeFixtureFile(dir, 'src/b.ts', body + `client.variation('FRESH_FLAG', user, false)\n`)
    commitAll(dir, 'init')

    const r = runCli([], { cwd: dir })
    expect(r.exitCode).toBe(0)
  })

  it('exits 1 when stale flags found', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const r = runCli([], { cwd: dir })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toMatch(/stale/i)
  })

  it('--verbose emits info logs to stderr', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli(['--verbose'], { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('[info]')
  })
})
