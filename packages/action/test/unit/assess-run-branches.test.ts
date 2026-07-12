import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssessmentActionClient } from '../../src/assess-run.js'
import { runFakeAssessmentAction, testJwt } from '../helpers/run-assessment-action.js'

const encoder = new TextEncoder()
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'flagshark-action-assess-branches-'))
  directories.push(value)
  return value
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    assessmentId: 'assessment_branches',
    status: 'succeeded',
    statusUrl: 'https://api.example.test/v1/migration-assessments/assessment_branches',
    artifacts: {
      markdown: { url: 'https://artifacts.example/report.md', expiresAt: '2030-01-01T00:00:00Z' },
      json: { url: 'https://artifacts.example/report.json', expiresAt: '2030-01-01T00:00:00Z' },
    },
    ...overrides,
  }
}

function client(options: {
  result?: ReturnType<typeof result>
  markdown?: Uint8Array
  json?: Uint8Array
  authenticate?: boolean
  thrown?: unknown
} = {}): AssessmentActionClient {
  return {
    runMigrationAssessment: vi.fn(async (_input, runOptions) => {
      if (options.thrown !== undefined) throw options.thrown
      if (options.authenticate) {
        await runOptions.getAccessToken()
        await runOptions.getAccessToken()
      }
      return options.result ?? result()
    }) as never,
    downloadMigrationAssessmentArtifact: vi.fn(async (_completed, format) => (
      format === 'markdown'
        ? options.markdown ?? encoder.encode('# Report without trailing newline')
        : options.json ?? encoder.encode('{}')
    )) as never,
  }
}

