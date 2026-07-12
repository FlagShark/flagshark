import { describe, expect, it, vi } from 'vitest'
import {
  MigrationAssessmentClientError,
  createMigrationAssessmentRequest,
  defaultAssessmentSleep,
  downloadMigrationAssessmentArtifact,
  normalizeAssessmentApiBaseUrl,
  parseMigrationAssessmentStatus,
  parseMigrationAssessmentSubmission,
  redactSensitiveText,
  redactUrlForLogs,
  runMigrationAssessment,
  sanitizeClientVersion,
  type AssessmentFetch,
  type CompletedMigrationAssessment,
  type DownloadMigrationAssessmentArtifactOptions,
} from '../src/index.js'

const CREATED_AT = '2026-07-12T10:00:00.000Z'
const UPDATED_AT = '2026-07-12T10:01:00.000Z'
const EXPIRES_AT = '2099-07-12T11:00:00.000Z'

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    assessmentId: 'assessment_1',
    status: 'queued',
    statusUrl: '/v1/migration-assessments/assessment_1',
    ...overrides,
  }
}

function status(statusValue: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    assessmentId: 'assessment_1',
    status: statusValue,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...extra,
  }
}

function succeeded() {
  return status('succeeded', {
    artifacts: {
      markdown: {
        url: 'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com/report.md?signature=secret',
        expiresAt: EXPIRES_AT,
      },
      json: {
        url: 'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com/report.json?signature=secret',
        expiresAt: EXPIRES_AT,
      },
    },
  })
}

function completed(): CompletedMigrationAssessment {
  return {
    ...succeeded(),
    status: 'succeeded',
    statusUrl: 'https://api.example/v1/migration-assessments/assessment_1',
  } as CompletedMigrationAssessment
}

function completedWithArtifact(
  url: string,
  statusUrl = 'https://api.example/v1/migration-assessments/assessment_1',
): CompletedMigrationAssessment {
  const value = completed()
  return {
    ...value,
    statusUrl,
    artifacts: {
      ...value.artifacts,
      markdown: { ...value.artifacts.markdown, url },
    },
  }
}

function baseInput() {
  return {
    repositories: [{ repository: 'FlagShark/example', ref: 'a'.repeat(40) }],
    launchDarklyProjectKey: 'production',
    client: { kind: 'cli' as const, version: '2.7.1' },
  }
}

function queuedFetch(...responses: Response[]): AssessmentFetch {
  const queue = [...responses]
  return vi.fn(async () => {
    const response = queue.shift()
    if (!response) throw new Error('Unexpected request')
    return response
  })
}

function failingBodyResponse(statusCode: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('stream reset https://store.example/object?signature=secret'))
      },
    }),
    { status: statusCode },
  )
}

