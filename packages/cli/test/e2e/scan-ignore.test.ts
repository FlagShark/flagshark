import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — ignore file', () => {
  it('honors .flagsharkignore by default', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL', user, false)\n`)
    writeFixtureFile(dir, 'examples/demo.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('DEMO', user, false)\n`)
    writeFixtureFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const r = runCli(['--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"REAL"')
    expect(r.stdout).not.toContain('"DEMO"')
  })

  it('--no-ignore-file bypasses .flagsharkignore', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL', user, false)\n`)
    writeFixtureFile(dir, 'examples/demo.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('DEMO', user, false)\n`)
    writeFixtureFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const r = runCli(['--no-ignore-file', '--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"REAL"')
    expect(r.stdout).toContain('"DEMO"')
  })

  it('--show-excluded with --verbose logs effective excludes', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    writeFixtureFile(dir, 'examples/demo.ts', 'export const y = 1\n')
    writeFixtureFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const r = runCli(['--show-excluded', '--verbose'], { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('Effective excludes')
  })
})
