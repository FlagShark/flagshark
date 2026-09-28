import { describe, it, expect } from 'vitest'

import { summarizeEvaluationSurface } from '../../src/detection/evaluation-surface.js'
import { EVALUATION_GAP_DETAILS } from '../../src/detection/wrapper-evaluations.js'

import type { FeatureFlag } from '../../src/detection/feature-flag.js'
import type {
  EvaluationSite,
  WrapperDeclaration,
  WrapperEvaluationResult,
} from '../../src/detection/wrapper-evaluations.js'

const ROOT = '/repo'

function site(partial: Partial<EvaluationSite> & Pick<EvaluationSite, 'status'>): EvaluationSite {
  return {
    filePath: `${ROOT}/src/app.ts`,
    lineNumber: 1,
    callee: 'getFlag',
    via: 'wrapper',
    ...partial,
  }
}

function wrapper(partial: Partial<WrapperDeclaration> = {}): WrapperDeclaration {
  return {
    filePath: `${ROOT}/src/flags.ts`,
    lineNumber: 4,
    kind: 'function',
    name: 'getFlag',
    owner: null,
    keyParameterIndex: 0,
    provider: '@launchdarkly/node-server-sdk',
    forwardsTo: 'boolVariation',
    depth: 1,
    exported: true,
    resolvedCallers: 1,
    unresolvedCallers: 0,
    forwardingCallers: 0,
    ...partial,
  }
}

function analysis(partial: Partial<WrapperEvaluationResult> = {}): WrapperEvaluationResult {
  return { wrappers: [], flags: [], sites: [], filesInScope: 0, ...partial }
}

describe('summarizeEvaluationSurface', () => {
  it('splits sites into accounted-for, delegated and unaccounted-for', () => {
    const { surface } = summarizeEvaluationSurface(
      analysis({
        filesInScope: 7,
        sites: [
          site({ status: { kind: 'accounted', flagKey: 'a' } }),
          site({ status: { kind: 'accounted', flagKey: 'b' }, lineNumber: 2 }),
          site({ status: { kind: 'delegated', wrapper: 'getFlag()' }, lineNumber: 3 }),
          site({ status: { kind: 'gap', reason: 'computed-key' }, lineNumber: 4 }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )

    expect(surface).toMatchObject({
      schemaVersion: 1,
      filesInScope: 7,
      sites: 4,
      accountedFor: 2,
      delegated: 1,
      unaccountedFor: 1,
    })
    expect(surface.accountedFor + surface.delegated + surface.unaccountedFor).toBe(surface.sites)
  })

  it('aggregates gaps by reason, most frequent first, with the first location as the sample', () => {
    const { surface } = summarizeEvaluationSurface(
      analysis({
        sites: [
          site({ status: { kind: 'gap', reason: 'unprovable-key' }, lineNumber: 11 }),
          site({ status: { kind: 'gap', reason: 'computed-key' }, lineNumber: 12 }),
          site({ status: { kind: 'gap', reason: 'computed-key' }, lineNumber: 13 }),
          site({ status: { kind: 'gap', reason: 'unnamed-wrapper' }, lineNumber: 14 }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )

    expect(surface.gaps).toEqual([
      {
        reason: 'computed-key',
        count: 2,
        sample: 'src/app.ts:12',
        detail: EVALUATION_GAP_DETAILS['computed-key'],
      },
      {
        reason: 'unnamed-wrapper',
        count: 1,
        sample: 'src/app.ts:14',
        detail: EVALUATION_GAP_DETAILS['unnamed-wrapper'],
      },
      {
        reason: 'unprovable-key',
        count: 1,
        sample: 'src/app.ts:11',
        detail: EVALUATION_GAP_DETAILS['unprovable-key'],
      },
    ])
  })

  it('reports each wrapper with its caller breakdown and a repository-relative location', () => {
    const { surface } = summarizeEvaluationSurface(
      analysis({
        wrappers: [
          wrapper({ resolvedCallers: 6, unresolvedCallers: 1, forwardingCallers: 2 }),
          wrapper({
            filePath: `${ROOT}/src/service.ts`,
            lineNumber: 9,
            kind: 'method',
            name: 'getVariation',
            owner: 'LaunchDarklyService',
            keyParameterIndex: 1,
            depth: 2,
            forwardsTo: 'getFlag()',
          }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )

    expect(surface.wrappers).toEqual([
      {
        label: 'getFlag()',
        declaredAt: 'src/flags.ts:4',
        kind: 'function',
        keyParameterIndex: 0,
        provider: '@launchdarkly/node-server-sdk',
        forwardsTo: 'boolVariation',
        depth: 1,
        callers: 9,
        resolvedCallers: 6,
        unresolvedCallers: 1,
        forwardingCallers: 2,
      },
      {
        label: 'LaunchDarklyService.getVariation()',
        declaredAt: 'src/service.ts:9',
        kind: 'method',
        keyParameterIndex: 1,
        provider: '@launchdarkly/node-server-sdk',
        forwardsTo: 'getFlag()',
        depth: 2,
        callers: 1,
        resolvedCallers: 1,
        unresolvedCallers: 0,
        forwardingCallers: 0,
      },
    ])
  })

  it('drops a flag the per-file detectors already reported at the same location', () => {
    const flag = (name: string, lineNumber: number): FeatureFlag => ({
      name,
      filePath: `${ROOT}/src/app.ts`,
      lineNumber,
      language: 'typescript',
      provider: '@launchdarkly/node-server-sdk',
      confidence: 'medium',
    })
    const { flags } = summarizeEvaluationSurface(
      analysis({ flags: [flag('already-known', 3), flag('new-one', 4), flag('new-one', 4)] }),
      {
        root: ROOT,
        detectedFlags: [
          { ...flag('already-known', 3), confidence: undefined },
          flag('different-name', 9),
        ],
      },
    )
    // The duplicate of the per-file detection is dropped, the new flag is kept
    // once, and a repeat of the same key at the same line is not double-counted.
    expect(flags.map((entry) => `${entry.name}:${entry.lineNumber}`)).toEqual(['new-one:4'])
  })

  it('falls back to the absolute path when a location is outside the scan root', () => {
    const { surface } = summarizeEvaluationSurface(
      analysis({
        sites: [site({ filePath: ROOT, lineNumber: 1, status: { kind: 'gap', reason: 'computed-key' } })],
      }),
      { root: ROOT, detectedFlags: [] },
    )
    expect(surface.gaps[0].sample).toBe('/repo:1')
  })

  it('is empty for a repository with no evaluation sites at all', () => {
    const { surface, flags } = summarizeEvaluationSurface(analysis(), { root: ROOT, detectedFlags: [] })
    expect(surface).toEqual({
      schemaVersion: 1,
      filesInScope: 0,
      sites: 0,
      accountedFor: 0,
      delegated: 0,
      unaccountedFor: 0,
      gaps: [],
      wrappers: [],
    })
    expect(flags).toEqual([])
  })
})
