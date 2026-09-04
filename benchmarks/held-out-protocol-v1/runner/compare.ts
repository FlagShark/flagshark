import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

interface ScannerDetection {
  name: string
  filePath: string
  lineNumber: number
  language: string
  provider?: string
  confidence?: string
}

interface ScannerTaskResult {
  task_id: string
  benchmark_version: string
  cli_version: string
  source_root: string
  source_manifest: string
  command: string
  exit_code: number
  cost_usd: number
  cli_summary: {
    totalFlags: number
    staleFlags: number
    flags: ScannerDetection[]
    healthScore: number
    detectedProviders: string[]
    languages: Record<string, number>
    errorCount?: number
    parseErrorCount?: number
    excludedPermanent?: string[]
    permanentByPlatform?: Record<string, string[]>
  }
  detections: ScannerDetection[]
}

interface PredictedFlag {
  name: string
  location: string
  classification: string
  evidence_citations?: string[]
}

interface NormalizedAiTaskResult {
  task_id: string
  runner: string
  runtime_seconds?: number
  token_usage?: Record<string, unknown>
  validation_commands?: string[]
  validation_results?: unknown[]
  predicted_flags: PredictedFlag[]
  abstentions?: string[]
  cost_usd?: number
}
interface ParsedAiLocation {
  filePath: string
  lineKnown: boolean
  lineStart?: number
  lineEnd?: number
  ranges: Array<{ start: number; end: number }>
}

interface ComparisonMatch {
  name: string
  filePath: string
  lineNumber?: number
  lineKnown: boolean
}

interface LocationUncertainMatch {
  name: string
  filePath: string
  scannerLineKnown: boolean
  aiLineKnown: boolean
  scannerLineNumber?: number
  aiLineNumber?: number
}

interface LocationMismatchMatch {
  name: string
  filePath: string
  scannerLineNumber: number
  aiLineNumber?: number
  aiLineStart?: number
  aiLineEnd?: number
}

interface ComparisonTask {
  task_id: string
  scanner: {
    detections: ScannerDetection[]
    candidate_count: number
    cost_usd: number
  }
  ai: {
    predicted_flags: Array<{ name: string; filePath: string; lineKnown: boolean; lineStart?: number; lineEnd?: number; ranges: Array<{ start: number; end: number }>; classification: string }>
    candidate_count: number
    abstentions: string[]
    cost_usd: number
  }
  overlap: ComparisonMatch[]
  location_uncertain: LocationUncertainMatch[]
  location_mismatches: LocationMismatchMatch[]
  scanner_only: ComparisonMatch[]
  ai_only: ComparisonMatch[]
  name_mismatches: Array<{ scanner: ComparisonMatch; ai: ComparisonMatch }>
}

export interface ComparisonResult {
  benchmark: string
  benchmark_version: string
  ai_runner: string
  scanner_results: string
  ai_results: string
  tasks: ComparisonTask[]
}

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const scannerIndexPath = resolve(benchmarkRoot, 'runner/results/index.json')
const aiIndexPath = resolve(benchmarkRoot, 'runner/ai-results/normalized.json')
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function normalizeAiPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\/projects\/flagshark\/flagshark\//, '')
}

function prefixSourceRoot(sourceRoot: string, filePath: string): string {
  const normalizedRoot = normalizeAiPath(sourceRoot).replace(/\/$/, '')
  const normalizedPath = normalizeAiPath(filePath).replace(/^\//, '')
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath
  return `${normalizedRoot}/${normalizedPath}`
}


function parseRangeText(rangeText: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const segment of rangeText.split(',')) {
    const trimmed = segment.trim()
    if (trimmed.length === 0) continue
    const [startText, endText] = trimmed.split('-')
    const start = Number.parseInt(startText ?? '', 10)
    const end = Number.parseInt(endText ?? startText ?? '', 10)
    if (Number.isFinite(start) && Number.isFinite(end)) ranges.push({ start, end })
  }
  return ranges
}

function parseAiLocation(sourceRoot: string, location: string): ParsedAiLocation {
  const [filePath, ...rest] = location.split(':')
  const filePathWithRoot = prefixSourceRoot(sourceRoot, filePath)
  if (rest.length === 0) return { filePath: filePathWithRoot, lineKnown: false, ranges: [] }
  const ranges = parseRangeText(rest.join(':'))
  return {
    filePath: filePathWithRoot,
    lineKnown: ranges.length > 0,
    lineStart: ranges[0]?.start,
    lineEnd: ranges[0]?.end,
    ranges,
  }
}

function aiLocationContainsScannerLine(ai: ParsedAiLocation, scannerLineNumber: number): boolean {
  return ai.ranges.some((range) => scannerLineNumber >= range.start && scannerLineNumber <= range.end)
}

function keyOf(match: ComparisonMatch): string {
  return `${match.name}\u0000${match.filePath}\u0000${match.lineKnown ? match.lineNumber ?? '' : 'unknown'}`
}

function loadScannerResults(): ScannerTaskResult[] {
  return readJson<ScannerTaskResult[]>(scannerIndexPath)
}

function loadAiResults(): NormalizedAiTaskResult[] {
  return readJson<NormalizedAiTaskResult[]>(aiIndexPath)
}

