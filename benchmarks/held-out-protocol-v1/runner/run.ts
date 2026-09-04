import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import {
  PolyglotAnalyzer,
  buildDefaultConfig,
  buildExcluder,
  collectFiles,
  createDefaultRegistry,
} from '../../../packages/core/src/index.ts'

interface ManifestTask {
  task_id: string
  task_type: string
  partition: string
  source: string
  config_files: string[]
  files: string[]
}

interface SourceManifest {
  source?: string
  record_id?: number
  record_url?: string
  zip_md5?: string
  zip_sha256?: string
  repo_url?: string
  commit?: string
  files?: SourceManifestFile[]
}

interface CliSummary {
  totalFlags: number
  staleFlags: number
  flags: Array<{ name: string; filePath: string; lineNumber: number; language: string; provider?: string; confidence?: string }>
  healthScore: number
  detectedProviders: string[]
  scanDuration: number
  filesScanned: number
  excludedCount?: number
  parseErrorCount?: number
}

interface RunnerResult {
  task_id: string
  source_root: string
  source_manifest: string
  command: string
  version: string
  exit_code: number
  runtime_ms: number
  cost_usd: number
  cli_summary: CliSummary
  detections: Array<{
    name: string
    filePath: string
    lineNumber: number
    language: string
    provider?: string
    confidence?: string
  }>
}

const repoRoot = resolve(import.meta.dirname, '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const manifestPath = resolve(benchmarkRoot, 'manifest.json')
const cliBin = resolve(repoRoot, 'packages/cli/bin/flagshark.mjs')
const resultsDir = resolve(benchmarkRoot, 'runner/results')
const command = `bun ${cliBin} scan --json --no-config --no-ignore-file`

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function resolveTaskPath(taskPath: string): string {
  const benchmarkPath = resolve(benchmarkRoot, taskPath)
  if (existsSync(benchmarkPath)) {
    return benchmarkPath
  }

  const repoPath = resolve(repoRoot, taskPath)
  if (existsSync(repoPath)) {
    return repoPath
  }

  throw new Error(`missing task path ${taskPath}`)
}
function validateSourceManifest(sourceRoot: string, manifest: SourceManifest, taskFiles: string[]): void {
  if (manifest.files && manifest.files.length > 0) {
    for (const entry of manifest.files) {
      const filePath = join(sourceRoot, entry.path)
      const content = readFileSync(filePath, 'utf8')
      const actual = sha256Hex(content)
      if (actual !== entry.sha256) {
        throw new Error(`checksum mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual}`)
      }
    }
    return
  }

  for (const filePath of taskFiles) {
    const candidate = existsSync(join(sourceRoot, filePath)) ? join(sourceRoot, filePath) : resolve(repoRoot, filePath)
    readFileSync(candidate, 'utf8')
  }
}

async function detectFlags(sourceRoot: string): Promise<RunnerResult['detections']> {
  const excluder = buildExcluder({
    config: buildDefaultConfig(),
    ignoreFilePatterns: [],
  })
  const registry = createDefaultRegistry()
  const supportedExtensions = new Set(registry.getSupportedExtensions())
  const { files } = collectFiles({ root: sourceRoot, supportedExtensions, excluder })
  const analyzer = new PolyglotAnalyzer(registry, console)
  const analysis = await analyzer.analyzeFiles(files)
  const detections: RunnerResult['detections'] = []
  for (const [name, occurrences] of analysis.totalFlags) {
    for (const flag of occurrences) {
      detections.push({
        name,
        filePath: flag.filePath,
        lineNumber: flag.lineNumber,
        language: flag.language,
        provider: flag.provider,
        confidence: flag.confidence,
      })
    }
  }
  detections.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber || a.name.localeCompare(b.name))
  return detections
}

async function runTask(task: ManifestTask): Promise<RunnerResult> {
  if (task.task_type !== 'detection' || task.partition !== 'dev') {
    throw new Error(`unexpected task selection for ${task.task_id}`)
  }
  if (!task.config_files?.length) {
    throw new Error(`missing config_files for ${task.task_id}`)
  }

  const sourceManifestPath = resolveTaskPath(task.config_files[0])
  const sourceRoot = dirname(sourceManifestPath)
  const sourceManifest = readJson<SourceManifest>(sourceManifestPath)
  validateSourceManifest(sourceRoot, sourceManifest, task.files)

  const started = performance.now()
  const cli = spawnSync('bun', [cliBin, 'scan', '--json', '--no-config', '--no-ignore-file'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  })
  const runtimeMs = performance.now() - started
  if (cli.error) {
    throw cli.error
  }
  if (cli.status === null || cli.status !== 0) {
    throw new Error(`CLI failed for ${task.task_id}: ${cli.status}\n${cli.stderr}`)
  }

  const cliSummary = cli.stdout ? (JSON.parse(cli.stdout) as CliSummary) : ({} as CliSummary)
  const detections = await detectFlags(sourceRoot)

  return {
    task_id: task.task_id,
    source_root: sourceRoot,
    source_manifest: sourceManifestPath,
    command,
    version: readJson<{ version: string }>(manifestPath).version,
    exit_code: cli.status,
    runtime_ms: runtimeMs,
    cost_usd: 0,
    cli_summary: cliSummary,
    detections,
  }
}

async function main(): Promise<void> {
  const manifest = readJson<{ tasks: ManifestTask[] }>(manifestPath)
  mkdirSync(resultsDir, { recursive: true })
  const outputs: RunnerResult[] = []
  const devDetectionTasks = manifest.tasks.filter(
    (task) => task.task_type === 'detection' && task.partition === 'dev' && task.source === 'msr-strudel-2020',
  )
  for (const task of devDetectionTasks) {
    const result = await runTask(task)
    outputs.push(result)
    writeFileSync(join(resultsDir, `${task.task_id}.json`), `${JSON.stringify(result, null, 2)}\n`)
  }
  writeFileSync(join(resultsDir, 'index.json'), `${JSON.stringify(outputs, null, 2)}\n`)
}

if (import.meta.main) {
  await main()
}

export { main, runTask }
