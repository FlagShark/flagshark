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

function maxSeverity(signals: Array<{ severity: 'error' | 'warning' }>): 'error' | 'warning' {
  return signals.some((s) => s.severity === 'error') ? 'error' : 'warning'
}

function severityRank(s: 'error' | 'warning'): number {
  return s === 'error' ? 0 : 1
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
        if (s.type === 'missing-in-platform') return 'missing-in-platform'
        if (s.type === 'archived-in-platform') return 'archived-in-platform'
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

  // Surface files where the detector errored. A small number is the long tail
  // of edge cases (mid-edit syntax errors, exotic source files, etc.) — note
  // it but don't shout. A large fraction means the analysis is materially
  // incomplete (e.g. PostHog on 1.3.x: ~27% of files aborted from the python
  // tree-sitter grammar) and the user needs to know before they trust the
  // flag count or health score. Threshold of >5% picks up "noticeably broken"
  // without firing on the dozen-files-out-of-ten-thousand case.
  const parseErrorCount = result.parseErrorCount ?? 0
  if (parseErrorCount > 0 && result.filesScanned > 0) {
    const pct = (parseErrorCount / result.filesScanned) * 100
    // Compare on the rounded value so the threshold and the displayed
    // percentage cannot disagree. Pre-fix, `pct > 5` with `Math.round(pct)`
    // could fire the warning branch while rendering "(5%)" — same number
    // we document as the quiet/loud boundary in the comment above. See
    // ultrareview bug_018.
    const rounded = Math.round(pct)
    const pctStr = pct >= 1 ? ` (${rounded}%)` : ''
    if (rounded > 5) {
      lines.push(
        `⚠ ${parseErrorCount} of ${result.filesScanned} files${pctStr} couldn't be parsed — results may be incomplete. See the "Parse errors during analysis" warning on stderr for the top failing patterns.`,
      )
    } else {
      lines.push(
        `(${parseErrorCount} file${parseErrorCount === 1 ? '' : 's'} couldn't be parsed — see the "Parse errors during analysis" warning above)`,
      )
    }
  }

  if (result.totalFlags === 0) {
    lines.push('No feature flags detected.')
    lines.push('')
    lines.push('Supported providers: LaunchDarkly, Unleash, Flipt, Split.io, PostHog, and more.')
    lines.push('Run flagshark scan --help for configuration options.')

    // Troubleshooting hint when a non-trivial repo turns up empty. Pre-fix,
    // this was the single most common confused-user response: "I have 50
    // feature flags, your scan found 0, what's wrong?". The hint surfaces
    // the three real causes (SDK wrappers loaded at runtime, TS path
    // aliases, config-struct flag systems) without falsely promising
    // "this WILL find them"; see README#known-limitations for the design
    // trade-offs that lead here. We only fire on repos large enough that
    // "no flags at all" is suspicious (≥100 files); empty/tiny repos
    // legitimately have no flags and don't deserve scolding.
    const SUSPICIOUS_THRESHOLD = 100
    if (result.filesScanned >= SUSPICIOUS_THRESHOLD) {
      lines.push('')
      lines.push(`Expected results in this ${result.filesScanned}-file repo? Three patterns FlagShark can't see today:`)
      lines.push('  • SDK loaded at runtime via window/globalThis (instead of static `import`)')
      lines.push('  • TS path aliases (`@/...`, `~/...`) bridging the consumer file to the SDK')
      lines.push('  • Typed config-struct flag systems (e.g. `Config().FeatureFlags.X`)')
      lines.push('See https://github.com/FlagShark/flagshark#known-limitations for details + workarounds.')
    }

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
    const sorted = [...result.staleFlags].sort((a, b) => {
      const sevA = severityRank(maxSeverity(a.signals))
      const sevB = severityRank(maxSeverity(b.signals))
      if (sevA !== sevB) return sevA - sevB
      return 0
    })
    const displayCount = options.verbose ? staleCount : Math.min(staleCount, options.maxDisplay)
    const displayFlags = sorted.slice(0, displayCount)
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
