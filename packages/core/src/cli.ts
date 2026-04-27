#!/usr/bin/env node
/**
 * FlagShark CLI entry point.
 * Scans a codebase for feature flags and reports staleness.
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { createDefaultRegistry } from './detection/index.js'
import { PolyglotAnalyzer } from './detection/polyglot-analyzer.js'
import { formatText, formatJson } from './formatter.js'
import { analyzeStaleness } from './staleness.js'

import type { FeatureFlag } from './detection/feature-flag.js'
import type { ScanResult } from './formatter.js'

// ── Constants ─────────────────────────────────────────────────────

const VERSION = '1.0.0'

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

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

const HELP_TEXT = `
flagshark scan [options]

Options:
  --json            Output as JSON
  --diff <ref>      Only scan files changed since <ref> (e.g., HEAD~1, main)
  --threshold <n>   Staleness threshold in months (default: 6)
  --verbose         Show all stale flags (not just top 10)
  --help            Show help
  --version         Show version
`.trim()

// ── Arg parsing ───────────────────────────────────────────────────

interface CliArgs {
  json: boolean
  diff: string | null
  threshold: number
  verbose: boolean
  help: boolean
  version: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    diff: null,
    threshold: 6,
    verbose: false,
    help: false,
    version: false,
  }

  let i = 2 // skip node + script
  while (i < argv.length) {
    const arg = argv[i]
    switch (arg) {
      case '--json':
        args.json = true
        break
      case '--diff':
        i++
        args.diff = argv[i] ?? null
        if (!args.diff) {
          throw new Error('--diff requires a git ref argument (e.g., HEAD~1, main)')
        }
        break
      case '--threshold':
        i++
        args.threshold = parseInt(argv[i], 10)
        if (isNaN(args.threshold) || args.threshold < 1) {
          throw new Error('--threshold requires a positive integer (months)')
        }
        break
      case '--verbose':
        args.verbose = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      case '--version':
      case '-v':
        args.version = true
        break
      case 'scan':
        // accepted as subcommand, no-op
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
    i++
  }

  return args
}

// ── Logger ────────────────────────────────────────────────────────

function createLogger(verbose: boolean) {
  return {
    debug: (...args: unknown[]) => {
      if (verbose) {
        console.error('[debug]', ...args)
      }
    },
    info: (...args: unknown[]) => console.error('[info]', ...args),
    warn: (...args: unknown[]) => console.error('[warn]', ...args),
    error: (...args: unknown[]) => console.error('[error]', ...args),
  }
}

// ── File walking ──────────────────────────────────────────────────

interface FileEntry {
  path: string
  content: string
}

function walkDirectory(
  dir: string,
  supportedExtensions: Set<string>,
  logger: ReturnType<typeof createLogger>,
): FileEntry[] {
  const files: FileEntry[] = []

  function walk(currentDir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      logger.warn(`Cannot read directory: ${currentDir}`)
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue
        }
        walk(fullPath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const ext = path.extname(entry.name)
      if (!supportedExtensions.has(ext)) {
        continue
      }

      try {
        const stat = fs.statSync(fullPath)
        if (stat.size > MAX_FILE_SIZE) {
          logger.debug(`Skipping large file: ${fullPath} (${stat.size} bytes)`)
          continue
        }
      } catch {
        continue
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf-8')
        files.push({ path: fullPath, content })
      } catch {
        logger.debug(`Cannot read file: ${fullPath}`)
      }
    }
  }

  walk(dir)
  return files
}

function getDiffFiles(
  ref: string,
  cwd: string,
  supportedExtensions: Set<string>,
  logger: ReturnType<typeof createLogger>,
): FileEntry[] {
  let output: string
  try {
    output = execFileSync('git', ['diff', ref, '--name-only'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    throw new Error(
      `Failed to get diff against "${ref}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!output) {
    return []
  }

  const files: FileEntry[] = []
  for (const relPath of output.split('\n')) {
    const ext = path.extname(relPath)
    if (!supportedExtensions.has(ext)) {
      continue
    }

    const fullPath = path.resolve(cwd, relPath)
    try {
      const stat = fs.statSync(fullPath)
      if (stat.size > MAX_FILE_SIZE) {
        logger.debug(`Skipping large file: ${fullPath}`)
        continue
      }
      const content = fs.readFileSync(fullPath, 'utf-8')
      files.push({ path: fullPath, content })
    } catch {
      logger.debug(`Cannot read changed file: ${fullPath}`)
    }
  }

  return files
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  if (args.version) {
    process.stdout.write(`flagshark v${VERSION}\n`)
    process.exit(0)
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT + '\n')
    process.exit(0)
  }

  const verbose = args.verbose
  const logger = createLogger(verbose)
  const startTime = performance.now()
  const cwd = process.cwd()

  // 1. Set up detection
  logger.debug('Creating language registry...')
  const registry = createDefaultRegistry()
  const analyzer = new PolyglotAnalyzer(registry, logger)

  const supportedExtensions = new Set(registry.getSupportedExtensions())

  // 2. Collect files
  logger.debug('Collecting files...')
  let fileEntries: FileEntry[]

  if (args.diff) {
    logger.info(`Scanning files changed since ${args.diff}...`)
    fileEntries = getDiffFiles(args.diff, cwd, supportedExtensions, logger)
  } else {
    logger.info('Scanning current directory...')
    fileEntries = walkDirectory(cwd, supportedExtensions, logger)
  }

  logger.debug(`Found ${fileEntries.length} files to scan`)

  // 3. Build file map (PolyglotAnalyzer expects Map<filePath, content>)
  const fileMap = new Map<string, string>()
  for (const entry of fileEntries) {
    fileMap.set(entry.path, entry.content)
  }

  // 4. Detect flags
  logger.debug('Running detection...')
  const analysisResult = await analyzer.analyzeFiles(fileMap)

  // 5. Staleness analysis
  logger.debug('Analyzing staleness...')
  const staleFlags = await analyzeStaleness(
    analysisResult.totalFlags as Map<string, FeatureFlag[]>,
    {
      thresholdMonths: args.threshold,
      repoRoot: cwd,
    },
  )

  // 6. Compute metadata
  const totalFlags = analysisResult.totalFlags.size
  // Count unique stale flag names (not occurrences) for health score
  const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size
  const healthScore =
    totalFlags === 0 ? 100 : Math.round(((totalFlags - uniqueStaleNames) / totalFlags) * 100)

  // Unique providers from all detected flags
  const allFlags: FeatureFlag[] = []
  for (const flags of analysisResult.totalFlags.values()) {
    allFlags.push(...(flags as FeatureFlag[]))
  }
  const detectedProviders = [
    ...new Set(
      allFlags
        .map((f) => f.provider)
        .filter((p): p is string => p !== null && p !== undefined && p !== ''),
    ),
  ]

  // Language breakdown (files per language from analysis result)
  const languageBreakdown = analysisResult.languages

  const scanDuration = Math.round(performance.now() - startTime)

  // 7. Build result
  const result: ScanResult = {
    totalFlags,
    staleFlags,
    detectedProviders,
    languageBreakdown,
    healthScore,
    scanDuration,
  }

  // 8. Output + exit
  // Must wait for stdout to drain before exiting, otherwise large JSON
  // output gets truncated at the 64KB buffer boundary.
  const output = args.json
    ? formatJson(result) + '\n'
    : formatText(result, { json: false, verbose: args.verbose, maxDisplay: 10 }) + '\n'

  const exitCode = staleFlags.length > 0 ? 1 : 0

  if (process.stdout.write(output)) {
    process.exit(exitCode)
  } else {
    process.stdout.once('drain', () => process.exit(exitCode))
  }
}

// ── Entry ─────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error(`[error] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
})
