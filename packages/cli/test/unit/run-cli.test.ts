import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { runCli } from '../../src/cli.js'

function collect(stream: PassThrough): { text: () => string } {
  let buf = ''
  stream.on('data', (chunk) => { buf += chunk.toString() })
  return { text: () => buf }
}

describe('runCli', () => {
  it('prints version on --version and returns exit code 0', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--version'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(0)
    expect(out.text()).toMatch(/^flagshark v\d+\.\d+\.\d+/)
    expect(err.text()).toBe('')
  })

  it('prints help on --help and returns exit code 0', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--help'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(0)
    expect(out.text()).toContain('flagshark scan')
  })
})
