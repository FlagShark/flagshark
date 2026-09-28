/**
 * Detection coverage for TypeScript/JavaScript: how much of the evaluation
 * surface a scan actually accounted for.
 *
 * The flag count a scanner prints is only meaningful next to the number of places
 * it *looked*. This module counts call-shaped evaluation sites from the parsed
 * tree — independently of whether any provenance could be established for them —
 * and then splits them into what the scan named, what it defers to a wrapper's
 * callers, and what it refused to guess about. A scan that cannot see everything
 * says so; a zero with unaccounted-for sites behind it is not a confident zero.
 *
 * Two metrics live here, deliberately kept apart:
 *
 *   - `evaluationSurface` — **FS-069's two-number cross-check**, under its own name
 *     and with its own semantics, so the public number and the hosted product's
 *     number mean the same thing and can be joined. `callShaped` counts
 *     `<expression>.<name>(…)` calls naming a catalogued evaluation method, from the
 *     tree, without consulting provenance; `accountedFor` counts those the scan then
 *     *explained* — a named flag, a delegation, or a named refusal. A shortfall
 *     means an evaluation-shaped call was neither named nor explained.
 *   - the scanner's own split (`sites` = `flagsNamed` + `delegated` + `unnamed`) —
 *     a different axis: it measures whether a flag *key* could be resolved, not
 *     whether the call was explained. FS-069 admits a computed-key caller for
 *     rewriting (the rewrite is key-independent) while this axis counts it as a flag
 *     it could not name. Both are reported; neither is presented as the other.
 *
 * `flagsNamed` never flatters the result: every site counted there has a flag in
 * the scan output at the same file and line.
 */

import { relative } from 'node:path'

import { EVALUATION_GAP_DETAILS, callerCount, wrapperLabel } from './wrapper-evaluations.js'

import type { FeatureFlag } from './feature-flag.js'
import type {
  EvaluationGapReason,
  EvaluationSurfaceCoverage,
  WrapperEvaluationResult,
  WrapperKind,
  WrapperRewriteBlocker,
} from './wrapper-evaluations.js'

/** One refusal reason, with how often it occurred and where to look first. */
export interface DetectionCoverageGap {
  reason: EvaluationGapReason
  count: number
  /** `path:line` of the first site with this reason. */
  sample: string
  /** One line on what the scan could not prove. */
  detail: string
}

/** A wrapper the scan identified, with the callers it found for it. */
export interface DetectionCoverageWrapper {
  /** `Class.method()` for a method, `helper()` for a free function. */
  label: string
  /** `path:line` of the declaration. */
  declaredAt: string
  kind: WrapperKind
  /** Zero-based position of the parameter forwarded as the flag key. */
  keyParameterIndex: number
  /** Provider string the detectors record (the SDK's import pattern). */
  provider: string
  /** The catalogued SDK method, or the wrapper, the key is forwarded to. */
  forwardsTo: string
  /** 1 when the wrapper calls the SDK itself, 2+ when it forwards into another wrapper. */
  depth: number
  /** Call sites found, resolved plus unresolved plus forwarded on. */
  callers: number
  /** Call sites whose key resolved to a literal or a proven const. */
  resolvedCallers: number
  /** Call sites whose key only exists at runtime. */
  unresolvedCallers: number
  /** Call sites that forward a parameter of their own, deferring the key again. */
  forwardingCallers: number
  /**
   * Set when the hosted migration refuses to rewrite this wrapper whatever its
   * callers pass (FS-069). Null means the scan makes no claim either way — never
   * that the wrapper is migratable.
   */
  rewriteBlocker: WrapperRewriteBlocker | null
}

/**
 * Detection coverage over the TypeScript/JavaScript evaluation surface. `sites`
 * always equals `flagsNamed + delegated + unnamed`.
 */
