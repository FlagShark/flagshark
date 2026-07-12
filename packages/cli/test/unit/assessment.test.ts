import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  defaultRunGit,
  parseGitHubOrigin,
  resolveAssessmentRepositories,
  runAssessCommand,
  writeFileAtomically,
} from '../../src/assessment.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flagshark-assess-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function collect(stream: PassThrough): () => string {
  let value = ''
  stream.on('data', (chunk) => { value += chunk.toString() })
  return () => value
}

describe('GitHub repository inference', () => {
  it.each([
    ['https://github.com/FlagShark/flagshark.git', 'FlagShark/flagshark'],
    ['git@github.com:FlagShark/flagshark.git', 'FlagShark/flagshark'],
    ['ssh://git@github.com/FlagShark/flagshark.git', 'FlagShark/flagshark'],
    ['ssh://git@github.com:22/FlagShark/flagshark', 'FlagShark/flagshark'],
  ])('parses supported origin %s', (origin, expected) => {
    expect(parseGitHubOrigin(origin)).toBe(expected)
  })

  it.each([
    'http://github.com/owner/repo',
    'https://token@github.com/owner/repo.git',
    'https://github.example/owner/repo.git',
    'git@gitlab.com:owner/repo.git',
    'ssh://root@github.com/owner/repo.git',
    'https://github.com/owner/repo.git?token=secret',
    'https://github.com/owner/repo/extra',
    'https://github.com:444/owner/repo',
    'ssh://git@github.com:2222/owner/repo',
    'https://github.com/owner/re%70o',
    'git@github.com:owner/repo/extra',
    'not a URL',
    'https://github.com/owner/repo#fragment',
    'https://user:password@github.com/owner/repo',
    'https://github.com/owner/repo\nhttps://github.com/evil/repo',
    '',
  ])('rejects unsafe or unsupported origin %s', (origin) => {
    expect(parseGitHubOrigin(origin)).toBeUndefined()
  })

  it('infers origin and immutable HEAD only when the repository is inferred', async () => {
    const runGit = vi.fn(async (arguments_: readonly string[]) => {
      if (arguments_[0] === 'remote') return 'git@github.com:Owner/Repo.git\n'
      return `${'a'.repeat(40)}\n`
    })
    expect(await resolveAssessmentRepositories({ repositories: [] }, '/repo', runGit)).toEqual([
      { repository: 'Owner/Repo', ref: 'a'.repeat(40) },
    ])
    expect(runGit.mock.calls.map(([arguments_]) => arguments_)).toEqual([
      ['remote', 'get-url', 'origin'],
      ['rev-parse', '--verify', 'HEAD'],
    ])
  })

  it('does not apply the current checkout SHA to explicitly named repositories', async () => {
    const runGit = vi.fn(async () => 'b'.repeat(40))
    expect(await resolveAssessmentRepositories({
      repositories: ['other/repository', 'another/repository'],
    }, '/repo', runGit)).toEqual([
      { repository: 'other/repository' },
      { repository: 'another/repository' },
    ])
    expect(runGit).not.toHaveBeenCalled()
  })

  it('applies an explicit ref without invoking Git', async () => {
    const runGit = vi.fn()
    expect(await resolveAssessmentRepositories({
      repositories: ['owner/repository'],
      ref: 'release',
    }, '/repo', runGit)).toEqual([{ repository: 'owner/repository', ref: 'release' }])
    expect(runGit).not.toHaveBeenCalled()
  })

  it('reports precise inference failures without including raw Git output', async () => {
    await expect(resolveAssessmentRepositories({ repositories: [] }, '/repo', async () => {
      throw new Error('https://token@github.com/private/repo')
    })).rejects.toThrow('no readable Git origin')

    await expect(resolveAssessmentRepositories({ repositories: [] }, '/repo', async () =>
      'https://token@github.com/private/repo',
    )).rejects.toThrow('credential-free github.com')

    const runGit = vi.fn()
      .mockResolvedValueOnce('git@github.com:owner/repository.git')
      .mockResolvedValueOnce('not-a-commit')
    await expect(resolveAssessmentRepositories({ repositories: [] }, '/repo', runGit))
      .rejects.toThrow('no valid HEAD commit')
  })

  it('supports SHA-256 Git object IDs', async () => {
    const runGit = vi.fn()
      .mockResolvedValueOnce('git@github.com:owner/repository.git')
      .mockResolvedValueOnce('A'.repeat(64))
    expect(await resolveAssessmentRepositories({ repositories: [] }, '/repo', runGit)).toEqual([
      { repository: 'owner/repository', ref: 'a'.repeat(64) },
    ])
  })

  it('runs Git without a shell and maps process failures to a bounded error', async () => {
    const directory = await temporaryDirectory()
    await defaultRunGit(['init', '--quiet'], directory)
    expect((await defaultRunGit(['rev-parse', '--is-inside-work-tree'], directory)).trim()).toBe('true')
    await expect(defaultRunGit(['definitely-not-a-command'], directory)).rejects.toThrow('Git command failed')
  })
})

