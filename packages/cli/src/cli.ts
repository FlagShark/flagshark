/**
 * FlagShark CLI — pure, testable core.
 * Exposes runCli(argv, io) that returns an exit code instead of calling process.exit.
 * The binary entry point is main.ts.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { scanRepo, FlagsharkConfigSchema, type FlagsharkConfig, selectFormatter } from '@flagshark/core'
import packageJson from '../package.json' with { type: 'json' }
import { runAssessCommand, type AssessmentCommandDependencies } from './assessment.js'
import { writeStream } from './write-stream.js'

// ── Helpers ───────────────────────────────────────────────────────

/** Safely extract a readable message from a thrown value (may not be an Error). */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Constants ─────────────────────────────────────────────────────

export const VERSION = packageJson.version

const ILL_FORMED_UTF16_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

const HELP_TEXT = `
flagshark scan [options]
flagshark assess [options]

Commands:
  scan              Find stale feature flags in the current repository
  assess            Request a private LaunchDarkly to OpenFeature migration assessment

Run "flagshark assess --help" for migration-assessment options.

Scan options:

Options:
  --json            Output as JSON
  --diff <ref>      Only scan files changed since <ref> (e.g., HEAD~1, main)
  --threshold <n>   Staleness threshold in days (default: 30)
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

Platform integration:
  --no-cache             Skip platform-flag cache, force re-fetch
  --fail-on-error        Fail on any missing-in-platform flag (default: true)
  --no-fail-on-error     Disable fail-on-error
`.trim()

const ASSESS_HELP_TEXT = `
flagshark assess [options]

Request a server-side LaunchDarkly to OpenFeature migration assessment. Source
analysis and report generation remain private; this command only submits, polls,
and downloads the completed report.

Repository:
  --repo <owner/name>      Repository to assess (repeatable, maximum 20)
  --ref <ref>              Git ref to assess; prefer an immutable commit SHA
                           (repo and HEAD are inferred only when --repo is omitted)
  --project <key>          Optional LaunchDarkly project key

Connection:
  --api-base <url>         Assessment API base URL
                           (default: FLAGSHARK_API_BASE_URL or https://api.flagshark.com/api/)
  --token-env <name>       Environment variable containing the API token
                           (default: FLAGSHARK_API_TOKEN)
  --timeout <seconds>      Overall assessment timeout (default: 900, maximum: 3600)

Output:
  --format <fmt>           Report format: markdown | json (default: markdown)
  --output <path> | -o     Write atomically to a file; use '-' or omit for stdout
  --json                   Shorthand for --format json
  --help                   Show help
  --version                Show version

Credentials are never accepted as command-line values. Set FLAGSHARK_API_TOKEN
(or the variable named by --token-env) in the environment. CLI tokens are
currently invite-only; request one from joe@flagshark.com. GitHub Actions users
should use the OIDC-based Action and do not need a token.
`.trim()

// ── Arg parsing ───────────────────────────────────────────────────

export interface CliArgs {
  command: 'scan' | 'assess'
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
  noCache?: boolean
  failOnError?: boolean
  repositories: string[]
  assessmentRef?: string
  launchDarklyProjectKey?: string
  apiBaseUrl?: string
  tokenEnvironmentVariable: string
  assessmentTimeoutMs: number
}

