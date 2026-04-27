/**
 * GitHub Action entry point for FlagShark.
 *
 * Scans a repo for stale feature flags, posts a rich PR comment,
 * writes a GitHub Actions job summary, and sets a status check.
 */

import * as core from '@actions/core'
import * as github from '@actions/github'

import { scanRepo } from '@flagshark/core'
import type { StaleFlag } from '@flagshark/core'

const COMMENT_MARKER = '<!-- flagshark-action -->'

// Logger that serializes objects properly instead of [object Object]
const logger = {
  debug: (...args: unknown[]) => core.debug(formatLogArgs(args)),
  info: (...args: unknown[]) => core.info(formatLogArgs(args)),
  warn: (...args: unknown[]) => core.warning(formatLogArgs(args)),
  error: (...args: unknown[]) => core.error(formatLogArgs(args)),
}

function formatLogArgs(args: unknown[]): string {
  return args.map(a =>
    typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ')
}

async function run(): Promise<void> {
  try {
    const scanMode = core.getInput('scan') || 'changed'
    const threshold = parseInt(core.getInput('threshold') || '6', 10)
    const failThreshold = parseInt(core.getInput('fail-threshold') || '0', 10)

    // Determine diff ref for "changed" mode
    const baseRef =
      scanMode === 'changed' && github.context.payload.pull_request
        ? `origin/${github.context.payload.pull_request.base.ref}`
        : undefined

    if (scanMode === 'changed' && !github.context.payload.pull_request) {
      core.info('scan: changed requested but no pull_request context — scanning full tree instead')
    }

    // Run the scan
    const result = await scanRepo({
      cwd: process.cwd(),
      threshold,
      diff: baseRef,
      logger,
    })

    // Destructure for clarity
    const {
      totalFlags,
      filesScanned,
      staleFlags,
      detectedProviders: providers,
      languageBreakdown: langStats,
      healthScore,
      scanDuration,
    } = result

    const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size

    // Pretty log output
    core.info('')
    core.info('┌─────────────────────────────────────────┐')
    core.info('│  🦈 FlagShark Scan Results               │')
    core.info('├─────────────────────────────────────────┤')
    core.info(`│  Files scanned:    ${String(filesScanned).padStart(6)}               │`)
    core.info(`│  Languages:        ${String(Object.keys(langStats).length).padStart(6)}               │`)
    core.info(`│  Flags detected:   ${String(totalFlags).padStart(6)}               │`)
    core.info(`│  Stale flags:      ${String(uniqueStaleNames).padStart(6)}               │`)
    core.info(`│  Health score:   ${String(healthScore).padStart(3)}/100               │`)
    core.info(`│  Scan time:      ${String(scanDuration).padStart(5)}ms               │`)
    core.info('└─────────────────────────────────────────┘')
    core.info('')

    if (providers.length > 0) {
      core.info(`Detected providers: ${providers.slice(0, 8).join(', ')}${providers.length > 8 ? ` (+${providers.length - 8} more)` : ''}`)
    }

    // Set outputs
    core.setOutput('health-score', healthScore.toString())
    core.setOutput('stale-count', uniqueStaleNames.toString())
    core.setOutput('total-count', totalFlags.toString())

    // Post PR comment
    if (github.context.payload.pull_request && totalFlags > 0) {
      const token = process.env.GITHUB_TOKEN || core.getInput('token')
      if (token) {
        await postComment(token, staleFlags, totalFlags, healthScore, scanMode, langStats, providers, scanDuration)
      }
    }

    // Set status check
    if (failThreshold > 0 && healthScore < failThreshold) {
      core.setFailed(
        `Flag health score ${healthScore}/100 is below threshold ${failThreshold}/100. ` +
        `${uniqueStaleNames} stale flags found.`,
      )
    }

    // Job summary (visible in Actions UI under "Summary" tab)
    const healthEmoji = healthScore >= 90 ? '🟢' : healthScore >= 70 ? '🟡' : healthScore >= 40 ? '🟠' : '🔴'

    core.summary.addHeading('🦈 FlagShark Scan Results', 2)
    core.summary.addRaw(`\n${healthEmoji} **Health Score: ${healthScore}/100**\n\n`)
    core.summary.addTable([
      [{ data: 'Metric', header: true }, { data: 'Value', header: true }],
      ['Files scanned', filesScanned.toString()],
      ['Languages', Object.keys(langStats).join(', ') || 'none'],
      ['Total flags', totalFlags.toString()],
      ['Stale flags', uniqueStaleNames.toString()],
      ['Scan mode', scanMode],
      ['Scan time', `${scanDuration}ms`],
    ])

    if (providers.length > 0) {
      core.summary.addRaw(`\n**Detected providers:** ${providers.join(', ')}\n`)
    }

    if (uniqueStaleNames > 0) {
      core.summary.addRaw('\n### Top stale flags\n\n')
      core.summary.addTable([
        [{ data: 'Flag', header: true }, { data: 'File', header: true }, { data: 'Age', header: true }, { data: 'Signal', header: true }],
        ...staleFlags.slice(0, 15).map(f => [
          `\`${f.name}\``,
          `${f.filePath}:${f.lineNumber}`,
          f.age || 'unknown',
          f.signals.map(s => s.description).join(', '),
        ]),
      ])
      if (staleFlags.length > 15) {
        core.summary.addRaw(`\n*... and ${staleFlags.length - 15} more stale flags*\n`)
      }
    }

    core.summary.addRaw('\n---\n')
    core.summary.addRaw('*Powered by [FlagShark](https://github.com/FlagShark/flagshark) — find stale feature flags before they cause incidents*\n')
    core.summary.addRaw('\n[Automate flag cleanup](https://flagshark.com) · [Open source CLI](https://github.com/FlagShark/flagshark) · [Report an issue](https://github.com/FlagShark/flagshark/issues)\n')

    await core.summary.write()

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unexpected error occurred')
    }
  }
}

