import { expect, test } from 'bun:test'

import { runTask } from './run'

const task = {
  task_id: 'dev-detection-msr-strudel-cloudfoundry-user_org_creation',
  task_type: 'detection',
  partition: 'dev',
  config_files: ['tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation/source-manifest.json'],
  files: ['app/models/runtime/feature_flag.rb'],
}

test('runner validates the fixture and preserves detection details separately from CLI stale flags', async () => {
  const result = await runTask(task)

  expect(result.task_id).toBe(task.task_id)
  expect(result.exit_code).toBe(0)
  expect(result.cost_usd).toBe(0)
  expect(result.cli_summary.totalFlags).toBeGreaterThanOrEqual(0)
  expect(Array.isArray(result.cli_summary.flags)).toBe(true)
  expect(result.detections.length).toBeGreaterThan(0)
  for (const detection of result.detections) {
    expect(detection.name.length).toBeGreaterThan(0)
    expect(detection.filePath.length).toBeGreaterThan(0)
    expect(detection.lineNumber).toBeGreaterThan(0)
  }
})
