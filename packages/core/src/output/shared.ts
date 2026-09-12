import type { StaleFlag } from '../staleness.js'

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