async function postComment(
  token: string,
  staleFlags: StaleFlag[],
  totalFlags: number,
  healthScore: number,
  scanMode: string,
  langStats: Record<string, number>,
  providers: string[],
  scanDuration: number,
): Promise<void> {
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const prNumber = github.context.payload.pull_request!.number

  const uniqueStaleCount = new Set(staleFlags.map((f) => f.name)).size
  const modeLabel = scanMode === 'full' ? 'Full repo scan' : 'Changed files only'
  const healthEmoji = healthScore >= 90 ? '🟢' : healthScore >= 70 ? '🟡' : healthScore >= 40 ? '🟠' : '🔴'
  const langList = Object.entries(langStats).map(([l, c]) => `${l} (${c})`).join(', ')
  const providerList = providers.length > 0
    ? providers.slice(0, 5).join(', ') + (providers.length > 5 ? ` +${providers.length - 5} more` : '')
    : 'none detected'

  let body = `${COMMENT_MARKER}\n`

  // Header
  if (uniqueStaleCount === 0) {
    body += `## 🦈 FlagShark — All flags healthy\n\n`
  } else {
    body += `## 🦈 FlagShark — ${uniqueStaleCount} stale flag${uniqueStaleCount !== 1 ? 's' : ''} found\n\n`
  }

  // Health score badge
  body += `${healthEmoji} **Health Score: ${healthScore}/100**\n\n`

  // Stats row
  body += `| Metric | Value |\n`
  body += `|--------|-------|\n`
  body += `| Flags detected | ${totalFlags} |\n`
  body += `| Stale flags | ${uniqueStaleCount} |\n`
  body += `| Languages | ${langList} |\n`
  body += `| Providers | ${providerList} |\n`
  body += `| Scan mode | ${modeLabel} |\n`
  body += `| Scan time | ${scanDuration}ms |\n\n`

  // Stale flags table
  if (uniqueStaleCount > 0) {
    body += `<details${uniqueStaleCount <= 5 ? ' open' : ''}>\n`
    body += `<summary><strong>Stale flags (${uniqueStaleCount})</strong></summary>\n\n`
    body += '| Flag | File | Age | Why it looks stale |\n'
    body += '|------|------|-----|--------------------|\n'

    const displayFlags = staleFlags.slice(0, 20)
    for (const flag of displayFlags) {
      const signals = flag.signals.map(s => s.description).join(', ')
      const shortPath = flag.filePath.replace(/^\.\//, '')
      body += `| \`${flag.name}\` | \`${shortPath}:${flag.lineNumber}\` | ${flag.age || 'unknown'} | ${signals} |\n`
    }

    if (staleFlags.length > 20) {
      body += `\n*... and ${staleFlags.length - 20} more. Run \`npx flagshark scan --verbose\` locally for the full list.*\n`
    }

    body += '\n</details>\n\n'
  }

  // Footer with links
  body += '---\n'
  body += `*[FlagShark](https://github.com/FlagShark/flagshark) finds stale feature flags before they cause incidents*\n\n`
  body += `[Automate flag cleanup](https://flagshark.com) · `
  body += `[Install CLI](https://www.npmjs.com/package/flagshark) · `
  body += `[Open source](https://github.com/FlagShark/flagshark)\n`

  // Find existing comment to update
  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: prNumber, per_page: 100,
  })

  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER))

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    core.info('Updated existing FlagShark comment')
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
    core.info('Posted new FlagShark comment')
  }
}

run()