async function expectClientError(
  promise: Promise<unknown>,
  code: string,
): Promise<MigrationAssessmentClientError> {
  try {
    await promise
    throw new Error('Expected promise to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationAssessmentClientError)
    expect((error as MigrationAssessmentClientError).code).toBe(code)
    return error as MigrationAssessmentClientError
  }
}

describe('protocol request validation', () => {
  it('constructs the exact protocol-v1 body without undefined optionals', () => {
    expect(
      createMigrationAssessmentRequest({
        repositories: [{ repository: 'FlagShark/example' }],
        client: { kind: 'github-action', version: 'v2.7.1+build.4' },
      }),
    ).toEqual({
      protocolVersion: 1,
      repositories: [{ repository: 'FlagShark/example' }],
      client: { kind: 'github-action', version: 'v2.7.1+build.4' },
    })
  })

  it.each([
    [{ ...baseInput(), extra: true }, 'INVALID_REQUEST'],
    [{ ...baseInput(), repositories: [] }, 'INVALID_REQUEST'],
    [
      {
        ...baseInput(),
        repositories: Array.from({ length: 21 }, (_, index) => ({
          repository: `o/r${index}`,
        })),
      },
      'INVALID_REQUEST',
    ],
    [{ ...baseInput(), repositories: [{ repository: 'not-a-repository' }] }, 'INVALID_REQUEST'],
    [
      {
        ...baseInput(),
        repositories: [{ repository: 'o/r', ref: 'x'.repeat(513) }],
      },
      'INVALID_REQUEST',
    ],
    [
      {
        ...baseInput(),
        repositories: [{ repository: 'o/r', ref: 'feature branch' }],
      },
      'INVALID_REQUEST',
    ],
    [
      {
        ...baseInput(),
        repositories: [{ repository: 'o/r', ref: 'bad\ud800-ref' }],
      },
      'INVALID_REQUEST',
    ],
    [{ ...baseInput(), launchDarklyProjectKey: ' project ' }, 'INVALID_REQUEST'],
    [{ ...baseInput(), launchDarklyProjectKey: 'bad\udc00-project' }, 'INVALID_REQUEST'],
    [{ ...baseInput(), client: { kind: 'cli', version: 'refs/tags/v1' } }, 'INVALID_REQUEST'],
    [{ ...baseInput(), client: { kind: 'browser', version: '1.0.0' } }, 'INVALID_REQUEST'],
  ])('rejects malformed request input %#', (input, code) => {
    expect(() => createMigrationAssessmentRequest(input as never)).toThrowError(
      expect.objectContaining({ code }),
    )
  })

  it('rejects case-insensitive duplicate repositories even at different refs', () => {
    expect(() =>
      createMigrationAssessmentRequest({
        ...baseInput(),
        repositories: [
          { repository: 'Owner/Repo', ref: 'main' },
          { repository: 'owner/repo', ref: 'other' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('accepts well-formed non-ASCII project keys without confusing surrogate pairs for errors', () => {
    expect(
      createMigrationAssessmentRequest({
        ...baseInput(),
        launchDarklyProjectKey: 'production-🚀',
      }).launchDarklyProjectKey,
    ).toBe('production-🚀')
  })

  it('rejects sparse repository arrays', () => {
    const repositories = new Array(1) as Array<{ repository: string }>
    expect(() => createMigrationAssessmentRequest({ ...baseInput(), repositories })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
  })
})

describe('protocol response validation', () => {
  it('parses all exact status variants', () => {
    expect(parseMigrationAssessmentStatus(status('queued')).status).toBe('queued')
    expect(parseMigrationAssessmentStatus(status('running')).status).toBe('running')
    expect(parseMigrationAssessmentStatus(succeeded()).status).toBe('succeeded')
    expect(
      parseMigrationAssessmentStatus(
        status('failed', {
          error: {
            code: 'ANALYSIS_FAILED',
            message: 'Analysis failed',
            retryable: true,
          },
        }),
      ).status,
    ).toBe('failed')
    expect(parseMigrationAssessmentStatus(status('expired')).status).toBe('expired')
  })

  it('parses the exact submission shape', () => {
    expect(parseMigrationAssessmentSubmission(submission())).toEqual(submission())
    expect(
      parseMigrationAssessmentSubmission(Object.assign(Object.create(null), submission())),
    ).toEqual(submission())
  })

  it('rejects a non-queued submission status', () => {
    expect(() => parseMigrationAssessmentSubmission(submission({ status: 'running' }))).toThrow(
      MigrationAssessmentClientError,
    )
  })

  it.each([
    [submission({ protocolVersion: 2 })],
    [submission({ unexpected: true })],
    [submission({ status: 'running' })],
    [status('running', { createdAt: 'yesterday' })],
    [status('running', { updatedAt: '2026-07-12T09:00:00.000Z' })],
    [status('succeeded', { artifacts: { markdown: {}, json: {} } })],
    [
      status('succeeded', {
        artifacts: {
          markdown: {
            url: 'https://example.test/a',
            expiresAt: '2099-01-01T01:00:00+01:00',
          },
          json: { url: 'https://example.test/b', expiresAt: EXPIRES_AT },
        },
      }),
    ],
    [
      status('succeeded', {
        artifacts: {
          markdown: { url: 'not a URL', expiresAt: EXPIRES_AT },
          json: { url: 'https://example.test/b', expiresAt: EXPIRES_AT },
        },
      }),
    ],
    [status('failed', { error: { code: 'bad code', message: 'x' } })],
    [
      status('failed', {
        error: { code: 'FAILED', message: 'x', retryable: 'yes' },
      }),
    ],
    [status('cancelled')],
  ])('rejects malformed response %#', (value) => {
    expect(() =>
      value.status === 'queued' && 'statusUrl' in value
        ? parseMigrationAssessmentSubmission(value)
        : parseMigrationAssessmentStatus(value),
    ).toThrow(MigrationAssessmentClientError)
  })

  it.each([null, 'response', []])('rejects non-object status response %#', (value) => {
    expect(() => parseMigrationAssessmentStatus(value)).toThrow(MigrationAssessmentClientError)
  })

  it('rejects a non-object submission', () => {
    expect(() => parseMigrationAssessmentSubmission(null)).toThrow(MigrationAssessmentClientError)
  })
})

describe('safe URLs and redaction', () => {
  it('normalizes HTTPS and explicit localhost API bases', () => {
    expect(normalizeAssessmentApiBaseUrl('https://api.example/prefix').toString()).toBe(
      'https://api.example/prefix/',
    )
    expect(normalizeAssessmentApiBaseUrl('http://127.0.0.1:1234').toString()).toBe(
      'http://127.0.0.1:1234/',
    )
  })

  it.each([
    '',
    'not a URL',
    'http://api.example',
    'https://user:password@api.example',
    'https://api.example?token=secret',
    'https://api.example/#fragment',
    'file:///tmp/api',
    'https://api.example/\ud800',
  ])('rejects unsafe API URL %s', (value) => {
    expect(() => normalizeAssessmentApiBaseUrl(value)).toThrowError(
      expect.objectContaining({ code: 'INVALID_URL' }),
    )
  })

  it('drops credentials, query strings, and fragments from logs', () => {
    expect(redactUrlForLogs('https://user:secret@example.test/report?q=secret#fragment')).toBe(
      'https://example.test/report',
    )
    expect(
      redactSensitiveText('GET https://example.test/a?signature=secret failed; Bearer abc', [
        'abc',
      ]),
    ).toBe('GET https://example.test/a failed; Bearer [redacted]')
    expect(redactSensitiveText('safe\u202eexe\nnext')).toBe('safe\\u202eexe\\u000anext')
    expect(redactUrlForLogs('not a URL')).toBe('[invalid URL]')
    expect(redactSensitiveText('https://example.test/a')).toBe('https://example.test/a')
    expect(redactSensitiveText('https://example.test/a).')).toBe('https://example.test/a).')
  })

  it('redacts exact secrets before transformations can expose a prefix or suffix', () => {
    const urlCredential = 'https://token.example/private?credential=abc'
    expect(redactSensitiveText(`server echoed ${urlCredential}`, [urlCredential])).toBe(
      'server echoed [redacted]',
    )
    expect(redactSensitiveText('Bearer alpha,beta', ['alpha,beta'])).toBe('Bearer [redacted]')
    expect(redactSensitiveText('https://%', ['[invalid URL]'])).toBe('[redacted]')
    expect(redactSensitiveText('safe', [''])).toBe('safe')
  })

  it('sanitizes client versions with a safe fallback', () => {
    expect(sanitizeClientVersion('refs/tags/v2')).toBe('refs-tags-v2')
    expect(sanitizeClientVersion('', '2.7.1')).toBe('2.7.1')
    expect(sanitizeClientVersion('', '')).toBe('unknown')
    expect(sanitizeClientVersion(`v${'1'.repeat(100)}`)).toHaveLength(64)
  })
})

describe('submission and polling', () => {
  it('submits, refreshes auth, polls with backoff, and returns only a successful result', async () => {
    const fetch = queuedFetch(
      json(submission(), 202),
      json(status('queued')),
      json({ message: 'busy' }, 503, { 'retry-after': '2' }),
      json(status('running')),
      json(succeeded()),
    ) as ReturnType<typeof vi.fn>
    const tokens = ['token-1', 'token-2', 'token-3', 'token-4', 'token-5']
    const getAccessToken = vi.fn(async () => tokens.shift() ?? 'unexpected')
    const delays: number[] = []
    let now = Date.parse(CREATED_AT)
    const statuses: string[] = []

    const result = await runMigrationAssessment(baseInput(), {
      apiBaseUrl: 'https://api.example/',
      getAccessToken,
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
        now += milliseconds
      },
      timeoutMs: 60_000,
      initialPollIntervalMs: 1_000,
      maxPollIntervalMs: 5_000,
      retryJitterRatio: 0,
      idempotencyKey: 'workflow-123',
      onStatus: (value) => statuses.push(value),
    })

    expect(result.status).toBe('succeeded')
    expect(result.statusUrl).toBe('https://api.example/v1/migration-assessments/assessment_1')
    expect(getAccessToken).toHaveBeenCalledTimes(5)
    expect(delays).toEqual([1_000, 2_000, 4_000])
    expect(statuses).toEqual(['queued', 'running', 'succeeded'])
    expect(
      fetch.mock.calls.map((call) => (call[1]?.headers as Record<string, string>).authorization),
    ).toEqual([
      'Bearer token-1',
      'Bearer token-2',
      'Bearer token-3',
      'Bearer token-4',
      'Bearer token-5',
    ])
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'error' }))
    expect(fetch.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({
        'idempotency-key': 'workflow-123',
      }),
    )
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      protocolVersion: 1,
      repositories: [{ repository: 'FlagShark/example', ref: 'a'.repeat(40) }],
      launchDarklyProjectKey: 'production',
      client: { kind: 'cli', version: '2.7.1' },
    })
  })

  it('rejects cross-origin or query-bearing status URLs before sending auth there', async () => {
    for (const statusUrl of [
      'https://evil.example/status',
      'https://api.example/status?signature=secret',
    ]) {
      const fetch = queuedFetch(json(submission({ statusUrl }), 202)) as ReturnType<typeof vi.fn>
      await expectClientError(
        runMigrationAssessment(baseInput(), {
          apiBaseUrl: 'https://api.example/',
          getAccessToken: () => 'token',
          fetch,
        }),
        'INVALID_URL',
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it('surfaces bounded terminal errors without retaining signed URLs or raw causes', async () => {
    const error = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'secret-token',
        fetch: queuedFetch(
          json(submission(), 202),
          json(
            status('failed', {
              error: {
                code: 'SOURCE_FAILED',
                message:
                  'Download https://store.example/a?signature=secret with Bearer secret-token failed',
              },
            }),
          ),
        ),
      }),
      'SOURCE_FAILED',
    )
    expect(error.message).toBe('Download https://store.example/a with Bearer [redacted] failed')
    expect(error.cause).toBeUndefined()
  })

  it('redacts the exact per-request credential from API and terminal errors', async () => {
    const createToken = 'fsa_create_secret_123'
    const createError = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => createToken,
        fetch: queuedFetch(
          json(
            {
              error: {
                code: 'DENIED',
                message: `Credential ${createToken} is invalid`,
              },
            },
            401,
          ),
        ),
      }),
      'DENIED',
    )
    expect(createError.message).toBe('Credential [redacted] is invalid')

    const statusToken = 'oidc_status_secret_456'
    const tokens = ['submission-token', statusToken]
    const statusError = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => tokens.shift() ?? 'unexpected-token',
        fetch: queuedFetch(
          json(submission(), 202),
          json(
            status('failed', {
              error: {
                code: 'SOURCE_FAILED',
                message: `Upstream echoed ${statusToken}`,
              },
            }),
          ),
        ),
      }),
      'SOURCE_FAILED',
    )
    expect(statusError.message).toBe('Upstream echoed [redacted]')
  })

  it('maps expired and timed-out assessments to stable errors', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission(), 202), json(status('expired'))),
      }),
      'ASSESSMENT_EXPIRED',
    )

    let now = 0
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission(), 202), json(status('queued'))),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        timeoutMs: 1_000,
        initialPollIntervalMs: 1_000,
        maxPollIntervalMs: 1_000,
      }),
      'ASSESSMENT_TIMEOUT',
    )
  })

  it('rejects identity/timestamp drift and invalid idempotency keys', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          json(submission(), 202),
          json(status('running', { assessmentId: 'other' })),
        ),
      }),
      'INVALID_RESPONSE',
    )

    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission(), 202)),
        idempotencyKey: 'bad key',
      }),
      'INVALID_OPTIONS',
    )
  })

  it('rejects a running-to-queued lifecycle regression', async () => {
    let now = Date.parse(CREATED_AT)
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          json(submission(), 202),
          json(status('running')),
          json(status('queued', { updatedAt: '2026-07-12T10:02:00.000Z' })),
        ),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      }),
      'INVALID_RESPONSE',
    )
  })

  it.each([
    [
      'createdAt changed',
      {
        createdAt: '2026-07-12T10:00:01.000Z',
        updatedAt: '2026-07-12T10:02:00.000Z',
      },
    ],
    ['updatedAt moved backwards', { updatedAt: '2026-07-12T10:00:30.000Z' }],
  ])('rejects status history when %s', async (_name, secondStatus) => {
    let now = 0
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          json(submission(), 202),
          json(status('running', { updatedAt: '2026-07-12T10:01:00.000Z' })),
          json(status('running', secondStatus)),
        ),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      }),
      'INVALID_RESPONSE',
    )
  })

  it('bounds a hung access-token provider by the overall timeout', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => new Promise<string>(() => {}),
        fetch: queuedFetch(),
        timeoutMs: 5,
      }),
      'ASSESSMENT_TIMEOUT',
    )
  })

  it('bounds fetch, retry-delay, and response-body implementations that ignore AbortSignal', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: () => new Promise<Response>(() => {}),
        timeoutMs: 5,
      }),
      'ASSESSMENT_TIMEOUT',
    )

    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: async () => {
          throw new Error('retry')
        },
        sleep: () => new Promise<void>(() => {}),
        timeoutMs: 5,
      }),
      'ASSESSMENT_TIMEOUT',
    )

    const hangingBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    })
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(new Response(hangingBody, { status: 202 })),
        timeoutMs: 5,
      }),
      'ASSESSMENT_TIMEOUT',
    )
  })

  it('settles a late access-token promise harmlessly after cancellation', async () => {
    let resolveToken: (value: string) => void = () => {}
    const token = new Promise<string>((resolvePromise) => {
      resolveToken = resolvePromise
    })
    const controller = new AbortController()
    const running = runMigrationAssessment(baseInput(), {
      apiBaseUrl: 'https://api.example/',
      getAccessToken: () => token,
      fetch: queuedFetch(),
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort()
    await expectClientError(running, 'ABORTED')
    resolveToken('late-token')
    await Promise.resolve()
  })

  it('does not retain raw auth-provider or network errors', async () => {
    const authError = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => {
          throw new Error('provider secret')
        },
        fetch: queuedFetch(),
      }),
      'AUTH_TOKEN_UNAVAILABLE',
    )
    expect(authError.cause).toBeUndefined()

    let now = 0
    const networkError = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'secret-token',
        fetch: async () => {
          throw new Error('https://api.example/x?secret=yes secret-token')
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        timeoutMs: 1_000,
        initialPollIntervalMs: 1_000,
        maxPollIntervalMs: 1_000,
      }),
      'ASSESSMENT_TIMEOUT',
    )
    expect(networkError.message).not.toContain('secret-token')
    expect(networkError.message).not.toContain('?secret')
    expect(networkError.cause).toBeUndefined()
  })

  it('normalizes non-Error network failures', async () => {
    let now = 0
    const error = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: async () => {
          throw 'socket closed'
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        timeoutMs: 1,
        initialPollIntervalMs: 1,
        maxPollIntervalMs: 1,
      }),
      'ASSESSMENT_TIMEOUT',
    )
    expect(error.message).not.toContain('socket closed')
  })

  it('recovers from a lost POST response and a polling network blip with one idempotency key', async () => {
    const calls: Array<{
      url: string
      idempotencyKey?: string
      authorization?: string
    }> = []
    let call = 0
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        idempotencyKey: (init?.headers as Record<string, string>)?.['idempotency-key'],
        authorization: (init?.headers as Record<string, string>)?.authorization,
      })
      call += 1
      if (call === 1) throw new Error('lost response https://api.example/create?token=secret')
      if (call === 2) return json(submission(), 202)
      if (call === 3) throw new Error('poll https://api.example/status?token=secret')
      return json(succeeded())
    })
    let now = 0
    const delays: number[] = []
    const submitted: unknown[] = []
    const result = await runMigrationAssessment(baseInput(), {
      apiBaseUrl: 'https://api.example/',
      getAccessToken: () => 'rotating-token',
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
        now += milliseconds
      },
      timeoutMs: 10_000,
      initialPollIntervalMs: 100,
      maxPollIntervalMs: 1_000,
      retryJitterRatio: 0,
      idempotencyKey: 'same-invocation-key',
      onSubmitted: (value) => submitted.push(value),
    })
    expect(result.status).toBe('succeeded')
    expect(delays).toEqual([100, 100])
    expect(calls.slice(0, 2).map((entry) => entry.idempotencyKey)).toEqual([
      'same-invocation-key',
      'same-invocation-key',
    ])
    expect(calls.every((entry) => entry.authorization === 'Bearer rotating-token')).toBe(true)
    expect(submitted).toEqual([
      expect.objectContaining({
        assessmentId: 'assessment_1',
        statusUrl: 'https://api.example/v1/migration-assessments/assessment_1',
      }),
    ])
  })

  it('adds bounded jitter above API and status Retry-After minima', async () => {
    let call = 0
    const fetch = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error('lost create response')
      if (call === 2) return json(submission(), 202)
      if (call === 3)
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '2' },
        })
      return json(succeeded())
    })
    let now = 0
    const delays: number[] = []
    expect(
      (
        await runMigrationAssessment(baseInput(), {
          apiBaseUrl: 'https://api.example/',
          getAccessToken: () => 'token',
          fetch,
          now: () => now,
          sleep: async (milliseconds) => {
            delays.push(milliseconds)
            now += milliseconds
          },
          initialPollIntervalMs: 100,
          maxPollIntervalMs: 100,
          random: () => 0.5,
          retryJitterRatio: 0.2,
        })
      ).status,
    ).toBe('succeeded')
    expect(delays).toEqual([110, 2_200])
  })

  it('retries ambiguous mid-body resets on both create and status', async () => {
    const idempotencyKeys: Array<string | undefined> = []
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        idempotencyKeys.push((init.headers as Record<string, string>)['idempotency-key'])
      }
      const call = fetch.mock.calls.length
      if (call === 1) return failingBodyResponse(202)
      if (call === 2) return json(submission(), 202)
      if (call === 3) return failingBodyResponse(200)
      return json(succeeded())
    })
    let now = 0
    expect(
      (
        await runMigrationAssessment(baseInput(), {
          apiBaseUrl: 'https://api.example/',
          getAccessToken: () => 'token',
          fetch,
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds
          },
          initialPollIntervalMs: 1,
          maxPollIntervalMs: 1,
          idempotencyKey: 'mid-body-key',
        })
      ).status,
    ).toBe('succeeded')
    expect(idempotencyKeys).toEqual(['mid-body-key', 'mid-body-key'])
  })

  it.each([
    ['HTTP-date Retry-After', new Date(2_000).toUTCString(), 2_000],
    ['invalid Retry-After', 'not-a-delay', 100],
  ])('retries transient POST responses with %s', async (_name, retryAfter, expectedDelay) => {
    let now = 0
    const delays: number[] = []
    expect(
      (
        await runMigrationAssessment(baseInput(), {
          apiBaseUrl: 'https://api.example/',
          getAccessToken: () => 'token',
          fetch: queuedFetch(
            new Response('busy', {
              status: 503,
              headers: { 'retry-after': retryAfter },
            }),
            json(submission(), 202),
            json(succeeded()),
          ),
          now: () => now,
          sleep: async (milliseconds) => {
            delays.push(milliseconds)
            now += milliseconds
          },
          initialPollIntervalMs: 100,
          maxPollIntervalMs: 5_000,
          retryJitterRatio: 0,
        })
      ).status,
    ).toBe('succeeded')
    expect(delays[0]).toBe(expectedDelay)
  })

  it('surfaces non-retryable quota errors and honors long retryable Retry-After values', async () => {
    const quotaFetch = vi.fn(async () =>
      json(
        {
          error: {
            code: 'DAILY_JOB_LIMIT_EXCEEDED',
            message: 'Daily migration-assessment limit exceeded',
            retryable: false,
          },
        },
        429,
        { 'retry-after': '3600' },
      ),
    )
    const quotaError = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: quotaFetch,
        sleep: async () => {
          throw new Error('must not retry')
        },
      }),
      'DAILY_JOB_LIMIT_EXCEEDED',
    )
    expect(quotaError.retryable).toBe(false)
    expect(quotaFetch).toHaveBeenCalledTimes(1)

    let now = 0
    const delays: number[] = []
    expect(
      (
        await runMigrationAssessment(baseInput(), {
          apiBaseUrl: 'https://api.example/',
          getAccessToken: () => 'token',
          fetch: queuedFetch(
            json(
              {
                error: {
                  code: 'ACTIVE_JOB_LIMIT',
                  message: 'Try later',
                  retryable: true,
                },
              },
              429,
              {
                'retry-after': '15',
              },
            ),
            json(submission(), 202),
            json(succeeded()),
          ),
          now: () => now,
          sleep: async (milliseconds) => {
            delays.push(milliseconds)
            now += milliseconds
          },
          timeoutMs: 20_000,
          initialPollIntervalMs: 100,
          maxPollIntervalMs: 1_000,
          retryJitterRatio: 0,
        })
      ).status,
    ).toBe('succeeded')
    expect(delays[0]).toBe(15_000)
  })

  it('does not retry non-transient API errors', async () => {
    const fetch = vi.fn(async () =>
      json(
        {
          error: { code: 'AUTH_DENIED', message: 'Workspace access denied' },
        },
        403,
      ),
    )
    const error = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch,
      }),
      'AUTH_DENIED',
    )
    expect(error.httpStatus).toBe(403)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry an explicitly non-retryable transient-class status response', async () => {
    const fetch = queuedFetch(
      json(submission(), 202),
      json(
        {
          error: {
            code: 'JOB_TERMINATED',
            message: 'Job cannot continue',
            retryable: false,
          },
        },
        503,
      ),
    ) as ReturnType<typeof vi.fn>
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch,
      }),
      'JOB_TERMINATED',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses a bounded generic HTTP error for malformed error bodies', async () => {
    const error = await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(new Response('{', { status: 400 })),
      }),
      'HTTP_ERROR',
    )
    expect(error.message).toBe('Assessment API returned HTTP 400')
  })

  it.each([
    [{ timeoutMs: 0 }, 'INVALID_OPTIONS'],
    [{ initialPollIntervalMs: 10, maxPollIntervalMs: 1 }, 'INVALID_OPTIONS'],
    [{ retryJitterRatio: -0.1 }, 'INVALID_OPTIONS'],
    [{ retryJitterRatio: 0.6 }, 'INVALID_OPTIONS'],
    [{ now: () => Number.NaN }, 'INVALID_OPTIONS'],
  ])('rejects invalid run options %#', async (overrides, code) => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(),
        ...overrides,
      }),
      code,
    )
  })

  it.each([Number.NaN, -0.1, 1])('rejects invalid retry RNG output %#', async (sample) => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: async () => {
          throw new Error('retry')
        },
        random: () => sample,
      }),
      'INVALID_OPTIONS',
    )
  })

  it('normalizes a retry RNG exception', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: async () => {
          throw new Error('retry')
        },
        random: () => {
          throw new Error('rng internals')
        },
      }),
      'INVALID_OPTIONS',
    )
  })

  it('rejects a clock that becomes non-finite during polling', async () => {
    let call = 0
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission(), 202)),
        now: () => (++call === 1 ? 0 : Number.NaN),
      }),
      'INVALID_OPTIONS',
    )
  })

  it('rejects a non-finite clock while interpreting an HTTP-date Retry-After', async () => {
    let call = 0
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          new Response('busy', {
            status: 503,
            headers: { 'retry-after': new Date(2_000).toUTCString() },
          }),
        ),
        now: () => (++call === 1 ? 0 : Number.NaN),
      }),
      'INVALID_OPTIONS',
    )
  })

  it('maps retry-delay failures and external cancellation to stable errors', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: async () => {
          throw new Error('transient')
        },
        sleep: async () => {
          throw new Error('timer failed')
        },
      }),
      'POLLING_ERROR',
    )

    const controller = new AbortController()
    controller.abort()
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(),
        signal: controller.signal,
      }),
      'ABORTED',
    )

    const duringDelay = new AbortController()
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: async () => {
          throw new Error('transient')
        },
        signal: duringDelay.signal,
        sleep: async () => {
          duringDelay.abort()
          throw new Error('aborted')
        },
      }),
      'ABORTED',
    )

    const duringFetch = new AbortController()
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        signal: duringFetch.signal,
        fetch: async () => {
          duringFetch.abort()
          throw new Error('aborted fetch')
        },
      }),
      'ABORTED',
    )
  })

  it('uses default API and fetch implementations when omitted', async () => {
    const fetch = queuedFetch(
      json(submission({ statusUrl: '/api/v1/migration-assessments/assessment_1' }), 202),
      json(succeeded()),
    )
    vi.stubGlobal('fetch', fetch)
    try {
      expect(
        (
          await runMigrationAssessment(baseInput(), {
            getAccessToken: () => 'token',
          })
        ).status,
      ).toBe('succeeded')
      expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe(
        'https://api.flagshark.com/api/v1/migration-assessments',
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(['', ' token', 'token\nvalue', 'token\ud800'])(
    'rejects invalid access token %#',
    async (token) => {
      await expectClientError(
        runMigrationAssessment(baseInput(), {
          apiBaseUrl: 'https://api.example/',
          getAccessToken: () => token,
          fetch: queuedFetch(),
        }),
        'AUTH_TOKEN_INVALID',
      )
    },
  )

  it('rejects malformed successful JSON without retrying', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(new Response('{', { status: 202 })),
      }),
      'INVALID_RESPONSE',
    )
  })

  it('rejects malformed status JSON and non-transient status HTTP errors', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission(), 202), new Response('{', { status: 200 })),
      }),
      'INVALID_RESPONSE',
    )

    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          json(submission(), 202),
          json({ error: { code: 'DENIED', message: 'Denied' } }, 403),
        ),
      }),
      'DENIED',
    )
  })

  it('does not retry oversized transient response bodies', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          new Response('busy', {
            status: 503,
            headers: { 'content-length': String(300 * 1024) },
          }),
        ),
      }),
      'RESPONSE_TOO_LARGE',
    )

    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(
          json(submission(), 202),
          new Response('busy', {
            status: 503,
            headers: { 'content-length': String(300 * 1024) },
          }),
        ),
      }),
      'RESPONSE_TOO_LARGE',
    )
  })

  it('stops polling when auth refresh becomes invalid', async () => {
    let tokenCall = 0
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => (++tokenCall === 1 ? 'token' : ''),
        fetch: queuedFetch(json(submission(), 202)),
      }),
      'AUTH_TOKEN_INVALID',
    )
  })

  it('honors cancellation after submission but before the first status request', async () => {
    const controller = new AbortController()
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission(), 202)),
        signal: controller.signal,
        onStatus: () => controller.abort(),
      }),
      'ABORTED',
    )
  })

  it('rejects an unparseable same-origin status URL', async () => {
    await expectClientError(
      runMigrationAssessment(baseInput(), {
        apiBaseUrl: 'https://api.example/',
        getAccessToken: () => 'token',
        fetch: queuedFetch(json(submission({ statusUrl: 'http://[' }), 202)),
      }),
      'INVALID_URL',
    )
  })
})

