import { describe, it, expect } from 'vitest'
import { runCli } from '../helpers/run-cli.js'

describe('CLI E2E — version, help, unknown', () => {
  it('--version prints version and exits 0', () => {
    const r = runCli(['--version'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^flagshark v\d+\.\d+\.\d+/)
  })

  it('-v is an alias for --version', () => {
    const r = runCli(['-v'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^flagshark v/)
  })

  it('--help prints help and exits 0', () => {
    const r = runCli(['--help'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('flagshark scan')
    expect(r.stdout).toContain('--threshold')
  })

  it('-h is an alias for --help', () => {
    const r = runCli(['-h'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('flagshark scan')
  })

  it('unknown flag exits 2 with stderr error', () => {
    const r = runCli(['--nope'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/Unknown option/)
  })

  it('--format bogus exits 2', () => {
    const r = runCli(['--format', 'bogus'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/--format must be one of/)
  })

  it('--engine bogus exits 2', () => {
    const r = runCli(['--engine', 'bogus'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/--engine must be/)
  })

  it('--threshold 0 exits 2', () => {
    const r = runCli(['--threshold', '0'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
  })

  it('--threshold abc exits 2', () => {
    const r = runCli(['--threshold', 'abc'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
  })

  it('--diff without value exits 2', () => {
    const r = runCli(['--diff'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
  })
})
