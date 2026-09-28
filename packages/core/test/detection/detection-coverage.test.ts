import { describe, it, expect } from 'vitest'

import { summarizeDetectionCoverage } from '../../src/detection/detection-coverage.js'
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
    rewriteRefusal: null,
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
    rewriteBlocker: null,
    ...partial,
  }
}

function analysis(partial: Partial<WrapperEvaluationResult> = {}): WrapperEvaluationResult {
  return {
    wrappers: [],
    flags: [],
    sites: [],
    filesInScope: 0,
    evaluationSurface: { callShaped: 0, accountedFor: 0 },
    ...partial,
  }
}

describe('summarizeDetectionCoverage', () => {
  it('splits sites into accounted-for, delegated and unaccounted-for', () => {
    const { coverage } = summarizeDetectionCoverage(
      analysis({
        filesInScope: 7,
        evaluationSurface: { callShaped: 3, accountedFor: 3 },
        sites: [
          site({ status: { kind: 'accounted', flagKey: 'a' } }),
          site({ status: { kind: 'accounted', flagKey: 'b' }, lineNumber: 2 }),
          site({ status: { kind: 'delegated', wrapper: 'getFlag()' }, lineNumber: 3 }),
          site({ status: { kind: 'gap', reason: 'computed-key' }, lineNumber: 4 }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )

    expect(coverage).toMatchObject({
      schemaVersion: 1,
      filesInScope: 7,
      sites: 4,
      flagsNamed: 2,
      delegated: 1,
      unnamed: 1,
      refusedForRewrite: 0,
      rewriteRefusals: [],
      evaluationSurface: { callShaped: 3, accountedFor: 3 },
    })
    expect(coverage.flagsNamed + coverage.delegated + coverage.unnamed).toBe(coverage.sites)
  })

  it('aggregates gaps by reason, most frequent first, with the first location as the sample', () => {
    const { coverage } = summarizeDetectionCoverage(
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

    expect(coverage.gaps).toEqual([
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
    const { coverage } = summarizeDetectionCoverage(
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

    expect(coverage.wrappers).toEqual([
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
        rewriteBlocker: null,
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
        rewriteBlocker: null,
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
    const { flags } = summarizeDetectionCoverage(
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
    const { coverage } = summarizeDetectionCoverage(
      analysis({
        sites: [site({ filePath: ROOT, lineNumber: 1, status: { kind: 'gap', reason: 'computed-key' } })],
      }),
      { root: ROOT, detectedFlags: [] },
    )
    expect(coverage.gaps[0].sample).toBe('/repo:1')
  })

  it('counts every caller of a wrapper the hosted migration refuses to rewrite', () => {
    const blocker = {
      reason: 'generic-variation' as const,
      sdkMethod: 'variation',
      detail: 'the body evaluates with variation()…',
    }
    const { coverage } = summarizeDetectionCoverage(
      analysis({
        wrappers: [
          wrapper({ resolvedCallers: 70, rewriteBlocker: blocker }),
          wrapper({ lineNumber: 20, name: 'typed', resolvedCallers: 3 }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )
    expect(coverage.refusedForRewrite).toBe(70)
    expect(coverage.wrappers.map((entry) => entry.rewriteBlocker)).toEqual([blocker, null])
    expect(coverage.rewriteRefusals).toEqual([
      {
        reason: 'generic-variation',
        count: 70,
        sample: 'src/flags.ts:4',
        sdkMethod: 'variation',
        detail: blocker.detail,
      },
    ])
  })

  it('aggregates a direct-call refusal alongside a wrapper one and counts each site once', () => {
    const served = {
      reason: 'unproven-served-type' as const,
      sdkMethod: 'variation',
      detail: 'a read of your LaunchDarkly project…',
    }
    const generic = {
      reason: 'generic-variation' as const,
      sdkMethod: 'jsonVariation',
      detail: 'the body evaluates with jsonVariation()…',
    }
    const { coverage } = summarizeDetectionCoverage(
      analysis({
        wrappers: [wrapper({ resolvedCallers: 4, rewriteBlocker: generic })],
        sites: [
          site({ lineNumber: 9, via: 'sdk', rewriteRefusal: served, status: { kind: 'accounted', flagKey: 'a' } }),
          site({ lineNumber: 10, via: 'sdk', rewriteRefusal: served, status: { kind: 'accounted', flagKey: 'b' } }),
          // A wrapper caller defers to the wrapper's refusal, so it adds nothing here.
          site({ lineNumber: 11, status: { kind: 'accounted', flagKey: 'c' } }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )
    expect(coverage.refusedForRewrite).toBe(6)
    expect(coverage.rewriteRefusals).toEqual([
      { reason: 'generic-variation', count: 4, sample: 'src/flags.ts:4', sdkMethod: 'jsonVariation', detail: generic.detail },
      { reason: 'unproven-served-type', count: 2, sample: 'src/app.ts:9', sdkMethod: 'variation', detail: served.detail },
    ])
  })

  it('breaks a tie between two refusal reasons by name', () => {
    const blocker = (reason: 'details-consumer' | 'second-sdk-call', sdkMethod: string) => ({
      reason,
      sdkMethod,
      detail: `${reason} detail`,
    })
    const { coverage } = summarizeDetectionCoverage(
      analysis({
        wrappers: [
          wrapper({ lineNumber: 4, name: 'later', resolvedCallers: 1, rewriteBlocker: blocker('second-sdk-call', 'a, b') }),
          wrapper({ lineNumber: 8, name: 'earlier', resolvedCallers: 1, rewriteBlocker: blocker('details-consumer', 'variationDetail') }),
        ],
      }),
      { root: ROOT, detectedFlags: [] },
    )
    expect(coverage.rewriteRefusals.map((entry) => `${entry.reason}:${entry.count}`)).toEqual([
      'details-consumer:1',
      'second-sdk-call:1',
    ])
  })

  it('is empty for a repository with no evaluation sites at all', () => {
    const { coverage, flags } = summarizeDetectionCoverage(analysis(), { root: ROOT, detectedFlags: [] })
    expect(coverage).toEqual({
      schemaVersion: 1,
      filesInScope: 0,
      sites: 0,
      flagsNamed: 0,
      delegated: 0,
      unnamed: 0,
      gaps: [],
      wrappers: [],
      refusedForRewrite: 0,
      rewriteRefusals: [],
      evaluationSurface: { callShaped: 0, accountedFor: 0 },
    })
    expect(flags).toEqual([])
  })
})
