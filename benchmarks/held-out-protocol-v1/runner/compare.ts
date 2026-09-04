import { createHash } from 'node:crypto'
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

interface PredictedProviderState {
  task_partition: string
  source: string
  source_revision: string
  repo_snapshot_id: string
  source_manifest: string
  source_root: string
}

interface NormalizedAiTaskResult {
  task_id: string
  runner: string
  runtime_seconds: number
  token_usage: Record<string, number | null>
  validation_commands: string[]
  validation_results: string[]
  predicted_flags: PredictedFlag[]
  predicted_provider_state?: PredictedProviderState
  predicted_transform?: unknown
  evidence_citations?: string[]
  abstentions?: string[]
}

interface AiRunStatusProvenanceRecord {
  model: string
  provider: string
  date: string
  tool_versions: {
    model: string
    provider: string
    comparator: string
  }
  snapshot_id: string
  prompt: string
  prompt_template: string
  output_schema_version: string
}

interface AiRunStatusProvenance {
  model: string
  provider: string
  date: string
  tool_versions: {
    model: string
    provider: string
    comparator: string
  }
  snapshot_id: string
  prompt: string
  prompt_template: string
  prompt_hash: string
  output_schema_version: string
  recordBeforeRun: AiRunStatusProvenanceRecord[]
}

interface AiRunStatus {
  status: 'valid' | 'invalid'
  reason: string
  version: string
  provenance?: AiRunStatusProvenance
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
  status: 'valid' | 'invalid'
  status_reason: string
  status_version: string
  tasks: ComparisonTask[]
}

interface ManifestSourceFile {
  path: string
  sha256: string
}

interface SourceManifest {
  source: string
  commit: string
  files: ManifestSourceFile[]
}

interface BenchmarkManifestTask {
  task_id: string
  task_partition: string
  source: string
  source_revision: string
  repo_snapshot_id: string
  source_manifest: string
  source_root: string
}

interface BenchmarkManifest {
  benchmark: string
  version: string
  tasks: BenchmarkManifestTask[]
}

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const scannerIndexPath = resolve(benchmarkRoot, 'runner/results/index.json')
const statusPath = resolve(benchmarkRoot, 'runner/ai-results/status.json')
const aiIndexPath = resolve(benchmarkRoot, 'runner/ai-results/normalized.json')
const manifestPath = resolve(benchmarkRoot, 'manifest.json')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function loadAiRunStatus(): AiRunStatus {
  return readJson<AiRunStatus>(statusPath)
}

function normalizeAiPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\/projects\/flagshark\/flagshark\//, '')
}