export function compareResults(scannerResults: ScannerTaskResult[], aiResults: NormalizedAiTaskResult[]): ComparisonResult {
  const aiByTask = new Map(aiResults.map((task) => [task.task_id, task]))
  const tasks: ComparisonTask[] = []

  for (const scannerTask of scannerResults) {
    const aiTask = aiByTask.get(scannerTask.task_id)
    if (!aiTask) continue

    const aiPredictedFlags = aiTask.predicted_flags.map((flag) => {
      const loc = parseAiLocation(scannerTask.source_root, flag.location)
      return {
        name: flag.name,
        filePath: loc.filePath,
        lineKnown: loc.lineKnown,
        lineStart: loc.lineStart,
        lineEnd: loc.lineEnd,
        ranges: loc.ranges,
        classification: flag.classification,
      }
    })
    const scannerMatches: ComparisonMatch[] = scannerTask.detections.map((detection) => ({
      name: detection.name,
      filePath: detection.filePath,
      lineNumber: detection.lineNumber,
      lineKnown: true,
    }))

    const aiMatches: Array<ComparisonMatch & { lineStart?: number; lineEnd?: number; ranges: Array<{ start: number; end: number }> }> = aiPredictedFlags.map((flag) => ({
      name: flag.name,
      filePath: flag.filePath,
      lineNumber: flag.lineStart,
      lineKnown: flag.lineKnown,
      lineStart: flag.lineStart,
      lineEnd: flag.lineEnd,
      ranges: flag.ranges,
    }))

    const aiByExact = new Map(aiMatches.filter((match) => match.lineKnown && match.lineNumber !== undefined).map((item) => [keyOf(item), item]))
    const aiByNameAndFile = new Map(aiMatches.map((item) => [`${item.name}\u0000${item.filePath}`, item]))

    const overlap: ComparisonMatch[] = []
    const locationUncertain: LocationUncertainMatch[] = []
    const locationMismatches: LocationMismatchMatch[] = []
    const scannerOnly: ComparisonMatch[] = []
    const aiOnly: ComparisonMatch[] = []

    for (const scannerMatch of scannerMatches) {
      const exact = aiByExact.get(keyOf(scannerMatch))
      if (exact) {
        overlap.push(scannerMatch)
        continue
      }

      const sameNameFile = aiByNameAndFile.get(`${scannerMatch.name}\u0000${scannerMatch.filePath}`)
      if (sameNameFile) {
        const scannerInsideAiRange = sameNameFile.lineKnown && sameNameFile.lineStart !== undefined && sameNameFile.lineEnd !== undefined
          ? aiLocationContainsScannerLine(sameNameFile, scannerMatch.lineNumber ?? 0)
          : false
        if (scannerInsideAiRange) {
          overlap.push(scannerMatch)
          continue
        }
        if (!sameNameFile.lineKnown) {
          locationUncertain.push({
            name: scannerMatch.name,
            filePath: scannerMatch.filePath,
            scannerLineKnown: scannerMatch.lineKnown,
            aiLineKnown: sameNameFile.lineKnown,
            scannerLineNumber: scannerMatch.lineNumber,
          })
        } else if (!scannerMatch.lineKnown) {
          locationUncertain.push({
            name: scannerMatch.name,
            filePath: scannerMatch.filePath,
            scannerLineKnown: scannerMatch.lineKnown,
            aiLineKnown: sameNameFile.lineKnown,
            aiLineNumber: sameNameFile.lineNumber,
            aiLineStart: sameNameFile.lineStart,
            aiLineEnd: sameNameFile.lineEnd,
          })
        } else {
          locationMismatches.push({
            name: scannerMatch.name,
            filePath: scannerMatch.filePath,
            scannerLineNumber: scannerMatch.lineNumber ?? 0,
            aiLineNumber: sameNameFile.lineNumber,
            aiLineStart: sameNameFile.lineStart,
            aiLineEnd: sameNameFile.lineEnd,
          })
        }
        continue
      }

      scannerOnly.push(scannerMatch)
    }

    const scannerSet = new Set(scannerMatches.map(keyOf))
    for (const match of aiMatches) {
      if (match.lineKnown && match.lineNumber !== undefined && scannerSet.has(keyOf(match))) continue
      if (locationUncertain.some((item) => item.name === match.name && item.filePath === match.filePath)) continue
      if (locationMismatches.some((item) => item.name === match.name && item.filePath === match.filePath)) continue
      if (scannerMatches.some((scannerMatch) => scannerMatch.name === match.name && scannerMatch.filePath === match.filePath && aiLocationContainsScannerLine(match, scannerMatch.lineNumber))) continue
      aiOnly.push(match)
    }

    tasks.push({
      task_id: scannerTask.task_id,
      scanner: {
        detections: scannerTask.detections,
        candidate_count: scannerTask.detections.length,
        cost_usd: scannerTask.cost_usd,
      },
      ai: {
        predicted_flags: aiPredictedFlags,
        candidate_count: aiPredictedFlags.length,
        abstentions: aiTask.abstentions ?? [],
        cost_usd: aiTask.cost_usd ?? 0,
      },
      overlap,
      location_uncertain: locationUncertain,
      location_mismatches: locationMismatches,
      scanner_only: scannerOnly,
      ai_only: aiOnly,
      name_mismatches: [],
    })
  }

  return {
    benchmark: 'flagshark-held-out-technical-comparison',
    benchmark_version: scannerResults[0]?.benchmark_version ?? 'unknown',
    ai_runner: 'benchmark-local-ai/default',
    scanner_results: 'benchmarks/held-out-protocol-v1/runner/results/index.json',
    ai_results: 'benchmarks/held-out-protocol-v1/runner/ai-results/normalized.json',
    tasks,
  }
}

export function writeComparisonResult(outputPath: string): ComparisonResult {
  const result = compareResults(loadScannerResults(), loadAiResults())
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (import.meta.main) {
  writeComparisonResult(resolve(benchmarkRoot, 'runner/comparison.json'))
}
