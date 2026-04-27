/**
 * Output formatter for FlagShark CLI scan results.
 * Supports human-readable text and JSON output modes.
 */

import type { StaleFlag } from './staleness.js'

export interface FormatOptions {
  json: boolean
  verbose: boolean
  maxDisplay: number // max stale flags to show (default: 10)
}

export interface ScanResult {
  totalFlags: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Map<string, number>
  healthScore: number // 0-100
  scanDuration: number // ms
}

const VERSION = '1.0.0'

// ── Text formatting ───────────────────────────────────────────────

/**
 * Pad a string to a fixed width, truncating with ellipsis if necessary.
 */
function pad(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + '\u2026'
  }
  return str.padEnd(width)
}

/**
 * Build a text table for stale flags.
 */
function buildTable(flags: StaleFlag[]): string {
  const cols = {
    flag: 16,
    file: 22,
    added: 13,
    signal: 28,
  }

  const hBorder = (left: string, mid: string, right: string) =>
    `${left}${'─'.repeat(cols.flag + 2)}${mid}${'─'.repeat(cols.file + 2)}${mid}${'─'.repeat(cols.added + 2)}${mid}${'─'.repeat(cols.signal + 2)}${right}`

  const lines: string[] = []

  lines.push(hBorder('┌', '┬', '┐'))
  lines.push(
    `│ ${pad('Flag', cols.flag)} │ ${pad('File', cols.file)} │ ${pad('Added', cols.added)} │ ${pad('Signal', cols.signal)} │`,
  )
  lines.push(hBorder('├', '┼', '┤'))

  for (const sf of flags) {
    const fileRef = `${sf.filePath}:${sf.lineNumber}`
    const signalText = sf.signals
      .map((s) => {
        if (s.type === 'age') {
          return 'Age > threshold'
        }
        if (s.type === 'low-usage') {
          return 'Single file'
        }
        return s.description
      })
      .join(', ')

    lines.push(
      `│ ${pad(sf.name, cols.flag)} │ ${pad(fileRef, cols.file)} │ ${pad(sf.age ?? 'unknown', cols.added)} │ ${pad(signalText, cols.signal)} │`,
    )
  }

  lines.push(hBorder('└', '┴', '┘'))

  return lines.join('\n')
}

/**
 * Format scan results as human-readable text.
 */
export function formatText(result: ScanResult, options: FormatOptions): string {
  const lines: string[] = []

  lines.push(`\u{1F988} FlagShark v${VERSION}`)
  lines.push('')

  // Language summary
  const langCount = result.languageBreakdown.size
  const fileCount = Array.from(result.languageBreakdown.values()).reduce((sum, n) => sum + n, 0)
  lines.push(`Scanned ${fileCount} files across ${langCount} language${langCount === 1 ? '' : 's'}`)

  // No flags found
  if (result.totalFlags === 0) {
    lines.push('No feature flags detected.')
    lines.push('')
    lines.push('Supported providers: LaunchDarkly, Unleash, Flipt, Split.io, PostHog, and more.')
    lines.push('Run flagshark scan --help for configuration options.')
    return lines.join('\n')
  }

  // Provider line
  if (result.detectedProviders.length > 0) {
    lines.push(`Detected providers: ${result.detectedProviders.join(', ')}`)
  }

  // Deduplicate stale flags by name (multiple occurrences of same flag = 1 stale flag)
  const uniqueStaleNames = new Set(result.staleFlags.map((f) => f.name))
  const staleCount = uniqueStaleNames.size
  lines.push(`Found ${result.totalFlags} feature flags, ${staleCount} stale`)

  // Stale flags table
  if (staleCount > 0) {
    lines.push('')
    lines.push('Stale flags:')

    const displayCount = options.verbose ? staleCount : Math.min(staleCount, options.maxDisplay)
    const displayFlags = result.staleFlags.slice(0, displayCount)

    lines.push(buildTable(displayFlags))

    const remaining = staleCount - displayCount
    if (remaining > 0) {
      lines.push('')
      lines.push(`... and ${remaining} more (use --verbose to see all)`)
    }
  }

  // Health score
  lines.push('')
  if (staleCount === 0) {
    lines.push(`Flag Health Score: ${result.healthScore}/100 \u2713 All flags look healthy!`)
  } else {
    lines.push(
      `Flag Health Score: ${result.healthScore}/100 (${staleCount}/${result.totalFlags} flags are stale)`,
    )
    lines.push('')
    lines.push('Automate cleanup \u2192 https://flagshark.com')
    lines.push('Open source CLI  \u2192 https://github.com/FlagShark/flagshark')
  }

  return lines.join('\n')
}

// ── JSON formatting ───────────────────────────────────────────────

/**
 * Format scan results as a JSON string.
 */
export function formatJson(result: ScanResult): string {
  const languages: Record<string, number> = {}
  for (const [lang, count] of result.languageBreakdown) {
    languages[lang] = count
  }

  const flags = result.staleFlags.map((sf) => ({
    name: sf.name,
    file: sf.filePath,
    line: sf.lineNumber,
    language: sf.language,
    provider: sf.provider,
    stale: true,
    signals: sf.signals.map((s) => ({
      type: s.type,
      description: s.description,
    })),
    age: sf.age ?? null,
  }))

  const output = {
    version: VERSION,
    totalFlags: result.totalFlags,
    staleFlags: new Set(result.staleFlags.map((f) => f.name)).size,
    healthScore: result.healthScore,
    detectedProviders: result.detectedProviders,
    languages,
    flags,
    scanDuration: result.scanDuration,
    links: {
      dashboard: 'https://flagshark.com',
      cli: 'https://github.com/FlagShark/flagshark',
      npm: 'https://www.npmjs.com/package/flagshark',
    },
  }

  return JSON.stringify(output, null, 2)
}
