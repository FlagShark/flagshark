import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssessmentActionClient } from '../../src/assess-run.js'
import { runFakeAssessmentAction, testJwt } from '../helpers/run-assessment-action.js'

const encoder = new TextEncoder()
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flagshark-action-assess-'))
  temporaryDirectories.push(directory)
  return directory
}

function completed(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    assessmentId: 'assessment_123',
    status: 'succeeded',
    statusUrl: 'https://api.example.test/v1/migration-assessments/assessment_123',
    artifacts: {
      markdown: {
        url: 'https://artifacts.example.test/report.md?signature=secret',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      json: {
        url: 'https://artifacts.example.test/report.json?signature=secret',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    },
    ...overrides,
  }
}

function mockClient(
  options: {
    result?: ReturnType<typeof completed>
    markdown?: Uint8Array
    json?: Uint8Array
    run?: (...args: unknown[]) => Promise<unknown>
  } = {},
): AssessmentActionClient {
  return {
    runMigrationAssessment: (options.run ??
      vi.fn(async () => options.result ?? completed())) as never,
    downloadMigrationAssessmentArtifact: vi.fn(async (_result, format) =>
      format === 'markdown'
        ? (options.markdown ?? encoder.encode('# First assessment\n\nReady.\n'))
        : (options.json ?? encoder.encode('{"schemaVersion":"1"}\n')),
    ) as never,
  }
}

describe('migration assessment Action', () => {
  it('uses the CloudFront /api base while keeping the default OIDC audience at the origin', async () => {
    const root = temporaryDirectory()
    const token = testJwt(2_000_000_000)
    const run = vi.fn(async (_input: unknown, options: unknown) => {
      const auth = (options as { getAccessToken: () => Promise<string> }).getAccessToken
      expect(await auth()).toBe(token)
      return completed({
        statusUrl: 'https://api.flagshark.com/api/v1/migration-assessments/assessment_123',
      })
    })

    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      getIDToken: async () => token,
      inputs: {},
    })

    expect(state.failed).toBeNull()
    expect(run).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ apiBaseUrl: 'https://api.flagshark.com/api' }),
    )
    expect(state.oidcAudiences).toEqual(['https://api.flagshark.com'])
    expect(state.outputs['status-url']).toBe(
      'https://api.flagshark.com/api/v1/migration-assessments/assessment_123',
    )
  })

  it('retains submission outputs when polling fails after the API accepts the job', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async (_input: unknown, options: unknown) => {
      const onSubmitted = (
        options as {
          onSubmitted: (submission: ReturnType<typeof completed>) => void
        }
      ).onSubmitted
      onSubmitted(
        completed({
          assessmentId: 'assessment_accepted',
          statusUrl: '/v1/migration-assessments/assessment_accepted',
        }),
      )
      throw new Error('Migration assessment timed out while polling')
    })

    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toContain('timed out while polling')
    expect(state.outputs['assessment-id']).toBe('assessment_accepted')
    expect(state.outputs['status-url']).toBe(
      'https://api.example.test/v1/migration-assessments/assessment_accepted',
    )
    expect(state.outputs['markdown-report-path']).toBeUndefined()
  })

  it('submits immutable Actions context, prefers cached OIDC, writes reports and outputs', async () => {
    const root = temporaryDirectory()
    const now = 1_900_000_000_000
    const oidc = testJwt(Math.floor(now / 1_000) + 300)
    const run = vi.fn(async (input: unknown, options: unknown) => {
      const auth = (options as { getAccessToken: () => Promise<string> }).getAccessToken
      expect(await auth()).toBe(oidc)
      expect(await auth()).toBe(oidc)
      return completed()
    })
    const client = mockClient({ run })

    const state = await runFakeAssessmentAction({
      cwd: root,
      client,
      now: () => now,
      getIDToken: async () => oidc,
      inputs: {
        'api-url': 'https://api.example.test',
        'oidc-audience': 'https://audience.example.test',
        'launchdarkly-project-key': 'production',
        'output-directory': 'reports',
        'timeout-seconds': '120',
        'api-token': 'unused-fallback-token',
        'include-report-in-job-summary': 'true',
      },
      env: { GITHUB_ACTION_REF: 'v2.7.1' },
      owner: 'FlagShark',
      repository: 'flagshark',
      sha: 'ABCDEF1234'.repeat(4),
    })

    expect(state.failed).toBeNull()
    expect(run).toHaveBeenCalledWith(
      {
        repositories: [
          {
            repository: 'FlagShark/flagshark',
            ref: 'abcdef1234'.repeat(4),
          },
        ],
        launchDarklyProjectKey: 'production',
        client: { kind: 'github-action', version: 'v2.7.1' },
      },
      expect.objectContaining({
        apiBaseUrl: 'https://api.example.test',
        timeoutMs: 120_000,
        getAccessToken: expect.any(Function),
        onSubmitted: expect.any(Function),
      }),
    )
    expect(state.oidcAudiences).toEqual(['https://audience.example.test'])
    expect(state.secrets).toEqual(['unused-fallback-token', oidc])
    expect(state.outputs['assessment-id']).toBe('assessment_123')
    expect(state.outputs['status-url']).toBe(
      'https://api.example.test/v1/migration-assessments/assessment_123',
    )
    expect(readFileSync(state.outputs['markdown-report-path'], 'utf8')).toContain(
      'First assessment',
    )
    expect(readFileSync(state.outputs['json-report-path'], 'utf8')).toContain('schemaVersion')
    expect(state.outputs['report-directory']).toBe(join(root, 'reports'))
    expect(state.summary.join('\n')).toContain('First assessment')
    expect(state.summaryWrites).toBe(1)
    expect(state.infos.join('\n')).not.toContain('signature=secret')
  })

  it('refreshes OIDC before expiry without exposing token acquisition failures', async () => {
    const root = temporaryDirectory()
    let now = 1_900_000_000_000
    const first = testJwt(Math.floor(now / 1_000) + 70)
    const second = testJwt(Math.floor(now / 1_000) + 600)
    const getIDToken = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const run = vi.fn(async (_input: unknown, options: unknown) => {
      const auth = (options as { getAccessToken: () => Promise<string> }).getAccessToken
      expect(await auth()).toBe(first)
      now += 11_000
      expect(await auth()).toBe(second)
      return completed()
    })

    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      now: () => now,
      getIDToken,
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toBeNull()
    expect(getIDToken).toHaveBeenCalledTimes(2)
    expect(state.secrets).toEqual([first, second])
  })

  it('falls back to the input API token and never reads GITHUB_TOKEN', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async (_input: unknown, options: unknown) => {
      const auth = (options as { getAccessToken: () => Promise<string> }).getAccessToken
      expect(await auth()).toBe('flagshark-api-token')
      return completed()
    })

    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      getIDToken: async () => {
        throw new Error('OIDC failed at https://oidc.example.test?token=do-not-log')
      },
      inputs: {
        'api-url': 'https://api.example.test',
        'api-token': 'flagshark-api-token',
      },
      env: { GITHUB_TOKEN: 'must-never-be-used' },
    })

    expect(state.failed).toBeNull()
    expect(state.secrets).toContain('flagshark-api-token')
    expect(JSON.stringify(state)).not.toContain('do-not-log')
    expect(JSON.stringify(state)).not.toContain('must-never-be-used')
  })

  it('uses FLAGSHARK_API_TOKEN when OIDC and the input token are unavailable', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async (_input: unknown, options: unknown) => {
      const auth = (options as { getAccessToken: () => Promise<string> }).getAccessToken
      expect(await auth()).toBe('environment-api-token')
      return completed()
    })
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      env: { FLAGSHARK_API_TOKEN: 'environment-api-token' },
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toBeNull()
    expect(state.secrets).toEqual(['environment-api-token'])
  })

  it('fails closed when only GITHUB_TOKEN is available', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async (_input: unknown, options: unknown) => {
      await (options as { getAccessToken: () => Promise<string> }).getAccessToken()
      return completed()
    })
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      env: { GITHUB_TOKEN: 'github-token' },
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toContain('grant id-token: write or configure api-token')
    expect(JSON.stringify(state)).not.toContain('github-token')
  })

  it('refuses to expose a query-bearing or cross-origin status URL', async () => {
    for (const statusUrl of [
      'https://api.example.test/v1/status/assessment_123?token=secret',
      'https://attacker.example/v1/status/assessment_123',
    ]) {
      const root = temporaryDirectory()
      const state = await runFakeAssessmentAction({
        cwd: root,
        client: mockClient({ result: completed({ statusUrl }) }),
        getIDToken: async () => testJwt(2_000_000_000),
        inputs: { 'api-url': 'https://api.example.test' },
      })

      expect(state.failed).toContain('status URL that is unsafe to expose')
      expect(state.outputs['status-url']).toBeUndefined()
      expect(JSON.stringify(state)).not.toContain('token=secret')
    }
  })

  it('redacts signed URLs, bearer credentials, and display-control characters', async () => {
    const root = temporaryDirectory()
    const client = mockClient({
      run: vi.fn(async () => {
        throw new Error(
          'GET https://artifacts.example.test/report?X-Amz-Credential=secret Bearer top-secret marker\u2066spoof',
        )
      }),
    })
    const state = await runFakeAssessmentAction({
      cwd: root,
      client,
      getIDToken: async () => testJwt(2_000_000_000),
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toContain('https://artifacts.example.test/report')
    expect(state.failed).toContain('Bearer [redacted]')
    expect(state.failed).toContain('\\u2066')
    expect(state.failed).not.toContain('X-Amz-Credential')
    expect(state.failed).not.toContain('top-secret')
    expect(state.failed).not.toContain('\u2066')
  })

  it('rejects a mutable ref and invalid bounded inputs before calling the client', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async () => completed())
    const client = mockClient({ run })
    const invalidSha = await runFakeAssessmentAction({
      cwd: root,
      client,
      sha: 'main',
    })
    expect(invalidSha.failed).toContain('immutable commit SHA')

    const invalidTimeout = await runFakeAssessmentAction({
      cwd: root,
      client,
      inputs: { 'timeout-seconds': '5' },
    })
    expect(invalidTimeout.failed).toContain('between 30 and 3600')
    expect(run).not.toHaveBeenCalled()
  })

  it('sanitizes GITHUB_ACTION_REF and falls back to the package version when absent', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async () => completed())
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run }),
      env: { GITHUB_ACTION_REF: 'refs/tags/a-ref-with/slashes' },
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toBeNull()
    expect(run.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        client: {
          kind: 'github-action',
          version: 'refs-tags-a-ref-with-slashes',
        },
      }),
    )

    const fallbackRun = vi.fn(async () => completed())
    const fallbackState = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ run: fallbackRun }),
      env: {},
      inputs: { 'api-url': 'https://api.example.test' },
    })
    expect(fallbackState.failed).toBeNull()
    expect(fallbackRun.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        client: { kind: 'github-action', version: 'unknown' },
      }),
    )
  })

  it('uses the package version injected by the bundled Action build', async () => {
    const root = temporaryDirectory()
    const run = vi.fn(async () => completed())
    Object.assign(globalThis, { __FLAGSHARK_ACTION_VERSION__: '9.8.7' })
    try {
      const state = await runFakeAssessmentAction({
        cwd: root,
        client: mockClient({ run }),
        env: {},
        inputs: { 'api-url': 'https://api.example.test' },
      })
      expect(state.failed).toBeNull()
      expect(run.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          client: { kind: 'github-action', version: '9.8.7' },
        }),
      )
    } finally {
      Reflect.deleteProperty(globalThis, '__FLAGSHARK_ACTION_VERSION__')
    }
  })

  it('keeps an oversized Markdown report out of the bounded job summary', async () => {
    const root = temporaryDirectory()
    const markdown = encoder.encode(`large report\n${'x'.repeat(901 * 1024)}`)
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient({ markdown }),
      inputs: {
        'api-url': 'https://api.example.test',
        'include-report-in-job-summary': 'true',
      },
    })

    expect(state.failed).toBeNull()
    expect(state.summary.join('\n')).toContain('too large for the GitHub job summary')
    expect(state.summary.join('\n')).not.toContain('large report')
    expect(readFileSync(state.outputs['markdown-report-path'])).toEqual(Buffer.from(markdown))
  })

  it('keeps detailed assessment content out of the job summary by default', async () => {
    const root = temporaryDirectory()
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient(),
      inputs: { 'api-url': 'https://api.example.test' },
    })

    expect(state.failed).toBeNull()
    expect(state.summary).toEqual([])
    expect(state.summaryWrites).toBe(0)
    expect(readFileSync(state.outputs['markdown-report-path'], 'utf8')).toContain(
      'First assessment',
    )
  })

  it('rejects an ambiguous job-summary privacy input', async () => {
    const root = temporaryDirectory()
    const state = await runFakeAssessmentAction({
      cwd: root,
      client: mockClient(),
      inputs: {
        'api-url': 'https://api.example.test',
        'include-report-in-job-summary': 'yes',
      },
    })

    expect(state.failed).toContain('include-report-in-job-summary must be true or false')
    expect(state.summaryWrites).toBe(0)
  })
})
