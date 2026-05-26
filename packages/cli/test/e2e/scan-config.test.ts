import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — config', () => {
  it('auto-discovers .flagshark.yml from cwd', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FOO', user, false)\n`)
    writeFixtureFile(dir, 'src/a.test.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('TEST_FOO', user, false)\n`)
    writeFixtureFile(dir, '.flagshark.yml', 'excludes:\n  presets:\n    - test-files\n')
    // Old commit date so the age signal fires. As of v2.1.1 the low-
    // usage signal alone no longer marks a flag stale, so single-file
    // FOO needs another signal to land in the staleFlags array (which
    // is what the JSON output's `flags` field contains — and what the
    // assertion below verifies).
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const r = runCli(['--format', 'json'], { cwd: dir })
    expect(r.exitCode).toBeLessThanOrEqual(1)
    expect(r.stdout).toContain('"FOO"')
    expect(r.stdout).not.toContain('"TEST_FOO"')
  })

  it('--config <path> overrides discovery', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FOO', user, false)\n`)
    writeFileSync(join(dir, 'custom.yml'), 'threshold: 24\n')
    commitAll(dir, 'init')

    const r = runCli(['--config', 'custom.yml', '--format', 'json'], { cwd: dir })
    expect(r.exitCode).toBeLessThanOrEqual(1)
  })

  it('--config with missing file exits 2', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli(['--config', './nope.yml'], { cwd: dir })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/config file not found/i)
  })

  it('--config with malformed YAML exits 2', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    writeFileSync(join(dir, 'bad.yml'), 'threshold: "not-a-number"\n')
    commitAll(dir, 'init')

    const r = runCli(['--config', 'bad.yml'], { cwd: dir })
    expect(r.exitCode).toBe(2)
  })

  it('--no-config ignores .flagshark.yml', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FOO', user, false)\n`)
    writeFixtureFile(dir, 'src/a.test.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('TEST_FOO', user, false)\n`)
    writeFixtureFile(dir, '.flagshark.yml', 'excludes:\n  presets:\n    - test-files\n')
    commitAll(dir, 'init')

    const r = runCli(['--no-config', '--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"TEST_FOO"')
  })
})
