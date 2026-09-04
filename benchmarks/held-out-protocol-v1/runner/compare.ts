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
  task_partition?: string
  source?: string
  source_revision?: string
  repo_snapshot_id?: string
  model: string
  provider: string
  model_version: string
  prompt_hash: string
  source_manifest: string
  source_root: string
}

interface NormalizedAiTaskResult {
  task_id: string
  runner: string
  runtime_seconds: number
  cost_usd?: number
  token_usage: Record<string, number | null>
  validation_commands: string[]
  validation_results: string[]
  predicted_flags: PredictedFlag[]
  predicted_provider_state?: PredictedProviderState
  predicted_transform?: unknown
  evidence_citations?: string[]
  abstentions?: string[]
}

interface AiRunConfig {
  benchmark: string
  version: string
  model: string
  provider: string
  model_version: string
  selection_rationale?: string
  prompt: string
  prompt_template: string
  prompt_hash: string
  output_schema_version: string
  benchmark_version: string
  tool_versions: { comparator: string; cli: string }
  recordBeforeRun: string[]
  constraints: { noNetwork: boolean; noCustomerData: boolean; noFlagSharkInternals: boolean; singleFreshRunPerTask: boolean; noRetries: boolean; freezeBeforeRun: boolean }
  inputs: { allowedSources: string[]; devSourcesOnly: string[]; heldOutSources: string[] }
}

interface AiRunProvenanceRecord {
  task_id: string
  model: string
  provider: string
  model_version: string
  date: string
  tool_versions: { comparator: string; cli: string }
  snapshot_id: string
  prompt: string
  prompt_template: string
  prompt_hash: string
  output_schema_version: string
  recordBeforeRun: string[]
}

interface AiRunProvenance {
  config_version: string
  tasks: AiRunProvenanceRecord[]
}

interface AiRunStatus {
  status: 'valid' | 'invalid'
  reason: string
  version: string
  provenance?: AiRunProvenance
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
  aiLineStart?: number
  aiLineEnd?: number
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
  scanner: { detections: ScannerDetection[]; candidate_count: number; cost_usd: number }
  ai: { predicted_flags: Array<{ name: string; filePath: string; lineKnown: boolean; lineStart?: number; lineEnd?: number; ranges: Array<{ start: number; end: number }>; classification: string }>; candidate_count: number; abstentions: string[]; cost_usd: number }
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

interface ManifestFile { path: string; sha256: string }
interface SourceManifest { source: string; commit: string; files: ManifestFile[] }
interface BenchmarkManifestTask { task_id: string; source: string; source_revision: string; repo_snapshot_id: string; task_type: string; partition: string; provider?: string; files: string[]; config_files: string[] }
interface BenchmarkManifest { benchmark: string; version: string; artifactChecksums: Record<string, string>; tasks: BenchmarkManifestTask[] }

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const scannerIndexPath = resolve(benchmarkRoot, 'runner/results/index.json')
const statusPath = resolve(benchmarkRoot, 'runner/ai-results/status.json')
const aiIndexPath = resolve(benchmarkRoot, 'runner/ai-results/normalized.json')
const aiRunConfigPath = resolve(benchmarkRoot, 'ai-run-config.json')
const manifestPath = resolve(benchmarkRoot, 'manifest.json')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
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
  if (rest.length === 0) return { filePath: filePathWithRoot, lineKnown: false, ranges: [] }
  const ranges = parseRangeText(rest.join(':'))
  return { filePath: filePathWithRoot, lineKnown: ranges.length > 0, lineStart: ranges[0]?.start, lineEnd: ranges[0]?.end, ranges }
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

function loadAiRunConfig(): AiRunConfig {
  return readJson<AiRunConfig>(aiRunConfigPath)
}

function loadAiRunStatus(): AiRunStatus {
  return readJson<AiRunStatus>(statusPath)
}

function readSourceManifest(manifestRelativePath: string): SourceManifest {
  return readJson<SourceManifest>(resolve(benchmarkRoot, manifestRelativePath))
}

function readSourceFileChecksum(sourceRoot: string, filePath: string): string {
  return sha256(readFileSync(resolve(benchmarkRoot, sourceRoot, filePath), 'utf8'))
}

function isIsoLikeDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-Z]+)?$/.test(value)
}

function compareStringArray(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) return false
  }
  return true
}

