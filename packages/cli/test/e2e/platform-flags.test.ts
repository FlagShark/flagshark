import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — platform flags', () => {
  it('--no-cache is accepted without error', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const r = runCli(['--no-cache'], { cwd: dir })
    expect(r.exitCode).toBe(0)
  })

  it('--fail-on-error is accepted without error', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const r = runCli(['--fail-on-error'], { cwd: dir })
    expect(r.exitCode).toBe(0)
  })

  it('--no-fail-on-error is accepted without error', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const r = runCli(['--no-fail-on-error'], { cwd: dir })
    expect(r.exitCode).toBe(0)
  })

  it('platforms config with missing token warns and continues exit 0', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('A', user, false)\n`)
    writeFixtureFile(dir, 'src/b.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('A', user, false)\n`)
    writeFixtureFile(dir, '.flagshark.yml',
      'platforms:\n  launchdarkly:\n    project: p\n    environment: prod\n')
    commitAll(dir, 'init')

    const r = runCli([], { cwd: dir, env: { LAUNCHDARKLY_API_TOKEN: '' } })
    expect(r.exitCode).toBe(0)
  })

  it('--help mentions --no-cache and --fail-on-error', () => {
    const r = runCli(['--help'], { cwd: process.cwd() })
    expect(r.stdout).toMatch(/--no-cache/)
    expect(r.stdout).toMatch(/--fail-on-error/)
  })
})
