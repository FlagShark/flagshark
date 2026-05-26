/**
 * Top-level orchestrator: walk the repo, detect flags, analyse staleness,
 * return a single result object that consumers can render however they like.
 */

import { collectFiles } from './scanner.js'
import { createDefaultRegistry, createRegistryWithEngine } from './detection/index.js'
import { buildImportGraph, isScannedSourceFile, loadTsconfigAliases } from './detection/import-graph.js'
import { Languages, getImportPattern } from './detection/interface.js'
import { PolyglotAnalyzer } from './detection/polyglot-analyzer.js'
import { analyzeStaleness } from './staleness.js'
import { buildDefaultConfig } from './config/defaults.js'
import { buildExcluder } from './config/excluder.js'
import { loadConfigFile } from './config/loader.js'
import { loadIgnoreFile } from './config/ignore-file.js'
import { orchestratePlatforms } from './providers/orchestrate.js'

import type { FeatureFlag } from './detection/feature-flag.js'
import type { LanguageRegistry } from './detection/registry.js'
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
   * Staleness threshold in days. A flag is considered stale if its
   * git-blame age exceeds this value. Default: 30.
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

  /** When true, bypass platform cache for this run. */
  noCache?: boolean
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

  /**
   * Count of files where the detector raised at least one parse error
   * (i.e. the file was scanned but the tree-sitter/regex pass bailed). Mirrors
   * `RepositoryAnalysisResult.parseErrorCount` and is exposed here so output
   * formatters (text, json, markdown) can tell the user up front when a
   * non-trivial slice of their code couldn't be analysed. Optional for
   * backward compatibility with test fixtures and external callers that
   * construct ScanRepoResult by hand; treat absent as `0`.
   */
  parseErrorCount?: number

  /**
   * Flag names that were detected in code AND found in a platform but
   * marked as permanent (LD's `temporary: false`, or equivalent on other
   * platforms). These are filtered out of `staleFlags` because they're
   * intentionally long-lived; surfacing them here lets output formatters
   * show users WHY a flag they expected to see in the table isn't there.
   * Empty array (not undefined) when no platforms are configured or no
   * matches were permanent. Per-platform breakdown lives in the
   * `permanentByPlatform` field below.
   */
  excludedPermanent?: string[]

  /**
   * Per-platform breakdown of `excludedPermanent`. Keyed by the
   * platform's displayName (e.g. 'LaunchDarkly'). Lets the output
   * formatter print 'X flags excluded as permanent in LaunchDarkly'
   * (not just 'in some platform somewhere').
   */
  permanentByPlatform?: Record<string, string[]>

  /** Diagnostic — populated only when logger.debug level is active or callers explicitly opt in. */
  effectiveExcludes?: EffectiveRules
}

const NOOP: (...args: unknown[]) => void = () => {}
const NOOP_LOGGER: ScanLogger = {
  debug: NOOP,
  info: NOOP,
  warn: NOOP,
  error: NOOP,
}

