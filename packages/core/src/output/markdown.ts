/**
 * Markdown output for FlagShark scan results.
 *
 * Used in two places:
 *   1. CLI: `flagshark scan --format markdown > REPORT.md`
 *   2. GitHub Action: PR comment body
 *
 * The Action passes `linkPrefix` so file paths render as absolute GitHub URLs;
 * the CLI omits the prefix and uses relative paths.
 */

import type { ScanRepoResult } from '../scan-repo.js'
import type { StaleFlag } from '../staleness.js'

import { uniqueStaleCount, healthEmoji } from './shared.js'

export interface MarkdownFormatOptions {
  /** 'full' or 'changed' — drives the "scan mode" label in the stats table. */
  scanMode: 'full' | 'changed'
  /** Prefix for file links (e.g. `https://github.com/owner/repo/blob/<sha>/`). When set, file paths become absolute URLs. */
  linkPrefix?: string
  /** HTML comment to prepend (used by the Action to find + update its own comment). */
  commentMarker?: string
  /** Cap on rendered stale flags before "...and N more". Default: 20. */
  maxStaleFlags?: number
}

const DEFAULT_MAX_STALE = 20

export function formatMarkdown(result: ScanRepoResult, options: MarkdownFormatOptions): string {
  const staleCount = uniqueStaleCount(result.staleFlags)
  const emoji = healthEmoji(result.healthScore)
  const modeLabel = options.scanMode === 'full' ? 'Full repo scan' : 'Changed files only'
  const maxStale = options.maxStaleFlags ?? DEFAULT_MAX_STALE

  const langList = Object.entries(result.languageBreakdown)
    .map(([l, c]) => `${l} (${c})`)
    .join(', ')
  const providerList = result.detectedProviders.length > 0
    ? result.detectedProviders.slice(0, 5).join(', ') +
      (result.detectedProviders.length > 5 ? ` +${result.detectedProviders.length - 5} more` : '')
    : 'none detected'

  let body = ''
  if (options.commentMarker) {
    body += `${options.commentMarker}\n`
  }

  // Header
  if (staleCount === 0) {
    body += `## 🦈 FlagShark — All flags healthy\n\n`
  } else {
    body += `## 🦈 FlagShark — ${staleCount} stale flag${staleCount !== 1 ? 's' : ''} found\n\n`
  }

  // Health badge
  body += `${emoji} **Health Score: ${result.healthScore}/100**\n\n`

  // Stats table
  body += `| Metric | Value |\n`
  body += `|--------|-------|\n`
  body += `| Flags detected | ${result.totalFlags} |\n`
  body += `| Stale flags | ${staleCount} |\n`
  body += `| Languages | ${langList || 'none'} |\n`
  body += `| Providers | ${providerList} |\n`
  body += `| Scan mode | ${modeLabel} |\n`
  body += `| Scan time | ${result.scanDuration}ms |\n\n`

  // Stale flags table
  if (staleCount > 0) {
    body += `<details${staleCount <= 5 ? ' open' : ''}>\n`
    body += `<summary><strong>Stale flags (${staleCount})</strong></summary>\n\n`
    body += '| Flag | File | Age | Why it looks stale |\n'
    body += '|------|------|-----|--------------------|\n'

    const displayFlags = result.staleFlags.slice(0, maxStale)
    for (const flag of displayFlags) {
      body += `| ${formatRow(flag, options.linkPrefix)} |\n`
    }

    if (result.staleFlags.length > maxStale) {
      body += `\n*... and ${result.staleFlags.length - maxStale} more. Run \`npx flagshark scan --verbose\` locally for the full list.*\n`
    }
    body += '\n</details>\n\n'
  }

  // Footer
  body += '---\n'
  body += `*[FlagShark](https://github.com/FlagShark/flagshark) finds stale feature flags before they cause incidents*\n\n`
  body += `[Automate flag cleanup](https://flagshark.com) · `
  body += `[Install CLI](https://www.npmjs.com/package/flagshark) · `
  body += `[Open source](https://github.com/FlagShark/flagshark)\n`

  return body
}

function formatRow(flag: StaleFlag, linkPrefix?: string): string {
  const signals = flag.signals.map((s) => s.description).join(', ')
  const shortPath = flag.filePath.replace(/^\.\//, '')
  const fileCell = linkPrefix
    ? `[${shortPath}:${flag.lineNumber}](${normalizePrefix(linkPrefix)}${shortPath}#L${flag.lineNumber})`
    : `\`${shortPath}:${flag.lineNumber}\``
  return `\`${flag.name}\` | ${fileCell} | ${flag.age || 'unknown'} | ${signals}`
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : prefix + '/'
}