describe('migration assessment Action boundary coverage', () => {
  it('supports SHA-256 context and defaults reports beneath RUNNER_TEMP', async () => {
    const root = directory()
    const runnerTemp = directory()
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: client(),
      sha: 'b'.repeat(64),
      env: { RUNNER_TEMP: runnerTemp },
      inputs: {
        'api-url': 'https://api.example.test',
        'include-report-in-job-summary': 'true',
      },
    })

    expect(state.failed).toBeNull()
    expect(state.outputs['report-directory']).toBe(
      join(runnerTemp, 'flagshark-migration-assessment'),
    )
    expect(state.summary.join('\n')).toContain('Report without trailing newline\n')
  })

  it('accepts an explicit false job-summary input', async () => {
    const state = await runFakeAssessmentAction({
      cwd: directory(),
      client: client(),
      inputs: {
        'api-url': 'https://api.example.test',
        'include-report-in-job-summary': 'false',
      },
    })

    expect(state.failed).toBeNull()
    expect(state.summary).toEqual([])
  })

  it('accepts an explicitly configured absolute report directory', async () => {
    const root = directory()
    const reports = join(directory(), 'absolute-reports')
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: client(),
      inputs: {
        'api-url': 'https://api.example.test',
        'output-directory': reports,
      },
    })

    expect(state.failed).toBeNull()
    expect(state.outputs['report-directory']).toBe(reports)
    expect(isAbsolute(state.outputs['markdown-report-path'])).toBe(true)
  })

  it.each([
    [{ owner: '', repository: 'repo' }, 'repository identity'],
    [{ owner: 'owner', repository: '' }, 'repository identity'],
    [{ owner: ' owner', repository: 'repo' }, 'repository identity'],
    [{ owner: 'owner', repository: ' repo' }, 'repository identity'],
    [{ owner: 'bad/owner', repository: 'repo' }, 'repository identity'],
    [{ owner: 'owner', repository: 'bad/repo' }, 'repository identity'],
    [{ owner: 'o'.repeat(513), repository: 'repo' }, 'repository identity'],
    [{ owner: 'owner\u202e', repository: 'repo' }, 'repository identity'],
  ])('rejects malformed GitHub repository context %#', async (context, expected) => {
    const state = await runFakeAssessmentAction({
      cwd: directory(),
      client: client(),
      ...context,
    })
    expect(state.failed).toContain(expected)
  })

  it.each([
    [{ 'timeout-seconds': 'abc' }, 'whole number'],
    [{ 'timeout-seconds': '3601' }, 'between 30 and 3600'],
    [{ 'launchdarkly-project-key': 'x'.repeat(257) }, 'launchdarkly-project-key is invalid'],
    [{ 'oidc-audience': 'bad\u0000audience' }, 'oidc-audience is invalid'],
    [{ 'oidc-audience': 'bad\ud800audience' }, 'oidc-audience is invalid'],
    [{ 'output-directory': 'bad\u202epath' }, 'output-directory is invalid'],
  ])('rejects malformed bounded input %#', async (inputs, expected) => {
    const actionClient = client()
    const state = await runFakeAssessmentAction({
      cwd: directory(),
      client: actionClient,
      inputs,
    })
    expect(state.failed).toContain(expected)
    expect(actionClient.runMigrationAssessment).not.toHaveBeenCalled()
  })

  it('rejects malformed fallback credentials before they reach the client', async () => {
    for (const token of ['bad\ntoken', 'x'.repeat(16_385)]) {
      const actionClient = client()
      const state = await runFakeAssessmentAction({
        cwd: directory(),
        client: actionClient,
        inputs: { 'api-token': token },
      })
      expect(state.failed).toContain('credential is invalid')
      expect(actionClient.runMigrationAssessment).not.toHaveBeenCalled()
    }
  })

  it.each([
    'opaque-token',
    'a.not-json.c',
    jwtPayload([]),
    jwtPayload({ exp: 'soon' }),
    jwtPayload({ exp: 1.5 }),
    jwtPayload({ exp: -1 }),
    jwtPayload({ exp: Number.MAX_SAFE_INTEGER }),
  ])('does not trust malformed JWT expiry when caching OIDC %#', async (token) => {
    const getIDToken = vi.fn(async () => token)
    const state = await runFakeAssessmentAction({
      cwd: directory(),
      client: client({ authenticate: true }),
      getIDToken,
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toBeNull()
    expect(getIDToken).toHaveBeenCalledTimes(2)
  })

  it('uses a short-lived but otherwise valid OIDC token without caching it', async () => {
    const now = 1_900_000_000_000
    const token = testJwt(Math.floor(now / 1_000) + 30)
    const getIDToken = vi.fn(async () => token)
    const state = await runFakeAssessmentAction({
      cwd: directory(),
      client: client({ authenticate: true }),
      getIDToken,
      now: () => now,
      inputs: { 'api-url': 'https://api.example.test' },
    })
    expect(state.failed).toBeNull()
    expect(getIDToken).toHaveBeenCalledTimes(2)
  })

  it.each([
    { markdown: new Uint8Array([0xff]), expected: 'non-UTF-8 Markdown' },
    { json: new Uint8Array([0xff]), expected: 'non-UTF-8 JSON' },
    { json: encoder.encode('{'), expected: 'invalid JSON' },
    { json: encoder.encode('[]'), expected: 'invalid JSON' },
  ])('fails closed on malformed downloaded artifacts %#', async ({ markdown, json, expected }) => {
    const root = directory()
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: client({ markdown, json }),
      inputs: { 'api-url': 'https://api.example.test' },
    })
    expect(state.failed).toContain(expected)
    expect(state.outputs['markdown-report-path']).toBeUndefined()
  })

  it.each([
    { statusUrl: 'http://[broken', expected: 'invalid status URL' },
    { statusUrl: 'https://user:pass@api.example.test/status', expected: 'unsafe to expose' },
    { statusUrl: 'https://api.example.test/status#secret', expected: 'unsafe to expose' },
    { assessmentId: '../unsafe', expected: 'invalid assessment ID' },
  ])('rejects malformed terminal API identity %#', async (override) => {
    const root = directory()
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: client({ result: result(override) }),
      inputs: { 'api-url': 'https://api.example.test' },
    })
    expect(state.failed).toContain(override.expected)
  })

  it('uses a generic diagnostic for non-Error failures and empty messages', async () => {
    const nonError = await runFakeAssessmentAction({
      cwd: directory(),
      client: client({ thrown: 'secret primitive' }),
    })
    expect(nonError.failed).toContain('an unexpected error occurred')
    expect(nonError.failed).not.toContain('secret primitive')

    const empty = await runFakeAssessmentAction({
      cwd: directory(),
      client: client({ thrown: new Error('') }),
    })
    expect(empty.failed).toContain('an unexpected error occurred')
  })

  it('redacts credentialed, trailing-punctuation, and malformed URLs', async () => {
    for (const message of [
      'failed at https://user:pass@example.test/path.',
      'failed at https://%',
    ]) {
      const state = await runFakeAssessmentAction({
        cwd: directory(),
        client: client({ thrown: new Error(message) }),
      })
      expect(state.failed).not.toContain('user:pass')
      expect(state.failed).not.toContain('https://%')
    }
  })

  it('writes byte-identical structured output', async () => {
    const root = directory()
    const json = encoder.encode('{"result":true}\n')
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: client({ json }),
      inputs: { 'api-url': 'https://api.example.test' },
    })
    expect(readFileSync(state.outputs['json-report-path'])).toEqual(Buffer.from(json))
  })
})

function jwtPayload(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}
