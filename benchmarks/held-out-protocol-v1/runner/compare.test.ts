import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'bun:test'

import { compareResults } from './compare'

type ManifestTask = { task_id: string; source: string; source_revision: string; repo_snapshot_id: string; task_type: string; partition: string; files: string[]; config_files: string[] }
type Manifest = { benchmark: string; version: string; tasks: ManifestTask[] }
type Status = { status: 'valid' | 'invalid'; reason: string; version: string; provenance?: { config_version: string; tasks: Array<{ task_id: string; model: string; provider: string; model_version: string; date: string; tool_versions: { comparator: string; cli: string }; snapshot_id: string; prompt: string; prompt_template: string; prompt_hash: string; output_schema_version: string; recordBeforeRun: string[] }> } }

const repoRoot = resolve(import.meta.dir, '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const manifest = JSON.parse(readFileSync(resolve(benchmarkRoot, 'manifest.json'), 'utf8')) as Manifest
const config = JSON.parse(readFileSync(resolve(benchmarkRoot, 'ai-run-config.json'), 'utf8')) as { version: string; model: string; provider: string; model_version: string; prompt: string; prompt_template: string; prompt_hash: string; output_schema_version: string; tool_versions: { comparator: string; cli: string }; recordBeforeRun: string[] }
const sourceRoot = 'tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation'
const sourceManifestPath = resolve(benchmarkRoot, sourceRoot, 'source-manifest.json')
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as { source: string; commit: string; files: Array<{ path: string; sha256: string }> }
const sourceFilePath = resolve(benchmarkRoot, sourceRoot, sourceManifest.files[0].path)
const sourceFileChecksum = createHash('sha256').update(readFileSync(sourceFilePath, 'utf8')).digest('hex')
if (sourceFileChecksum !== sourceManifest.files[0].sha256) throw new Error('source checksum drifted')

const devDetectionTasks = manifest.tasks.filter((task) => task.task_type === 'detection' && task.partition === 'dev' && task.source === 'msr-strudel-2020')
const scannerResults = devDetectionTasks.map((task) => ({
  task_id: task.task_id,
  benchmark_version: manifest.version,
  cli_version: '2.8.0',
  source_root: `tasks/dev/detection/sources/${task.task_id}`,
  source_manifest: task.config_files[0],
  command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file',
  exit_code: 0,
  cost_usd: 0,
  cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } },
  detections: [{ name: task.task_id === 'dev-detection-msr-strudel-cloudfoundry-user_org_creation' ? 'user_org_creation' : task.task_id === 'dev-detection-msr-strudel-digitalmarketplace-edit-service-page' ? 'EDIT_SERVICE_PAGE' : 'activity', filePath: `tasks/dev/detection/sources/${task.task_id}/${task.files[0]}`, lineNumber: 7, language: 'ruby' }],
}))

const validAiResults = devDetectionTasks.map((task) => ({
  task_id: task.task_id,
  runner: 'benchmark-local-ai/default',
  runtime_seconds: 1,
  token_usage: {},
  validation_commands: ['completion(prompt, \'default\', ...)'],
  validation_results: [],
  predicted_flags: [{ name: task.task_id === 'dev-detection-msr-strudel-cloudfoundry-user_org_creation' ? 'user_org_creation' : task.task_id === 'dev-detection-msr-strudel-digitalmarketplace-edit-service-page' ? 'EDIT_SERVICE_PAGE' : 'activity', location: `${task.files[0]}:7-10`, classification: 'safe', evidence_citations: ['fixture'] }],
  predicted_provider_state: { task_partition: 'dev', source: 'msr-strudel-2020', source_revision: task.source_revision, repo_snapshot_id: task.repo_snapshot_id, model: config.model, provider: config.provider, model_version: config.model_version, prompt_hash: config.prompt_hash, source_manifest: task.config_files[0], source_root: `tasks/dev/detection/sources/${task.task_id}` },
  abstentions: [],
}))
const invalidAiResults = validAiResults.map((row) => ({ ...row, predicted_provider_state: row.predicted_provider_state ? { ...row.predicted_provider_state, source_root: `${row.predicted_provider_state.source_root}-placeholder` } : row.predicted_provider_state }))

const validStatus: Status = { status: 'valid', reason: 'provenance-complete benchmark run', version: manifest.version, provenance: { config_version: config.version, tasks: devDetectionTasks.map((task) => ({ task_id: task.task_id, model: config.model, provider: config.provider, model_version: config.model_version, date: '2026-09-04', tool_versions: config.tool_versions, snapshot_id: task.repo_snapshot_id, prompt: config.prompt, prompt_template: config.prompt_template, prompt_hash: config.prompt_hash, output_schema_version: config.output_schema_version, recordBeforeRun: config.recordBeforeRun })) } }
const invalidStatus: Status = { status: 'invalid', reason: 'audit-only harness capture', version: '2026-08-29' }

