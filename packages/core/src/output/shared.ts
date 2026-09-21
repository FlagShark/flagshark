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
