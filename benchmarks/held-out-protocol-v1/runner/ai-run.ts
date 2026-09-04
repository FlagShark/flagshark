import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

interface ManifestTask {
  task_id: string
  task_type: string
  partition: string
  source: string
  source_revision: string
  repo_snapshot_id: string
  config_files: string[]
  files: string[]
}

interface SourceManifestFile { path: string; sha256: string }
interface SourceManifest { source?: string; commit?: string; files?: SourceManifestFile[] }
interface AiRunConfig {
  version: string
  benchmark_version: string
  model: string
  provider: string
  model_version: string
  prompt: string
  prompt_template: string
  prompt_hash: string
  output_schema_version: string
  tool_versions: { comparator: string; cli: string }
  recordBeforeRun: string[]
}
interface CliEvent {
  type: string
  message?: {
    role?: string
    content?: Array<{ type: string; text?: string }>
    provider?: string
    model?: string
    api?: string
    responseId?: string
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } }
    duration?: number
    ttft?: number
    stopReason?: string
  }
}
interface RunnerResult {
  task_id: string
  runner: string
  provider: string
  model: string
  model_version: string
  raw_response: string
  raw_response_id?: string
  raw_response_api?: string
  runtime_seconds: number
  token_usage: Record<string, number>
  validation_commands: string[]
  validation_results: string[]
  predicted_flags: Array<{ name: string; location: string; classification: string; evidence_citations: string[] }>
  predicted_provider_state: {
    task_partition: string
    source: string
    source_revision: string
    repo_snapshot_id: string
    model: string
    provider: string
    model_version: string
    prompt_hash: string
    source_manifest: string
    source_root: string
  }
  evidence_citations: string[]
  abstentions: string[]
}

