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

// Regression coverage for the silent-skip bug: without this surfacing, a
// user could scan PostHog with v1.3.x, see "54 stale flags" in the summary,
// and have no idea that 4568 of 17170 files (27%) were silently dropped by
// the python tree-sitter grammar. The shakedown report on the docs/product-
// specific-readme-links branch documents the original repro.
describe('formatText — parseErrorCount surfacing', () => {
  it('omits the parse-error line when parseErrorCount is 0', () => {
    const result = makeScanResult({ filesScanned: 100, parseErrorCount: 0 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).not.toContain("couldn't be parsed")
  })

  it('omits the parse-error line when parseErrorCount is missing (backward compat)', () => {
    const result = makeScanResult({ filesScanned: 100 })
    delete (result as { parseErrorCount?: number }).parseErrorCount
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).not.toContain("couldn't be parsed")
  })

  it('uses a quiet parenthetical when only a few files failed (<= 5%)', () => {
    const result = makeScanResult({ filesScanned: 100, parseErrorCount: 3 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain("(3 files couldn't be parsed")
    // Points to the existing stderr warning (logParseErrorSample) rather
    // than promising fictional `--verbose` detail. Ultrareview bug_012.
    expect(output).toContain('Parse errors during analysis')
    expect(output).not.toContain('⚠')
  })

  it('uses singular "file" when exactly one file failed', () => {
    const result = makeScanResult({ filesScanned: 100, parseErrorCount: 1 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain("(1 file couldn't be parsed")
    expect(output).not.toContain("files couldn't")
  })

  it('escalates to a warning with percentage when more than 5% of files failed', () => {
    // PostHog repro: 4568 / 17170 ≈ 27%.
    const result = makeScanResult({ filesScanned: 17170, parseErrorCount: 4568 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).toContain('⚠')
    expect(output).toContain('4568 of 17170 files')
    expect(output).toContain('(27%)')
    expect(output).toContain('results may be incomplete')
  })

  it('does not show a percentage when below 1% (avoids "(0%)")', () => {
    const result = makeScanResult({ filesScanned: 1000, parseErrorCount: 5 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    expect(output).not.toContain('(0%)')
    expect(output).toContain("5 files couldn't be parsed")
  })

  it('does not divide by zero when filesScanned is 0', () => {
    // Important: use parseErrorCount > 0 here. Pre-fix this test used
    // parseErrorCount=0 which short-circuited the guard at
    // `parseErrorCount > 0 && filesScanned > 0` before the division was
    // ever reached — so it didn't actually exercise the filesScanned > 0
    // protection. Ultrareview bug_008.
    const result = makeScanResult({ filesScanned: 0, parseErrorCount: 1 })
    const output = formatText(result, { verbose: false, maxDisplay: 10 })
    // The guarded clause was hit (parseErrorCount > 0 was true) and
    // skipped because filesScanned === 0. The output must not have
    // computed `1 / 0 * 100` → Infinity, nor `NaN%`.
    expect(output).not.toMatch(/NaN|Infinity/)
  })
})

describe('formatJson — parseErrorCount field', () => {
  it('includes parseErrorCount when present on the result', () => {
    const result = makeScanResult({ filesScanned: 100, parseErrorCount: 7 })
    const parsed = JSON.parse(formatJson(result, { version: '0.0.0-test' }))
    expect(parsed.parseErrorCount).toBe(7)
  })

  it('defaults parseErrorCount to 0 when missing on the result', () => {
    const result = makeScanResult({ filesScanned: 100 })
    delete (result as { parseErrorCount?: number }).parseErrorCount
    const parsed = JSON.parse(formatJson(result, { version: '0.0.0-test' }))
    expect(parsed.parseErrorCount).toBe(0)
  })

  it('keeps the legacy errorCount field separate (it counts severity-error stale flags, not parse failures)', () => {
    const result = makeScanResult({ filesScanned: 100, parseErrorCount: 12, staleFlags: [] })
    const parsed = JSON.parse(formatJson(result, { version: '0.0.0-test' }))
    expect(parsed.errorCount).toBe(0) // no severity-error flags
    expect(parsed.parseErrorCount).toBe(12)
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

  // B2.C — confidence field on detected flags. The detection-side
  // emission omits the field when value is 'high' (absent = high
  // convention); the JSON formatter normalises that to an explicit
  // string so downstream consumers (cleanup-PR builder, dashboards)
  // can read the field unconditionally.
  describe('confidence field (B2.C)', () => {
    it('defaults absent confidence to "high" in JSON output', () => {
      const result = makeScanResult({
        staleFlags: [
          {
            name: 'F1',
            filePath: 'a.ts',
            lineNumber: 1,
            language: 'typescript',
            provider: 'LaunchDarkly',
            signals: [{ type: 'low-usage', severity: 'warning', description: 'x' }],
            // confidence intentionally not set
          },
        ],
      })
      const parsed = JSON.parse(formatJson(result, { version: 'test' }))
      expect(parsed.flags[0].confidence).toBe('high')
    })

    it('emits medium confidence verbatim for runtime-symbol detections', () => {
      const result = makeScanResult({
        staleFlags: [
          {
            name: 'F2',
            filePath: 'a.tsx',
            lineNumber: 1,
            language: 'typescript',
            provider: 'posthog-js',
            signals: [{ type: 'low-usage', severity: 'warning', description: 'x' }],
            confidence: 'medium',
          },
        ],
      })
      const parsed = JSON.parse(formatJson(result, { version: 'test' }))
      expect(parsed.flags[0].confidence).toBe('medium')
    })
  })
})

describe('json formatter — severity + errorCount', () => {
  function staleFlag(name: string, severity: 'error' | 'warning') {
    return {
      name, filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
      signals: [{ type: 'missing-in-platform' as const, severity, description: 'desc' }],
      age: '12 months ago',
    }
  }
  function makeResult(staleFlags: ReturnType<typeof staleFlag>[]) {
    return {
      totalFlags: staleFlags.length, filesScanned: 1, staleFlags,
      detectedProviders: [], languageBreakdown: {},
      healthScore: 50, scanDuration: 1,
    }
  }

  it('includes errorCount at top level', () => {
    const out = JSON.parse(formatJson(makeResult([staleFlag('E', 'error'), staleFlag('W', 'warning')]), { version: 'v1' }))
    expect(out.errorCount).toBe(1)
  })

  it('errorCount is 0 when no error-severity flags', () => {
    const out = JSON.parse(formatJson(makeResult([staleFlag('W', 'warning')]), { version: 'v1' }))
    expect(out.errorCount).toBe(0)
  })

  it('preserves severity field on each signal', () => {
    const out = JSON.parse(formatJson(makeResult([staleFlag('E', 'error')]), { version: 'v1' }))
    expect(out.flags[0].signals[0].severity).toBe('error')
  })

  it('adds severity field to each staleFlag (max across signals)', () => {
    const out = JSON.parse(formatJson(makeResult([staleFlag('E', 'error')]), { version: 'v1' }))
    expect(out.flags[0].severity).toBe('error')
  })
})
