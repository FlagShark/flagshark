/**
 * How the detection-coverage metric surfaces: the shared renderer, the text
 * block inside (and without) the lock-in summary, the Markdown section, and the
 * additive JSON key.
 */
import { describe, it, expect } from 'vitest'

import { formatJson } from '../../src/output/json.js'
import { formatMarkdown } from '../../src/output/markdown.js'
import {
  describeDetectionCoverage,
  DETECTION_COVERAGE_HEADING,
  MAX_DETECTION_COVERAGE_LINES,
} from '../../src/output/shared.js'
import { formatText } from '../../src/output/text.js'

import type {
  DetectionCoverage,
  DetectionCoverageGap,
  DetectionCoverageWrapper,
} from '../../src/detection/detection-coverage.js'
import type { LockInSummary } from '../../src/migration/lock-in.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeCoverage(overrides: Partial<DetectionCoverage> = {}): DetectionCoverage {
  return {
    schemaVersion: 1,
    filesInScope: 349,
    sites: 11,
    flagsNamed: 7,
    delegated: 2,
    unnamed: 2,
    refusedForRewrite: 0,
    rewriteRefusals: [],
    evaluationSurface: { callShaped: 9, accountedFor: 9 },
    gaps: [
      {
        reason: 'unprovable-key',
        count: 2,
        sample: 'src/main/utils/isRespondToClaimEnabledForUser.ts:15',
        detail: 'the flag key is an identifier the scan cannot prove',
      },
    ],
    wrappers: [
      {
        label: 'getLaunchDarklyFlag()',
        declaredAt: 'src/main/utils/getLaunchDarklyFlag.ts:9',
        kind: 'function',
        keyParameterIndex: 1,
        provider: '@launchdarkly/node-server-sdk',
        forwardsTo: 'variation',
        depth: 1,
        callers: 8,
        resolvedCallers: 7,
        unresolvedCallers: 1,
        forwardingCallers: 0,
        rewriteBlocker: null,
      },
    ],
    ...overrides,
  }
}

/** Nothing counted on either axis: the parsed trees held no evaluation-shaped call. */
const EMPTY_COVERAGE: DetectionCoverage = {
  schemaVersion: 1,
  filesInScope: 12,
  sites: 0,
  flagsNamed: 0,
  delegated: 0,
  unnamed: 0,
  gaps: [],
  wrappers: [],
  refusedForRewrite: 0,
  rewriteRefusals: [],
  evaluationSurface: { callShaped: 0, accountedFor: 0 },
}

function makeLockIn(overrides: Partial<LockInSummary> = {}): LockInSummary {
  return {
    schemaVersion: 1,
    registry: { sourceRevision: 'a'.repeat(40), generatedAt: '2026-09-01T00:00:00Z' },
    callSites: 7,
    uniqueFlags: 5,
    totals: {
      'already-openfeature': 0,
      'needs-review': 7,
      'draft-pr': 0,
      'draft-pr-refused': 0,
      preview: 0,
      assessment: 0,
      'detection-only': 0,
    },
    providers: [
      {
        provider: 'LaunchDarkly Node Server SDK',
        packages: ['@launchdarkly/node-server-sdk'],
        languages: ['typescript'],
        callSites: 7,
        uniqueFlags: 5,
        cell: {
          id: 'adopt-openfeature/launchdarkly-node-server/ecmascript/server',
          version: 2,
          highestStage: 'verification',
        },
        classification: 'needs-review',
        needsReview: 7,
      },
    ],
    hostedAdmission: [],
    ...overrides,
  }
}

function makeScanResult(overrides: Partial<ScanRepoResult> = {}): ScanRepoResult {
  return {
    totalFlags: 5,
    filesScanned: 991,
    staleFlags: [],
    detectedProviders: ['@launchdarkly/node-server-sdk'],
    languageBreakdown: { typescript: 991 },
    healthScore: 100,
    scanDuration: 1400,
    ...overrides,
  }
}

