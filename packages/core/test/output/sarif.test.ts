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

  it('declares rules dynamically based on signal types present in results', () => {
    // Empty results → no rules emitted
    const sarifEmpty = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    expect(sarifEmpty.runs[0].tool.driver.rules).toHaveLength(0)

    // stale-age rule appears when age signal is present
    const sarifAge = JSON.parse(formatSarif(makeResult({
      staleFlags: [{ name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'ld',
        signals: [{ type: 'age', severity: 'warning', description: 'old' }] }],
    }), { version: '1.4.0' }))
    const ageRuleIds = sarifAge.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)
    expect(ageRuleIds).toContain('stale-age')
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
    expect(results[0].level).toBe('warning')
    expect(results[0].message.text).toContain('CHECKOUT_V2')
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/checkout.ts')
    expect(results[0].locations[0].physicalLocation.region.startLine).toBe(47)
    expect(results[0].properties.flag).toBe('CHECKOUT_V2')
    expect(results[0].properties.provider).toBe('launchdarkly')
  })

  it('maps severity field to SARIF level: warning signals → warning, error signals → error', () => {
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [
          {
            name: 'WARN', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
            signals: [{ type: 'age', severity: 'warning', description: 'old' }], age: '12 months ago',
          },
          {
            name: 'ERR', filePath: 'b.ts', lineNumber: 2, language: 'typescript', provider: 'launchdarkly',
            signals: [{ type: 'missing-in-platform', severity: 'error', description: 'missing' }],
            age: '12 months ago',
          },
        ],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results.find((r: { properties: { flag: string } }) => r.properties.flag === 'WARN').level).toBe('warning')
    expect(sarif.runs[0].results.find((r: { properties: { flag: string } }) => r.properties.flag === 'ERR').level).toBe('error')
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

  it('maps "hardcoded" first signal to stale-hardcoded rule', () => {
    // Covers the fallback branch in signalTypeToRuleId
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

  it('uses stale-hardcoded rule when flag has no signals', () => {
    // Covers the firstSignal falsy branch in toSarifResult
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [{
          name: 'Y', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [],
        }],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results[0].ruleId).toBe('stale-hardcoded')
  })
})

describe('sarif formatter — severity + rule IDs', () => {
  function staleFlag(name: string, type: 'missing-in-platform' | 'archived-in-platform' | 'age', severity: 'error' | 'warning') {
    return {
      name, filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
      signals: [{ type, severity, description: 'desc' }],
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

  it('emits level: error for missing-in-platform flag', () => {
    const out = JSON.parse(formatSarif(makeResult([staleFlag('M', 'missing-in-platform', 'error')]), { version: 'v1' }))
    const r = out.runs[0].results[0]
    expect(r.level).toBe('error')
  })

  it('emits level: warning for age signal', () => {
    const out = JSON.parse(formatSarif(makeResult([staleFlag('A', 'age', 'warning')]), { version: 'v1' }))
    const r = out.runs[0].results[0]
    expect(r.level).toBe('warning')
  })

  it('includes flagshark/missing-in-platform rule', () => {
    const out = JSON.parse(formatSarif(makeResult([staleFlag('M', 'missing-in-platform', 'error')]), { version: 'v1' }))
    const ruleIds = (out.runs[0].tool.driver.rules ?? []).map((r: { id: string }) => r.id)
    expect(ruleIds).toContain('flagshark/missing-in-platform')
  })

  it('includes flagshark/archived-in-platform rule when archived signal present', () => {
    const out = JSON.parse(formatSarif(makeResult([staleFlag('A', 'archived-in-platform', 'warning')]), { version: 'v1' }))
    const ruleIds = (out.runs[0].tool.driver.rules ?? []).map((r: { id: string }) => r.id)
    expect(ruleIds).toContain('flagshark/archived-in-platform')
  })
})
