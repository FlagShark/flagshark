import { runAssessmentAction, type AssessmentActionClient } from '../../src/assess-run.js'

export interface AssessmentCoreState {
  outputs: Record<string, string>
  failed: string | null
  infos: string[]
  secrets: string[]
  oidcAudiences: string[]
  summary: string[]
  summaryWrites: number
}

export interface RunAssessmentActionOptions {
  cwd: string
  inputs?: Record<string, string>
  env?: NodeJS.ProcessEnv
  owner?: string
  repository?: string
  sha?: string
  getIDToken?: (audience: string) => Promise<string>
  client: AssessmentActionClient
  now?: () => number
}

export async function runFakeAssessmentAction(options: RunAssessmentActionOptions) {
  const state: AssessmentCoreState = {
    outputs: {},
    failed: null,
    infos: [],
    secrets: [],
    oidcAudiences: [],
    summary: [],
    summaryWrites: 0,
  }
  const inputs = options.inputs ?? {}
  const summary = {
    addHeading(text: string) {
      state.summary.push(`# ${text}`)
      return summary
    },
    addRaw(text: string) {
      state.summary.push(text)
      return summary
    },
    async write() {
      state.summaryWrites += 1
    },
  }
  const core = {
    getInput: (name: string) => inputs[name] ?? '',
    getIDToken: async (audience: string) => {
      state.oidcAudiences.push(audience)
      if (!options.getIDToken) throw new Error('OIDC unavailable')
      return options.getIDToken(audience)
    },
    setSecret: (secret: string) => { state.secrets.push(secret) },
    setOutput: (name: string, value: string) => { state.outputs[name] = value },
    setFailed: (message: string) => { state.failed = message },
    info: (message: string) => { state.infos.push(message) },
    summary,
  }
  const github = {
    context: {
      repo: {
        owner: options.owner ?? 'FlagShark',
        repo: options.repository ?? 'fixture',
      },
      sha: options.sha ?? 'a'.repeat(40),
    },
  }

  await runAssessmentAction({
    core: core as unknown as typeof import('@actions/core'),
    github: github as unknown as typeof import('@actions/github'),
    cwd: options.cwd,
    env: options.env ?? {},
    client: options.client,
    now: options.now,
  })

  return state
}

export function testJwt(expirySeconds: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ exp: expirySeconds })}.signature`
}
