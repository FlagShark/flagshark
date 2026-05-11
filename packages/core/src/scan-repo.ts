/**
 * Top-level orchestrator: walk the repo, detect flags, analyse staleness,
 * return a single result object that consumers can render however they like.
 */

import { collectFiles } from './scanner.js'
import { createDefaultRegistry, createRegistryWithEngine } from './detection/index.js'
import { PolyglotAnalyzer } from './detection/polyglot-analyzer.js'
import { analyzeStaleness } from './staleness.js'
import { buildDefaultConfig } from './config/defaults.js'
import { buildExcluder } from './config/excluder.js'
import { loadConfigFile } from './config/loader.js'
import { loadIgnoreFile } from './config/ignore-file.js'

import type { FeatureFlag } from './detection/feature-flag.js'
import type { StaleFlag } from './staleness.js'
import type { FlagsharkConfig } from './config/schema.js'
import type { EffectiveRules } from './config/excluder.js'

export interface ScanLogger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface ScanRepoOptions {
  /**
   * Absolute path to the repository being scanned. Typically `process.cwd()`,
   * but can be a different directory when scanning a path other than where
   * the consumer process was started.
   */
  cwd: string

  /**
   * Staleness threshold in months. A flag is considered stale if its
   * git-blame age exceeds this value. Default: 6.
   */
  threshold?: number

  /**
   * If set, only scan files changed since this git ref (e.g., `HEAD~1`,
   * `origin/main`). Otherwise, walk the entire `cwd` tree.
   */
  diff?: string

  /**
   * Optional cancellation signal. Aborting cancels file *analysis* (the
   * detection phase). It does NOT cancel staleness analysis (`git blame`
   * subprocesses), which always runs to completion once started.
   */
  signal?: AbortSignal

  /**
   * Optional logger for debug/info/warn/error messages. Defaults to a no-op.
   */
  logger?: ScanLogger

  /** @internal — undocumented escape hatch for cross-engine smoke testing */
  engine?: 'regex' | 'tree-sitter'

  /**
   * Explicit config to use. If undefined, scanRepo discovers .flagshark.yml
   * from cwd upward.
   */
  config?: FlagsharkConfig

  /**
   * Set true to skip auto-discovery of .flagshark.yml (used by --no-config).
   */
  noConfig?: boolean

  /**
   * Set true to skip .flagsharkignore discovery (used by --no-ignore-file).
   */
  noIgnoreFile?: boolean

  /**
   * When true, the result will include the list of excluded file paths.
   */
  collectExcludedPaths?: boolean
}

export interface ScanRepoResult {
  /** Total count of unique flag names detected across the repository. */
  totalFlags: number

  /** Number of source files actually read and analyzed. */
  filesScanned: number

  /**
   * Flags that tripped at least one staleness signal (age, low-usage, etc.).
   * One entry per stale flag occurrence; a single flag name may appear
   * multiple times if found in multiple locations.
   */
  staleFlags: StaleFlag[]

  /**
   * Unique provider identifiers detected (e.g., `launchdarkly-node-server-sdk`,
   * `posthog-node`). Order is undefined.
   */
  detectedProviders: string[]

  /** Map of language identifier (e.g. `typescript`, `go`) to file count. */
  languageBreakdown: Record<string, number>

  /**
   * 0–100. Calculated as `100 - round((unique stale names / totalFlags) * 100)`.
   * Returns 100 for repos with no flags detected.
   */
  healthScore: number

  /** Wall-clock duration of the scan in milliseconds. */
  scanDuration: number

  /** Number of files skipped due to exclude rules (paths, presets, .flagsharkignore). */
  excludedCount?: number

  /** Relative paths of excluded files. Only populated when collectExcludedPaths is true. */
  excludedPaths?: string[]

  /** Diagnostic — populated only when logger.debug level is active or callers explicitly opt in. */
  effectiveExcludes?: EffectiveRules
}

const NOOP_LOGGER: ScanLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export async function scanRepo(opts: ScanRepoOptions): Promise<ScanRepoResult> {
  const start = performance.now()
  const logger = opts.logger ?? NOOP_LOGGER

  const config =
    opts.config ??
    (opts.noConfig
      ? buildDefaultConfig()
      : (await loadConfigFile(opts.cwd))?.config ?? buildDefaultConfig())

  const threshold = opts.threshold ?? config.threshold ?? 6

  const ignoreFile = opts.noIgnoreFile ? null : await loadIgnoreFile(opts.cwd)

  const excluder = buildExcluder({
    config,
    ignoreFilePatterns: ignoreFile?.patterns ?? [],
  })

  logger.debug('Effective excludes', excluder.effectiveRules)

  const registry = opts.engine
    ? createRegistryWithEngine(opts.engine)
    : createDefaultRegistry()
  const supportedExtensions = new Set(registry.getSupportedExtensions())
  const analyzer = new PolyglotAnalyzer(registry, logger)

  logger.debug('Collecting files...')
  const { files, excludedCount, excludedPaths } = collectFiles({
    root: opts.cwd,
    supportedExtensions,
    diffRef: opts.diff,
    excluder,
    collectExcludedPaths: opts.collectExcludedPaths,
  })

  logger.debug(`Detected ${files.size} candidate files (excluded ${excludedCount})`)
  const filesScanned = files.size
  const analysisResult = await analyzer.analyzeFiles(files, opts.signal)

  const staleFlags = await analyzeStaleness(
    analysisResult.totalFlags,
    { thresholdMonths: threshold, repoRoot: opts.cwd },
  )

  const totalFlags = analysisResult.totalFlags.size
  const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size
  const healthScore =
    totalFlags === 0 ? 100 : Math.round(((totalFlags - uniqueStaleNames) / totalFlags) * 100)

  const allFlags: FeatureFlag[] = []
  for (const flags of analysisResult.totalFlags.values()) {
    allFlags.push(...flags)
  }
  const detectedProviders = [
    ...new Set(
      allFlags
        .map((f) => f.provider)
        .filter((p): p is string => p != null && p !== ''),
    ),
  ]

  return {
    totalFlags,
    filesScanned,
    staleFlags,
    detectedProviders,
    // analysisResult.languages is Map<Language, number> — convert to plain object
    languageBreakdown: Object.fromEntries(analysisResult.languages),
    healthScore,
    scanDuration: Math.round(performance.now() - start),
    excludedCount,
    excludedPaths,
    effectiveExcludes: excluder.effectiveRules,
  }
}