const repoRoot = resolve(import.meta.dirname, '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const manifestPath = resolve(benchmarkRoot, 'manifest.json')
const configPath = resolve(benchmarkRoot, 'ai-run-config.json')
const resultsDir = resolve(benchmarkRoot, 'runner/ai-results')
const ompPackageJson = resolve('/Users/joe/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/package.json')

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T }
function sha256(text: string): string { return createHash('sha256').update(text).digest('hex') }
function relativeToBenchmark(path: string): string { return path.startsWith(`${benchmarkRoot}/`) ? path.slice(benchmarkRoot.length + 1) : path }
function resolveTaskPath(taskPath: string): string {
  const benchmarkPath = resolve(benchmarkRoot, taskPath)
  if (existsSync(benchmarkPath)) return benchmarkPath
  const repoPath = resolve(repoRoot, taskPath)
  if (existsSync(repoPath)) return repoPath
  throw new Error(`missing task path ${taskPath}`)
}
function validateSourceManifest(sourceRoot: string, manifest: SourceManifest, taskFiles: string[]): void {
  if (manifest.files?.length) {
    for (const entry of manifest.files) {
      const actual = sha256(readFileSync(join(sourceRoot, entry.path), 'utf8'))
      if (actual !== entry.sha256) throw new Error(`checksum mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual}`)
    }
    return
  }
  for (const filePath of taskFiles) {
    const candidate = existsSync(join(sourceRoot, filePath)) ? join(sourceRoot, filePath) : resolve(repoRoot, filePath)
    readFileSync(candidate, 'utf8')
  }
}
function runOmp(prompt: string): { provider: string; model: string; api: string; responseId?: string; usage: NonNullable<CliEvent['message']>['usage']; rawResponse: string; duration?: number; ttft?: number } {
  const proc = spawnSync('omp', ['--mode', 'json', '--no-session', '--no-rules', '--no-skills', '--no-tools', '--model', 'default', '-p', prompt], { cwd: benchmarkRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  if (proc.error) throw proc.error
  if (proc.status !== 0) throw new Error(`omp failed: ${proc.status}\n${proc.stderr}`)
  let rawResponse = ''
  let provider = ''
  let model = ''
  let api = ''
  let responseId: string | undefined
  let usage: NonNullable<CliEvent['message']>['usage']
  let duration: number | undefined
  let ttft: number | undefined
  for (const line of proc.stdout.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as CliEvent
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      rawResponse = event.message.content?.map((part) => part.text ?? '').join('') ?? ''
      provider = event.message.provider ?? ''
      model = event.message.model ?? ''
      api = event.message.api ?? ''
      responseId = event.message.responseId
      usage = event.message.usage
      duration = event.message.duration
      ttft = event.message.ttft
    }
  }
  if (!rawResponse) throw new Error('missing assistant response text')
  if (!provider || !model || !api) throw new Error('missing provider/model/api provenance')
  if (!usage) throw new Error('missing usage provenance')
  return { provider, model, api, responseId, usage, rawResponse, duration, ttft }
}
function parseOutput(rawResponse: string): { predicted_flags: RunnerResult['predicted_flags']; evidence_citations: string[]; abstentions: string[] } {
  try {
    const parsed = JSON.parse(rawResponse) as Partial<RunnerResult>
    if (!Array.isArray(parsed.predicted_flags)) return { predicted_flags: [], evidence_citations: [], abstentions: ['assistant response was not JSON schema valid'] }
    for (const flag of parsed.predicted_flags) {
      if (typeof flag?.name !== 'string' || typeof flag?.location !== 'string' || typeof flag?.classification !== 'string' || !Array.isArray(flag.evidence_citations)) {
        return { predicted_flags: [], evidence_citations: [], abstentions: ['assistant response was not JSON schema valid'] }
      }
    }
    return { predicted_flags: parsed.predicted_flags as RunnerResult['predicted_flags'], evidence_citations: Array.isArray(parsed.evidence_citations) ? parsed.evidence_citations.filter((value): value is string => typeof value === 'string' && value.length > 0) : [], abstentions: Array.isArray(parsed.abstentions) ? parsed.abstentions.filter((value): value is string => typeof value === 'string' && value.length > 0) : [] }
  } catch {
    return { predicted_flags: [], evidence_citations: [], abstentions: ['assistant response was not JSON schema valid'] }
  }
}
async function runOne(task: ManifestTask, config: AiRunConfig, cliVersion: string): Promise<RunnerResult> {
  if (task.task_type !== 'detection' || task.partition !== 'dev' || task.source !== 'msr-strudel-2020') throw new Error(`unexpected task selection for ${task.task_id}`)
  const sourceManifestPath = resolveTaskPath(task.config_files[0])
  const sourceRoot = dirname(sourceManifestPath)
  validateSourceManifest(sourceRoot, readJson<SourceManifest>(sourceManifestPath), task.files)
  const startedAt = new Date()
  const start = process.hrtime.bigint()
  const run = runOmp(config.prompt)
  const runtimeSeconds = Number(process.hrtime.bigint() - start) / 1e9
  const parsed = parseOutput(run.rawResponse)
  const result: RunnerResult = {
    task_id: task.task_id,
    runner: 'benchmark-held-out-protocol-v1/chatgpt-baseline',
    provider: run.provider,
    model: run.model,
    model_version: run.model,
    raw_response: run.rawResponse,
    raw_response_id: run.responseId,
    raw_response_api: run.api,
    runtime_seconds: runtimeSeconds,
    token_usage: { input: run.usage.input ?? 0, output: run.usage.output ?? 0, cacheRead: run.usage.cacheRead ?? 0, cacheWrite: run.usage.cacheWrite ?? 0, totalTokens: run.usage.totalTokens ?? 0 },
    validation_commands: ['omp --mode json --no-session --no-rules --no-skills --no-tools --model default -p <prompt>', 'JSON.parse(raw_response)'],
    validation_results: [`provider=${run.provider}; model=${run.model}; api=${run.api}; responseId=${run.responseId ?? 'n/a'}`, `parsed predicted_flags=${parsed.predicted_flags.length}`],
    predicted_flags: parsed.predicted_flags,
    predicted_provider_state: { task_partition: task.partition, source: task.source, source_revision: task.source_revision, repo_snapshot_id: task.repo_snapshot_id, model: run.model, provider: run.provider, model_version: run.model, prompt_hash: config.prompt_hash, source_manifest: relativeToBenchmark(sourceManifestPath), source_root: relativeToBenchmark(sourceRoot) },
    evidence_citations: parsed.evidence_citations,
    abstentions: parsed.abstentions,
  }
  return result
}

async function main(): Promise<void> {
  const manifest = readJson<{ tasks: ManifestTask[] }>(manifestPath)
  const config = readJson<AiRunConfig>(configPath)
  const cliVersion = readJson<{ version: string }>(ompPackageJson).version
  const taskArg = process.argv[2]
  const tasks = taskArg ? manifest.tasks.filter((task) => task.task_id === taskArg) : manifest.tasks.filter((candidate) => candidate.task_type === 'detection' && candidate.partition === 'dev' && candidate.source === 'msr-strudel-2020')
  if (tasks.length === 0) throw new Error('no dev msr detection task found')
  mkdirSync(resultsDir, { recursive: true })
  const results: RunnerResult[] = []
  for (const task of tasks) {
    const result = await runOne(task, config, cliVersion)
    results.push(result)
    const sourceManifestPath = relativeToBenchmark(resolveTaskPath(task.config_files[0]))
    const sourceRoot = relativeToBenchmark(dirname(resolveTaskPath(task.config_files[0])))
    const provenance = { config_version: config.version, task_id: task.task_id, model: result.model, provider: result.provider, model_version: result.model_version, date: new Date().toISOString(), tool_versions: config.tool_versions, snapshot_id: task.repo_snapshot_id, prompt: config.prompt, prompt_template: config.prompt_template, prompt_hash: config.prompt_hash, output_schema_version: config.output_schema_version, recordBeforeRun: config.recordBeforeRun, benchmark_version: config.benchmark_version, cli_version: cliVersion, raw_response_id: result.raw_response_id, raw_response_api: result.raw_response_api, raw_response: result.raw_response, runtime_seconds: result.runtime_seconds, token_usage: result.token_usage, validation_commands: result.validation_commands, validation_results: result.validation_results, source_manifest: sourceManifestPath, source_root: sourceRoot }
    writeFileSync(join(resultsDir, `${task.task_id}.raw.json`), `${JSON.stringify(provenance, null, 2)}\n`)
    writeFileSync(join(resultsDir, `${task.task_id}.json`), `${JSON.stringify(result, null, 2)}\n`)
  }
  writeFileSync(join(resultsDir, 'index.json'), `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(join(resultsDir, 'status.json'), `${JSON.stringify({ status: 'invalid', reason: 'provenance-only capture until comparator accepts complete per-task provenance', version: config.version }, null, 2)}\n`)
}
if (import.meta.main) await main()