describe('artifact download', () => {
  it('downloads a bounded JSON artifact without attaching API authorization', async () => {
    const fetch = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      json({ assessment: true }),
    )
    const bytes = await downloadMigrationAssessmentArtifact(completed(), 'json', {
      fetch,
      now: () => Date.parse(CREATED_AT),
    })
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      assessment: true,
    })
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'flagshark-artifacts.s3.eu-west-2.amazonaws.com',
      }),
      expect.objectContaining({
        redirect: 'error',
        headers: { accept: 'application/json' },
      }),
    )
    expect(
      (fetch.mock.calls[0][1]?.headers as Record<string, string>).authorization,
    ).toBeUndefined()
  })

  it.each([
    ['expired', { now: () => Date.parse(EXPIRES_AT) }, 'ARTIFACT_EXPIRED'],
    [
      'too large',
      {
        fetch: async () => new Response('x', { headers: { 'content-length': '999' } }),
        maxBytes: 10,
      },
      'RESPONSE_TOO_LARGE',
    ],
    ['empty', { fetch: async () => new Response('') }, 'INVALID_ARTIFACT'],
    ['bad json', { fetch: async () => new Response('{') }, 'INVALID_ARTIFACT'],
    [
      'invalid UTF-8',
      { fetch: async () => new Response(new Uint8Array([0xff])) },
      'INVALID_RESPONSE',
    ],
    [
      'stream overflow',
      { fetch: async () => new Response('123456'), maxBytes: 5 },
      'RESPONSE_TOO_LARGE',
    ],
    [
      'HTTP failure',
      { fetch: async () => new Response('no', { status: 403 }) },
      'ARTIFACT_DOWNLOAD_FAILED',
    ],
    ['bodyless response', { fetch: async () => new Response(null) }, 'INVALID_ARTIFACT'],
  ])('rejects %s artifacts', async (_name, overrides, code) => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'json', {
        fetch: async () => json({ ok: true }),
        now: () => Date.parse(CREATED_AT),
        ...overrides,
      }),
      code,
    )
  })

  it('bounds repeated signed-URL network errors without exposing their query', async () => {
    let now = 0
    const error = await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => {
          throw new Error('GET https://artifacts.example/report.md?signature=secret failed')
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        timeoutMs: 1,
        initialRetryIntervalMs: 1,
        maxRetryIntervalMs: 1,
        retryJitterRatio: 0,
      }),
      'ASSESSMENT_TIMEOUT',
    )
    expect(error.message).not.toContain('signature')
    expect(error.cause).toBeUndefined()
  })

  it('bounds a non-Error artifact network failure', async () => {
    let now = 0
    const error = await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => {
          throw 'socket closed'
        },
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        timeoutMs: 1,
        initialRetryIntervalMs: 1,
        maxRetryIntervalMs: 1,
        retryJitterRatio: 0,
      }),
      'ASSESSMENT_TIMEOUT',
    )
    expect(error.message).not.toContain('socket closed')
  })

  it('retries a response-stream NETWORK_ERROR and succeeds without auth', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('https://artifacts.example/report?signature=secret'))
      },
    })
    const fetch = queuedFetch(new Response(stream), new Response('recovered')) as ReturnType<
      typeof vi.fn
    >
    let now = 0
    const bytes = await downloadMigrationAssessmentArtifact(completed(), 'markdown', {
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
      initialRetryIntervalMs: 1,
      maxRetryIntervalMs: 1,
      retryJitterRatio: 0,
    })
    expect(new TextDecoder().decode(bytes)).toBe('recovered')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(
      fetch.mock.calls.every(
        (call) => (call[1]?.headers as Record<string, string>).authorization === undefined,
      ),
    ).toBe(true)
  })

  it('retries artifact 429/5xx with jitter above Retry-After', async () => {
    const fetch = queuedFetch(
      new Response(null, { status: 429, headers: { 'retry-after': '2' } }),
      new Response(null, { status: 503 }),
      new Response('report'),
    ) as ReturnType<typeof vi.fn>
    let now = 0
    const delays: number[] = []
    const bytes = await downloadMigrationAssessmentArtifact(completed(), 'markdown', {
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
        now += milliseconds
      },
      initialRetryIntervalMs: 100,
      maxRetryIntervalMs: 100,
      random: () => 0.5,
      retryJitterRatio: 0.2,
    })
    expect(new TextDecoder().decode(bytes)).toBe('report')
    expect(delays).toEqual([2_200, 110])
    expect(
      fetch.mock.calls.every(
        (call) => (call[1]?.headers as Record<string, string>).authorization === undefined,
      ),
    ).toBe(true)
  })

  it.each([
    [
      '4xx',
      'markdown',
      () => new Response('denied', { status: 403 }),
      {},
      'ARTIFACT_DOWNLOAD_FAILED',
    ],
    ['oversize', 'markdown', () => new Response('123456'), { maxBytes: 5 }, 'RESPONSE_TOO_LARGE'],
    ['invalid JSON', 'json', () => new Response('{'), {}, 'INVALID_ARTIFACT'],
  ])('never retries %s artifact failures', async (_name, format, response, options, code) => {
    const fetch = vi.fn(async () => response())
    const sleep = vi.fn(async () => {})
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), format as 'markdown' | 'json', {
        fetch,
        sleep,
        ...options,
      }),
      code,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([
    'http://localhost/report.md',
    'https://localhost/report.md',
    'https://127.0.0.1/report.md',
    'https://[::1]/report.md',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/report.md',
    'https://172.16.0.1/report.md',
    'https://192.168.1.1/report.md',
    'https://[fe80::1]/report.md',
    'https://[fd00::1]/report.md',
    'https://reports.example.com/report.md',
    'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com:444/report.md',
  ])('rejects untrusted artifact URL %s for a production assessment', async (url) => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(completedWithArtifact(url), 'markdown', {
        fetch: async () => new Response('must not fetch'),
      }),
      'UNTRUSTED_ARTIFACT_URL',
    )
  })

  it('rejects ill-formed UTF-16 in direct artifact and completed-status URLs', async () => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(
        completedWithArtifact('https://flagshark-artifacts.s3.amazonaws.com/report-\ud800.md'),
        'markdown',
        { fetch: async () => new Response('must not fetch') },
      ),
      'INVALID_URL',
    )

    await expectClientError(
      downloadMigrationAssessmentArtifact(
        completedWithArtifact(
          'https://flagshark-artifacts.s3.amazonaws.com/report.md',
          'https://api.example/status-\udc00',
        ),
        'markdown',
        {
          fetch: async () => new Response('must not fetch'),
        },
      ),
      'INVALID_URL',
    )
  })

  it('allows loopback artifacts only for a loopback assessment API', async () => {
    const bytes = await downloadMigrationAssessmentArtifact(
      completedWithArtifact(
        'http://localhost:9999/report.md',
        'http://127.0.0.1:8888/v1/migration-assessments/a',
      ),
      'markdown',
      {
        fetch: async () => new Response('local report'),
      },
    )
    expect(new TextDecoder().decode(bytes)).toBe('local report')
  })

  it('allows an explicit non-S3 HTTPS hostname without allowing literal IPs', async () => {
    const bytes = await downloadMigrationAssessmentArtifact(
      completedWithArtifact('https://reports.example.com/report.md'),
      'markdown',
      {
        allowedArtifactHosts: ['reports.example.com'],
        fetch: async () => new Response('allowed report'),
      },
    )
    expect(new TextDecoder().decode(bytes)).toBe('allowed report')

    await expectClientError(
      downloadMigrationAssessmentArtifact(
        completedWithArtifact('https://10.0.0.1/report.md'),
        'markdown',
        {
          allowedArtifactHosts: ['10.0.0.1'],
          fetch: async () => new Response('must not fetch'),
        },
      ),
      'INVALID_OPTIONS',
    )
  })

  it('validates the completed status URL before deriving artifact trust', async () => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(
        completedWithArtifact(
          'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com/report.md',
          'not a URL',
        ),
        'markdown',
      ),
      'INVALID_URL',
    )

    await expectClientError(
      downloadMigrationAssessmentArtifact(
        completedWithArtifact(
          'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com/report.md',
          'https://api.example/status?token=secret',
        ),
        'markdown',
      ),
      'INVALID_URL',
    )
  })

  it('does not await a hanging stream cancel after overflow', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16))
      },
      cancel: () => new Promise<void>(() => {}),
    })
    const result = downloadMigrationAssessmentArtifact(completed(), 'markdown', {
      fetch: async () => new Response(stream),
      maxBytes: 8,
    })
    await expect(
      Promise.race([
        result,
        new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung')), 100)),
      ]),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })

  it('grows its bounded streaming buffer without chunk duplication', async () => {
    const content = 'x'.repeat(70 * 1024)
    const bytes = await downloadMigrationAssessmentArtifact(completed(), 'markdown', {
      fetch: async () => new Response(content),
      now: () => Date.parse(CREATED_AT),
      maxBytes: 80 * 1024,
    })
    expect(bytes.byteLength).toBe(content.length)
  })

  it.each([
    ['invalid format', 'xml', {}, 'INVALID_OPTIONS'],
    ['invalid clock', 'markdown', { now: () => Number.NaN }, 'INVALID_OPTIONS'],
    ['invalid timeout', 'markdown', { timeoutMs: 0 }, 'INVALID_OPTIONS'],
    ['invalid size', 'markdown', { maxBytes: 0 }, 'INVALID_OPTIONS'],
    [
      'invalid retry intervals',
      'markdown',
      { initialRetryIntervalMs: 10, maxRetryIntervalMs: 1 },
      'INVALID_OPTIONS',
    ],
    ['invalid jitter', 'markdown', { retryJitterRatio: 0.6 }, 'INVALID_OPTIONS'],
    ['invalid allowlist', 'markdown', { allowedArtifactHosts: ['LOCALHOST'] }, 'INVALID_OPTIONS'],
    [
      'oversized allowlist',
      'markdown',
      {
        allowedArtifactHosts: Array.from({ length: 33 }, (_, index) => `h${index}.example.com`),
      },
      'INVALID_OPTIONS',
    ],
    [
      'non-array allowlist',
      'markdown',
      { allowedArtifactHosts: 'reports.example.com' },
      'INVALID_OPTIONS',
    ],
  ])('rejects %s download options', async (_name, format, overrides, code) => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), format as never, {
        fetch: async () => new Response('ok'),
        now: () => Date.parse(CREATED_AT),
        ...(overrides as DownloadMigrationAssessmentArtifactOptions),
      }),
      code,
    )
  })

  it('rejects sparse artifact-host allowlists', async () => {
    const allowedArtifactHosts = new Array(1) as string[]
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        allowedArtifactHosts,
      }),
      'INVALID_OPTIONS',
    )
  })

  it('validates artifact retry RNG output', async () => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => new Response(null, { status: 503 }),
        random: () => 1,
      }),
      'INVALID_OPTIONS',
    )
  })

  it('checks the retry deadline before invoking an injected sleep', async () => {
    let clockCall = 0
    const now = () => {
      clockCall += 1
      return clockCall >= 4 ? 1 : 0
    }
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => {
          throw new Error('retry')
        },
        now,
        timeoutMs: 1,
        sleep: async () => {
          throw new Error('must not sleep')
        },
        retryJitterRatio: 0,
      }),
      'ASSESSMENT_TIMEOUT',
    )
  })

  it('rejects a clock that becomes non-finite inside the artifact loop', async () => {
    let clockCall = 0
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        now: () => (++clockCall === 1 ? 0 : Number.NaN),
      }),
      'INVALID_OPTIONS',
    )
  })

  it('maps artifact retry-delay failures and cancellation', async () => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => new Response(null, { status: 503 }),
        sleep: async () => {
          throw new Error('timer failed')
        },
        retryJitterRatio: 0,
      }),
      'ARTIFACT_RETRY_ERROR',
    )

    const controller = new AbortController()
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => new Response(null, { status: 503 }),
        sleep: async () => {
          controller.abort()
          throw new Error('aborted')
        },
        signal: controller.signal,
        retryJitterRatio: 0,
      }),
      'ABORTED',
    )
  })

  it('rechecks signed URL expiry after a transient retry', async () => {
    let now = Date.parse(EXPIRES_AT) - 1_000
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: async () => new Response(null, { status: 503 }),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
        initialRetryIntervalMs: 1_000,
        maxRetryIntervalMs: 1_000,
        retryJitterRatio: 0,
      }),
      'ARTIFACT_EXPIRED',
    )
  })

  it('uses default artifact options and fetch implementation', async () => {
    vi.stubGlobal('fetch', async () => new Response('default artifact'))
    try {
      expect(
        new TextDecoder().decode(
          await downloadMigrationAssessmentArtifact(completed(), 'markdown'),
        ),
      ).toBe('default artifact')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps artifact cancellation to ABORTED', async () => {
    const controller = new AbortController()
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        signal: controller.signal,
        fetch: async () => {
          controller.abort()
          throw new Error('aborted')
        },
      }),
      'ABORTED',
    )
  })

  it('bounds an artifact fetch implementation that ignores AbortSignal', async () => {
    await expectClientError(
      downloadMigrationAssessmentArtifact(completed(), 'markdown', {
        fetch: () => new Promise<Response>(() => {}),
        timeoutMs: 5,
      }),
      'ASSESSMENT_TIMEOUT',
    )
  })
})

describe('abort-aware sleep', () => {
  it('rejects an already-aborted signal without scheduling a delay', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(defaultAssessmentSleep(100, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('resolves an active zero-length delay', async () => {
    await expect(defaultAssessmentSleep(0, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('cancels a delay after its timer has been scheduled', async () => {
    const controller = new AbortController()
    const sleeping = defaultAssessmentSleep(1_000, controller.signal)
    controller.abort()
    await expect(sleeping).rejects.toMatchObject({ name: 'AbortError' })
  })
})
