import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'bun:test'

import { compareResults } from './compare'

const repoRoot = resolve(import.meta.dir, '../../..')
const benchmarkRoot = resolve(repoRoot, 'benchmarks/held-out-protocol-v1')
const sourceRoot = 'tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation'
const sourceManifestPath = resolve(benchmarkRoot, sourceRoot, 'source-manifest.json')
const manifestPath = resolve(benchmarkRoot, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  tasks: Array<{ task_id: string; repo_snapshot_id: string }>
}
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as {
  source: string
  commit: string
  files: Array<{ path: string; sha256: string }>
}
const sourceFilePath = resolve(benchmarkRoot, sourceRoot, sourceManifest.files[0].path)
const sourceFileChecksum = createHash('sha256').update(readFileSync(sourceFilePath, 'utf8')).digest('hex')
const manifestTask = manifest.tasks.find((task) => task.task_id === 'dev-detection-msr-strudel-cloudfoundry-user_org_creation')
if (!manifestTask) throw new Error('missing manifest task fixture')
if (sourceFileChecksum !== sourceManifest.files[0].sha256) throw new Error('source checksum drifted')

const prompt = 'compare normalized AI outputs against scanner results'
const provenance = {
  model: 'gpt-5.4-mini',
  provider: 'openai',
  date: '2026-09-04',
  tool_versions: {
    model: 'gpt-5.4-mini',
    provider: 'openai',
    comparator: '2026-09-04',
  },
  snapshot_id: manifestTask.repo_snapshot_id,
  prompt,
  prompt_template: 'benchmark comparator validation prompt',
  prompt_hash: createHash('sha256').update(prompt).digest('hex'),
  output_schema_version: '1.0.0',
  recordBeforeRun: [
    {
      model: 'gpt-5.4-mini',
      provider: 'openai',
      date: '2026-09-04',
      tool_versions: {
        model: 'gpt-5.4-mini',
        provider: 'openai',
        comparator: '2026-09-04',
      },
      snapshot_id: manifestTask.repo_snapshot_id,
      prompt,
      prompt_template: 'benchmark comparator validation prompt',
      output_schema_version: '1.0.0',
    },
  ],
}

const invalidStatus = {
  status: 'invalid' as const,
  reason: 'audit-only harness capture',
  version: '2026-08-29',
}

const validStatus = {
  status: 'valid' as const,
  reason: 'future provenance-complete benchmark run',
  version: '1.5.3',
  provenance,
}
const validScanner = [
  {
    task_id: 'dev-detection-msr-strudel-cloudfoundry-user_org_creation',
    benchmark_version: '1.5.3',
    cli_version: '2.8.0',
    source_root: sourceRoot,
    source_manifest: `${sourceRoot}/source-manifest.json`,
    command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file',
    exit_code: 0,
    cost_usd: 0,
    cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } },
    detections: [{ name: 'user_org_creation', filePath: `${sourceRoot}/${sourceManifest.files[0].path}`, lineNumber: 7, language: 'ruby' }],
  },
]

const validAi = [
  {
    task_id: 'dev-detection-msr-strudel-cloudfoundry-user_org_creation',
    runner: 'benchmark-local-ai/default',
    runtime_seconds: 1.25,
    token_usage: {},
    validation_commands: ['completion(prompt, \'default\', ...)'],
    validation_results: ['validated'],
    predicted_flags: [
      {
        name: 'user_org_creation',
        location: `${sourceManifest.files[0].path}:7-7`,
        classification: 'safe',
        evidence_citations: [],
      },
    ],
    predicted_provider_state: {
      task_partition: 'dev',
      source: 'msr-strudel-2020',
      source_revision: sourceManifest.commit,
      repo_snapshot_id: manifestTask.repo_snapshot_id,
      source_manifest: `${sourceRoot}/source-manifest.json`,
      source_root: sourceRoot,
    },
    predicted_transform: null,
    evidence_citations: [],
    abstentions: [],
  },
]

test('comparison prefixes ai locations with the matched scanner source_root and treats scanner lines inside ai ranges as overlap', () => {
  const scanner = [
    {
      task_id: 'task-a',
      benchmark_version: '1.0.0',
      cli_version: '2.0.0',
      source_root: 'tasks/dev/a',
      source_manifest: 'tasks/dev/a/source-manifest.json',
      command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file',
      exit_code: 0,
      cost_usd: 0,
      cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } },
      detections: [{ name: 'shared', filePath: 'tasks/dev/a/app/models/runtime/feature_flag.rb', lineNumber: 8, language: 'ruby' }],
    },
  ]

  const ai = [
    {
      task_id: 'task-a',
      runner: 'benchmark-local-ai/default',
      runtime_seconds: 0,
      token_usage: {},
      validation_commands: [],
      validation_results: [],
      predicted_flags: [
        {
          name: 'shared',
          location: 'app/models/runtime/feature_flag.rb:7-10',
          classification: 'safe',
          evidence_citations: [],
        },
      ],
      predicted_provider_state: {
        task_partition: 'dev',
        source: 'msr-strudel-2020',
        source_revision: 'rev',
        repo_snapshot_id: 'snapshot',
        source_manifest: 'tasks/dev/a/source-manifest.json',
        source_root: 'tasks/dev/a',
      },
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never, invalidStatus)
  expect(result.status).toBe('invalid')
  expect(result.status_reason).toBe(invalidStatus.reason)
  expect(result.status_version).toBe(invalidStatus.version)
  expect(result.tasks[0].ai.predicted_flags[0].filePath).toBe('tasks/dev/a/app/models/runtime/feature_flag.rb')
  expect(result.tasks[0].ai.predicted_flags[0].lineStart).toBe(7)
  expect(result.tasks[0].ai.predicted_flags[0].lineEnd).toBe(10)
  expect(result.tasks[0].overlap).toEqual([{ name: 'shared', filePath: 'tasks/dev/a/app/models/runtime/feature_flag.rb', lineNumber: 8, lineKnown: true }])
  expect(result.tasks[0].location_uncertain).toEqual([])
  expect(result.tasks[0].location_mismatches).toEqual([])
  expect(result.tasks[0].scanner_only).toEqual([])
  expect(result.tasks[0].ai_only).toEqual([])
})

