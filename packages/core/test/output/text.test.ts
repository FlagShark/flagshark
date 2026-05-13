import { describe, it, expect } from 'vitest'

import { formatText } from '../../src/output/text.js'
import { formatJson } from '../../src/output/json.js'

import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeScanResult(overrides: Partial<ScanRepoResult> = {}): ScanRepoResult {
  return {
    totalFlags: 10,
    filesScanned: 50,
    staleFlags: [],
    detectedProviders: ['LaunchDarkly'],
    languageBreakdown: { typescript: 50 },
    healthScore: 100,
    scanDuration: 500,
    ...overrides,
  }
}

describe('formatText', () => {
  it('shows healthy message when no stale flags', () => {
    const result = makeScanResult({ healthScore: 100, staleFlags: [] })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('FlagShark')
    expect(output).toContain('100/100')
  })

  it('shows "no flags detected" when totalFlags is 0', () => {
    const result = makeScanResult({ totalFlags: 0, healthScore: 100, staleFlags: [] })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('No feature flags detected')
  })

  it('shows excluded count when excludedCount > 0', () => {
    const result = makeScanResult({ totalFlags: 0, staleFlags: [], excludedCount: 47 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('47 excluded')
  })

  it('shows stale flag table when stale flags exist', () => {
    const result = makeScanResult({
      totalFlags: 5,
      healthScore: 60,
      staleFlags: [
        {
          name: 'TEST_FLAG',
          filePath: 'src/test.ts',
          lineNumber: 42,
          language: 'typescript',
          provider: 'LaunchDarkly',
          signals: [{ type: 'age', severity: 'warning', description: 'Added 8 months ago' }],
          age: '8 months ago',
        },
      ],
    })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('TEST_FLAG')
    expect(output).toContain('60/100')
  })

  it('shows "... and N more" when stale flags exceed maxDisplay (lines 89-91)', () => {
    const staleFlags = Array.from({ length: 5 }, (_, i) => ({
      name: `FLAG_${i}`,
      filePath: `src/file${i}.ts`,
      lineNumber: i + 1,
      language: 'typescript',
      provider: 'LaunchDarkly',
      signals: [{ type: 'age' as const, severity: 'warning' as const, description: 'old' }],
      age: '8 months ago',
    }))
    const result = makeScanResult({ totalFlags: 5, healthScore: 50, staleFlags })
    // maxDisplay: 2 with 5 flags → remaining = 3
    const output = formatText(result, { verbose: false, maxDisplay: 2 })
    expect(output).toContain('... and 3 more')
  })

  it('does not show "... and N more" when verbose is true', () => {
    const staleFlags = Array.from({ length: 5 }, (_, i) => ({
      name: `FLAG_${i}`,
      filePath: `src/file${i}.ts`,
      lineNumber: i + 1,
      language: 'typescript',
      provider: 'LaunchDarkly',
      signals: [{ type: 'age' as const, severity: 'warning' as const, description: 'old' }],
      age: '8 months ago',
    }))
    const result = makeScanResult({ totalFlags: 5, healthScore: 50, staleFlags })
    const output = formatText(result, { verbose: true, maxDisplay: 2 })
    expect(output).not.toContain('more (use --verbose')
  })

  it('shows excluded paths when excludedPaths is set (lines 107-112)', () => {
    const result = makeScanResult({
      totalFlags: 1,
      healthScore: 100,
      staleFlags: [],
      excludedPaths: ['examples/demo.ts', 'test/app.test.ts'],
    })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('Excluded files (2):')
    expect(output).toContain('examples/demo.ts')
    expect(output).toContain('test/app.test.ts')
  })

  it('shows "All flags look healthy" when staleCount === 0', () => {
    const result = makeScanResult({ totalFlags: 10, healthScore: 100, staleFlags: [] })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('All flags look healthy')
  })

  it('shows stale link when there are stale flags', () => {
    const result = makeScanResult({
      totalFlags: 5,
      healthScore: 60,
      staleFlags: [{
        name: 'TEST_FLAG',
        filePath: 'src/test.ts',
        lineNumber: 42,
        language: 'typescript',
        provider: 'LaunchDarkly',
        signals: [{ type: 'age', severity: 'warning', description: 'Added 8 months ago' }],
        age: '8 months ago',
      }],
    })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('flagshark.com')
  })

  it('shows "low-usage" signal text in table', () => {
    const result = makeScanResult({
      totalFlags: 3,
      healthScore: 70,
      staleFlags: [{
        name: 'LOW_USAGE',
        filePath: 'src/test.ts',
        lineNumber: 10,
        language: 'typescript',
        provider: 'LaunchDarkly',
        signals: [{ type: 'low-usage', severity: 'warning', description: 'Single file usage' }],
      }],
    })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('Single file')
  })

  it('shows hardcoded signal description (line 41 — else fallback)', () => {
    // Signal type 'hardcoded' falls through to `return s.description`
    const result = makeScanResult({
      totalFlags: 3,
      healthScore: 70,
      staleFlags: [{
        name: 'HARD_CODED',
        filePath: 'src/test.ts',
        lineNumber: 5,
        language: 'typescript',
        provider: 'LaunchDarkly',
        signals: [{ type: 'hardcoded', severity: 'warning', description: 'Hardcoded value detected' }],
      }],
    })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('Hardcoded value detected')
  })

  it('truncates long flag names in table (lines 17-18 — pad truncation)', () => {
    // Flag name longer than 16 chars triggers the `str.length > width` branch
    const result = makeScanResult({
      totalFlags: 3,
      healthScore: 60,
      staleFlags: [{
        name: 'THIS_IS_A_VERY_LONG_FLAG_NAME_EXCEEDS_COLUMN',
        filePath: 'src/test.ts',
        lineNumber: 1,
        language: 'typescript',
        provider: 'LaunchDarkly',
        signals: [{ type: 'age', severity: 'warning', description: 'old' }],
        age: '8 months ago',
      }],
    })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    // Truncated name should contain '…' ellipsis
    expect(output).toContain('…')
  })
})

describe('text formatter — severity + new signals', () => {
  function staleFlag(name: string, signalType: 'missing-in-platform' | 'archived-in-platform' | 'age', severity: 'error' | 'warning') {
    return {
      name, filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
      signals: [{ type: signalType, severity, description: 'desc' }],
      age: '12 months ago',
    }
  }
  function makeResult(staleFlags: ReturnType<typeof staleFlag>[]) {
    return {
      totalFlags: staleFlags.length,
      filesScanned: 1,
      staleFlags,
      detectedProviders: [],
      languageBreakdown: {},
      healthScore: 50,
      scanDuration: 1,
    }
  }

  it('sorts error-severity flags before warning-severity', () => {
    const result = makeResult([
      staleFlag('OLD', 'age', 'warning'),
      staleFlag('MISSING', 'missing-in-platform', 'error'),
    ])
    const out = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(out.indexOf('MISSING')).toBeLessThan(out.indexOf('OLD'))
  })

  it('shows missing-in-platform signal in the output', () => {
    const result = makeResult([staleFlag('M', 'missing-in-platform', 'error')])
    const out = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(out).toMatch(/missing-in-platform/)
  })

  it('shows archived-in-platform signal in the output', () => {
    const result = makeResult([staleFlag('A', 'archived-in-platform', 'warning')])
    const out = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(out).toMatch(/archived-in-platform/)
  })
})

describe('formatJson', () => {
  it('produces valid JSON', () => {
    const result = makeScanResult()
    const output = formatJson(result, { version: 'test' })
    const parsed = JSON.parse(output)
    expect(parsed.version).toBe('test')
    expect(parsed.totalFlags).toBe(10)
    expect(parsed.healthScore).toBe(100)
  })

  it('includes flag details in JSON', () => {
    const result = makeScanResult({
      staleFlags: [
        {
          name: 'MY_FLAG',
          filePath: 'src/app.ts',
          lineNumber: 10,
          language: 'typescript',
          provider: 'LaunchDarkly',
          signals: [{ type: 'low-usage', severity: 'warning', description: 'Single file' }],
        },
      ],
    })
    const output = formatJson(result, { version: 'test' })
    const parsed = JSON.parse(output)
    expect(parsed.flags).toHaveLength(1)
    expect(parsed.flags[0].name).toBe('MY_FLAG')
    expect(parsed.flags[0].stale).toBe(true)
  })
})
