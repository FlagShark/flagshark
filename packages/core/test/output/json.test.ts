import { describe, it, expect } from 'vitest'
import { formatJson } from '../../src/output/json.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'
import type { StaleFlag } from '../../src/staleness.js'

function baseResult(staleFlags: StaleFlag[]): ScanRepoResult {
  return {
    totalFlags: staleFlags.length,
    filesScanned: 1,
    staleFlags,
    parseErrorCount: 0,
    excludedPermanent: [],
    permanentByPlatform: {},
    healthScore: 10,
    detectedProviders: ['launchdarkly-node-server-sdk'],
    languageBreakdown: { typescript: 1 },
    excludedPaths: [],
    scanDuration: 0,
  }
}

describe('formatJson — environments block', () => {
  it('omits the environments key when no per-env data is attached', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('environments')
  })

  it('emits per-env data when present', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', { status: 'launched', evaluations30d: 12000, lastRequested: new Date('2026-05-25T00:00:00Z'), lastTouched: new Date('2026-04-01T00:00:00Z') }],
        ['staging',    { status: 'active',   evaluations30d: 3,     lastRequested: new Date('2026-05-26T00:00:00Z'), lastTouched: new Date('2026-05-20T00:00:00Z') }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments).toEqual({
      production: {
        status: 'launched',
        evaluations30d: 12000,
        lastRequested: '2026-05-25T00:00:00.000Z',
        lastTouched: '2026-04-01T00:00:00.000Z',
      },
      staging: {
        status: 'active',
        evaluations30d: 3,
        lastRequested: '2026-05-26T00:00:00.000Z',
        lastTouched: '2026-05-20T00:00:00.000Z',
      },
    })
  })

  it('omits per-env status when undefined while including other fields', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          // status intentionally absent — exercises the data.status != null else branch
          evaluations30d: 100,
          lastRequested: new Date('2026-05-25T00:00:00Z'),
          lastTouched: new Date('2026-04-01T00:00:00Z'),
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).not.toHaveProperty('status')
    expect(json.flags[0].environments.production).toHaveProperty('evaluations30d', 100)
  })

  it('omits null/undefined per-env fields', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', { status: 'active' /* no evaluations30d, no lastRequested, no lastTouched */ }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).toEqual({ status: 'active' })
  })
})