function prefixSourceRoot(sourceRoot: string, filePath: string): string {
  const normalizedRoot = normalizeAiPath(sourceRoot).replace(/\/$/, '')
  const normalizedPath = normalizeAiPath(filePath).replace(/^\//, '')
  return normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath : `${normalizedRoot}/${normalizedPath}`
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
  if (rest.length === 0) {
    return { filePath: filePathWithRoot, lineKnown: false, ranges: [] }
  }
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function failInvalid(reason: string, status: AiRunStatus): ComparisonResult {
  const manifest = readJson<BenchmarkManifest>(manifestPath)
  return {
    benchmark: manifest.benchmark,
    benchmark_version: manifest.version,
    ai_runner: 'benchmark-local-ai/default',
    scanner_results: 'benchmarks/held-out-protocol-v1/runner/results/index.json',
    ai_results: 'benchmarks/held-out-protocol-v1/runner/ai-results/normalized.json',
    status: 'invalid',
    status_reason: reason,
    status_version: status.version,
    tasks: [],
  }
}

function validateAiRunStatus(status: AiRunStatus): string | null {
  if (status.status !== 'valid') return null
  const provenance = status.provenance
  if (!provenance) return 'valid status requires provenance'
  if (!provenance.model || !provenance.provider || !provenance.date) return 'valid status provenance requires model, provider, and date'
  if (!provenance.tool_versions?.model || !provenance.tool_versions?.provider || !provenance.tool_versions?.comparator) return 'valid status provenance requires tool version records'
  if (!provenance.snapshot_id) return 'valid status provenance requires snapshot_id'
  if (!provenance.prompt || !provenance.prompt_template) return 'valid status provenance requires prompt and prompt_template'
  if (!provenance.output_schema_version) return 'valid status provenance requires output_schema_version'
  if (!Array.isArray(provenance.recordBeforeRun) || provenance.recordBeforeRun.length === 0) return 'valid status provenance requires recordBeforeRun entries'
  if (provenance.prompt_hash !== sha256(provenance.prompt)) return 'valid status provenance prompt hash mismatch'
  for (const record of provenance.recordBeforeRun) {
    if (record.model !== provenance.model || record.provider !== provenance.provider || record.date !== provenance.date) return 'valid status provenance recordBeforeRun mismatch'
    if (record.tool_versions.model !== provenance.tool_versions.model || record.tool_versions.provider !== provenance.tool_versions.provider || record.tool_versions.comparator !== provenance.tool_versions.comparator) return 'valid status provenance recordBeforeRun tool version mismatch'
    if (record.snapshot_id !== provenance.snapshot_id) return 'valid status provenance recordBeforeRun snapshot mismatch'
    if (record.prompt !== provenance.prompt || record.prompt_template !== provenance.prompt_template) return 'valid status provenance recordBeforeRun prompt mismatch'
    if (record.output_schema_version !== provenance.output_schema_version) return 'valid status provenance recordBeforeRun output schema mismatch'
  }
  return null
}

function validateRowStructure(aiResults: NormalizedAiTaskResult[]): string | null {
  for (const row of aiResults) {
    if (!row.task_id) return 'normalized row missing task_id'
    if (!row.runner) return `normalized row ${row.task_id} missing runner`
    if (typeof row.runtime_seconds !== 'number' || row.runtime_seconds < 0) return `normalized row ${row.task_id} has invalid runtime_seconds`
    if (typeof row.token_usage !== 'object' || row.token_usage === null || Array.isArray(row.token_usage)) return `normalized row ${row.task_id} has invalid token_usage`
    if (!Array.isArray(row.validation_commands) || !Array.isArray(row.validation_results) || !Array.isArray(row.predicted_flags)) return `normalized row ${row.task_id} has invalid arrays`
    if (!row.predicted_provider_state) return `normalized row ${row.task_id} missing predicted_provider_state`
    const providerState = row.predicted_provider_state
    if (providerState.task_partition !== 'dev') return `normalized row ${row.task_id} must target dev`
    if (providerState.source !== 'msr-strudel-2020') return `normalized row ${row.task_id} must target msr-strudel-2020`
    if (!providerState.source_revision || !providerState.repo_snapshot_id || !providerState.source_manifest || !providerState.source_root) return `normalized row ${row.task_id} has incomplete provider state`
    for (const flag of row.predicted_flags) {
      if (!flag.name || !flag.location || !flag.classification) return `normalized row ${row.task_id} has incomplete predicted flag`
    }
  }
  return null
}

function validateAgainstManifest(manifest: BenchmarkManifest, aiResults: NormalizedAiTaskResult[]): string | null {
  const manifestByTaskId = new Map(manifest.tasks.map((task) => [task.task_id, task]))
  for (const row of aiResults) {
    const task = manifestByTaskId.get(row.task_id)
    if (!task) return `normalized row ${row.task_id} is missing from manifest`
    const providerState = row.predicted_provider_state
    if (!providerState) return `normalized row ${row.task_id} missing predicted_provider_state`
    if (task.partition !== 'dev') return `manifest task ${row.task_id} is not dev`
    if (task.source !== 'msr-strudel-2020') return `manifest task ${row.task_id} source mismatch`
    if (task.source_revision !== providerState.source_revision) return `source revision mismatch for ${row.task_id}`
    if (task.repo_snapshot_id !== providerState.repo_snapshot_id) return `repo snapshot mismatch for ${row.task_id}`
    if (task.config_files?.[0] !== providerState.source_manifest) return `source manifest mismatch for ${row.task_id}`
    if (providerState.source_root !== `tasks/dev/detection/sources/${row.task_id}`) return `source root mismatch for ${row.task_id}`
    if (!row.task_id.startsWith('dev-detection-msr-strudel-')) return `scanner task ${row.task_id} is not an MSR dev task`
  }
  return null
}

function validateSourceManifests(aiResults: NormalizedAiTaskResult[]): string | null {
  for (const row of aiResults) {
    const providerState = row.predicted_provider_state
    if (!providerState) return `normalized row ${row.task_id} missing predicted_provider_state`
    const sourceManifestPath = resolve(benchmarkRoot, providerState.source_manifest)
    const sourceManifest = readJson<SourceManifest>(sourceManifestPath)
    if (sourceManifest.source !== 'msr-strudel-2020') return `source manifest source mismatch for ${row.task_id}`
    if (sourceManifest.commit !== providerState.source_revision) return `source manifest commit mismatch for ${row.task_id}`
    for (const file of sourceManifest.files) {
      const filePath = resolve(benchmarkRoot, providerState.source_root, file.path)
      const fileHash = sha256(readFileSync(filePath, 'utf8'))
      if (fileHash !== file.sha256) return `source file checksum mismatch for ${row.task_id}:${file.path}`
    }
  }
  return null
}

function validateValidRun(status: AiRunStatus, aiResults: NormalizedAiTaskResult[]): string | null {
  const provenanceError = validateAiRunStatus(status)
  if (provenanceError) return provenanceError
  const rowError = validateRowStructure(aiResults)
  if (rowError) return rowError
  const manifest = readJson<BenchmarkManifest>(manifestPath)
  if (manifest.version !== status.version) return 'status version does not match benchmark manifest version'
  const manifestError = validateAgainstManifest(manifest, aiResults)
  if (manifestError) return manifestError
  const sourceError = validateSourceManifests(aiResults)
  if (sourceError) return sourceError
  if (status.provenance?.prompt_hash !== sha256(status.provenance.prompt)) return 'prompt hash mismatch'
  return null
}

export function compareResults(scannerResults: ScannerTaskResult[], aiResults: NormalizedAiTaskResult[], aiRunStatus: AiRunStatus): ComparisonResult {
  if (aiRunStatus.status === 'valid') {
    const validationError = validateValidRun(aiRunStatus, aiResults)
    if (validationError) return failInvalid(validationError, aiRunStatus)
  }

  const aiByTask = new Map(aiResults.map((task) => [task.task_id, task]))
  const tasks: ComparisonTask[] = []

  for (const scannerTask of scannerResults) {
    const aiTask = aiByTask.get(scannerTask.task_id)
    if (!aiTask) continue

    const providerState = aiTask.predicted_provider_state
    if (!providerState) return failInvalid(`missing predicted_provider_state for ${scannerTask.task_id}`, aiRunStatus)
    if (providerState.task_partition !== 'dev' || providerState.source !== 'msr-strudel-2020') return failInvalid(`provider state mismatch for ${scannerTask.task_id}`, aiRunStatus)
    if (providerState.source_manifest !== scannerTask.source_manifest || providerState.source_root !== scannerTask.source_root) return failInvalid(`scanner provider state mismatch for ${scannerTask.task_id}`, aiRunStatus)


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
        cost_usd: aiTask.runtime_seconds,
      },
      overlap,
      location_uncertain: locationUncertain,
      location_mismatches: locationMismatches,
      scanner_only: scannerOnly,
      ai_only: aiOnly,
      name_mismatches: [],
    })
  }

  const manifest = readJson<BenchmarkManifest>(manifestPath)
  return {
    benchmark: manifest.benchmark,
    benchmark_version: manifest.version,
    ai_runner: 'benchmark-local-ai/default',
    scanner_results: 'benchmarks/held-out-protocol-v1/runner/results/index.json',
    ai_results: 'benchmarks/held-out-protocol-v1/runner/ai-results/normalized.json',
    status: aiRunStatus.status,
    status_reason: aiRunStatus.reason,
    status_version: aiRunStatus.version,
    tasks,
  }
}

export function writeComparisonResult(outputPath: string): ComparisonResult {
  const result = compareResults(loadScannerResults(), loadAiResults(), loadAiRunStatus())
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (import.meta.main) {
  writeComparisonResult(resolve(benchmarkRoot, 'runner/comparison.json'))
}
