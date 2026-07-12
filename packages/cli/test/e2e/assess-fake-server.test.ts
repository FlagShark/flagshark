import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runCli, VERSION } from '../../src/cli.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function collect(stream: PassThrough): () => string {
  let value = ''
  stream.on('data', (chunk) => { value += chunk.toString() })
  return () => value
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let value = ''
  for await (const chunk of request) value += chunk.toString()
  return value
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

describe('CLI E2E — private assessment API contract', () => {
  it('submits, polls, downloads signed Markdown without leaking credentials, and writes atomically', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = []
    let pollCount = 0
    let baseUrl = ''
    const server = createServer(async (request, response) => {
      const body = await requestBody(request)
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      })

      if (request.method === 'POST' && request.url === '/v1/migration-assessments') {
        sendJson(response, 202, {
          protocolVersion: 1,
          assessmentId: 'assessment_e2e',
          status: 'queued',
          statusUrl: '/v1/migration-assessments/assessment_e2e',
        })
        return
      }
      if (request.method === 'GET' && request.url === '/v1/migration-assessments/assessment_e2e') {
        pollCount += 1
        const common = {
          protocolVersion: 1,
          assessmentId: 'assessment_e2e',
          createdAt: '2026-07-12T10:00:00.000Z',
          updatedAt: `2026-07-12T10:00:0${pollCount}.000Z`,
        }
        if (pollCount === 1) sendJson(response, 200, { ...common, status: 'running' })
        else sendJson(response, 200, {
          ...common,
          status: 'succeeded',
          artifacts: {
            markdown: {
              url: `${baseUrl}/artifacts/report.md?signature=markdown-secret`,
              expiresAt: '2099-07-12T10:00:00.000Z',
            },
            json: {
              url: `${baseUrl}/artifacts/report.json?signature=json-secret`,
              expiresAt: '2099-07-12T10:00:00.000Z',
            },
          },
        })
        return
      }
      if (request.method === 'GET' && request.url === '/artifacts/report.md?signature=markdown-secret') {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        response.end('# First real migration assessment\n\nAutomated: 3\n')
        return
      }
      response.writeHead(404)
      response.end()
    })

    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      baseUrl = `http://127.0.0.1:${address.port}`
      const cwd = await mkdtemp(join(tmpdir(), 'flagshark-assess-e2e-'))
      directories.push(cwd)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdoutText = collect(stdout)
      const stderrText = collect(stderr)
      const exitCode = await runCli([
        'node',
        'flagshark',
        'assess',
        '--repo', 'FlagShark/prospect',
        '--ref', 'b'.repeat(40),
        '--project', 'production',
        '--api-base', baseUrl,
        '--output', 'reports/assessment.md',
      ], { stdout, stderr, cwd }, {
        env: { FLAGSHARK_API_TOKEN: 'api-token-secret' },
        sleep: async () => {},
      })

      expect(exitCode).toBe(0)
      expect(stdoutText()).toBe('')
      expect(await readFile(join(cwd, 'reports/assessment.md'), 'utf8'))
        .toContain('# First real migration assessment')
      expect(JSON.parse(requests[0].body)).toEqual({
        protocolVersion: 1,
        repositories: [{ repository: 'FlagShark/prospect', ref: 'b'.repeat(40) }],
        launchDarklyProjectKey: 'production',
        client: { kind: 'cli', version: VERSION },
      })
      expect(requests.slice(0, 3).map((request) => request.authorization))
        .toEqual(['Bearer api-token-secret', 'Bearer api-token-secret', 'Bearer api-token-secret'])
      expect(requests[3]).toMatchObject({
        url: '/artifacts/report.md?signature=markdown-secret',
        authorization: undefined,
      })
      expect(stderrText()).toContain('Migration assessment running')
      expect(stderrText()).toContain('Migration assessment succeeded')
      expect(stderrText()).not.toContain('api-token-secret')
      expect(stderrText()).not.toContain('markdown-secret')
      expect(stderrText()).not.toContain('/artifacts/')
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
    }
  })
})
