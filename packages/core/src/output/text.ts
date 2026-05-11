/**
 * Human-readable text output for FlagShark scan results.
 */

import type { ScanRepoResult } from '../scan-repo.js'
import type { StaleFlag, StalenessSignal } from '../staleness.js'

export interface TextFormatOptions {
  verbose: boolean
  /** Max stale flags to show before truncating. Default: 10. Ignored if verbose. */
  maxDisplay: number
}

/** Pad a string to a fixed width, truncating with ellipsis if necessary. */
function pad(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + '…'
  }
  return str.padEnd(width)
}

function buildTable(flags: StaleFlag[]): string {
  const cols = { flag: 16, file: 22, added: 13, signal: 28 }

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
      .map((s: StalenessSignal) => {
        if (s.type === 'age') return 'Age > threshold'
        if (s.type === 'low-usage') return 'Single file'
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

export function formatText(result: ScanRepoResult, options: TextFormatOptions): string {
  const lines: string[] = []

  lines.push(`\u{1F988} FlagShark`)
  lines.push('')

  const langCount = Object.keys(result.languageBreakdown).length
  lines.push(`Scanned ${result.filesScanned} files across ${langCount} language${langCount === 1 ? '' : 's'}`)
  if (result.excludedCount && result.excludedCount > 0) {
    lines.push(`(${result.excludedCount} excluded via .flagsharkignore + excludes)`)
  }

  if (result.totalFlags === 0) {
    lines.push('No feature flags detected.')
    lines.push('')
    lines.push('Supported providers: LaunchDarkly, Unleash, Flipt, Split.io, PostHog, and more.')
    lines.push('Run flagshark scan --help for configuration options.')
    return lines.join('\n')
  }

  if (result.detectedProviders.length > 0) {
    lines.push(`Detected providers: ${result.detectedProviders.join(', ')}`)
  }

  const uniqueStaleNames = new Set(result.staleFlags.map((f) => f.name))
  const staleCount = uniqueStaleNames.size
  lines.push(`Found ${result.totalFlags} feature flags, ${staleCount} stale`)

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

  lines.push('')
  if (staleCount === 0) {
    lines.push(`Flag Health Score: ${result.healthScore}/100 ✓ All flags look healthy!`)
  } else {
    lines.push(
      `Flag Health Score: ${result.healthScore}/100 (${staleCount}/${result.totalFlags} flags are stale)`,
    )
    lines.push('')
    lines.push('Automate cleanup → https://flagshark.com')
    lines.push('Open source CLI  → https://github.com/FlagShark/flagshark')
  }

  if (result.excludedPaths && result.excludedPaths.length > 0) {
    lines.push('')
    lines.push(`Excluded files (${result.excludedPaths.length}):`)
    for (const p of result.excludedPaths) {
      lines.push(`  ${p}`)
    }
  }

  return lines.join('\n')
}