export function parseArgs(argv: string[]): CliArgs {
  const tokens = argv.slice(2).flatMap((argument) => {
    if (!argument.startsWith('--') || !argument.includes('=')) return [argument]
    const equals = argument.indexOf('=')
    return [argument.slice(0, equals), argument.slice(equals + 1)]
  })
  const explicitCommand = tokens[0] === 'scan' || tokens[0] === 'assess' ? (tokens.shift() as 'scan' | 'assess') : undefined
  const command = explicitCommand ?? 'scan'
  const args: CliArgs = {
    command,
    json: false,
    format: command === 'assess' ? 'markdown' : 'text',
    diff: null,
    threshold: undefined,
    verbose: false,
    help: false,
    version: false,
    failOnError: true,
    repositories: [],
    tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
    assessmentTimeoutMs: 900_000,
  }

  let i = 0
  while (i < tokens.length) {
    const arg = tokens[i]

    if (arg === '--help' || arg === '-h') {
      args.help = true
      i += 1
      continue
    }
    if (arg === '--version' || arg === '-v') {
      args.version = true
      i += 1
      continue
    }

    if (command === 'assess') {
      switch (arg) {
        case '--repo': {
          const value = tokens[++i]
          if (!value) throw new Error('--repo requires an owner/repository argument')
          args.repositories.push(value)
          if (args.repositories.length > 20) throw new Error('--repo may be supplied at most 20 times')
          break
        }
        case '--ref': {
          const value = tokens[++i]
          if (!value) throw new Error('--ref requires a Git ref argument')
          args.assessmentRef = value
          break
        }
        case '--project': {
          const value = tokens[++i]
          if (!value) throw new Error('--project requires a LaunchDarkly project key')
          args.launchDarklyProjectKey = value
          break
        }
        case '--api-base': {
          const value = tokens[++i]
          if (!value) throw new Error('--api-base requires a URL')
          args.apiBaseUrl = value
          break
        }
        case '--token-env': {
          const value = tokens[++i]
          if (!value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
            throw new Error('--token-env requires a valid environment-variable name')
          }
          args.tokenEnvironmentVariable = value
          break
        }
        case '--timeout': {
          const value = tokens[++i]
          const seconds = Number(value)
          if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 3_600) {
            throw new Error('--timeout requires a positive integer no greater than 3600 seconds')
          }
          args.assessmentTimeoutMs = seconds * 1_000
          break
        }
        case '--format': {
          const value = tokens[++i]
          if (value !== 'markdown' && value !== 'json') {
            throw new Error(`--format must be one of markdown, json; got '${value}'`)
          }
          args.format = value
          break
        }
        case '--json':
          args.json = true
          args.format = 'json'
          break
        case '--output':
        case '-o': {
          const value = tokens[++i]
          if (
            !value ||
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value) ||
            ILL_FORMED_UTF16_PATTERN.test(value)
          ) {
            throw new Error(`${arg} requires a safe file path or '-'`)
          }
          args.output = value
          break
        }
        default:
          throw new Error(`Unknown assess option: ${arg}`)
      }
      i += 1
      continue
    }

    switch (arg) {
      case '--json':
        args.json = true
        args.format = 'json'
        break
      case '--format': {
        const v = tokens[++i]
        if (!['text', 'json', 'markdown', 'csv', 'sarif'].includes(v)) {
          throw new Error(`--format must be one of text, json, markdown, csv, sarif; got '${v}'`)
        }
        args.format = v as CliArgs['format']
        break
      }
      case '--output':
      case '-o': {
        const value = tokens[++i]
        if (!value) throw new Error(`${arg} requires a file path`)
        args.output = value
        break
      }
      case '--diff':
        i++
        args.diff = tokens[i] ?? null
        if (!args.diff) {
          throw new Error('--diff requires a git ref argument (e.g., HEAD~1, main)')
        }
        break
      case '--threshold':
        i++
        args.threshold = parseInt(tokens[i], 10)
        if (isNaN(args.threshold) || args.threshold < 1) {
          throw new Error('--threshold requires a positive integer (days)')
        }
        break
      case '--verbose':
        args.verbose = true
        break
      case '--engine': {
        const value = tokens[++i]
        if (value !== 'regex' && value !== 'tree-sitter') {
          throw new Error(`--engine must be 'regex' or 'tree-sitter', got '${value}'`)
        }
        args.engine = value
        break
      }
      case '--config':
        i++
        args.configPath = tokens[i]
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
      case '--no-cache':
        args.noCache = true
        break
      case '--no-fail-on-error':
        args.failOnError = false
        break
      case '--fail-on-error':
        args.failOnError = true
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

export function createLogger(verbose: boolean) {
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

export interface RunCliDependencies extends AssessmentCommandDependencies {}

export async function runCli(argv: string[], io: RunCliIO, dependencies: RunCliDependencies = {}): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr.write(`[error] ${toErrorMessage(err)}\n`)
    return 2
  }

  if (args.version) {
    await writeStream(io.stdout, `flagshark v${VERSION}\n`)
    return 0
  }

  if (args.help) {
    await writeStream(io.stdout, (args.command === 'assess' ? ASSESS_HELP_TEXT : HELP_TEXT) + '\n')
    return 0
  }

  if (args.command === 'assess') {
    return runAssessCommand(
      {
        repositories: args.repositories,
        ref: args.assessmentRef,
        launchDarklyProjectKey: args.launchDarklyProjectKey,
        apiBaseUrl: args.apiBaseUrl,
        tokenEnvironmentVariable: args.tokenEnvironmentVariable,
        format: args.format as 'markdown' | 'json',
        output: args.output,
        timeoutMs: args.assessmentTimeoutMs,
      },
      io,
      VERSION,
      dependencies,
    )
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
      io.stderr.write(`Error: invalid YAML at ${args.configPath}: ${toErrorMessage(err)}\n`)
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
    noCache: args.noCache,
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

  const hasErrorSignals = result.staleFlags.some((f) => f.signals.some((s) => s.severity === 'error'))
  const exitCode = args.failOnError && hasErrorSignals ? 1 : result.staleFlags.length > 0 ? 1 : 0

  if (args.output) {
    writeFileSync(args.output, output)
    return exitCode
  }

  const finalOutput = output.endsWith('\n') ? output : output + '\n'
  await writeStream(io.stdout, finalOutput)
  return exitCode
}
