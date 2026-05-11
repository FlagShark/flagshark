#!/usr/bin/env node
/**
 * FlagShark CLI entry point.
 * Scans a codebase for feature flags and reports staleness.
 */

import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { scanRepo, FlagsharkConfigSchema, type FlagsharkConfig } from '@flagshark/core'
import { formatText, formatJson } from './formatter.js'

// ── Constants ─────────────────────────────────────────────────────

const VERSION = '1.2.0'

const HELP_TEXT = `
flagshark scan [options]

Options:
  --json            Output as JSON
  --diff <ref>      Only scan files changed since <ref> (e.g., HEAD~1, main)
  --threshold <n>   Staleness threshold in months (default: 6)
  --verbose         Show all stale flags (not just top 10)
  --help            Show help
  --version         Show version

Configuration:
  --config <path>          Use this config file (overrides .flagshark.yml discovery)
  --no-config              Skip config file discovery
  --no-ignore-file         Skip .flagsharkignore discovery
  --show-excluded          Show excluded files in text output
`.trim()

// ── Arg parsing ───────────────────────────────────────────────────

interface CliArgs {
  json: boolean
  diff: string | null
  threshold: number | undefined
  verbose: boolean
  help: boolean
  version: boolean
  configPath?: string
  noConfig?: boolean
  noIgnoreFile?: boolean
  showExcluded?: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    diff: null,
    threshold: undefined,
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
      case '--config':
        i++
        args.configPath = argv[i]
        if (!args.configPath) {
          throw new Error('--config requires a file path argument')
        }
        break
      case '--no-config':
        args.noConfig = true
        break
      case '--no-ignore-file':
        args.noIgnoreFile = true
        break
      case '--show-excluded':
        args.showExcluded = true
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

  const logger = createLogger(args.verbose)

  if (args.diff) {
    logger.info(`Scanning files changed since ${args.diff}...`)
  } else {
    logger.info('Scanning current directory...')
  }

  let configOverride: FlagsharkConfig | undefined
  if (args.configPath) {
    if (!existsSync(args.configPath)) {
      process.stderr.write(`Error: config file not found: ${args.configPath}\n`)
      process.exit(2)
    }
    const raw = readFileSync(args.configPath, 'utf-8')
    const parsed = parseYaml(raw)
    const configResult = FlagsharkConfigSchema.safeParse(parsed)
    if (!configResult.success) {
      process.stderr.write(`Error: invalid config at ${args.configPath}: ${configResult.error.message}\n`)
      process.exit(2)
    }
    configOverride = configResult.data
  }

  const result = await scanRepo({
    cwd: process.cwd(),
    threshold: args.threshold,
    diff: args.diff ?? undefined,
    config: configOverride,
    noConfig: args.noConfig,
    noIgnoreFile: args.noIgnoreFile,
    collectExcludedPaths: args.showExcluded,
    logger,
  })

  if (args.verbose && result.effectiveExcludes) {
    const r = result.effectiveExcludes
    const allRules = [
      ...r.paths.map((p) => `excludes.paths: ${p}`),
      ...r.files.map((p) => `excludes.files: ${p}`),
      ...r.presets.flatMap((name, i) => [`excludes.presets[${i}]: ${name}`]),
      ...r.ignoreFile.map((p) => `.flagsharkignore: ${p}`),
    ]
    if (allRules.length > 0) {
      process.stderr.write('Effective excludes:\n')
      for (const rule of allRules) process.stderr.write(`  ${rule}\n`)
    }
  }

  const output = args.json
    ? formatJson(result) + '\n'
    : formatText(result, { json: false, verbose: args.verbose, maxDisplay: 10 }) + '\n'

  const exitCode = result.staleFlags.length > 0 ? 1 : 0

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