export async function scanRepo(opts: ScanRepoOptions): Promise<ScanRepoResult> {
  const start = performance.now()
  const logger = opts.logger ?? NOOP_LOGGER

  const config =
    opts.config ??
    (opts.noConfig
      ? buildDefaultConfig()
      : (await loadConfigFile(opts.cwd))?.config ?? buildDefaultConfig())

  const threshold = opts.threshold ?? config.threshold

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

  // Wrapper-aware detection: build the TS/JS import graph and "lift" the SDK
  // gate for any file that transitively reaches a known SDK through 1-N hops
  // of relative imports. We do this by appending a single-line comment to
  // the file content that mentions every reachable SDK pattern; the per-
  // provider import gate (a substring check in helpers.ts / engine.ts) then
  // passes for wrapper-consumer files. Appending to the END of content keeps
  // every flag's line number correct.
  //
  // Direct importers already pass the gate, so the appended marker is a
  // no-op for them. Files with no SDK reach are untouched.
  //
  // Why scan-repo.ts and not PolyglotAnalyzer: PolyglotAnalyzer is a generic
  // multi-language coordinator. The graph is TS/JS-only and SDK-aware; that
  // knowledge lives at the orchestrator layer where we also know the registry.
  const tsJsSdkPatterns = collectSdkPatterns(registry)
  const filesForAnalysis = augmentForWrapperDetection(files, tsJsSdkPatterns, logger, opts.cwd)

  const analysisResult = await analyzer.analyzeFiles(filesForAnalysis, opts.signal)

  // B3: user-configured custom detectors (struct-field-access only today).
  // Layered on top of the standard detection so it never reduces recall,
  // only adds matches — typically for codebases whose flag system bypasses
  // the SDK model entirely (e.g. Mattermost's typed Config().FeatureFlags.X).
  // Detected flags are tagged confidence: 'low' so cleanup pipelines route
  // them to manual review rather than auto-merge.
  if (config.custom_detectors && config.custom_detectors.length > 0) {
    applyCustomDetectors(files, config.custom_detectors, analysisResult.totalFlags, logger)
  }

  const {
    signals: platformSignals,
    permanentByPlatform,
    metadataByFlag,
    environmentsByFlag,
  } = await orchestratePlatforms({
    platformsConfig: config.platforms as Record<string, unknown> | undefined,
    detectedFlags: analysisResult.totalFlags,
    logger,
    noCache: opts.noCache,
    signal: opts.signal,
    // Threshold drives the platform-too-old signal in cross-reference.
    // Same threshold the staleness engine uses for code-age, so the two
    // dimensions stay aligned ("if code older than N is stale, so is a
    // platform record older than N").
    thresholdDays: threshold,
  })

  const staleFlags = await analyzeStaleness(
    analysisResult.totalFlags,
    {
      thresholdDays: threshold,
      repoRoot: opts.cwd,
      platformSignals,
      platformMetadata: metadataByFlag,
      platformEnvironments: environmentsByFlag,  // NEW
    },
  )

  // Flatten the per-platform breakdown into a single sorted, deduplicated
  // list so callers that only want "did anything get excluded?" don't
  // have to walk the platform record themselves. The per-platform record
  // is retained for output formatters that want to attribute correctly.
  const excludedPermanent = Array.from(
    new Set(Object.values(permanentByPlatform).flat()),
  ).sort()

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

  const scanDuration = Math.round(performance.now() - start)

  // Structured metric line — one per scan, info-level. Same shape as the
  // SaaS-side piranha_metric events so a single dashboard can join them.
  // CloudWatch Logs Insights query: `filter event="flagshark_scan_complete"`.
  // Off by default at debug-only loggers (e.g. the no-op logger used in
  // tests); info-level loggers (CLI, Action) surface them.
  logger.info('flagshark_scan_complete', {
    event: 'flagshark_scan_complete',
    durationMs: scanDuration,
    filesScanned,
    // Defensive ?? 0 fallbacks: collectFiles always returns excludedCount as
    // a number and PolyglotAnalyzer always populates parseErrorCount, so the
    // RHS of these expressions is unreachable today — kept for type safety
    // against future refactors.
    /* v8 ignore next 2 */
    excludedCount: excludedCount ?? 0,
    parseErrorCount: analysisResult.parseErrorCount ?? 0,
    totalFlags,
    staleFlags: uniqueStaleNames,
    healthScore,
    detectedProviders: detectedProviders.length,
    languages: Object.keys(analysisResult.languages).length,
    detectionEngine: opts.engine ?? 'regex',
  })

  return {
    totalFlags,
    filesScanned,
    staleFlags,
    detectedProviders,
    // analysisResult.languages is Map<Language, number> — convert to plain object
    languageBreakdown: Object.fromEntries(analysisResult.languages),
    healthScore,
    scanDuration,
    excludedCount,
    excludedPaths,
    parseErrorCount: analysisResult.parseErrorCount,
    excludedPermanent,
    permanentByPlatform,
    effectiveExcludes: excluder.effectiveRules,
  }
}

// -- Wrapper-aware detection helpers ------------------------------------------

/**
 * Pulls every `importPattern` string registered on the language detectors
 * the import graph supports today (TS/JS + Python). These are the seed
 * packages for the graph — a file is "in SDK scope" iff its imports reach
 * one of these via 1-N hops of relative imports.
 *
 * We pull TS/JS and Python together because the seed list is matched
 * substring-style on each spec and both languages share the same matching
 * surface inside the graph. Python-only seeds (`posthog`, `ldclient`) and
 * TS-only seeds (`@launchdarkly/node-server-sdk`) never collide because
 * their syntactic shapes are different.
 */