describe('describeDetectionCoverage', () => {
  it('names the counted sites, the wrappers carrying them, and each refusal', () => {
    const described = describeDetectionCoverage(makeCoverage())!
    expect(described.headline).toBe('7 of 11 sites named · 2 forwarded by 1 wrapper · 2 not named')
    expect(described.wrappers).toEqual([
      'getLaunchDarklyFlag() forwards argument 2 to variation · src/main/utils/getLaunchDarklyFlag.ts:9 · ' +
        '8 callers (7 named · 1 runtime-only · 0 forwarded on)',
    ])
    expect(described.gaps).toEqual([
      'unprovable-key  2 sites (first at src/main/utils/isRespondToClaimEnabledForUser.ts:15) — ' +
        'the flag key is an identifier the scan cannot prove',
    ])
    expect(described.hasShortfall).toBe(true)
  })

  it('omits the forwarded clause when nothing is delegated, and reports a clean surface', () => {
    const described = describeDetectionCoverage(
      makeCoverage({
        sites: 3,
        flagsNamed: 3,
        delegated: 0,
        unnamed: 0,
        gaps: [],
        wrappers: [],
        evaluationSurface: { callShaped: 3, accountedFor: 3 },
      }),
    )!
    expect(described.headline).toBe('3 of 3 sites named · 0 not named')
    expect(described.hasShortfall).toBe(false)
  })

  it('names the cross-check shortfall and the hosted refusal in the headline', () => {
    const blocker = {
      reason: 'generic-variation' as const,
      sdkMethod: 'variation',
      detail: 'LaunchDarkly does not type-check variation()',
    }
    const described = describeDetectionCoverage(
      makeCoverage({
        refusedForRewrite: 70,
        evaluationSurface: { callShaped: 9, accountedFor: 7 },
        wrappers: [{ ...makeCoverage().wrappers[0], rewriteBlocker: blocker }],
        rewriteRefusals: [
          {
            reason: 'generic-variation',
            count: 70,
            sample: 'src/main/utils/getLaunchDarklyFlag.ts:9',
            sdkMethod: 'variation',
            detail: blocker.detail,
          },
        ],
      }),
    )!
    // The cross-check clause names itself, so it cannot be mistaken for the `sites`
    // split beside it — the two have different denominators on purpose.
    expect(described.headline).toBe(
      '7 of 11 sites named · 2 forwarded by 1 wrapper · 2 not named · ' +
        'FS-069 cross-check 2 of 9 member-form evaluation calls unexplained · ' +
        '70 sites the hosted migration refuses to rewrite',
    )
    expect(described.refusals).toEqual([
      'generic-variation  70 sites (first at src/main/utils/getLaunchDarklyFlag.ts:9) — ' +
        'LaunchDarkly does not type-check variation()',
    ])
    expect(described.hasShortfall).toBe(true)
  })

  it('reports a shortfall from the cross-check alone, even when every site was named', () => {
    const described = describeDetectionCoverage(
      makeCoverage({
        sites: 1,
        flagsNamed: 1,
        delegated: 0,
        unnamed: 0,
        gaps: [],
        wrappers: [],
        evaluationSurface: { callShaped: 3, accountedFor: 1 },
      }),
    )!
    expect(described.hasShortfall).toBe(true)
  })

  it('truncates a long list of refusals', () => {
    const rewriteRefusals = Array.from({ length: MAX_DETECTION_COVERAGE_LINES + 3 }, (_unused, index) => ({
      reason: 'generic-variation' as const,
      count: index + 1,
      sample: `src/file${index}.ts:1`,
      sdkMethod: 'variation',
      detail: 'LaunchDarkly does not type-check variation()',
    }))
    const described = describeDetectionCoverage(makeCoverage({ rewriteRefusals, refusedForRewrite: 8 }))!
    expect(described.refusals).toHaveLength(MAX_DETECTION_COVERAGE_LINES + 1)
    expect(described.refusals.at(-1)).toBe('… and 3 more refusals (see --format json)')
  })

  it('returns null when the parsed trees held no evaluation-shaped call', () => {
    expect(
      describeDetectionCoverage(
        EMPTY_COVERAGE,
      ),
    ).toBeNull()
  })

  it('truncates long wrapper and refusal lists and points at the JSON output', () => {
    const many = MAX_DETECTION_COVERAGE_LINES + 2
    const wrappers: DetectionCoverageWrapper[] = Array.from({ length: many }, (_unused, index) => ({
      ...makeCoverage().wrappers[0],
      label: `wrapper${index}()`,
    }))
    const gaps: DetectionCoverageGap[] = Array.from({ length: many }, (_unused, index) => ({
      ...makeCoverage().gaps[0],
      count: many - index,
      sample: `src/file${index}.ts:1`,
    }))
    const described = describeDetectionCoverage(makeCoverage({ wrappers, gaps }))!
    expect(described.wrappers).toHaveLength(MAX_DETECTION_COVERAGE_LINES + 1)
    expect(described.wrappers.at(-1)).toBe('… and 2 more wrappers (see --format json)')
    expect(described.gaps.at(-1)).toBe('… and 2 more refusal reasons (see --format json)')
  })

  it('uses the singular form when exactly one entry is truncated', () => {
    const wrappers: DetectionCoverageWrapper[] = Array.from(
      { length: MAX_DETECTION_COVERAGE_LINES + 1 },
      (_unused, index) => ({ ...makeCoverage().wrappers[0], label: `wrapper${index}()` }),
    )
    const described = describeDetectionCoverage(makeCoverage({ wrappers }))!
    expect(described.wrappers.at(-1)).toBe('… and 1 more wrapper (see --format json)')
  })
})