test('comparison prefixes ai locations with the matched scanner source_root and treats scanner lines inside ai ranges as overlap', () => {
  const scanner = [{ task_id: 'task-a', benchmark_version: '1.0.0', cli_version: '2.0.0', source_root: 'tasks/dev/a', source_manifest: 'tasks/dev/a/source-manifest.json', command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file', exit_code: 0, cost_usd: 0, cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } }, detections: [{ name: 'shared', filePath: 'tasks/dev/a/app/models/runtime/feature_flag.rb', lineNumber: 8, language: 'ruby' }]}]
  const ai = [{ task_id: 'task-a', runner: 'benchmark-local-ai/default', runtime_seconds: 0, cost_usd: 0, token_usage: {}, validation_commands: [], validation_results: [], predicted_flags: [{ name: 'shared', location: 'app/models/runtime/feature_flag.rb:7-10', classification: 'safe', evidence_citations: [] }], predicted_provider_state: { task_partition: 'dev', source: 'msr-strudel-2020', source_revision: 'rev', repo_snapshot_id: 'snapshot', source_manifest: 'tasks/dev/a/source-manifest.json', source_root: 'tasks/dev/a' }, abstentions: [] }]
  const result = compareResults(scanner as never, ai as never, invalidStatus)
  expect(result.status).toBe('invalid')
  expect(result.tasks[0].ai.predicted_flags[0].filePath).toBe('tasks/dev/a/app/models/runtime/feature_flag.rb')
  expect(result.tasks[0].overlap).toEqual([{ name: 'shared', filePath: 'tasks/dev/a/app/models/runtime/feature_flag.rb', lineNumber: 8, lineKnown: true }])
})

test('comparison validates a provenance-complete valid run and rejects mutated prompt hash or source checksum state', () => {
  const validResult = compareResults(scannerResults as never, validAiResults as never, validStatus as never)
  expect(validResult.status).toBe('valid')
  expect(validResult.tasks).toHaveLength(3)
  expect(validResult.status_version).toBe(manifest.version)
  const mutatedPrompt = { ...validStatus, provenance: { ...validStatus.provenance!, tasks: validStatus.provenance!.tasks.map((record, index) => index === 0 ? { ...record, prompt_hash: `${record.prompt_hash.slice(0, -1)}0` } : record) } }
  expect(compareResults(scannerResults as never, validAiResults as never, mutatedPrompt as never).status_reason).toContain('prompt mismatch')
  const mutatedSourceRoot = validAiResults.map((row) => row.task_id === 'dev-detection-msr-strudel-cloudfoundry-user_org_creation' ? { ...row, predicted_provider_state: { ...row.predicted_provider_state!, source_root: 'tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation-bad' } } : row)
  expect(compareResults(scannerResults as never, mutatedSourceRoot as never, validStatus as never).status_reason).toContain('scanner provider state mismatch')
  const mutatedSnapshot = validAiResults.map((row) => row.task_id === 'dev-detection-msr-strudel-opengever-activity' ? { ...row, predicted_provider_state: { ...row.predicted_provider_state!, repo_snapshot_id: `${row.predicted_provider_state!.repo_snapshot_id}-bad` } } : row)
  expect(compareResults(scannerResults as never, mutatedSnapshot as never, validStatus as never).status_reason).toContain('provider state mismatch for dev-detection-msr-strudel-opengever-activity')
  const mutatedScanner = scannerResults.map((row) => row.task_id === 'dev-detection-msr-strudel-opengever-activity' ? { ...row, source_root: `${row.source_root}-bad` } : row)
  expect(compareResults(mutatedScanner as never, validAiResults as never, validStatus as never).status_reason).toContain('scanner provider state mismatch for dev-detection-msr-strudel-opengever-activity')
})

test('comparison keeps same-name same-file unknown-line pairs in location_uncertain instead of scanner_only or ai_only', () => {
  const scanner = [{ task_id: 'task-b', benchmark_version: '1.0.0', cli_version: '2.0.0', source_root: 'tasks/dev/b', source_manifest: 'tasks/dev/b/source-manifest.json', command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file', exit_code: 0, cost_usd: 0, cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } }, detections: [{ name: 'maybe-line', filePath: 'tasks/dev/b/app.rb', lineNumber: 10, language: 'ruby' }]}]
  const ai = [{ task_id: 'task-b', runner: 'benchmark-local-ai/default', runtime_seconds: 0, cost_usd: 0, token_usage: {}, validation_commands: [], validation_results: [], predicted_flags: [{ name: 'maybe-line', location: 'app.rb', classification: 'safe', evidence_citations: [] }], predicted_provider_state: { task_partition: 'dev', source: 'msr-strudel-2020', source_revision: 'rev', repo_snapshot_id: 'snapshot', source_manifest: 'tasks/dev/b/source-manifest.json', source_root: 'tasks/dev/b' }, abstentions: [] }]
  const result = compareResults(scanner as never, ai as never, invalidStatus as never)
  expect(result.tasks[0].location_uncertain).toEqual([{ name: 'maybe-line', filePath: 'tasks/dev/b/app.rb', scannerLineKnown: true, aiLineKnown: false, scannerLineNumber: 10 }])
})

test('comparison records same-name same-file differing known lines as location_mismatches', () => {
  const scanner = [{ task_id: 'task-c', benchmark_version: '1.0.0', cli_version: '2.0.0', source_root: 'tasks/dev/c', source_manifest: 'tasks/dev/c/source-manifest.json', command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file', exit_code: 0, cost_usd: 0, cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } }, detections: [{ name: 'mismatch', filePath: 'tasks/dev/c/app.rb', lineNumber: 12, language: 'ruby' }]}]
  const ai = [{ task_id: 'task-c', runner: 'benchmark-local-ai/default', runtime_seconds: 0, cost_usd: 0, token_usage: {}, validation_commands: [], validation_results: [], predicted_flags: [{ name: 'mismatch', location: 'app.rb:7-10', classification: 'safe', evidence_citations: [] }], predicted_provider_state: { task_partition: 'dev', source: 'msr-strudel-2020', source_revision: 'rev', repo_snapshot_id: 'snapshot', source_manifest: 'tasks/dev/c/source-manifest.json', source_root: 'tasks/dev/c' }, abstentions: [] }]
  const result = compareResults(scanner as never, ai as never, invalidStatus as never)
  expect(result.tasks[0].location_mismatches).toEqual([{ name: 'mismatch', filePath: 'tasks/dev/c/app.rb', scannerLineNumber: 12, aiLineNumber: 7, aiLineStart: 7, aiLineEnd: 10 }])
})
