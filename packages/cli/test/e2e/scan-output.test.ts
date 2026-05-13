import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function makeRepo(): string {
  const dir = makeTempRepo()
  dirs.push(dir)
  const body =
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n`
  writeFixtureFile(dir, 'src/a.ts', body + `client.variation('A_FLAG', user, false)\n`)
  writeFixtureFile(dir, 'src/b.ts', body + `client.variation('A_FLAG', user, false)\n`)
  commitAll(dir, 'init')
  return dir
}

describe('CLI E2E — output formats', () => {
  it('text is default', () => {
    const r = runCli([], { cwd: makeRepo() })
    expect(r.stdout).toContain('FlagShark')
  })

  it('--format json emits valid JSON', () => {
    const r = runCli(['--format', 'json'], { cwd: makeRepo() })
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  it('--json alias works', () => {
    const r = runCli(['--json'], { cwd: makeRepo() })
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  it('--format markdown', () => {
    const r = runCli(['--format', 'markdown'], { cwd: makeRepo() })
    expect(r.stdout).toMatch(/^#|^\|/m)
  })

  it('--format csv', () => {
    const r = runCli(['--format', 'csv'], { cwd: makeRepo() })
    expect(r.stdout).toContain(',')
  })

  it('--format sarif', () => {
    const r = runCli(['--format', 'sarif'], { cwd: makeRepo() })
    const parsed = JSON.parse(r.stdout)
    expect(parsed.$schema).toMatch(/sarif/i)
  })

  it('--output writes to file instead of stdout', () => {
    const dir = makeRepo()
    const outPath = join(dir, 'report.json')
    const r = runCli(['--format', 'json', '--output', outPath], { cwd: dir })
    expect(r.stdout).toBe('')
    expect(existsSync(outPath)).toBe(true)
    expect(() => JSON.parse(readFileSync(outPath, 'utf-8'))).not.toThrow()
  })

  it('-o alias for --output', () => {
    const dir = makeRepo()
    const outPath = join(dir, 'report.json')
    runCli(['--format', 'json', '-o', outPath], { cwd: dir })
    expect(existsSync(outPath)).toBe(true)
  })
})