describe('formatText — detection coverage', () => {
  it('prints the coverage block inside the lock-in summary', () => {
    const output = formatText(
      makeScanResult({ lockIn: makeLockIn(), detectionCoverage: makeCoverage() }),
      { verbose: false, maxDisplay: 10 },
    )
    expect(output).toContain(`  ${DETECTION_COVERAGE_HEADING}: 7 of 11 sites named`)
    expect(output).toContain('    → getLaunchDarklyFlag() forwards argument 2 to variation')
    expect(output).toContain('    ✗ unprovable-key  2 sites')
    // Order: the coverage block sits between the provider rows and the next step.
    expect(output.indexOf('LaunchDarkly Node Server SDK')).toBeLessThan(
      output.indexOf(DETECTION_COVERAGE_HEADING),
    )
    expect(output.indexOf(DETECTION_COVERAGE_HEADING)).toBeLessThan(output.indexOf('Next: npx flagshark'))
  })

  it('prints the hosted-migration refusal so a detected wrapper never reads as migratable', () => {
    const blocker = {
      reason: 'generic-variation' as const,
      sdkMethod: 'variation',
      detail: 'LaunchDarkly does not type-check variation()',
    }
    const coverage = makeCoverage({
      refusedForRewrite: 70,
      wrappers: [{ ...makeCoverage().wrappers[0], rewriteBlocker: blocker }],
      rewriteRefusals: [
        {
          reason: 'generic-variation',
          count: 70,
          sample: 'src/main/utils/getLaunchDarklyFlag.ts:9',
          sdkMethod: 'variation',
          detail: blocker.detail,
        },
      ],
    })
    const text = formatText(makeScanResult({ lockIn: makeLockIn(), detectionCoverage: coverage }), {
      verbose: false,
      maxDisplay: 10,
    })
    expect(text).toContain('70 sites the hosted migration refuses to rewrite')
    expect(text).toContain('    ⛔ generic-variation  70 sites (first at')

    const markdown = formatMarkdown(
      makeScanResult({ lockIn: makeLockIn(), detectionCoverage: coverage }),
      { scanMode: 'full' },
    )
    expect(markdown).toContain('- Hosted migration refuses: generic-variation  70 sites (first at')
  })

  it('omits the coverage block when there is no surface, and when the surface is empty', () => {
    const withoutSurface = formatText(makeScanResult({ lockIn: makeLockIn() }), {
      verbose: false,
      maxDisplay: 10,
    })
    expect(withoutSurface).not.toContain(DETECTION_COVERAGE_HEADING)

    const emptySurface = formatText(
      makeScanResult({ lockIn: makeLockIn(), detectionCoverage: EMPTY_COVERAGE }),
      { verbose: false, maxDisplay: 10 },
    )
    expect(emptySurface).not.toContain(DETECTION_COVERAGE_HEADING)
  })

  it('refuses to present a zero as confident when sites went unaccounted for', () => {
    const output = formatText(
      makeScanResult({
        totalFlags: 0,
        detectionCoverage: makeCoverage({
          sites: 4,
          flagsNamed: 0,
          delegated: 0,
          unnamed: 4,
          evaluationSurface: { callShaped: 4, accountedFor: 4 },
          wrappers: [],
          gaps: [
            {
              reason: 'computed-key',
              count: 4,
              sample: 'src/flags.ts:12',
              detail: 'the flag key is built at runtime',
            },
          ],
        }),
      }),
      { verbose: false, maxDisplay: 10 },
    )
    expect(output).toContain('No feature flags detected.')
    expect(output).toContain('⚠ This is not a confident zero.')
    expect(output).toContain(`${DETECTION_COVERAGE_HEADING}: 0 of 4 sites named`)
    expect(output).toContain('✗ computed-key  4 sites')
  })

  it('leaves a genuine zero alone when every site was accounted for', () => {
    const output = formatText(
      makeScanResult({
        totalFlags: 0,
        detectionCoverage: makeCoverage({
          sites: 1,
          flagsNamed: 1,
          delegated: 0,
          unnamed: 0,
          gaps: [],
          wrappers: [],
          evaluationSurface: { callShaped: 1, accountedFor: 1 },
        }),
      }),
      { verbose: false, maxDisplay: 10 },
    )
    expect(output).toContain('No feature flags detected.')
    expect(output).not.toContain('not a confident zero')
  })
})

