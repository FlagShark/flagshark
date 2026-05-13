/**
 * FlagShark CLI — pure, testable core.
 * Exposes runCli(argv, io) that returns an exit code instead of calling process.exit.
 * The binary entry point is main.ts.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { scanRepo, FlagsharkConfigSchema, type FlagsharkConfig, selectFormatter } from '@flagshark/core'

// ── Constants ─────────────────────────────────────────────────────

const VERSION = '1.3.1'

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

Output:
  --format <fmt>           Output format: text | json | markdown | csv | sarif (default: text)
  --output <path> | -o     Write output to this file instead of stdout
  --json                   Shorthand for --format json (deprecated, will be removed in v2)
`.trim()

// ── Arg parsing ───────────────────────────────────────────────────

export interface CliArgs {
  json: boolean
  format: 'text' | 'json' | 'markdown' | 'csv' | 'sarif'
  output?: string
  diff: string | null
  threshold: number | undefined
  verbose: boolean
  help: boolean
  version: boolean
  engine?: 'regex' | 'tree-sitter'
  configPath?: string
  noConfig?: boolean
  noIgnoreFile?: boolean
  showExcluded?: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    format: 'text',
    diff: null,
    threshold: undefined,
    verbose: false,
    help: false,
    version: false,
  }

  let i = 2 // skip node + script
  while (i < argv.length) {
    // Support both --flag value and --flag=value forms
    let arg = argv[i]
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=')
      argv.splice(i, 1, arg.slice(0, eqIdx), arg.slice(eqIdx + 1))
      arg = argv[i]
    }
    switch (arg) {
      case '--json':
        args.json = true
        args.format = 'json'
        break
      case '--format': {
        const v = argv[++i]
        if (!['text', 'json', 'markdown', 'csv', 'sarif'].includes(v)) {
          throw new Error(`--format must be one of text, json, markdown, csv, sarif; got '${v}'`)
        }
        args.format = v as CliArgs['format']
        break
      }
      case '--output':
      case '-o':
        args.output = argv[++i]
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
      case '--engine': {
        const value = argv[++i]
        if (value !== 'regex' && value !== 'tree-sitter') {
          throw new Error(`--engine must be 'regex' or 'tree-sitter', got '${value}'`)
        }
        args.engine = value
        break
      }
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

// ── Public entry — pure, returns exit code instead of calling process.exit ────

export interface RunCliIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  cwd: string
}

export async function runCli(argv: string[], io: RunCliIO): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr.write(`[error] ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  if (args.version) {
    io.stdout.write(`flagshark v${VERSION}\n`)
    return 0
  }

  if (args.help) {
    io.stdout.write(HELP_TEXT + '\n')
    return 0
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
      io.stderr.write(`Error: config file not found: ${args.configPath}\n`)
      return 2
    }
    const raw = readFileSync(args.configPath, 'utf-8')
    let parsed: unknown
    try {
      parsed = parseYaml(raw)
    } catch (err) {
      io.stderr.write(`Error: invalid YAML at ${args.configPath}: ${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
    const configResult = FlagsharkConfigSchema.safeParse(parsed)
    if (!configResult.success) {
      io.stderr.write(`Error: invalid config at ${args.configPath}: ${configResult.error.message}\n`)
      return 2
    }
    configOverride = configResult.data
  }

  const result = await scanRepo({
    cwd: io.cwd,
    threshold: args.threshold,
    diff: args.diff ?? undefined,
    engine: args.engine,
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
      io.stderr.write('Effective excludes:\n')
      for (const rule of allRules) io.stderr.write(`  ${rule}\n`)
    }
  }

  const formatter = selectFormatter(args.format)
  const output = formatter(result, {
    version: VERSION,
    scanMode: args.diff ? 'changed' : 'full',
    verbose: args.verbose,
  })

  const exitCode = result.staleFlags.length > 0 ? 1 : 0

  if (args.output) {
    writeFileSync(args.output, output)
    return exitCode
  }

  const finalOutput = output.endsWith('\n') ? output : output + '\n'
  io.stdout.write(finalOutput)
  return exitCode
}
