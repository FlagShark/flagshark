/**
 * GitHub Action entry point for FlagShark.
 *
 * This is a thin wrapper around the same detection engine used by the CLI.
 * It runs the scan, posts a PR comment with results, and sets a status check.
 *
 * Architecture:
 *   action/index.ts (this file)
 *       │
 *       ├─ Runs the same scanner + staleness logic as the CLI
 *       ├─ Posts a PR comment with markdown table
 *       └─ Sets a GitHub check status (pass/fail)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { createDefaultRegistry } from '../src/detection/index.js'
import { PolyglotAnalyzer } from '../src/detection/polyglot-analyzer.js'
import { analyzeStaleness } from '../src/staleness.js'

import type { FeatureFlag } from '../src/detection/feature-flag.js'
import type { StaleFlag } from '../src/staleness.js'

const COMMENT_MARKER = '<!-- flagshark-action -->'
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.next',
  '.turbo',
])

const logger = {
  debug: (...args: unknown[]) => core.debug(args.map(String).join(' ')),
  info: (...args: unknown[]) => core.info(args.map(String).join(' ')),
  warn: (...args: unknown[]) => core.warning(args.map(String).join(' ')),
  error: (...args: unknown[]) => core.error(args.map(String).join(' ')),
}

async function run(): Promise<void> {
  const startTime = Date.now()

  try {
    const scanMode = core.getInput('scan') || 'changed'
    const threshold = parseInt(core.getInput('threshold') || '6', 10)
    const failThreshold = parseInt(core.getInput('fail-threshold') || '0', 10)

    const registry = createDefaultRegistry()
    const supportedExts = new Set(registry.getSupportedExtensions())
    const analyzer = new PolyglotAnalyzer(registry, logger)

    // Determine files to scan
    let filePaths: string[]

    if (scanMode === 'changed' && github.context.payload.pull_request) {
      const token = process.env.GITHUB_TOKEN || core.getInput('token')
      if (!token) {
        core.setFailed('GITHUB_TOKEN is required for changed-file scanning')
        return
      }
      const octokit = github.getOctokit(token)
      const { data: prFiles } = await octokit.rest.pulls.listFiles({
        ...github.context.repo,
        pull_number: github.context.payload.pull_request.number,
        per_page: 100,
      })
      filePaths = prFiles
        .filter((f) => f.status !== 'removed')
        .map((f) => f.filename)
        .filter((f) => supportedExts.has(extname(f)))
    } else {
      filePaths = walkDir('.', supportedExts)
    }

    // Read file contents
    const files = new Map<string, string>()
    for (const fp of filePaths) {
      try {
        const stat = statSync(fp)
        if (stat.size > 5 * 1024 * 1024) {
          continue
        }
        files.set(fp, readFileSync(fp, 'utf-8'))
      } catch {
        // Skip unreadable files
      }
    }

    core.info(`Scanning ${files.size} files...`)

    // Run detection
    const result = await analyzer.analyzeFiles(files)
    const totalFlags = result.totalFlags.size

    // Run staleness analysis
    const staleFlags = await analyzeStaleness(result.totalFlags as Map<string, FeatureFlag[]>, {
      thresholdMonths: threshold,
      repoRoot: process.cwd(),
    })

    // Use unique stale flag names (not occurrences) for health score — matches CLI formula
    const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size
    const healthScore =
      totalFlags > 0 ? Math.round(((totalFlags - uniqueStaleNames) / totalFlags) * 100) : 100

    const scanDuration = Date.now() - startTime

    // Set outputs
    core.setOutput('health-score', healthScore.toString())
    core.setOutput('stale-count', staleFlags.length.toString())
    core.setOutput('total-count', totalFlags.toString())

    // Post PR comment when flags are found (stale or not, to show health score)
    if (github.context.payload.pull_request && totalFlags > 0) {
      const token = process.env.GITHUB_TOKEN || core.getInput('token')
      if (token) {
        await postComment(token, staleFlags, totalFlags, healthScore, scanMode)
      }
    }

    // Set status check
    if (failThreshold > 0 && healthScore < failThreshold) {
      core.setFailed(
        `Flag health score ${healthScore}/100 is below threshold ${failThreshold}/100. ` +
          `${staleFlags.length} stale flags found.`,
      )
    } else {
      core.info(`Flag Health Score: ${healthScore}/100 (${staleFlags.length}/${totalFlags} stale)`)
    }

    // Summary
    core.summary
      .addHeading('FlagShark Results', 2)
      .addRaw(`**Health Score:** ${healthScore}/100\n\n`)
      .addRaw(`**Flags:** ${totalFlags} total, ${staleFlags.length} stale\n\n`)
      .addRaw(`**Scan time:** ${scanDuration}ms\n`)
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
): Promise<void> {
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const prNumber = github.context.payload.pull_request!.number

  const uniqueStaleCount = new Set(staleFlags.map((f) => f.name)).size
  const modeLabel = scanMode === 'full' ? '(full repo scan)' : '(changed files only)'

  let body = `${COMMENT_MARKER}\n`

  if (uniqueStaleCount === 0) {
    body += `### 🦈 FlagShark ${modeLabel}\n\n`
    body += `Scanned ${totalFlags} feature flag${totalFlags !== 1 ? 's' : ''}. All look healthy.\n\n`
    body += `**Flag Health:** ${healthScore}/100\n`
  } else {
    body += `### 🦈 FlagShark found ${uniqueStaleCount} stale flag${uniqueStaleCount !== 1 ? 's' : ''} ${modeLabel}\n\n`
    body += '| Flag | File | Added | Signal |\n'
    body += '|------|------|-------|--------|\n'

    const displayFlags = staleFlags.slice(0, 10)
    const remaining = staleFlags.length - displayFlags.length

    for (const flag of displayFlags) {
      const signals = flag.signals.map((s) => s.description).join(', ')
      body += `| \`${flag.name}\` | ${flag.filePath}:${flag.lineNumber} | ${flag.age || 'unknown'} | ${signals} |\n`
    }

    if (remaining > 0) {
      body += `\n... and ${remaining} more stale flags.\n`
    }

    body += `\n**Flag Health:** ${healthScore}/100 (${totalFlags} total, ${uniqueStaleCount} stale)\n`
  }

  body += '\n---\n*Powered by [FlagShark](https://github.com/FlagShark/flagshark)*\n'

  // Find existing comment to update
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  })

  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER))

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    })
    core.info('Updated existing FlagShark comment')
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    })
    core.info('Posted new FlagShark comment')
  }
}

function walkDir(dir: string, supportedExts: Set<string>): string[] {
  const results: string[] = []

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue
      }
      if (entry.name.startsWith('.')) {
        continue
      }

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, supportedExts))
      } else if (entry.isFile() && supportedExts.has(extname(entry.name))) {
        results.push(fullPath)
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return results
}

run()
