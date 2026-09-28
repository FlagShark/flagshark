import type { DetectionCoverage } from '../detection/detection-coverage.js'
import type { AdmissionGate, HostedAdmissionPreflight } from '../migration/hosted-admission.js'
import type { StaleFlag } from '../staleness.js'

/** Heading shared by the text and Markdown renderings of the local preflight. Names the invariant, never promises. */
export const ADMISSION_PREFLIGHT_HEADING =
  'Hosted draft PR preflight (local; no account, no network; the hosted planner decides)'

export interface AdmissionGateTally {
  refusing: AdmissionGate[]
  unknownIds: string[]
  passCount: number
}

/** Split a preflight into what the renderers print: refusing gates in order, unknown gate ids, and the pass count. */
export function tallyAdmissionGates(preflight: HostedAdmissionPreflight): AdmissionGateTally {
  return {
    refusing: preflight.gates.filter((g) => g.status === 'refuse'),
    unknownIds: preflight.gates.filter((g) => g.status === 'unknown').map((g) => g.id),
    passCount: preflight.gates.filter((g) => g.status === 'pass').length,
  }
}

/** Returns the count of unique stale flag names (de-duped across occurrences). */
export function uniqueStaleCount(stale: StaleFlag[]): number {
  return new Set(stale.map((f) => f.name)).size
}

/** Map health score to an emoji used in markdown + SARIF + Action summary. */
export function healthEmoji(score: number): string {
  if (score >= 90) return '🟢'
  if (score >= 70) return '🟡'
  if (score >= 40) return '🟠'
  return '🔴'
}

/**
 * SARIF severity level mapping based on number of staleness signals on a flag.
 *   1 signal  → 'note'
 *   2 signals → 'warning'
 *   3+ signals → 'error'
 */
export function sarifLevel(signalCount: number): 'note' | 'warning' | 'error' {
  if (signalCount >= 3) return 'error'
  if (signalCount === 2) return 'warning'
  return 'note'
}

/** Display labels for the language identifiers detectors record. */
export const LANGUAGE_LABELS: Record<string, string> = {
  go: 'Go',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  ruby: 'Ruby',
  csharp: 'C#',
  php: 'PHP',
  rust: 'Rust',
  cpp: 'C/C++',
  objc: 'Objective-C',
}

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language
}

/**
 * Heading shared by the text and Markdown renderings of the detection-coverage
 * metric. Names what is counted and where the count comes from; it never claims
 * the scan saw everything.
 */
export const DETECTION_COVERAGE_HEADING =
  'Detection coverage (local; call-shaped evaluation sites counted from the parsed tree)'

/** Cap on how many wrapper, refusal and gap lines the human-readable renderings print. */
export const MAX_DETECTION_COVERAGE_LINES = 5

export interface DetectionCoverageDescription {
  /** One line: how many sites were named, forwarded, and not named. */
  headline: string
  /** One line per identified wrapper, with the callers found for it. */
  wrappers: string[]
  /**
   * One line per wrapper the hosted migration refuses to rewrite (FS-069). Detection
   * is not migratability, and these lines are what stops the flag count reading as a
   * migration promise.
   */
  refusals: string[]
  /** One line per refusal reason behind `unnamed`. */
  gaps: string[]
  /** True when at least one site has no flag name the scan is willing to claim. */
  hasShortfall: boolean
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function truncate<T>(items: T[], render: (item: T) => string, noun: string): string[] {
  const lines = items.slice(0, MAX_DETECTION_COVERAGE_LINES).map(render)
  const remaining = items.length - MAX_DETECTION_COVERAGE_LINES
  if (remaining > 0) lines.push(`… and ${plural(remaining, noun)} (see --format json)`)
  return lines
}

/**
 * Renders the detection-coverage metrics into the lines both human-readable
 * formatters print. Returns null when the parsed trees held no evaluation-shaped
 * call at all — there is nothing to be honest about in that case.
 *
 * The headline carries three things at once: the scanner's own key-resolution split,
 * FS-069's `callShaped`/`accountedFor` cross-check when it disagrees, and how much of
 * the reported surface the hosted migration refuses to rewrite.
 */
export function describeDetectionCoverage(
  coverage: DetectionCoverage,
): DetectionCoverageDescription | null {
  if (coverage.sites === 0 && coverage.evaluationSurface.callShaped === 0) return null
  const parts = [`${coverage.flagsNamed} of ${plural(coverage.sites, 'site')} named`]
  if (coverage.delegated > 0) {
    parts.push(`${coverage.delegated} forwarded by ${plural(coverage.wrappers.length, 'wrapper')}`)
  }
  parts.push(`${coverage.unnamed} not named`)
  const surface = coverage.evaluationSurface
  // The cross-check only earns a place in the headline when it disagrees: equal
  // numbers mean every evaluation-shaped call was explained, which is the
  // expected state and is already implied by the split above.
  if (surface.accountedFor !== surface.callShaped) {
    parts.push(
      `${surface.callShaped - surface.accountedFor} of ${plural(surface.callShaped, 'evaluation-shaped call')} unexplained`,
    )
  }
  if (coverage.refusedForRewrite > 0) {
    parts.push(`${plural(coverage.refusedForRewrite, 'site')} the hosted migration refuses to rewrite`)
  }
  return {
    headline: parts.join(' · '),
    wrappers: truncate(
      coverage.wrappers,
      (wrapper) =>
        `${wrapper.label} forwards argument ${wrapper.keyParameterIndex + 1} to ${wrapper.forwardsTo} · ` +
        `${wrapper.declaredAt} · ${plural(wrapper.callers, 'caller')} ` +
        `(${wrapper.resolvedCallers} named · ${wrapper.unresolvedCallers} runtime-only · ` +
        `${wrapper.forwardingCallers} forwarded on)`,
      'more wrapper',
    ),
    refusals: truncate(
      coverage.wrappers.filter((wrapper) => wrapper.rewriteBlocker !== null),
      (wrapper) =>
        `${wrapper.rewriteBlocker!.reason}  ${wrapper.label} at ${wrapper.declaredAt} — ` +
        `${wrapper.rewriteBlocker!.detail}`,
      'more refused wrapper',
    ),
    gaps: truncate(
      coverage.gaps,
      (gap) => `${gap.reason}  ${plural(gap.count, 'site')} (first at ${gap.sample}) — ${gap.detail}`,
      'more refusal reason',
    ),
    hasShortfall: coverage.unnamed > 0 || surface.accountedFor !== surface.callShaped,
  }
}
