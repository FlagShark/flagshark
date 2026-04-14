/**
 * Polyglot Analyzer -- multi-language feature flag detection coordinator.
 * Ported from Go: internal/processor/polyglot_analyzer.go
 *
 * This module coordinates analysis across multiple programming languages,
 * delegating to language-specific detectors registered in a language registry.
 */

import pLimit from 'p-limit'

import type { FeatureFlag } from './feature-flag.js'

const DEFAULT_WORKER_POOL_SIZE = 10

interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

// -- Language types --

export type Language = string

// -- Detector / Registry interfaces --

export interface FlagDetector {
  language(): Language
  detectFlags(filePath: string, content: string): Promise<FeatureFlag[]> | FeatureFlag[]
}

export interface LanguageRegistry {
  getDetectorForFile(filePath: string): FlagDetector | undefined
  getSupportedExtensions(): string[]
  getSupportedLanguages(): Language[]
}

// -- Analysis status --

export type FileAnalysisStatus = 'ok' | 'partial' | 'skipped' | 'unsupported'

export interface FileAnalysisResult {
  filePath: string
  language: Language
  flags: FeatureFlag[]
  parseErrors: Error[]
  status: FileAnalysisStatus
  skippedReason?: string
}

export interface RepositoryAnalysisResult {
  commitSha?: string
  files: Map<string, FileAnalysisResult>
  /** Map of flag name to all occurrences. */
  totalFlags: Map<string, FeatureFlag[]>
  /** Count of files per language. */
  languages: Map<Language, number>
  skippedFiles: string[]
  partialFiles: string[]
}

export type AnalysisProgressCallback = (analyzed: number, total: number) => void

// -- Max file size for analysis (5 MB) --
const MAX_FILE_SIZE = 5 * 1024 * 1024

// -- Analyzer --

export class PolyglotAnalyzer {
  private registry: LanguageRegistry
  private logger: Logger

  constructor(registry: LanguageRegistry, logger: Logger) {
    this.registry = registry
    this.logger = logger
  }

