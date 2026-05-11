/**
 * RFC 4180-compliant CSV output. One row per stale flag.
 *
 * Header columns: flag, file, line, language, provider, signals, age
 * Multi-value `signals` are joined with `; ` inside a single quoted cell.
 */

import type { ScanRepoResult } from '../scan-repo.js'

const HEADER = 'flag,file,line,language,provider,signals,age'

/** RFC 4180 cell escape: wrap in quotes; double any internal quotes. */
function csvCell(value: string | number | undefined): string {
  const s = value == null ? '' : String(value)
  return `"${s.replace(/"/g, '""')}"`
}

export function formatCsv(result: ScanRepoResult): string {
  const lines: string[] = [HEADER]

  for (const flag of result.staleFlags) {
    const signals = flag.signals.map((s) => s.type).join('; ')
    lines.push(
      [
        csvCell(flag.name),
        csvCell(flag.filePath),
        String(flag.lineNumber),
        csvCell(flag.language),
        csvCell(flag.provider),
        csvCell(signals),
        csvCell(flag.age),
      ].join(','),
    )
  }

  return lines.join('\n') + '\n'
}