export interface DetectionCoverage {
  schemaVersion: 1
  /** TS/JS files reaching a provider SDK that the coverage pass parsed. */
  filesInScope: number
  /** Evaluation sites the scanner classified: catalogued SDK calls plus wrapper calls. */
  sites: number
  /** Sites the scan reports a flag for. */
  flagsNamed: number
  /** Sites that hand a parameter to a wrapper; their keys are counted at its callers. */
  delegated: number
  /** Sites with no flag name the scan is willing to claim. */
  unnamed: number
  /** The refusals behind `unnamed`, most frequent first. */
  gaps: DetectionCoverageGap[]
  /** Wrappers identified, in declaration order. */
  wrappers: DetectionCoverageWrapper[]
  /**
   * Wrapper-mediated call sites sitting behind a wrapper the hosted migration
   * refuses to rewrite (FS-069). Detection is not migratability; this number is
   * how much of the reported surface the hosted product would refuse.
   */
  refusedForRewrite: number
  /**
   * FS-069's cross-check, its semantics, its name: evaluation-shaped calls counted
   * without provenance versus how many the scan explained.
   */
  evaluationSurface: EvaluationSurfaceCoverage
}

export interface SummarizeDetectionCoverageOptions {
  /** Repository root, so reported locations are repository-relative. */
  root: string
  /** Flags the per-file detectors already reported, to avoid counting a site twice. */
  detectedFlags: readonly FeatureFlag[]
}

/**
 * Build the coverage metrics, and return the wrapper-mediated flags that are not
 * already in `detectedFlags` (the per-file detectors resolve a literal or a
 * same-file const at an SDK call site; this pass resolves more, so the two overlap
 * at exactly those sites).
 */
export function summarizeDetectionCoverage(
  analysis: WrapperEvaluationResult,
  options: SummarizeDetectionCoverageOptions,
): { coverage: DetectionCoverage; flags: FeatureFlag[] } {
  const location = (filePath: string, lineNumber: number): string =>
    `${relative(options.root, filePath) || filePath}:${lineNumber}`

  let flagsNamed = 0
  let delegated = 0
  const gapCounts = new Map<EvaluationGapReason, { count: number; sample: string }>()
  for (const site of analysis.sites) {
    if (site.status.kind === 'accounted') {
      flagsNamed += 1
      continue
    }
    if (site.status.kind === 'delegated') {
      delegated += 1
      continue
    }
    const existing = gapCounts.get(site.status.reason)
    if (existing) existing.count += 1
    else gapCounts.set(site.status.reason, { count: 1, sample: location(site.filePath, site.lineNumber) })
  }

  const gaps: DetectionCoverageGap[] = [...gapCounts]
    .map(([reason, { count, sample }]) => ({
      reason,
      count,
      sample,
      detail: EVALUATION_GAP_DETAILS[reason],
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  let refusedForRewrite = 0
  const wrappers: DetectionCoverageWrapper[] = analysis.wrappers.map((wrapper) => {
    if (wrapper.rewriteBlocker !== null) refusedForRewrite += callerCount(wrapper)
    return {
      label: wrapperLabel(wrapper),
      declaredAt: location(wrapper.filePath, wrapper.lineNumber),
      kind: wrapper.kind,
      keyParameterIndex: wrapper.keyParameterIndex,
      provider: wrapper.provider,
      forwardsTo: wrapper.forwardsTo,
      depth: wrapper.depth,
      callers: callerCount(wrapper),
      resolvedCallers: wrapper.resolvedCallers,
      unresolvedCallers: wrapper.unresolvedCallers,
      forwardingCallers: wrapper.forwardingCallers,
      rewriteBlocker: wrapper.rewriteBlocker,
    }
  })

  const reported = new Set<string>()
  for (const flag of options.detectedFlags) {
    reported.add(`${flag.filePath}:${flag.lineNumber}:${flag.name}`)
  }
  const flags: FeatureFlag[] = []
  for (const flag of analysis.flags) {
    const key = `${flag.filePath}:${flag.lineNumber}:${flag.name}`
    if (reported.has(key)) continue
    reported.add(key)
    flags.push(flag)
  }

  return {
    coverage: {
      schemaVersion: 1,
      filesInScope: analysis.filesInScope,
      sites: analysis.sites.length,
      flagsNamed,
      delegated,
      unnamed: analysis.sites.length - flagsNamed - delegated,
      gaps,
      wrappers,
      refusedForRewrite,
      evaluationSurface: analysis.evaluationSurface,
    },
    flags,
  }
}
