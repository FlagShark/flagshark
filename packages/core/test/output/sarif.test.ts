import { describe, it, expect } from 'vitest'

import { formatSarif } from '../../src/output/sarif.js'
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

describe('formatSarif', () => {
  it('emits a valid SARIF v2.1.0 envelope', () => {
    const sarif = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json')
    expect(sarif.version).toBe('2.1.0')
    expect(Array.isArray(sarif.runs)).toBe(true)
    expect(sarif.runs).toHaveLength(1)
  })

  it('includes the tool driver metadata with the passed version', () => {
    const sarif = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    expect(sarif.runs[0].tool.driver.name).toBe('FlagShark')
    expect(sarif.runs[0].tool.driver.version).toBe('1.4.0')
    expect(sarif.runs[0].tool.driver.informationUri).toBe('https://github.com/FlagShark/flagshark')
  })

  it('declares the three rules: stale-age, stale-low-usage, stale-hardcoded', () => {
    const sarif = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id).sort()
    expect(ruleIds).toEqual(['stale-age', 'stale-hardcoded', 'stale-low-usage'])
  })

  it('emits one result per stale flag', () => {
    const sarif = JSON.parse(formatSarif(
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
      { version: '1.4.0' },
    ))
    const results = sarif.runs[0].results
    expect(results).toHaveLength(1)
    expect(results[0].ruleId).toBe('stale-age')
    expect(results[0].level).toBe('note')
    expect(results[0].message.text).toContain('CHECKOUT_V2')
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/checkout.ts')
    expect(results[0].locations[0].physicalLocation.region.startLine).toBe(47)
    expect(results[0].properties.flag).toBe('CHECKOUT_V2')
    expect(results[0].properties.provider).toBe('launchdarkly')
  })

  it('maps signal count to severity: 1 signal = note, 2 = warning, 3+ = error', () => {
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [
          {
            name: 'ONE', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
            signals: [{ type: 'age', severity: 'warning', description: 'old' }], age: '12 months ago',
          },
          {
            name: 'TWO', filePath: 'b.ts', lineNumber: 2, language: 'typescript', provider: 'launchdarkly',
            signals: [
              { type: 'age', severity: 'warning', description: 'old' },
              { type: 'low-usage', severity: 'warning', description: 'single' },
            ],
            age: '12 months ago',
          },
        ],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results.find((r: { properties: { flag: string } }) => r.properties.flag === 'ONE').level).toBe('note')
    expect(sarif.runs[0].results.find((r: { properties: { flag: string } }) => r.properties.flag === 'TWO').level).toBe('warning')
  })

  it('picks rule id from the first signal (deterministic)', () => {
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [
            { type: 'low-usage', severity: 'warning', description: 'single' },
            { type: 'age', severity: 'warning', description: 'old' },
          ],
          age: '12 months ago',
        }],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results[0].ruleId).toBe('stale-low-usage')
  })

  it('maps "hardcoded" first signal to stale-hardcoded rule (line 85)', () => {
    // Covers the final `else` branch in toSarifResult ruleId mapping
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [{ type: 'hardcoded', severity: 'warning', description: 'hardcoded default' }],
        }],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results[0].ruleId).toBe('stale-hardcoded')
  })
})
