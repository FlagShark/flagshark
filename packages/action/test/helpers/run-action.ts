import { run } from '../../src/run.js'
import { makeFakeCore } from './fake-actions-core.js'
import { makeFakeOctokit, makeFakeGithub, type FakeComment } from './fake-octokit.js'
import type { scanRepo as ScanRepoFn } from '@flagshark/core'

export interface RunActionOpts {
  inputs?: Record<string, string>
  pullRequest?: { number: number; baseRef: string; headSha: string }
  initialComments?: FakeComment[]
  cwd: string
  env?: Record<string, string>
  scanRepoFn?: typeof ScanRepoFn
}

export async function runAction(opts: RunActionOpts) {
  const core = makeFakeCore(opts.inputs ?? {})
  const fakeOctokit = makeFakeOctokit(opts.initialComments ?? [])
  const github = makeFakeGithub({
    pullRequest: opts.pullRequest,
    octokit: fakeOctokit.octokit,
  })

  const prevEnv: Record<string, string | undefined> = {}
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      prevEnv[k] = process.env[k]
      process.env[k] = v
    }
  }

  try {
    await run({
      core: core.api as unknown as typeof import('@actions/core'),
      github: github as unknown as typeof import('@actions/github'),
      cwd: opts.cwd,
      scanRepoFn: opts.scanRepoFn,
    })
  } finally {
    if (opts.env) {
      for (const k of Object.keys(opts.env)) {
        if (prevEnv[k] === undefined) delete process.env[k]
        else process.env[k] = prevEnv[k]
      }
    }
  }

  return { core, octokit: fakeOctokit }
}
