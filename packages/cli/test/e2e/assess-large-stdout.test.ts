import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

describe('CLI E2E — large assessment stdout', () => {
  it('flushes a multi-MiB piped report before the bundled process exits', async () => {
    const prefix = '# Large migration assessment\n\n'
    const report = Buffer.from(prefix + 'x'.repeat((8 * 1024 * 1024) - prefix.length))
    let baseUrl = ''
    const server = createServer((request, response) => {
      request.resume()
      if (request.method === 'POST' && request.url === '/v1/migration-assessments') {
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          protocolVersion: 1,
          assessmentId: 'large_report',
          status: 'queued',
          statusUrl: '/v1/migration-assessments/large_report',
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/v1/migration-assessments/large_report') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          protocolVersion: 1,
          assessmentId: 'large_report',
          status: 'succeeded',
          createdAt: '2026-07-12T10:00:00.000Z',
          updatedAt: '2026-07-12T10:01:00.000Z',
          artifacts: {
            markdown: {
              url: `${baseUrl}/artifacts/large.md?signature=not-for-logs`,
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
            json: {
              url: `${baseUrl}/artifacts/large.json?signature=not-for-logs`,
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          },
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/artifacts/large.md?signature=not-for-logs') {
        response.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-length': String(report.byteLength),
        })
        response.end(report)
        return
      }
      response.writeHead(404)
      response.end()
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
      baseUrl = `http://127.0.0.1:${address.port}`
      const child = spawn(process.execPath, [
        CLI_PATH,
        'assess',
        '--repo', 'FlagShark/prospect',
        '--ref', 'c'.repeat(40),
        '--api-base', baseUrl,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, FLAGSHARK_API_TOKEN: 'test-token' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdout: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })

      const actual = Buffer.concat(stdout)
      expect(exitCode).toBe(0)
      expect(actual.byteLength).toBe(report.byteLength)
      expect(actual.equals(report)).toBe(true)
      expect(stderr).toContain('Migration assessment large_report submitted')
      expect(stderr).not.toContain('not-for-logs')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 15_000)
})