function failInvalid(reason: string, status: AiRunStatus): ComparisonResult {
  const manifest = readJson<BenchmarkManifest>(manifestPath)
  return { benchmark: manifest.benchmark, benchmark_version: manifest.version, ai_runner: 'benchmark-local-ai/default', scanner_results: 'benchmarks/held-out-protocol-v1/runner/results/index.json', ai_results: 'benchmarks/held-out-protocol-v1/runner/ai-results/normalized.json', status: 'invalid', status_reason: reason, status_version: status.version, tasks: [] }
}

function validateValidRun(status: AiRunStatus, config: AiRunConfig, manifest: BenchmarkManifest, scannerResults: ScannerTaskResult[], aiResults: NormalizedAiTaskResult[]): string | null {
  if (status.status !== 'valid') return null
  if (!status.provenance) return 'valid status requires provenance'
  if (status.version !== manifest.version) return 'status version must match manifest version'
  const provenance = status.provenance
  if (provenance.config_version !== config.version) return 'status provenance config version mismatch'
  const manifestTaskById = new Map(manifest.tasks.map((task) => [task.task_id, task]))
  const expectedDevDetectionTasks = manifest.tasks.filter((task) => task.task_type === 'detection' && task.partition === 'dev' && task.source === 'msr-strudel-2020')
  const expectedDevDetectionIds = expectedDevDetectionTasks.map((task) => task.task_id)
  const scannerTaskIds = scannerResults.map((row) => row.task_id)
  const aiTaskIds = aiResults.map((row) => row.task_id)
  if (!compareStringArray([...expectedDevDetectionIds].sort(), [...scannerTaskIds].sort())) return 'scanner task set does not match dev msr detection manifest set'
  if (!compareStringArray([...expectedDevDetectionIds].sort(), [...aiTaskIds].sort())) return 'normalized task set does not match dev msr detection manifest set'
  if (!Array.isArray(provenance.tasks) || provenance.tasks.length !== expectedDevDetectionIds.length) return 'status provenance must include per-task records'
  const provenanceByTaskId = new Map(provenance.tasks.map((record) => [record.task_id, record]))
  if (!compareStringArray([...expectedDevDetectionIds].sort(), [...provenanceByTaskId.keys()].sort())) return 'status provenance task_id set must exactly match dev msr detection manifest set'

  for (const scannerTask of scannerResults) {
    if (scannerTask.exit_code !== 0) return `scanner task ${scannerTask.task_id} exit_code must be 0`
    if (scannerTask.benchmark_version !== manifest.version) return `scanner task ${scannerTask.task_id} benchmark_version mismatch`
    const task = manifestTaskById.get(scannerTask.task_id)
    if (!task) return `scanner task ${scannerTask.task_id} missing manifest task`
    if (task.task_type !== 'detection' || task.partition !== 'dev' || task.source !== 'msr-strudel-2020') return `scanner task ${scannerTask.task_id} is not dev msr detection`
    if (scannerTask.source_root !== `tasks/dev/detection/sources/${scannerTask.task_id}`) return `scanner task ${scannerTask.task_id} source_root mismatch`
    if (scannerTask.source_manifest !== task.config_files[0]) return `scanner task ${scannerTask.task_id} source_manifest mismatch`
  }

  for (const expectedTask of expectedDevDetectionTasks) {
    const record = provenanceByTaskId.get(expectedTask.task_id)
    if (!record) return `status provenance missing task record for ${expectedTask.task_id}`
    if (record.model !== config.model || record.provider !== config.provider || record.model_version !== config.model_version) return `status provenance model/provider/version mismatch for ${expectedTask.task_id}`
    if (!isIsoLikeDate(record.date)) return `status provenance date must be ISO-like for ${expectedTask.task_id}`
    if (!compareStringArray([record.tool_versions.comparator, record.tool_versions.cli], [config.tool_versions.comparator, config.tool_versions.cli])) return `status provenance tool version mismatch for ${expectedTask.task_id}`
    if (record.snapshot_id !== expectedTask.repo_snapshot_id) return `status provenance snapshot_id mismatch for ${expectedTask.task_id}`
    if (record.prompt !== config.prompt || record.prompt_template !== config.prompt_template || record.prompt_hash !== config.prompt_hash) return `status provenance prompt mismatch for ${expectedTask.task_id}`
    if (record.output_schema_version !== config.output_schema_version) return `status provenance output schema version mismatch for ${expectedTask.task_id}`
    if (!compareStringArray(record.recordBeforeRun, config.recordBeforeRun)) return `status provenance recordBeforeRun mismatch for ${expectedTask.task_id}`
  }

  for (const row of aiResults) {
    if (!row.task_id || !row.runner) return `normalized row ${row.task_id || '<missing>'} has invalid identifiers`
    if (!Number.isFinite(row.runtime_seconds) || row.runtime_seconds < 0) return `normalized row ${row.task_id} has invalid runtime_seconds`
    if (typeof row.token_usage !== 'object' || row.token_usage === null || Array.isArray(row.token_usage)) return `normalized row ${row.task_id} has invalid token_usage`
    for (const value of Object.values(row.token_usage)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `normalized row ${row.task_id} has invalid token_usage values`
    }
    if (!Array.isArray(row.validation_commands) || row.validation_commands.some((command) => typeof command !== 'string' || command.length === 0)) return `normalized row ${row.task_id} has invalid validation_commands`
    if (!Array.isArray(row.validation_results)) return `normalized row ${row.task_id} has invalid validation_results`
    if (!Array.isArray(row.predicted_flags)) return `normalized row ${row.task_id} has invalid predicted_flags`
    if (!row.predicted_provider_state) return `normalized row ${row.task_id} missing predicted_provider_state`

    const task = manifestTaskById.get(row.task_id)
    if (!task) return `normalized row ${row.task_id} missing manifest task`
    if (task.task_type !== 'detection' || task.partition !== 'dev' || task.source !== 'msr-strudel-2020') return `manifest task ${row.task_id} is not dev msr detection`
    if (task.config_files.length === 0) return `manifest task ${row.task_id} missing config_files`
    if (task.config_files[0] !== `tasks/dev/detection/sources/${task.task_id}/source-manifest.json`) return `manifest task ${row.task_id} has unexpected config file`

    const providerState = row.predicted_provider_state
    const provenanceRecord = provenanceByTaskId.get(row.task_id)
    if (!provenanceRecord) return `status provenance missing task record for ${row.task_id}`
    if (providerState.task_partition !== task.partition || providerState.source !== task.source || providerState.source_revision !== task.source_revision || providerState.repo_snapshot_id !== provenanceRecord.snapshot_id) return `provider state mismatch for ${row.task_id}`
    if (providerState.model !== provenanceRecord.model || providerState.provider !== provenanceRecord.provider || providerState.model_version !== provenanceRecord.model_version || providerState.prompt_hash !== provenanceRecord.prompt_hash) return `provider model provenance mismatch for ${row.task_id}`
    if (providerState.source_manifest !== task.config_files[0]) return `provider manifest mismatch for ${row.task_id}`
    if (providerState.source_root !== `tasks/dev/detection/sources/${task.task_id}`) return `provider source root mismatch for ${row.task_id}`

    const sourceManifest = readSourceManifest(providerState.source_manifest)
    if (sourceManifest.source !== task.source || sourceManifest.commit !== task.source_revision) return `source manifest metadata mismatch for ${row.task_id}`
    if (sourceManifest.files.length !== task.files.length) return `source manifest file count mismatch for ${row.task_id}`

    for (const file of sourceManifest.files) {
      if (!task.files.includes(file.path)) return `source manifest file not declared by manifest for ${row.task_id}:${file.path}`
      if (readSourceFileChecksum(providerState.source_root, file.path) !== file.sha256) return `source file checksum mismatch for ${row.task_id}:${file.path}`
    }

    const declaredArtifactHash = manifest.artifactChecksums[providerState.source_manifest]
    if (declaredArtifactHash !== undefined) {
      const actualSourceManifestText = readFileSync(resolve(benchmarkRoot, providerState.source_manifest), 'utf8')
      if (sha256(actualSourceManifestText) !== declaredArtifactHash) return `source manifest artifact checksum mismatch for ${row.task_id}`
    }
  }

  return null
}

