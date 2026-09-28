/**
 * How the detection-coverage metric surfaces: the shared renderer, the text
 * block inside (and without) the lock-in summary, the Markdown section, and the
 * additive JSON key.
 */
import { describe, it, expect } from 'vitest'

import { formatJson } from '../../src/output/json.js'
import { formatMarkdown } from '../../src/output/markdown.js'
import {
  describeEvaluationSurface,
  EVALUATION_SURFACE_HEADING,
  MAX_EVALUATION_SURFACE_LINES,
} from '../../src/output/shared.js'
import { formatText } from '../../src/output/text.js'

import type {
  EvaluationSurface,
  EvaluationSurfaceGap,
  EvaluationSurfaceWrapper,
} from '../../src/detection/evaluation-surface.js'
import type { LockInSummary } from '../../src/migration/lock-in.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeSurface(overrides: Partial<EvaluationSurface> = {}): EvaluationSurface {
  return {
    schemaVersion: 1,
    filesInScope: 349,
    sites: 11,
    accountedFor: 7,
    delegated: 2,
    unaccountedFor: 2,
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
      },
    ],
    ...overrides,
  }
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

describe('describeEvaluationSurface', () => {
  it('names the counted sites, the wrappers carrying them, and each refusal', () => {
    const described = describeEvaluationSurface(makeSurface())!
    expect(described.headline).toBe('7 of 11 sites accounted for · 2 forwarded by 1 wrapper · 2 not accounted for')
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
    const described = describeEvaluationSurface(
      makeSurface({ sites: 3, accountedFor: 3, delegated: 0, unaccountedFor: 0, gaps: [], wrappers: [] }),
    )!
    expect(described.headline).toBe('3 of 3 sites accounted for · 0 not accounted for')
    expect(described.hasShortfall).toBe(false)
  })

  it('returns null when the parsed trees held no evaluation-shaped call', () => {
    expect(describeEvaluationSurface(makeSurface({ sites: 0 }))).toBeNull()
  })

  it('truncates long wrapper and refusal lists and points at the JSON output', () => {
    const many = MAX_EVALUATION_SURFACE_LINES + 2
    const wrappers: EvaluationSurfaceWrapper[] = Array.from({ length: many }, (_unused, index) => ({
      ...makeSurface().wrappers[0],
      label: `wrapper${index}()`,
    }))
    const gaps: EvaluationSurfaceGap[] = Array.from({ length: many }, (_unused, index) => ({
      ...makeSurface().gaps[0],
      count: many - index,
      sample: `src/file${index}.ts:1`,
    }))
    const described = describeEvaluationSurface(makeSurface({ wrappers, gaps }))!
    expect(described.wrappers).toHaveLength(MAX_EVALUATION_SURFACE_LINES + 1)
    expect(described.wrappers.at(-1)).toBe('… and 2 more wrappers (see --format json)')
    expect(described.gaps.at(-1)).toBe('… and 2 more refusal reasons (see --format json)')
  })

  it('uses the singular form when exactly one entry is truncated', () => {
    const wrappers: EvaluationSurfaceWrapper[] = Array.from(
      { length: MAX_EVALUATION_SURFACE_LINES + 1 },
      (_unused, index) => ({ ...makeSurface().wrappers[0], label: `wrapper${index}()` }),
    )
    const described = describeEvaluationSurface(makeSurface({ wrappers }))!
    expect(described.wrappers.at(-1)).toBe('… and 1 more wrapper (see --format json)')
  })
})

describe('formatText — detection coverage', () => {
  it('prints the coverage block inside the lock-in summary', () => {
    const output = formatText(
      makeScanResult({ lockIn: makeLockIn(), evaluationSurface: makeSurface() }),
      { verbose: false, maxDisplay: 10 },
    )
    expect(output).toContain(`  ${EVALUATION_SURFACE_HEADING}: 7 of 11 sites accounted for`)
    expect(output).toContain('    → getLaunchDarklyFlag() forwards argument 2 to variation')
    expect(output).toContain('    ✗ unprovable-key  2 sites')
    // Order: the coverage block sits between the provider rows and the next step.
    expect(output.indexOf('LaunchDarkly Node Server SDK')).toBeLessThan(
      output.indexOf(EVALUATION_SURFACE_HEADING),
    )
    expect(output.indexOf(EVALUATION_SURFACE_HEADING)).toBeLessThan(output.indexOf('Next: npx flagshark'))
  })

  it('omits the coverage block when there is no surface, and when the surface is empty', () => {
    const withoutSurface = formatText(makeScanResult({ lockIn: makeLockIn() }), {
      verbose: false,
      maxDisplay: 10,
    })
    expect(withoutSurface).not.toContain(EVALUATION_SURFACE_HEADING)

    const emptySurface = formatText(
      makeScanResult({ lockIn: makeLockIn(), evaluationSurface: makeSurface({ sites: 0 }) }),
      { verbose: false, maxDisplay: 10 },
    )
    expect(emptySurface).not.toContain(EVALUATION_SURFACE_HEADING)
  })

  it('refuses to present a zero as confident when sites went unaccounted for', () => {
    const output = formatText(
      makeScanResult({
        totalFlags: 0,
        evaluationSurface: makeSurface({
          sites: 4,
          accountedFor: 0,
          delegated: 0,
          unaccountedFor: 4,
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
    expect(output).toContain(`${EVALUATION_SURFACE_HEADING}: 0 of 4 sites accounted for`)
    expect(output).toContain('✗ computed-key  4 sites')
  })

  it('leaves a genuine zero alone when every site was accounted for', () => {
    const output = formatText(
      makeScanResult({
        totalFlags: 0,
        evaluationSurface: makeSurface({
          sites: 1,
          accountedFor: 1,
          delegated: 0,
          unaccountedFor: 0,
          gaps: [],
          wrappers: [],
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
      makeScanResult({ lockIn: makeLockIn(), evaluationSurface: makeSurface() }),
      { scanMode: 'full' },
    )
    expect(output).toContain(`**${EVALUATION_SURFACE_HEADING}:** 7 of 11 sites accounted for`)
    expect(output).toContain('- Wrapper: getLaunchDarklyFlag() forwards argument 2 to variation')
    expect(output).toContain('- Not accounted for: unprovable-key  2 sites')
  })

  it('omits the coverage section when there is nothing measured', () => {
    expect(
      formatMarkdown(makeScanResult({ lockIn: makeLockIn() }), { scanMode: 'full' }),
    ).not.toContain(EVALUATION_SURFACE_HEADING)
    expect(
      formatMarkdown(
        makeScanResult({ lockIn: makeLockIn(), evaluationSurface: makeSurface({ sites: 0 }) }),
        { scanMode: 'full' },
      ),
    ).not.toContain(EVALUATION_SURFACE_HEADING)
  })
})

describe('formatJson — detection coverage', () => {
  it('emits evaluationSurface as an additive top-level key', () => {
    const surface = makeSurface()
    const json = JSON.parse(formatJson(makeScanResult({ evaluationSurface: surface }), { version: 'test' }))
    expect(json.evaluationSurface).toEqual(surface)
  })

  it('emits null when the result carries no surface', () => {
    const json = JSON.parse(formatJson(makeScanResult(), { version: 'test' }))
    expect(json.evaluationSurface).toBeNull()
  })
})