function collectSdkPatterns(registry: LanguageRegistry): string[] {
  const patterns = new Set<string>()
  for (const lang of [Languages.TypeScript, Languages.JavaScript, Languages.Python]) {
    const detector = registry.getDetector(lang)
    // Defensive skip: the default registry always populates TS/JS/Python
    // detectors. Custom engines could theoretically omit one, hence the guard.
    /* v8 ignore next */
    if (!detector) continue
    for (const provider of detector.getProviders()) {
      const pat = getImportPattern(provider)
      if (pat) patterns.add(pat)
    }
  }
  return [...patterns]
}

/**
 * Marker comment appended to TS/JS files that transitively reach an SDK. The
 * existing per-provider import gate is a `content.includes(importPat)` check;
 * mentioning the SDK pattern in this comment satisfies the gate without
 * touching the detector interface or shifting any line numbers (the marker
 * goes at end-of-file, after the last line of real code).
 *
 * The marker text is recognisable so an operator inspecting an instrumented
 * file or a debug log can tell the difference between a real import and our
 * post-hoc marker.
 */
const WRAPPER_MARKER_PREFIX = '// flagshark-internal: transitively reaches'

/**
 * Same marker semantics but in Python comment syntax (`#`). When wrapper
 * augmentation extended to .py files (B4), appending a `//` line would
 * make the file unparseable — Python doesn't have `//` comments. The
 * detector's import-gate is a substring `content.includes(importPat)`
 * check that doesn't care WHICH comment syntax wraps the SDK pattern,
 * so language-appropriate markers work transparently.
 */
const WRAPPER_MARKER_PREFIX_PYTHON = '# flagshark-internal: transitively reaches'

/**
 * Returns a new Map<filePath, content> where TS/JS files with transitive SDK
 * reach have a single comment line appended that mentions each reachable SDK
 * pattern. Returns the original Map unchanged if no SDK seeds exist (e.g.
 * registry was constructed without TS/JS detectors).
 *
 * Non-TS/JS files are passed through untouched.
 */
function augmentForWrapperDetection(
  files: Map<string, string>,
  tsJsSdkPatterns: string[],
  logger: ScanLogger,
  cwd: string,
): Map<string, string> {
  // Defensive early-return: every default registry contributes at least
  // one SDK pattern, so this branch only fires for hand-built empty
  // registries — not reachable from public scan paths.
  /* v8 ignore next */
  if (tsJsSdkPatterns.length === 0) return files

  // Load tsconfig path aliases from the scan root, then pass them to the
  // graph builder. Most TS monorepos use `@/foo`-style aliases; without
  // this, the transitive wrapper detection stops at every aliased
  // boundary and under-counts. Falls back gracefully — `loadTsconfigAliases`
  // returns null when there's no tsconfig or no aliases declared, in which
  // case the graph behaves exactly as before.
  const aliases = loadTsconfigAliases(cwd)
  if (aliases) {
    logger.debug('tsconfig path aliases loaded', {
      baseUrl: aliases.baseUrl,
      aliasCount: aliases.paths.size,
    })
  }

  const graph = buildImportGraph(files, {
    seedSdkPatterns: tsJsSdkPatterns,
    // Polyglot scope — graph now walks TS/JS *and* Python wrappers so a
    // Python consumer file that does `from .feature_flags import is_enabled`
    // (where feature_flags.py imports `posthog`) is in scope. The option
    // name is legacy from when TS/JS was the only surface; the helper
    // returns true for .py files too. See B4 in the bug inventory.
    isTsJs: isScannedSourceFile,
    aliases: aliases ?? undefined,
  })

  logger.debug('Import graph built', graph.stats)

  // No transitive reach (seeds didn't propagate beyond themselves, or no seeds
  // at all) -> return the original map. Avoids a wasted clone on repos that
  // don't use any flag SDK.
  if (graph.stats.inScopeFiles === 0) {
    return files
  }

  const augmented = new Map<string, string>()
  let augmentedCount = 0

  for (const [filePath, content] of files) {
    const sdks = graph.transitiveSdks.get(filePath)
    if (!sdks || sdks.size === 0) {
      augmented.set(filePath, content)
      continue
    }
    // Append at end-of-file with a leading newline so we never glue onto a
    // partial last line. Sorting the SDK list keeps the marker deterministic
    // across runs (useful when diffing logs). Use Python comment syntax for
    // .py files; the substring-based import gate doesn't care which prefix
    // wraps the SDK pattern, so language-appropriate markers stay parseable.
    const sdkList = [...sdks].sort().join(' ')
    const prefix = filePath.toLowerCase().endsWith('.py')
      ? WRAPPER_MARKER_PREFIX_PYTHON
      : WRAPPER_MARKER_PREFIX
    augmented.set(filePath, `${content}\n${prefix} ${sdkList}\n`)
    augmentedCount++
  }

  logger.debug(`Wrapper-aware detection augmented ${augmentedCount} files`)
  return augmented
}

