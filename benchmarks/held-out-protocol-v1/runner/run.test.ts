import { expect, test } from 'bun:test'

import { runTask } from './run'

const task = {
  task_id: 'dev-detection-msr-strudel-cloudfoundry-user_org_creation',
  task_type: 'detection',
  partition: 'dev',
  config_files: ['tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation/source-manifest.json'],
  files: ['app/models/runtime/feature_flag.rb'],
}

test('runner validates the fixture and preserves detector details separately from CLI summary data', async () => {
  const result = await runTask(task)

  expect(result.task_id).toBe(task.task_id)
  expect(result.benchmark_version).toBeTruthy()
  expect(result.cli_version).toBeTruthy()
  expect(result.source_root).toBe('tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation')
  expect(result.source_manifest).toBe('tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation/source-manifest.json')
  expect(result.exit_code).toBe(0)
  expect(result.cost_usd).toBe(0)
  expect(result.cli_summary.totalFlags).toBeGreaterThan(0)
  expect(result.cli_summary.staleFlags).toBe(0)
  expect(result.cli_summary.flags.length).toBe(0)
  expect(result.cli_summary.detectedProviders.length).toBeGreaterThan(0)
  expect(result.detections.length).toBeGreaterThan(0)
  for (const detection of result.detections) {
    expect(detection.name.length).toBeGreaterThan(0)
    expect(detection.filePath.startsWith('/')).toBe(false)
    expect(detection.lineNumber).toBeGreaterThan(0)
  }
})
