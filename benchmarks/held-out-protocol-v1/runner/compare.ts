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

interface ComparisonTask {
  task_id: string
  scanner: {
    detections: ScannerDetection[]
    candidate_count: number
    cost_usd: number
  }
  ai: {
    predicted_flags: Array<{ name: string; filePath: string; lineNumber?: number; lineKnown: boolean; classification: string }>
    candidate_count: number
    abstentions: string[]
    cost_usd: number
  }
  overlap: ComparisonMatch[]
  location_uncertain: LocationUncertainMatch[]
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

function parseAiLocation(sourceRoot: string, location: string): { filePath: string; lineKnown: boolean; lineNumber?: number } {
  const [filePath, lineRange] = location.split(':')
  if (!lineRange) {
    return { filePath: prefixSourceRoot(sourceRoot, filePath), lineKnown: false }
  }
  const parsed = Number.parseInt(lineRange.split('-')[0] ?? '', 10)
  return {
    filePath: prefixSourceRoot(sourceRoot, filePath),
    lineNumber: Number.isFinite(parsed) ? parsed : undefined,
    lineKnown: Number.isFinite(parsed),
  }
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
        lineNumber: loc.lineNumber,
        lineKnown: loc.lineKnown,
        classification: flag.classification,
      }
    })

    const scannerMatches: ComparisonMatch[] = scannerTask.detections.map((detection) => ({
      name: detection.name,
      filePath: detection.filePath,
      lineNumber: detection.lineNumber,
      lineKnown: true,
    }))
    const aiMatches: ComparisonMatch[] = aiPredictedFlags.map((flag) => ({
      name: flag.name,
      filePath: flag.filePath,
      lineNumber: flag.lineNumber,
      lineKnown: flag.lineKnown,
    }))

    const aiByExact = new Map(aiMatches.filter((match) => match.lineKnown).map((item) => [keyOf(item), item]))
    const aiByNameAndFile = new Map(aiMatches.map((item) => [`${item.name}\u0000${item.filePath}`, item]))

    const overlap: ComparisonMatch[] = []
    const locationUncertain: LocationUncertainMatch[] = []
    const scannerOnly: ComparisonMatch[] = []
    const aiOnly: ComparisonMatch[] = []

    for (const scannerMatch of scannerMatches) {
      const exact = aiByExact.get(keyOf(scannerMatch))
      if (exact) {
        overlap.push(scannerMatch)
        continue
      }

      const sameNameFile = aiByNameAndFile.get(`${scannerMatch.name}\u0000${scannerMatch.filePath}`)
      if (sameNameFile && (!sameNameFile.lineKnown || !scannerMatch.lineKnown)) {
        locationUncertain.push({
          name: scannerMatch.name,
          filePath: scannerMatch.filePath,
          scannerLineKnown: scannerMatch.lineKnown,
          aiLineKnown: sameNameFile.lineKnown,
          scannerLineNumber: scannerMatch.lineNumber,
          aiLineNumber: sameNameFile.lineNumber,
        })
        continue
      }

      scannerOnly.push(scannerMatch)
    }

    const scannerSet = new Set(scannerMatches.map(keyOf))
    for (const match of aiMatches) {
      if (match.lineKnown && scannerSet.has(keyOf(match))) continue
      if (locationUncertain.some((item) => item.name === match.name && item.filePath === match.filePath)) continue
      aiOnly.push(match)
    }

    const nameMismatches: Array<{ scanner: ComparisonMatch; ai: ComparisonMatch }> = []
    const aiNames = new Map(aiMatches.map((match) => [match.name, match]))
    for (const scannerMatch of scannerMatches) {
      const aiMatch = aiNames.get(scannerMatch.name)
      if (aiMatch && scannerMatch.filePath === aiMatch.filePath && keyOf(scannerMatch) !== keyOf(aiMatch)) {
        nameMismatches.push({ scanner: scannerMatch, ai: aiMatch })
      }
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
      scanner_only: scannerOnly,
      ai_only: aiOnly,
      name_mismatches: nameMismatches,
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