describe('atomic report output', () => {
  it('creates parent directories and atomically replaces an existing report', async () => {
    const directory = await temporaryDirectory()
    const output = join('nested', 'report.md')
    await writeFileAtomically(output, new TextEncoder().encode('# First\n'), directory)
    expect(await readFile(join(directory, output), 'utf8')).toBe('# First\n')

    await writeFile(join(directory, output), 'old')
    await writeFileAtomically(output, new TextEncoder().encode('# Final\n'), directory)
    expect(await readFile(join(directory, output), 'utf8')).toBe('# Final\n')
    expect(await readdir(join(directory, 'nested'))).toEqual(['report.md'])
  })
})

describe('assessment command preflight', () => {
  function successfulFetch(markdown = '# Assessment\n') {
    const responses = [
      new Response(JSON.stringify({
        protocolVersion: 1,
        assessmentId: 'unit_1',
        status: 'queued',
        statusUrl: '/status/unit_1',
      }), { status: 202 }),
      new Response(JSON.stringify({
        protocolVersion: 1,
        assessmentId: 'unit_1',
        status: 'succeeded',
        createdAt: '2026-07-12T10:00:00.000Z',
        updatedAt: '2026-07-12T10:01:00.000Z',
        artifacts: {
          markdown: { url: 'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com/artifact.md?secret=signed', expiresAt: '2099-01-01T00:00:00.000Z' },
          json: { url: 'https://flagshark-artifacts.s3.eu-west-2.amazonaws.com/artifact.json?secret=signed', expiresAt: '2099-01-01T00:00:00.000Z' },
        },
      })),
      new Response(markdown),
    ]
    return vi.fn(async (_input: string | URL, _init?: RequestInit) => {
      const response = responses.shift()
      if (!response) throw new Error('Unexpected request')
      return response
    })
  }

  it('fails before Git or network access when the selected token variable is missing', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    const runGit = vi.fn()
    const fetch = vi.fn()
    const exitCode = await runAssessCommand({
      repositories: ['owner/repository'],
      tokenEnvironmentVariable: 'CUSTOM_TOKEN',
      format: 'markdown',
      timeoutMs: 900_000,
    }, { stdout, stderr, cwd: '/repo' }, '2.7.1', {
      env: {},
      runGit,
      fetch,
    })
    expect(exitCode).toBe(2)
    expect(errorText()).toContain('CUSTOM_TOKEN is required')
    expect(runGit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('writes the selected server artifact to stdout and honors the API-base environment variable', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const output = collect(stdout)
    const fetch = successfulFetch()
    const exitCode = await runAssessCommand({
      repositories: ['owner/repository'],
      ref: 'main',
      tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
      format: 'markdown',
      output: '-',
      timeoutMs: 900_000,
    }, { stdout, stderr, cwd: '/repo' }, '2.7.1', {
      env: {
        FLAGSHARK_API_TOKEN: 'token',
        FLAGSHARK_API_BASE_URL: 'http://localhost/',
      },
      fetch,
    })
    expect(exitCode).toBe(0)
    expect(output()).toBe('# Assessment\n')
    expect(String(fetch.mock.calls[0][0])).toBe('http://localhost/v1/migration-assessments')
  })

  it('carries one timeout deadline through polling and artifact retries', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    let now = 0
    let statusRequests = 0
    let artifactRequests = 0
    const delays: number[] = []
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            assessmentId: 'deadline_1',
            status: 'queued',
            statusUrl: '/status/deadline_1',
          }),
          { status: 202 },
        )
      }
      if (url.pathname === '/status/deadline_1') {
        statusRequests += 1
        if (statusRequests === 1) {
          return new Response(
            JSON.stringify({
              protocolVersion: 1,
              assessmentId: 'deadline_1',
              status: 'running',
              createdAt: '2026-07-12T10:00:00.000Z',
              updatedAt: '2026-07-12T10:00:01.000Z',
            }),
          )
        }
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            assessmentId: 'deadline_1',
            status: 'succeeded',
            createdAt: '2026-07-12T10:00:00.000Z',
            updatedAt: '2026-07-12T10:00:02.000Z',
            artifacts: {
              markdown: {
                url: 'http://127.0.0.1/artifacts/deadline.md',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
              json: {
                url: 'http://127.0.0.1/artifacts/deadline.json',
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            },
          }),
        )
      }
      artifactRequests += 1
      return new Response('temporarily unavailable', { status: 503 })
    })

    const exitCode = await runAssessCommand(
      {
        repositories: ['owner/repository'],
        tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
        format: 'markdown',
        timeoutMs: 1_500,
        apiBaseUrl: 'http://127.0.0.1/',
      },
      { stdout, stderr, cwd: '/repo' },
      '2.7.1',
      {
        env: { FLAGSHARK_API_TOKEN: 'token' },
        fetch,
        now: () => now,
        sleep: async (milliseconds) => {
          delays.push(milliseconds)
          now += milliseconds
        },
      },
    )

    expect(exitCode).toBe(2)
    expect(errorText()).toContain('artifact download timed out')
    expect(statusRequests).toBe(2)
    expect(artifactRequests).toBe(1)
    expect(delays).toHaveLength(2)
    expect(delays[0]).toBeGreaterThanOrEqual(1_000)
    expect(delays[1]).toBeLessThanOrEqual(500)
    expect(now).toBe(1_500)
  })

  it('does not begin an artifact download after polling consumes the deadline', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    let now = 0
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            protocolVersion: 1,
            assessmentId: 'deadline_2',
            status: 'queued',
            statusUrl: '/status/deadline_2',
          }),
          { status: 202 },
        )
      }
      now = 100
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          assessmentId: 'deadline_2',
          status: 'succeeded',
          createdAt: '2026-07-12T10:00:00.000Z',
          updatedAt: '2026-07-12T10:00:01.000Z',
          artifacts: {
            markdown: {
              url: 'http://127.0.0.1/artifacts/deadline.md',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
            json: {
              url: 'http://127.0.0.1/artifacts/deadline.json',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          },
        }),
      )
    })

    expect(
      await runAssessCommand(
        {
          repositories: ['owner/repository'],
          tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
          format: 'markdown',
          timeoutMs: 100,
          apiBaseUrl: 'http://127.0.0.1/',
        },
        { stdout, stderr, cwd: '/repo' },
        '2.7.1',
        {
          env: { FLAGSHARK_API_TOKEN: 'token' },
          fetch,
          now: () => now,
        },
      ),
    ).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(errorText()).toContain('Migration assessment timed out')
  })

  it.each([0, 1.5])('rejects an invalid direct timeout value %s before network access', async (timeoutMs) => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    const fetch = vi.fn()
    expect(
      await runAssessCommand(
        {
          repositories: ['owner/repository'],
          tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
          format: 'markdown',
          timeoutMs,
        },
        { stdout, stderr, cwd: '/repo' },
        '2.7.1',
        {
          env: { FLAGSHARK_API_TOKEN: 'token' },
          fetch,
        },
      ),
    ).toBe(2)
    expect(errorText()).toContain('timeoutMs must be a positive integer')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['at deadline creation', () => Number.NaN],
    [
      'while calculating the remaining budget',
      (() => {
        let calls = 0
        return () => (calls++ === 0 ? 0 : Number.NaN)
      })(),
    ],
  ])('rejects a non-finite clock %s', async (_case, now) => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    const fetch = vi.fn()
    expect(
      await runAssessCommand(
        {
          repositories: ['owner/repository'],
          tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
          format: 'markdown',
          timeoutMs: 100,
        },
        { stdout, stderr, cwd: '/repo' },
        '2.7.1',
        {
          env: { FLAGSHARK_API_TOKEN: 'token' },
          fetch,
          now,
        },
      ),
    ).toBe(2)
    expect(errorText()).toContain('now() must return a finite timestamp')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses process environment and the default API base when overrides are absent', async () => {
    const previousToken = process.env.FLAGSHARK_API_TOKEN
    const previousBase = process.env.FLAGSHARK_API_BASE_URL
    process.env.FLAGSHARK_API_TOKEN = 'process-token'
    delete process.env.FLAGSHARK_API_BASE_URL
    try {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const output = collect(stdout)
      const fetch = successfulFetch('default base')
      const exitCode = await runAssessCommand({
        repositories: ['owner/repository'],
        tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
        format: 'markdown',
        timeoutMs: 900_000,
      }, { stdout, stderr, cwd: '/repo' }, '2.7.1', { fetch })
      expect(exitCode).toBe(0)
      expect(output()).toBe('default base')
      expect(String(fetch.mock.calls[0][0])).toBe('https://api.flagshark.com/api/v1/migration-assessments')
    } finally {
      if (previousToken === undefined) delete process.env.FLAGSHARK_API_TOKEN
      else process.env.FLAGSHARK_API_TOKEN = previousToken
      if (previousBase === undefined) delete process.env.FLAGSHARK_API_BASE_URL
      else process.env.FLAGSHARK_API_BASE_URL = previousBase
    }
  })

  it('sanitizes non-Error failures in command diagnostics', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    const exitCode = await runAssessCommand({
      repositories: ['owner/repository'],
      tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
      format: 'markdown',
      timeoutMs: 900_000,
    }, { stdout, stderr, cwd: '/repo' }, '2.7.1', {
      env: { FLAGSHARK_API_TOKEN: 'secret-token' },
      now: () => { throw 'failure\u202esecret-token' },
    })
    expect(exitCode).toBe(2)
    expect(errorText()).toContain('failure\\u202e[redacted]')
    expect(errorText()).not.toContain('secret-token')
  })

  it('handles a token disappearing after preflight without exposing provider state', async () => {
    let reads = 0
    const env = Object.defineProperty({}, 'FLAGSHARK_API_TOKEN', {
      enumerable: true,
      get: () => {
        reads += 1
        return reads === 1 ? 'initial-token' : undefined
      },
    }) as Readonly<Record<string, string | undefined>>
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errorText = collect(stderr)
    const exitCode = await runAssessCommand({
      repositories: ['owner/repository'],
      tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
      format: 'markdown',
      timeoutMs: 900_000,
    }, { stdout, stderr, cwd: '/repo' }, '2.7.1', {
      env,
      fetch: successfulFetch(),
    })
    expect(exitCode).toBe(2)
    expect(errorText()).toContain('Could not obtain an assessment API access token')
    expect(errorText()).not.toContain('initial-token')
  })

  it('supports the default dependency object on credential preflight', async () => {
    const previous = process.env.FLAGSHARK_API_TOKEN
    delete process.env.FLAGSHARK_API_TOKEN
    try {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      expect(await runAssessCommand({
        repositories: ['owner/repository'],
        tokenEnvironmentVariable: 'FLAGSHARK_API_TOKEN',
        format: 'markdown',
        timeoutMs: 900_000,
      }, { stdout, stderr, cwd: '/repo' }, '2.7.1')).toBe(2)
    } finally {
      if (previous === undefined) delete process.env.FLAGSHARK_API_TOKEN
      else process.env.FLAGSHARK_API_TOKEN = previous
    }
  })
})