  /** Analyzes multiple files using appropriate language detectors. */
  async analyzeFiles(
    files: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<RepositoryAnalysisResult> {
    return this.analyzeFilesWithProgress(files, undefined, signal)
  }

  /** Analyzes multiple files with progress reporting. */
  async analyzeFilesWithProgress(
    files: Map<string, string>,
    progressCallback?: AnalysisProgressCallback,
    signal?: AbortSignal,
  ): Promise<RepositoryAnalysisResult> {
    const result: RepositoryAnalysisResult = {
      files: new Map(),
      totalFlags: new Map(),
      languages: new Map(),
      skippedFiles: [],
      partialFiles: [],
    }

    const workerPoolSize = Number(process.env.ANALYZER_WORKER_POOL_SIZE) || DEFAULT_WORKER_POOL_SIZE
    const limit = pLimit(workerPoolSize)

    this.logger.debug('Using analyzer worker pool size', {
      workerPoolSize,
      filesToAnalyze: files.size,
    })

    let filesAnalyzed = 0
    let filesWithFlags = 0
    let totalFlagsFound = 0
    let errorCount = 0
    let lastEmittedPercent = 0
    const totalFiles = files.size

    const tasks: Promise<void>[] = []

    for (const [filePath, content] of files) {
      if (signal?.aborted) {
        break
      }

      tasks.push(
        limit(async () => {
          if (signal?.aborted) {
            return
          }

          const fileResult = await this.analyzeFile(filePath, content)

          filesAnalyzed++

          result.files.set(filePath, fileResult)

          let flagsInFile = 0
          for (const flag of fileResult.flags) {
            flag.language = fileResult.language
            const existing = result.totalFlags.get(flag.name) ?? []
            existing.push(flag)
            result.totalFlags.set(flag.name, existing)
            flagsInFile++
            totalFlagsFound++
          }

          if (flagsInFile > 0) {
            filesWithFlags++
          }
          if (fileResult.parseErrors.length > 0) {
            errorCount++
          }

          if (fileResult.status === 'skipped') {
            result.skippedFiles.push(filePath)
          } else if (fileResult.status === 'partial') {
            result.partialFiles.push(filePath)
          }

          if (fileResult.language) {
            const count = result.languages.get(fileResult.language) ?? 0
            result.languages.set(fileResult.language, count + 1)
          }

          // Report progress every 5%
          if (progressCallback && totalFiles > 0) {
            const currentPercent = Math.floor((filesAnalyzed * 100) / totalFiles)
            const roundedPercent = Math.floor(currentPercent / 5) * 5
            if (roundedPercent > lastEmittedPercent || filesAnalyzed === totalFiles) {
              lastEmittedPercent = roundedPercent
              progressCallback(filesAnalyzed, totalFiles)
            }
          }
        }),
      )
    }

    await Promise.allSettled(tasks)

    if (totalFlagsFound > 0 || errorCount > 0) {
      this.logger.info('Polyglot analysis completed', {
        totalFiles: filesAnalyzed,
        filesWithFlags,
        totalFlagsFound,
        uniqueFlags: result.totalFlags.size,
        filesWithErrors: errorCount,
        languages: Object.fromEntries(result.languages),
      })
    }

    return result
  }

  /** Analyzes a single file using the appropriate language detector. */
  async analyzeSingleFile(filePath: string, content: string): Promise<FileAnalysisResult> {
    return this.analyzeFile(filePath, content)
  }

  /** Determines if a file should be analyzed based on language support. */
  shouldAnalyzeFile(filePath: string, status: string): boolean {
    if (status === 'removed') {
      return false
    }

    if (filePath.includes('/vendor/') || filePath.startsWith('vendor/')) {
      return false
    }
    if (filePath.includes('/node_modules/') || filePath.startsWith('node_modules/')) {
      return false
    }

    return !!this.registry.getDetectorForFile(filePath)
  }

  /** Returns all supported file extensions. */
  getSupportedExtensions(): string[] {
    return this.registry.getSupportedExtensions()
  }

  private async analyzeFile(filePath: string, content: string): Promise<FileAnalysisResult> {
    const result: FileAnalysisResult = {
      filePath,
      language: '',
      flags: [],
      parseErrors: [],
      status: 'ok',
    }

    if (!filePath) {
      result.parseErrors.push(new Error('empty file path'))
      result.status = 'skipped'
      result.skippedReason = 'empty file path'
      return result
    }

    if (content.length === 0) {
      return result
    }

    if (content.length > MAX_FILE_SIZE) {
      result.parseErrors.push(new Error(`file too large: ${content.length} bytes`))
      result.status = 'skipped'
      result.skippedReason = `file too large (${Math.floor(content.length / (1024 * 1024))} MB)`
      return result
    }

    const detector = this.registry.getDetectorForFile(filePath)
    if (!detector) {
      result.status = 'unsupported'
      return result
    }

    result.language = detector.language()

    try {
      const flags = await Promise.resolve(detector.detectFlags(filePath, content))
      result.flags = flags
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      result.parseErrors.push(error)

      if (error.message.includes('operation limit')) {
        result.status = 'skipped'
        result.skippedReason = 'file too complex for parsing'
      } else {
        result.status = 'partial'
      }
    }

    return result
  }
}

// -- Comparison helper --

export interface FlagOccurrence {
  name: string
  filePath: string
  lineNumber: number
  language: string
  provider?: string
}

export interface OccurrenceChange {
  flagName: string
  beforeCount: number
  afterCount: number
  addedIn: FlagOccurrence[]
  removedFrom: FlagOccurrence[]
}

export interface ComparisonResult {
  added: Map<string, FlagOccurrence[]>
  removed: Map<string, FlagOccurrence[]>
  occurrenceChanges: Map<string, OccurrenceChange>
}

/** Compares two analysis results to find flag changes. */
export function compareResults(
  before: RepositoryAnalysisResult,
  after: RepositoryAnalysisResult,
): ComparisonResult {
  const comparison: ComparisonResult = {
    added: new Map(),
    removed: new Map(),
    occurrenceChanges: new Map(),
  }

  const allFlags = new Set<string>()
  for (const name of before.totalFlags.keys()) {
    allFlags.add(name)
  }
  for (const name of after.totalFlags.keys()) {
    allFlags.add(name)
  }

  for (const flagName of allFlags) {
    const beforeOccurrences = before.totalFlags.get(flagName) ?? []
    const afterOccurrences = after.totalFlags.get(flagName) ?? []

    if (beforeOccurrences.length === 0 && afterOccurrences.length > 0) {
      comparison.added.set(flagName, toOccurrences(afterOccurrences))
    } else if (beforeOccurrences.length > 0 && afterOccurrences.length === 0) {
      comparison.removed.set(flagName, toOccurrences(beforeOccurrences))
    } else if (beforeOccurrences.length !== afterOccurrences.length) {
      comparison.occurrenceChanges.set(flagName, {
        flagName,
        beforeCount: beforeOccurrences.length,
        afterCount: afterOccurrences.length,
        addedIn: findNewOccurrences(beforeOccurrences, afterOccurrences),
        removedFrom: findRemovedOccurrences(beforeOccurrences, afterOccurrences),
      })
    }
  }

  return comparison
}

function toOccurrences(flags: FeatureFlag[]): FlagOccurrence[] {
  return flags.map((f) => ({
    name: f.name,
    filePath: f.filePath,
    lineNumber: f.lineNumber,
    language: f.language,
    provider: f.provider,
  }))
}

function flagKey(f: FeatureFlag): string {
  return `${f.filePath}:${f.lineNumber}:${f.name}`
}

function findNewOccurrences(before: FeatureFlag[], after: FeatureFlag[]): FlagOccurrence[] {
  const existing = new Set(before.map(flagKey))
  return after
    .filter((f) => !existing.has(flagKey(f)))
    .map((f) => ({
      name: f.name,
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      language: f.language,
      provider: f.provider,
    }))
}

function findRemovedOccurrences(before: FeatureFlag[], after: FeatureFlag[]): FlagOccurrence[] {
  const remaining = new Set(after.map(flagKey))
  return before
    .filter((f) => !remaining.has(flagKey(f)))
    .map((f) => ({
      name: f.name,
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      language: f.language,
      provider: f.provider,
    }))
}
