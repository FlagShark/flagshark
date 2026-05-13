/**
 * Spawns the built CLI binary (packages/cli/dist/cli.js) in a child process.
 * Used by E2E tests — does NOT contribute to coverage data (child-process v8
 * coverage isn't merged back to vitest).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunCliOpts {
  cwd: string
  env?: NodeJS.ProcessEnv
}

export function runCli(args: string[], opts: RunCliOpts): CliResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf-8',
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}