// -- Custom detector application (B3) -----------------------------------------

/**
 * File extensions per language, for routing custom detectors to the right
 * files. Kept in sync with the language detector registry; we duplicate
 * the table here rather than pulling from the registry because the
 * registry is awareness-of-detector, not awareness-of-extensions, and
 * the registry's API is method-call-shaped (asks "do you support this
 * file" per detector) rather than data-shaped.
 */
const LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
  go: ['.go'],
  python: ['.py', '.pyx', '.pyi'],
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  java: ['.java'],
  kotlin: ['.kt', '.kts'],
  swift: ['.swift'],
  ruby: ['.rb'],
  csharp: ['.cs'],
  php: ['.php'],
  rust: ['.rs'],
  cpp: ['.c', '.cc', '.cpp', '.h', '.hpp'],
  objc: ['.m', '.mm'],
}

/**
 * Runs each configured custom detector over the appropriate file subset
 * and adds matches to `totalFlags`. Mutates the map in place — same shape
 * as the polyglot analyzer's output, so downstream staleness + JSON
 * surfacing pick the new flags up without further wiring.
 *
 * Each match becomes a FeatureFlag with `confidence: 'low'` to signal
 * that the detection came from a user-declared regex rather than a
 * disciplined SDK gate. The legacy `'high'`/`'medium'` flags from the
 * standard detector are left untouched.
 */
function applyCustomDetectors(
  files: Map<string, string>,
  detectors: ReadonlyArray<{
    type: 'struct-field-access'
    language: string
    access_pattern: string
    name?: string
  }>,
  totalFlags: Map<string, FeatureFlag[]>,
  logger: ScanLogger,
): void {
  for (const detector of detectors) {
    let regex: RegExp
    try {
      regex = new RegExp(detector.access_pattern, 'g')
    } catch (err) {
      logger.warn(`custom_detector regex failed to compile`, {
        access_pattern: detector.access_pattern,
        /* v8 ignore next */
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const allowedExts = LANGUAGE_EXTENSIONS[detector.language] ?? []
    if (allowedExts.length === 0) {
      logger.warn(`custom_detector skipped — unknown language`, {
        language: detector.language,
      })
      continue
    }

    const providerName = detector.name ?? 'Custom struct-field detector'
    let matchCount = 0

    for (const [filePath, content] of files) {
      const lower = filePath.toLowerCase()
      if (!allowedExts.some((ext) => lower.endsWith(ext))) continue

      // Walk every match in the file. Each must capture exactly one
      // group (the flag name) — schemas validated at load time, but we
      // defensively skip captureless matches at runtime too.
      regex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = regex.exec(content)) !== null) {
        const flagName = m[1]
        /* v8 ignore next */
        if (!flagName) continue
        // Resolve line number from the match offset. Cheap: count
        // newlines up to the match. Files are typically <10k lines so
        // O(n) per match is fine.
        const lineNumber = content.slice(0, m.index).split('\n').length

        const existing = totalFlags.get(flagName) ?? []
        existing.push({
          name: flagName,
          filePath,
          lineNumber,
          language: detector.language,
          provider: providerName,
          confidence: 'low',
        })
        totalFlags.set(flagName, existing)
        matchCount++
      }
    }

    if (matchCount > 0) {
      logger.debug(`custom_detector matched`, {
        language: detector.language,
        matchCount,
        provider: providerName,
      })
    }
  }
}