test('comparison validates a provenance-complete valid run and rejects a mutated prompt hash', () => {
  const validResult = compareResults(validScanner as never, validAi as never, validStatus)
  expect(validResult.status).toBe('valid')
  expect(validResult.status_reason).toBe(validStatus.reason)
  expect(validResult.status_version).toBe(validStatus.version)
  expect(validResult.tasks).toHaveLength(1)
  expect(validResult.tasks[0].overlap).toEqual([{ name: 'user_org_creation', filePath: `${sourceRoot}/${sourceManifest.files[0].path}`, lineNumber: 7, lineKnown: true }])

  const mutatedStatus = {
    ...validStatus,
    provenance: {
      ...validStatus.provenance,
      prompt: `${prompt} mutated`,
    },
  }
  const mutatedResult = compareResults(validScanner as never, validAi as never, mutatedStatus)
  expect(mutatedResult.status).toBe('invalid')
  expect(mutatedResult.status_reason).toContain('prompt hash mismatch')
})

test('comparison keeps same-name same-file unknown-line pairs in location_uncertain instead of scanner_only or ai_only', () => {
  const scanner = [
    {
      task_id: 'task-b',
      benchmark_version: '1.0.0',
      cli_version: '2.0.0',
      source_root: 'tasks/dev/b',
      source_manifest: 'tasks/dev/b/source-manifest.json',
      command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file',
      exit_code: 0,
      cost_usd: 0,
      cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } },
      detections: [{ name: 'maybe-line', filePath: 'tasks/dev/b/app.rb', lineNumber: 10, language: 'ruby' }],
    },
  ]

  const ai = [
    {
      task_id: 'task-b',
      runner: 'benchmark-local-ai/default',
      runtime_seconds: 0,
      token_usage: {},
      validation_commands: [],
      validation_results: [],
      predicted_flags: [
        {
          name: 'maybe-line',
          location: 'app.rb',
          classification: 'safe',
          evidence_citations: [],
        },
      ],
      predicted_provider_state: {
        task_partition: 'dev',
        source: 'msr-strudel-2020',
        source_revision: 'rev',
        repo_snapshot_id: 'snapshot',
        source_manifest: 'tasks/dev/b/source-manifest.json',
        source_root: 'tasks/dev/b',
      },
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never, invalidStatus)
  expect(result.tasks[0].location_uncertain).toEqual([
    {
      name: 'maybe-line',
      filePath: 'tasks/dev/b/app.rb',
      scannerLineKnown: true,
      aiLineKnown: false,
      scannerLineNumber: 10,
    },
  ])
  expect(result.tasks[0].scanner_only).toEqual([])
  expect(result.tasks[0].ai_only).toEqual([])
})

test('comparison records same-name same-file differing known lines as location_mismatches', () => {
  const scanner = [
    {
      task_id: 'task-c',
      benchmark_version: '1.0.0',
      cli_version: '2.0.0',
      source_root: 'tasks/dev/c',
      source_manifest: 'tasks/dev/c/source-manifest.json',
      command: 'bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file',
      exit_code: 0,
      cost_usd: 0,
      cli_summary: { totalFlags: 1, staleFlags: 0, flags: [], healthScore: 100, detectedProviders: [], languages: { ruby: 1 } },
      detections: [{ name: 'mismatch', filePath: 'tasks/dev/c/app.rb', lineNumber: 12, language: 'ruby' }],
    },
  ]

  const ai = [
    {
      task_id: 'task-c',
      runner: 'benchmark-local-ai/default',
      runtime_seconds: 0,
      token_usage: {},
      validation_commands: [],
      validation_results: [],
      predicted_flags: [
        {
          name: 'mismatch',
          location: 'app.rb:7-10',
          classification: 'safe',
          evidence_citations: [],
        },
      ],
      predicted_provider_state: {
        task_partition: 'dev',
        source: 'msr-strudel-2020',
        source_revision: 'rev',
        repo_snapshot_id: 'snapshot',
        source_manifest: 'tasks/dev/c/source-manifest.json',
        source_root: 'tasks/dev/c',
      },
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never, invalidStatus)
  expect(result.tasks[0].location_mismatches).toEqual([
    {
      name: 'mismatch',
      filePath: 'tasks/dev/c/app.rb',
      scannerLineNumber: 12,
      aiLineNumber: 7,
      aiLineStart: 7,
      aiLineEnd: 10,
    },
  ])
  expect(result.tasks[0].scanner_only).toEqual([])
  expect(result.tasks[0].ai_only).toEqual([])
})
