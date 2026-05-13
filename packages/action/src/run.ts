/**
 * Pure, dependency-injected action body. Importable in tests without
 * triggering top-level side effects.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

import { scanRepo as defaultScanRepo, formatMarkdown, formatSarif, healthEmoji } from '@flagshark/core'
import type { ScanRepoResult } from '@flagshark/core'

const COMMENT_MARKER = '<!-- flagshark-action -->'

export interface RunDeps {
  core: typeof import('@actions/core')
  github: typeof import('@actions/github')
  cwd: string
  scanRepoFn?: typeof defaultScanRepo
}

function formatLogArgs(args: unknown[]): string {
  return args.map(a =>
    typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ')
}

export async function run(deps: RunDeps): Promise<void> {
  const { core, github, cwd, scanRepoFn = defaultScanRepo } = deps

  const logger = {
    debug: (...args: unknown[]) => core.debug(formatLogArgs(args)),
    info: (...args: unknown[]) => core.info(formatLogArgs(args)),
    warn: (...args: unknown[]) => core.warning(formatLogArgs(args)),
    error: (...args: unknown[]) => core.error(formatLogArgs(args)),
  }

  try {
    const scanMode = core.getInput('scan') || 'changed'
    const threshold = parseInt(core.getInput('threshold') || '6', 10)
    const failThreshold = parseInt(core.getInput('fail-threshold') || '0', 10)
    const outputFormat = core.getInput('output-format') || 'markdown'

    if (outputFormat !== 'markdown' && outputFormat !== 'none') {
      core.warning(`Unknown output-format "${outputFormat}" — expected "markdown" or "none". Defaulting to "markdown".`)
    }

    const baseRef =
      scanMode === 'changed' && github.context.payload.pull_request
        ? `origin/${github.context.payload.pull_request.base.ref}`
        : undefined

    if (scanMode === 'changed' && !github.context.payload.pull_request) {
      core.info('scan: changed requested but no pull_request context — scanning full tree instead')
    }

    const result = await scanRepoFn({ cwd, threshold, diff: baseRef, logger })

    const {
      totalFlags, filesScanned, staleFlags,
      detectedProviders: providers,
      languageBreakdown: langStats,
      healthScore, scanDuration,
    } = result

    const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size

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

    core.setOutput('health-score', healthScore.toString())
    core.setOutput('stale-count', uniqueStaleNames.toString())
    core.setOutput('total-count', totalFlags.toString())

    const sarifPath = core.getInput('sarif')
    if (sarifPath) {
      const actionVersion = process.env.GITHUB_ACTION_REF || 'unknown'
      const sarifJson = formatSarif(result, { version: actionVersion })
      const absolutePath = resolve(cwd, sarifPath)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, sarifJson)
      core.info(`Wrote SARIF to ${absolutePath}`)
      core.setOutput('sarif-path', absolutePath)
    }

    if (github.context.payload.pull_request && totalFlags > 0 && outputFormat === 'markdown') {
      const token = process.env.GITHUB_TOKEN || core.getInput('token')
      if (token) {
        await postComment({ core, github, token, result, scanMode: scanMode as 'full' | 'changed' })
      }
    }

    if (failThreshold > 0 && healthScore < failThreshold) {
      core.setFailed(
        `Flag health score ${healthScore}/100 is below threshold ${failThreshold}/100. ` +
        `${uniqueStaleNames} stale flags found.`,
      )
    }

    const emoji = healthEmoji(healthScore)
    core.summary.addHeading('🦈 FlagShark Scan Results', 2)
    core.summary.addRaw(`\n${emoji} **Health Score: ${healthScore}/100**\n\n`)
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

async function postComment(opts: {
  core: typeof import('@actions/core')
  github: typeof import('@actions/github')
  token: string
  result: ScanRepoResult
  scanMode: 'full' | 'changed'
}): Promise<void> {
  const { core, github, token, result, scanMode } = opts
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const prNumber = github.context.payload.pull_request!.number
  const headSha = github.context.payload.pull_request!.head.sha
  const linkPrefix = `https://github.com/${owner}/${repo}/blob/${headSha}/`

  const body = formatMarkdown(result, {
    scanMode,
    linkPrefix,
    commentMarker: COMMENT_MARKER,
  })

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