describe('formatMarkdown — detection coverage', () => {
  it('renders the coverage section under the lock-in table', () => {
    const output = formatMarkdown(
      makeScanResult({ lockIn: makeLockIn(), detectionCoverage: makeCoverage() }),
      { scanMode: 'full' },
    )
    expect(output).toContain(`**${DETECTION_COVERAGE_HEADING}:** 7 of 11 sites named`)
    expect(output).toContain('- Wrapper: getLaunchDarklyFlag() forwards argument 2 to variation')
    expect(output).toContain('- Not named: unprovable-key  2 sites')
  })

  it('omits the coverage section when there is nothing measured', () => {
    expect(
      formatMarkdown(makeScanResult({ lockIn: makeLockIn() }), { scanMode: 'full' }),
    ).not.toContain(DETECTION_COVERAGE_HEADING)
    expect(
      formatMarkdown(
        makeScanResult({ lockIn: makeLockIn(), detectionCoverage: EMPTY_COVERAGE }),
        { scanMode: 'full' },
      ),
    ).not.toContain(DETECTION_COVERAGE_HEADING)
  })
})

describe('formatJson — detection coverage', () => {
  it('emits detectionCoverage as an additive top-level key, with FS-069 nested inside it', () => {
    const coverage = makeCoverage()
    const json = JSON.parse(formatJson(makeScanResult({ detectionCoverage: coverage }), { version: 'test' }))
    expect(json.detectionCoverage).toEqual(coverage)
    // FS-069's two-number cross-check keeps its own name and its own semantics, so a
    // consumer joining it against the hosted product's number compares like with like.
    expect(json.detectionCoverage.evaluationSurface).toEqual({ callShaped: 9, accountedFor: 9 })
    expect(json.evaluationSurface).toBeUndefined()
  })

  it('emits null when the result carries no coverage', () => {
    const json = JSON.parse(formatJson(makeScanResult(), { version: 'test' }))
    expect(json.detectionCoverage).toBeNull()
  })
})
