import { describe, it, expect } from 'vitest'

import { formatText, formatJson } from '../src/formatter.js'

import type { ScanResult } from '../src/formatter.js'

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    totalFlags: 10,
    staleFlags: [],
    detectedProviders: ['LaunchDarkly'],
    languageBreakdown: new Map([['typescript', 50]]),
    healthScore: 100,
    scanDuration: 500,
    ...overrides,
  }
}

describe('formatText', () => {
  it('shows healthy message when no stale flags', () => {
    const result = makeScanResult({ healthScore: 100, staleFlags: [] })
    const output = formatText(result, { json: false, verbose: false, maxDisplay: 10 })
    expect(output).toContain('FlagShark')
    expect(output).toContain('100/100')
  })

  it('shows "no flags detected" when totalFlags is 0', () => {
    const result = makeScanResult({ totalFlags: 0, healthScore: 100, staleFlags: [] })
    const output = formatText(result, { json: false, verbose: false, maxDisplay: 10 })
    expect(output).toContain('No feature flags detected')
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
          signals: [{ type: 'age', description: 'Added 8 months ago' }],
          age: '8 months ago',
        },
      ],
    })
    const output = formatText(result, { json: false, verbose: false, maxDisplay: 10 })
    expect(output).toContain('TEST_FLAG')
    expect(output).toContain('60/100')
  })
})

describe('formatJson', () => {
  it('produces valid JSON', () => {
    const result = makeScanResult()
    const output = formatJson(result)
    const parsed = JSON.parse(output)
    expect(parsed.version).toBe('1.0.0')
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
          signals: [{ type: 'low-usage', description: 'Single file' }],
        },
      ],
    })
    const output = formatJson(result)
    const parsed = JSON.parse(output)
    expect(parsed.flags).toHaveLength(1)
    expect(parsed.flags[0].name).toBe('MY_FLAG')
    expect(parsed.flags[0].stale).toBe(true)
  })
})
