import { describe, it, expect } from 'vitest'

import { formatCsv } from '../../src/output/csv.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeResult(overrides: Partial<ScanRepoResult> = {}): ScanRepoResult {
  return {
    totalFlags: 0,
    filesScanned: 0,
    staleFlags: [],
    detectedProviders: [],
    languageBreakdown: {},
    healthScore: 100,
    scanDuration: 0,
    ...overrides,
  } as ScanRepoResult
}

describe('formatCsv', () => {
  it('emits only the header row when no stale flags', () => {
    expect(formatCsv(makeResult())).toBe(
      'flag,file,line,language,provider,signals,age,severity\n',
    )
  })

  it('emits one row per stale flag', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [
          {
            name: 'CHECKOUT_V2',
            filePath: 'src/checkout.ts',
            lineNumber: 47,
            language: 'typescript',
            provider: 'launchdarkly',
            signals: [{ type: 'age', severity: 'warning', description: 'Flag reference last modified 14 months ago' }],
            age: '14 months ago',
          },
        ],
      }),
    )
    const lines = csv.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('flag,file,line,language,provider,signals,age,severity')
    expect(lines[1]).toBe('"CHECKOUT_V2","src/checkout.ts",47,"typescript","launchdarkly","age","14 months ago","warning"')
  })

  it('joins multiple signals with semicolons', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'unleash',
          signals: [
            { type: 'age', severity: 'warning', description: 'old' },
            { type: 'low-usage', severity: 'warning', description: 'single file' },
          ],
          age: '12 months ago',
        }],
      }),
    )
    expect(csv).toContain('"age; low-usage"')
  })

  it('escapes double quotes by doubling (RFC 4180)', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'FLAG"WITH"QUOTES',
          filePath: 'src/"weird".ts',
          lineNumber: 1,
          language: 'typescript',
          provider: 'launchdarkly',
          signals: [{ type: 'age', severity: 'warning', description: 'old' }],
          age: '12 months ago',
        }],
      }),
    )
    expect(csv).toContain('"FLAG""WITH""QUOTES"')
    expect(csv).toContain('"src/""weird"".ts"')
  })

  it('handles missing age as empty string', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [{ type: 'age', severity: 'warning', description: 'old' }],
          // age omitted
        }],
      }),
    )
    expect(csv).toMatch(/,"","warning"\n$/)
  })

  it('ends with a single newline after the data row', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [{ type: 'age', severity: 'warning', description: 'old' }],
          age: '12 months ago',
        }],
      }),
    )
    expect(csv.endsWith('"warning"\n')).toBe(true)
  })
})

describe('csv formatter — severity column', () => {
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

  it('header includes severity column', () => {
    const out = formatCsv(makeResult([]))
    expect(out.split('\n')[0]).toContain('severity')
  })

  it('row includes the severity value', () => {
    const out = formatCsv(makeResult([staleFlag('E', 'error')]))
    expect(out).toContain('error')
  })
})
