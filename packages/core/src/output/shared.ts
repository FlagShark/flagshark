import type { EvaluationSurface } from '../detection/evaluation-surface.js'
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
export const EVALUATION_SURFACE_HEADING =
  'Detection coverage (local; call-shaped evaluation sites counted from the parsed tree)'

/** Cap on how many wrapper and gap lines the human-readable renderings print. */
export const MAX_EVALUATION_SURFACE_LINES = 5

export interface EvaluationSurfaceDescription {
  /** One line: how many sites were accounted for, forwarded, and not accounted for. */
  headline: string
  /** One line per identified wrapper, with the callers found for it. */
  wrappers: string[]
  /** One line per refusal reason behind `unaccountedFor`. */
  gaps: string[]
  /** True when at least one site has no flag name the scan is willing to claim. */
  hasShortfall: boolean
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function truncate<T>(items: T[], render: (item: T) => string, noun: string): string[] {
  const lines = items.slice(0, MAX_EVALUATION_SURFACE_LINES).map(render)
  const remaining = items.length - MAX_EVALUATION_SURFACE_LINES
  if (remaining > 0) lines.push(`… and ${plural(remaining, noun)} (see --format json)`)
  return lines
}

/**
 * Renders the detection-coverage metric into the lines both human-readable
 * formatters print. Returns null when the parsed trees held no evaluation-shaped
 * call at all — there is nothing to be honest about in that case.
 */
export function describeEvaluationSurface(
  surface: EvaluationSurface,
): EvaluationSurfaceDescription | null {
  if (surface.sites === 0) return null
  const parts = [`${surface.accountedFor} of ${plural(surface.sites, 'site')} accounted for`]
  if (surface.delegated > 0) {
    parts.push(`${surface.delegated} forwarded by ${plural(surface.wrappers.length, 'wrapper')}`)
  }
  parts.push(`${surface.unaccountedFor} not accounted for`)
  return {
    headline: parts.join(' · '),
    wrappers: truncate(
      surface.wrappers,
      (wrapper) =>
        `${wrapper.label} forwards argument ${wrapper.keyParameterIndex + 1} to ${wrapper.forwardsTo} · ` +
        `${wrapper.declaredAt} · ${plural(wrapper.callers, 'caller')} ` +
        `(${wrapper.resolvedCallers} named · ${wrapper.unresolvedCallers} runtime-only · ` +
        `${wrapper.forwardingCallers} forwarded on)`,
      'more wrapper',
    ),
    gaps: truncate(
      surface.gaps,
      (gap) => `${gap.reason}  ${plural(gap.count, 'site')} (first at ${gap.sample}) — ${gap.detail}`,
      'more refusal reason',
    ),
    hasShortfall: surface.unaccountedFor > 0,
  }
}
