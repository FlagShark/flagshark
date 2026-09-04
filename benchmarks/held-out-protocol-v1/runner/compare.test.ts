import { expect, test } from 'bun:test'

import { compareResults } from './compare'

test('comparison joins scanner benchmark-relative paths with task-relative AI paths', () => {
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
      detections: [{ name: 'shared', filePath: 'tasks/dev/a/app.rb', lineNumber: 10, language: 'ruby' }],
    },
  ]

  const ai = [
    {
      task_id: 'task-a',
      runner: 'benchmark-local-ai/default',
      runtime_seconds: 1,
      token_usage: {},
      validation_commands: [],
      validation_results: [],
      predicted_flags: [{ name: 'shared', location: 'app.rb:10-10', classification: 'safe', evidence_citations: [] }],
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never)
  expect(result.tasks[0].ai.predicted_flags[0].filePath).toBe('tasks/dev/a/app.rb')
  expect(result.tasks[0].overlap).toEqual([{ name: 'shared', filePath: 'tasks/dev/a/app.rb', lineNumber: 10, lineKnown: true }])
  expect(result.tasks[0].scanner_only).toEqual([])
  expect(result.tasks[0].ai_only).toEqual([])
})

test('comparison keeps same-name same-file unknown-line pairs out of scanner-only and ai-only', () => {
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
      runtime_seconds: 1,
      token_usage: {},
      validation_commands: [],
      validation_results: [],
      predicted_flags: [{ name: 'maybe-line', location: 'app.rb', classification: 'safe', evidence_citations: [] }],
      abstentions: [],
    },
  ]

  const result = compareResults(scanner as never, ai as never)
  expect(result.tasks[0].location_uncertain).toHaveLength(1)
  expect(result.tasks[0].scanner_only).toEqual([])
  expect(result.tasks[0].ai_only).toEqual([])
})
