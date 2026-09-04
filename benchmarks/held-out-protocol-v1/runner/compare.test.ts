import { expect, test } from 'bun:test'

import { compareResults } from './compare'

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
      predicted_flags: [
        {
          name: 'shared',
          location: 'app/models/runtime/feature_flag.rb:7-10',
          classification: 'safe',
          evidence_citations: [],
        },
      ],
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never)
  expect(result.tasks[0].ai.predicted_flags[0].filePath).toBe('tasks/dev/a/app/models/runtime/feature_flag.rb')
  expect(result.tasks[0].ai.predicted_flags[0].lineStart).toBe(7)
  expect(result.tasks[0].ai.predicted_flags[0].lineEnd).toBe(10)
  expect(result.tasks[0].overlap).toEqual([{ name: 'shared', filePath: 'tasks/dev/a/app/models/runtime/feature_flag.rb', lineNumber: 8, lineKnown: true }])
  expect(result.tasks[0].location_uncertain).toEqual([])
  expect(result.tasks[0].location_mismatches).toEqual([])
  expect(result.tasks[0].scanner_only).toEqual([])
  expect(result.tasks[0].ai_only).toEqual([])
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
      predicted_flags: [
        {
          name: 'maybe-line',
          location: 'app.rb',
          classification: 'safe',
          evidence_citations: [],
        },
      ],
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never)
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
      predicted_flags: [
        {
          name: 'mismatch',
          location: 'app.rb:7-10',
          classification: 'safe',
          evidence_citations: [],
        },
      ],
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never)
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
