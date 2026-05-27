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

describe('formatJson — variations', () => {
  it('emits top-level variations when populated', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      variations: [
        { value: false, name: 'off' },
        { value: true, name: 'on' },
      ],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].variations).toEqual([
      { value: false, name: 'off' },
      { value: true, name: 'on' },
    ])
  })

  it('omits variations when absent', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('variations')
  })

  it('omits variations when present but empty', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      variations: [],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('variations')
  })
})

describe('formatJson — per-env variation config', () => {
  it('emits on/fallthroughVariation/offVariation when populated', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          status: 'launched',
          on: true,
          fallthroughVariation: 1,
          offVariation: 0,
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).toMatchObject({
      on: true,
      fallthroughVariation: 1,
      offVariation: 0,
    })
  })

  it('preserves fallthroughVariation: null literally (load-bearing for split rollouts)', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          status: 'active',
          on: true,
          fallthroughVariation: null,  // split rollout
          offVariation: 0,
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    // Crucial: null must survive serialization, NOT be omitted.
    // SaaS uses null vs absent to distinguish "split rollout, fail closed"
    // from "field unknown".
    expect(json.flags[0].environments.production.fallthroughVariation).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(
      json.flags[0].environments.production,
      'fallthroughVariation',
    )).toBe(true)
  })

  it('omits on/offVariation when undefined while preserving other fields', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          status: 'active',
          // on intentionally undefined
          // offVariation intentionally undefined
          // fallthroughVariation also undefined — should be omitted too
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).not.toHaveProperty('on')
    expect(json.flags[0].environments.production).not.toHaveProperty('offVariation')
    expect(json.flags[0].environments.production).not.toHaveProperty('fallthroughVariation')
    expect(json.flags[0].environments.production.status).toBe('active')
  })
})

describe('formatJson — codeReferences', () => {
  it('emits codeReferences as object when populated', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      codeReferences: { count: 12 },
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].codeReferences).toEqual({ count: 12 })
  })

  it('preserves codeReferences: null literally (LD-says-zero is meaningful)', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      codeReferences: null,
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].codeReferences).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(
      json.flags[0],
      'codeReferences',
    )).toBe(true)
  })

  it('omits codeReferences when undefined (feature unavailable)', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      // codeReferences intentionally undefined
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('codeReferences')
  })
})
