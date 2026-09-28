/**
 * Detection coverage for TypeScript/JavaScript: how much of the evaluation
 * surface a scan actually accounted for.
 *
 * The flag count a scanner prints is only meaningful next to the number of
 * places it *looked*. This module counts call-shaped evaluation sites from the
 * parsed tree — independently of whether any provenance could be established for
 * them — and then splits them into what the scan named, what it deliberately
 * defers to a wrapper's callers, and what it refused to guess about. A scan that
 * cannot see everything says so; a zero with unaccounted-for sites behind it is
 * not a confident zero.
 *
 * The metric is deliberately conservative in both directions:
 *
 *   - It only counts sites inside the TS/JS import-graph scope (files that reach
 *     a provider SDK directly or through local imports). Sites reached only by a
 *     runtime-symbol gate are outside it, so the denominator never inflates with
 *     shapes the scan was never going to attribute.
 *   - Every site it reports as accounted for has a flag in the scan output at the
 *     same file and line, so `accountedFor` can never flatter the result.
 */

import { relative } from 'node:path'

import { EVALUATION_GAP_DETAILS, callerCount, wrapperLabel } from './wrapper-evaluations.js'

import type { FeatureFlag } from './feature-flag.js'
import type {
  EvaluationGapReason,
  WrapperEvaluationResult,
  WrapperKind,
} from './wrapper-evaluations.js'

/** One refusal reason, with how often it occurred and where to look first. */
export interface EvaluationSurfaceGap {
  reason: EvaluationGapReason
  count: number
  /** `path:line` of the first site with this reason. */
  sample: string
  /** One line on what the scan could not prove. */
  detail: string
}

/** A wrapper the scan identified, with the callers it found for it. */
export interface EvaluationSurfaceWrapper {
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
  /** Call sites found, resolved plus unresolved. */
  callers: number
  /** Call sites whose key resolved to a literal or a proven const. */
  resolvedCallers: number
  /** Call sites whose key only exists at runtime. */
  unresolvedCallers: number
  /** Call sites that forward a parameter of their own, deferring the key again. */
  forwardingCallers: number
}

/**
 * Detection coverage over the TS/JS evaluation surface. `sites` always equals
 * `accountedFor + delegated + unaccountedFor`.
 */
export interface EvaluationSurface {
  schemaVersion: 1
  /** TS/JS files reaching a provider SDK that the coverage pass parsed. */
  filesInScope: number
  /** Call-shaped evaluation sites counted from the parsed trees. */
  sites: number
  /** Sites the scan reports a flag for. */
  accountedFor: number
  /** Sites that hand a parameter to a wrapper; their keys are counted at its callers. */
  delegated: number
  /** Sites with no flag name the scan is willing to claim. */
  unaccountedFor: number
  /** The refusals behind `unaccountedFor`, most frequent first. */
  gaps: EvaluationSurfaceGap[]
  /** Wrappers identified, in declaration order. */
  wrappers: EvaluationSurfaceWrapper[]
}

export interface SummarizeEvaluationSurfaceOptions {
  /** Repository root, so reported locations are repository-relative. */
  root: string
  /** Flags the per-file detectors already reported, to avoid counting a site twice. */
  detectedFlags: readonly FeatureFlag[]
}

/**
 * Build the coverage metric, and return the wrapper-mediated flags that are not
 * already in `detectedFlags` (the per-file detectors resolve a literal or a
 * same-file const at an SDK call site; this pass resolves more, so the two
 * overlap at exactly those sites).
 */
export function summarizeEvaluationSurface(
  analysis: WrapperEvaluationResult,
  options: SummarizeEvaluationSurfaceOptions,
): { surface: EvaluationSurface; flags: FeatureFlag[] } {
  const location = (filePath: string, lineNumber: number): string =>
    `${relative(options.root, filePath) || filePath}:${lineNumber}`

  let accountedFor = 0
  let delegated = 0
  const gapCounts = new Map<EvaluationGapReason, { count: number; sample: string }>()
  for (const site of analysis.sites) {
    if (site.status.kind === 'accounted') {
      accountedFor += 1
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

  const gaps: EvaluationSurfaceGap[] = [...gapCounts]
    .map(([reason, { count, sample }]) => ({
      reason,
      count,
      sample,
      detail: EVALUATION_GAP_DETAILS[reason],
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  const wrappers: EvaluationSurfaceWrapper[] = analysis.wrappers.map((wrapper) => ({
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
  }))

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
    surface: {
      schemaVersion: 1,
      filesInScope: analysis.filesInScope,
      sites: analysis.sites.length,
      accountedFor,
      delegated,
      unaccountedFor: analysis.sites.length - accountedFor - delegated,
      gaps,
      wrappers,
    },
    flags,
  }
}
