/**
 * Top-level orchestrator: walk the repo, detect flags, analyse staleness,
 * return a single result object that consumers can render however they like.
 */

import { collectFiles } from './scanner.js'
import { createDefaultRegistry } from './detection/index.js'
import { PolyglotAnalyzer } from './detection/polyglot-analyzer.js'
import { analyzeStaleness } from './staleness.js'

import type { FeatureFlag } from './detection/feature-flag.js'
import type { StaleFlag } from './staleness.js'

export interface ScanLogger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface ScanRepoOptions {
  cwd: string
  threshold?: number
  diff?: string
  signal?: AbortSignal
  logger?: ScanLogger
}

export interface ScanRepoResult {
  totalFlags: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Record<string, number>
  healthScore: number
  scanDuration: number
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
  const threshold = opts.threshold ?? 6

  const registry = createDefaultRegistry()
  const supportedExtensions = new Set(registry.getSupportedExtensions())
  const analyzer = new PolyglotAnalyzer(registry, logger)

  logger.debug('Collecting files...')
  const files = collectFiles({
    root: opts.cwd,
    supportedExtensions,
    diffRef: opts.diff,
  })

  logger.debug(`Detected ${files.size} candidate files`)
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
    staleFlags,
    detectedProviders,
    // analysisResult.languages is Map<Language, number> — convert to plain object
    languageBreakdown: Object.fromEntries(analysisResult.languages),
    healthScore,
    scanDuration: Math.round(performance.now() - start),
  }
}
