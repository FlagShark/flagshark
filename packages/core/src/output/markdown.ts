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

  // Parse-error surfacing — mirrors text output. When a non-trivial slice of
  // files failed to parse, the totals at the top of this comment are
  // computed over an incomplete sample, and the cleanup PR reviewer needs
  // to know. Pre-fix this was text-only, so the GitHub Action's PR comment
  // — the most visible FlagShark surface — silently hid the "27% of files
  // skipped" case the feature was originally designed to expose. See
  // REPORT.md (PostHog 1.3.x repro) for the motivating scenario.
  const parseErrorCount = result.parseErrorCount ?? 0
  if (parseErrorCount > 0 && result.filesScanned > 0) {
    const pct = (parseErrorCount / result.filesScanned) * 100
    const rounded = Math.round(pct)
    const pctStr = pct >= 1 ? ` (${rounded}%)` : ''
    if (rounded > 5) {
      body += `> ⚠️ **${parseErrorCount} of ${result.filesScanned} files${pctStr} couldn't be parsed** — results may be incomplete. The totals below are computed over the parseable subset only.\n\n`
    } else {
      body += `> _${parseErrorCount} file${parseErrorCount === 1 ? '' : 's'} couldn't be parsed — totals exclude them._\n\n`
    }
  }

  // Compute error / warning split up front (used in both sections below)
  const errorFlags = result.staleFlags.filter((f) => f.signals.some((s) => s.severity === 'error'))
  const warningFlags = result.staleFlags.filter((f) => !f.signals.some((s) => s.severity === 'error'))

  // Production-risk section (before stats table so it appears at a higher position)
  if (errorFlags.length > 0) {
    body += `### 🚨 Production-risk: flags missing in platform\n\n`
    body += '| Flag | File | Age | Why it looks stale |\n'
    body += '|------|------|-----|--------------------|\n'
    for (const flag of errorFlags) {
      body += `| ${formatRow(flag, options.linkPrefix)} |\n`
    }
    body += '\n'
  }

  // Stats table
  body += `| Metric | Value |\n`
  body += `|--------|-------|\n`
  body += `| Flags detected | ${result.totalFlags} |\n`
  body += `| Stale flags | ${staleCount} |\n`
  body += `| Languages | ${langList || 'none'} |\n`
  body += `| Providers | ${providerList} |\n`
  body += `| Scan mode | ${modeLabel} |\n`
  body += `| Scan time | ${result.scanDuration}ms |\n\n`

  // Surface permanent-flag exclusions before the stale-flag tables so a
  // PR reviewer immediately sees which flags FlagShark consciously
  // skipped (rather than wondering why a known-stale flag isn't here).
  if (result.permanentByPlatform && Object.keys(result.permanentByPlatform).length > 0) {
    for (const [platform, names] of Object.entries(result.permanentByPlatform)) {
      if (names.length === 0) continue
      const flagWord = names.length === 1 ? 'flag' : 'flags'
      const inlineList = names.map((n) => `\`${n}\``).join(', ')
      body += `> _${names.length} ${flagWord} excluded as permanent in ${platform}: ${inlineList}_\n\n`
    }
  }

  // Warning-severity stale flags section
  if (warningFlags.length > 0) {
    const displayFlags = warningFlags.slice(0, maxStale)

    body += `<details${warningFlags.length <= 5 ? ' open' : ''}>\n`
    body += `<summary><strong>Stale flags (${warningFlags.length})</strong></summary>\n\n`
    body += '| Flag | File | Age | Why it looks stale |\n'
    body += '|------|------|-----|--------------------|\n'

    for (const flag of displayFlags) {
      body += `| ${formatRow(flag, options.linkPrefix)} |\n`
    }

    if (warningFlags.length > maxStale) {
      body += `\n*... and ${warningFlags.length - maxStale} more. Run \`npx flagshark scan --verbose\` locally for the full list.*\n`
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

  // Platform-side metadata appended after the signal list (kept in the
  // same cell so the table stays 4-column). Tags inline as backticks;
  // maintainer prefixed with @ for natural-language flow. Status only
  // surfaces non-default verdicts (not 'active' — already the norm).
  const metaParts: string[] = []
  if (flag.tags && flag.tags.length > 0) {
    metaParts.push(flag.tags.map((t) => `\`${t}\``).join(' '))
  }
  if (flag.maintainer) {
    metaParts.push(`@${flag.maintainer}`)
  }
  if (flag.platformStatus && flag.platformStatus !== 'active') {
    metaParts.push(`_status: ${flag.platformStatus}_`)
  }
  const meta = metaParts.length > 0 ? ` <br/> ${metaParts.join(' • ')}` : ''

  return `\`${flag.name}\` | ${fileCell} | ${flag.age || 'unknown'} | ${signals}${meta}`
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : prefix + '/'
}