function compareTask(scannerTask: ScannerTaskResult, aiTask: NormalizedAiTaskResult): ComparisonTask {
  const aiPredictedFlags = aiTask.predicted_flags.map((flag) => {
    const loc = parseAiLocation(scannerTask.source_root, flag.location)
    return { name: flag.name, filePath: loc.filePath, lineKnown: loc.lineKnown, lineStart: loc.lineStart, lineEnd: loc.lineEnd, ranges: loc.ranges, classification: flag.classification }
  })
  const scannerMatches: ComparisonMatch[] = scannerTask.detections.map((detection) => ({ name: detection.name, filePath: detection.filePath, lineNumber: detection.lineNumber, lineKnown: true }))
  const aiMatches: Array<ComparisonMatch & { lineStart?: number; lineEnd?: number; ranges: Array<{ start: number; end: number }> }> = aiPredictedFlags.map((flag) => ({ name: flag.name, filePath: flag.filePath, lineNumber: flag.lineStart, lineKnown: flag.lineKnown, lineStart: flag.lineStart, lineEnd: flag.lineEnd, ranges: flag.ranges }))
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
      const scannerInsideAiRange = sameNameFile.lineKnown && sameNameFile.lineStart !== undefined && sameNameFile.lineEnd !== undefined ? aiLocationContainsScannerLine(sameNameFile, scannerMatch.lineNumber ?? 0) : false
      if (scannerInsideAiRange) {
        overlap.push(scannerMatch)
        continue
      }
      if (!sameNameFile.lineKnown) {
        locationUncertain.push({ name: scannerMatch.name, filePath: scannerMatch.filePath, scannerLineKnown: scannerMatch.lineKnown, aiLineKnown: sameNameFile.lineKnown, scannerLineNumber: scannerMatch.lineNumber })
      } else if (!scannerMatch.lineKnown) {
        locationUncertain.push({ name: scannerMatch.name, filePath: scannerMatch.filePath, scannerLineKnown: scannerMatch.lineKnown, aiLineKnown: sameNameFile.lineKnown, aiLineNumber: sameNameFile.lineNumber, aiLineStart: sameNameFile.lineStart, aiLineEnd: sameNameFile.lineEnd })
      } else {
        locationMismatches.push({ name: scannerMatch.name, filePath: scannerMatch.filePath, scannerLineNumber: scannerMatch.lineNumber ?? 0, aiLineNumber: sameNameFile.lineNumber, aiLineStart: sameNameFile.lineStart, aiLineEnd: sameNameFile.lineEnd })
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

  return { task_id: scannerTask.task_id, scanner: { detections: scannerTask.detections, candidate_count: scannerTask.detections.length, cost_usd: scannerTask.cost_usd }, ai: { predicted_flags: aiPredictedFlags, candidate_count: aiPredictedFlags.length, abstentions: aiTask.abstentions ?? [], cost_usd: aiTask.cost_usd ?? 0 }, overlap, location_uncertain: locationUncertain, location_mismatches: locationMismatches, scanner_only: scannerOnly, ai_only: aiOnly, name_mismatches: [] }
}

export function compareResults(scannerResults: ScannerTaskResult[], aiResults: NormalizedAiTaskResult[], aiRunStatus: AiRunStatus): ComparisonResult {
  const manifest = readJson<BenchmarkManifest>(manifestPath)
  const config = loadAiRunConfig()
  let status = aiRunStatus.status
  let reason = aiRunStatus.reason
  if (aiRunStatus.status === 'valid') {
    const validationError = validateValidRun(aiRunStatus, config, manifest, scannerResults, aiResults)
    if (validationError) {
      status = 'invalid'
      reason = validationError
    }
  }

  const aiByTask = new Map(aiResults.map((task) => [task.task_id, task]))
  const tasks: ComparisonTask[] = []
  for (const scannerTask of scannerResults) {
    const aiTask = aiByTask.get(scannerTask.task_id)
    if (!aiTask) continue
    if (!aiTask.predicted_provider_state) return failInvalid(`missing predicted_provider_state for ${scannerTask.task_id}`, aiRunStatus)
    if (aiTask.predicted_provider_state.source_manifest !== scannerTask.source_manifest || normalizeAiPath(aiTask.predicted_provider_state.source_root) !== normalizeAiPath(scannerTask.source_root)) return failInvalid(`scanner provider state mismatch for ${scannerTask.task_id}`, aiRunStatus)
    tasks.push(compareTask(scannerTask, aiTask))
  }

  return { benchmark: manifest.benchmark, benchmark_version: manifest.version, ai_runner: 'benchmark-local-ai/default', scanner_results: 'benchmarks/held-out-protocol-v1/runner/results/index.json', ai_results: 'benchmarks/held-out-protocol-v1/runner/ai-results/normalized.json', status, status_reason: reason, status_version: aiRunStatus.version, tasks }
}

export function writeComparisonResult(outputPath: string): ComparisonResult {
  const result = compareResults(loadScannerResults(), loadAiResults(), loadAiRunStatus())
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (import.meta.main) writeComparisonResult(resolve(benchmarkRoot, 'runner/comparison.json'))
