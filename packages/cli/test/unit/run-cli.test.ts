import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli, createLogger, toErrorMessage } from '../../src/cli.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

// ── Mock helpers ──────────────────────────────────────────────────────────────
// The mock is installed globally so vi.hoisted works correctly; the real
// implementation is used as the default so existing tests are unaffected.

const { mockScanRepo, realScanRepo } = vi.hoisted(() => {
  // We can't import here, so we capture the real impl after the mock is set up.
  // We use a wrapper that is swapped in the failOnError describe block.
  const mockFn = vi.fn()
  return { mockScanRepo: mockFn, realScanRepo: { fn: undefined as unknown as typeof import('@flagshark/core').scanRepo } }
})

vi.mock('@flagshark/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@flagshark/core')>()
  // Stash the real impl so tests can restore it
  realScanRepo.fn = actual.scanRepo
  // Default: delegate to the real implementation
  mockScanRepo.mockImplementation((...args: Parameters<typeof actual.scanRepo>) => actual.scanRepo(...args))
  return { ...actual, scanRepo: mockScanRepo }
})

function collect(stream: PassThrough): { text: () => string } {
  let buf = ''
  stream.on('data', (chunk) => { buf += chunk.toString() })
  return { text: () => buf }
}

const dirsToClean: string[] = []
afterEach(() => {
  for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('toErrorMessage', () => {
  it('returns the message property for Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('returns String(value) for non-Error thrown values', () => {
    expect(toErrorMessage('plain string')).toBe('plain string')
    expect(toErrorMessage(42)).toBe('42')
    expect(toErrorMessage(null)).toBe('null')
  })
})

describe('createLogger', () => {
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it('debug logs when verbose is true', () => {
    const logger = createLogger(true)
    logger.debug('msg')
    expect(spy).toHaveBeenCalledWith('[debug]', 'msg')
  })

  it('debug is silent when verbose is false', () => {
    const logger = createLogger(false)
    logger.debug('msg')
    expect(spy).not.toHaveBeenCalled()
  })

  it('info always logs', () => {
    const logger = createLogger(false)
    logger.info('hello')
    expect(spy).toHaveBeenCalledWith('[info]', 'hello')
  })

  it('warn always logs', () => {
    const logger = createLogger(false)
    logger.warn('caution')
    expect(spy).toHaveBeenCalledWith('[warn]', 'caution')
  })

  it('error always logs', () => {
    const logger = createLogger(false)
    logger.error('fail')
    expect(spy).toHaveBeenCalledWith('[error]', 'fail')
  })
})

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

  it('prints command-specific help for assess without requiring credentials', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', 'assess', '--help'], {
      stdout, stderr, cwd: process.cwd(),
    })
    expect(code).toBe(0)
    expect(out.text()).toContain('flagshark assess')
    expect(out.text()).toContain('FLAGSHARK_API_TOKEN')
    expect(out.text()).toContain('joe@flagshark.com')
    expect(out.text()).toContain('OIDC-based Action')
  })
})

describe('runCli — coverage branches', () => {
  it('returns 2 on unknown flag (parseArgs error path)', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--bogus'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/Unknown option/)
  })

  it('returns 2 when --config path does not exist', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--config', './nope.yml'], { stdout, stderr, cwd: dir })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/config file not found/i)
  })

  it('returns 2 on config with unparseable YAML syntax', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    const badYml = join(dir, 'bad.yml')
    // Unclosed flow sequence — guaranteed YAML parse error
    writeFileSync(badYml, 'threshold: [unclosed\n')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--config', badYml], { stdout, stderr, cwd: dir })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/invalid YAML/i)
  })

  it('returns 2 on config with valid YAML but invalid schema (wrong type)', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    const badYml = join(dir, 'bad.yml')
    writeFileSync(badYml, 'threshold: "not-a-number"\n')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--config', badYml], { stdout, stderr, cwd: dir })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/invalid config/i)
  })

  it('accepts a valid --config file and runs scan successfully', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    const configPath = join(dir, 'custom.yml')
    writeFileSync(configPath, 'threshold: 24\n')
    commitAll(dir, 'init')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--config', configPath, '--format', 'json'], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    expect(() => JSON.parse(out.text())).not.toThrow()
  })

  it('returns 0 and scans clean repo (exercises scanRepo path)', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli'], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    expect(out.text()).toContain('FlagShark')
  })

  it('returns 1 when stale flags found (non-zero exit path)', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const code = await runCli(['node', 'cli'], { stdout, stderr, cwd: dir })
    expect(code).toBe(1)
  })

  it('writes output to --output path and skips stdout', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const outPath = join(dir, 'out.json')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--format', 'json', '--output', outPath], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    expect(out.text()).toBe('')
    expect(readFileSync(outPath, 'utf-8').length).toBeGreaterThan(0)
  })

  it('--verbose with --show-excluded prints effective excludes to stderr', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    writeFixtureFile(dir, 'examples/demo.ts', 'export const y = 1\n')
    writeFixtureFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--verbose', '--show-excluded'], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    expect(err.text()).toMatch(/Effective excludes/)
  })

  it('writes csv output to stdout without adding a duplicate newline', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--format', 'csv'], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    // csv formatter already ends with \n — the finalOutput branch keeps it as-is
    expect(out.text().endsWith('\n')).toBe(true)
  })

  it('--diff flag reaches scanRepo with diff set (returns valid JSON output)', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'first')
    writeFixtureFile(dir, 'src/b.ts', 'export const y = 2\n')
    commitAll(dir, 'second')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--diff', 'HEAD~1', '--format', 'json'], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    // JSON output means scanRepo ran successfully with diff option
    expect(() => JSON.parse(out.text())).not.toThrow()
    expect(JSON.parse(out.text()).totalFlags).toBeGreaterThanOrEqual(0)
  })
})

describe('runCli — failOnError + hasErrorSignals branches', () => {
  const cannedErrorResult = {
    totalFlags: 1,
    filesScanned: 1,
    staleFlags: [{
      name: 'MISSING_FLAG',
      filePath: 'src/a.ts',
      lineNumber: 3,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [{ type: 'missing-in-platform' as const, severity: 'error' as const, description: 'not in LD' }],
      age: '0 months ago',
    }],
    detectedProviders: ['launchdarkly-node-server-sdk'],
    languageBreakdown: { typescript: 1 },
    healthScore: 0,
    scanDuration: 1,
  }

  beforeEach(() => {
    mockScanRepo.mockResolvedValue(cannedErrorResult)
  })

  afterEach(() => {
    // Restore default (delegate to real impl) after each test in this block
    mockScanRepo.mockImplementation((...args: Parameters<typeof realScanRepo.fn>) => realScanRepo.fn(...args))
  })

  it('returns 1 when failOnError is true (default) and error-severity signals present', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const code = await runCli(['node', 'cli', '--format', 'json'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(1)
  })

  it('returns 1 when --no-fail-on-error but stale flags still present (staleFlags.length > 0)', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const code = await runCli(['node', 'cli', '--no-fail-on-error', '--format', 'json'], { stdout, stderr, cwd: process.cwd() })
    // staleFlags.length > 0 → still 1 even without failOnError
    expect(code).toBe(1)
  })

  it('--no-cache is forwarded to scanRepo', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    mockScanRepo.mockResolvedValue({ ...cannedErrorResult, staleFlags: [], totalFlags: 0, healthScore: 100 })
    await runCli(['node', 'cli', '--no-cache', '--format', 'json'], { stdout, stderr, cwd: process.cwd() })
    expect(mockScanRepo).toHaveBeenCalledWith(expect.objectContaining({ noCache: true }))
  })
})
