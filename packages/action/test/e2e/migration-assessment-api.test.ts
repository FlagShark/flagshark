import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  downloadMigrationAssessmentArtifact,
  runMigrationAssessment,
  type AssessmentFetch,
} from '@flagshark/assessment-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssessmentActionClient } from '../../src/assess-run.js'
import { runFakeAssessmentAction, testJwt } from '../helpers/run-assessment-action.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('migration assessment Action → async API E2E', () => {
  it('submits, polls and downloads server-rendered reports without artifact authorization', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flagshark-assessment-action-e2e-'))
    directories.push(cwd)
    const clock = Date.parse('2026-07-12T12:00:00.000Z')
    const oidc = testJwt(Math.floor(clock / 1_000) + 300)
    const requests: Array<{
      url: string
      method: string
      authorization: string | null
      redirect: RequestRedirect | undefined
      body: string | undefined
    }> = []
    let statusRequest = 0

    const fakeApi: AssessmentFetch = vi.fn(async (input, init = {}) => {
      const url = new URL(input)
      const headers = new Headers(init.headers)
      requests.push({
        url: url.toString(),
        method: init.method ?? 'GET',
        authorization: headers.get('authorization'),
        redirect: init.redirect,
        body: typeof init.body === 'string' ? init.body : undefined,
      })

      if (url.pathname === '/v1/migration-assessments' && init.method === 'POST') {
        return jsonResponse({
          protocolVersion: 1,
          assessmentId: 'assessment_e2e',
          status: 'queued',
          statusUrl: '/v1/migration-assessments/assessment_e2e',
        }, 202)
      }

      if (url.pathname === '/v1/migration-assessments/assessment_e2e') {
        statusRequest += 1
        if (statusRequest === 1) {
          return jsonResponse({
            protocolVersion: 1,
            assessmentId: 'assessment_e2e',
            status: 'running',
            createdAt: '2026-07-12T12:00:00.000Z',
            updatedAt: '2026-07-12T12:00:01.000Z',
          })
        }
        return jsonResponse({
          protocolVersion: 1,
          assessmentId: 'assessment_e2e',
          status: 'succeeded',
          createdAt: '2026-07-12T12:00:00.000Z',
          updatedAt: '2026-07-12T12:00:02.000Z',
          artifacts: {
            markdown: {
              url: 'https://flagshark-test.s3.eu-west-2.amazonaws.com/assessment.md?X-Amz-Signature=markdown-secret',
              expiresAt: '2026-07-12T13:00:00.000Z',
            },
            json: {
              url: 'https://flagshark-test.s3.eu-west-2.amazonaws.com/assessment.json?X-Amz-Signature=json-secret',
              expiresAt: '2026-07-12T13:00:00.000Z',
            },
          },
        })
      }

      if (url.pathname.endsWith('/assessment.md')) {
        return new Response('# Migration assessment\n\nAutomated: **4**\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        })
      }
      if (url.pathname.endsWith('/assessment.json')) {
        return jsonResponse({ schemaVersion: '1', automated: 4 })
      }
      return new Response(null, { status: 404 })
    })

    const actionClient: AssessmentActionClient = {
      runMigrationAssessment: (input, options) => runMigrationAssessment(input, {
        ...options,
        fetch: fakeApi,
        now: () => clock,
        sleep: async () => {},
        initialPollIntervalMs: 1,
        maxPollIntervalMs: 1,
      }),
      downloadMigrationAssessmentArtifact: (completed, format) => (
        downloadMigrationAssessmentArtifact(completed, format, {
          fetch: fakeApi,
          now: () => clock,
        })
      ),
    }

    const state = await runFakeAssessmentAction({
      cwd,
      client: actionClient,
      getIDToken: async () => oidc,
      now: () => clock,
      owner: 'FlagShark',
      repository: 'prospect-fixture',
      sha: 'c'.repeat(40),
      env: { GITHUB_ACTION_REF: 'v2.7.1' },
      inputs: {
        'api-url': 'https://api.example.test',
        'oidc-audience': 'https://api.example.test',
        'launchdarkly-project-key': 'production',
        'include-report-in-job-summary': 'true',
      },
    })

    expect(state.failed).toBeNull()
    expect(state.outputs['assessment-id']).toBe('assessment_e2e')
    expect(state.outputs['status-url']).toBe(
      'https://api.example.test/v1/migration-assessments/assessment_e2e',
    )
    expect(readFileSync(state.outputs['markdown-report-path'], 'utf8')).toContain('Automated: **4**')
    expect(JSON.parse(readFileSync(state.outputs['json-report-path'], 'utf8'))).toEqual({
      schemaVersion: '1',
      automated: 4,
    })
    expect(state.summary.join('\n')).toContain('Migration assessment')

    const creation = requests[0]
    expect(JSON.parse(creation.body ?? '')).toEqual({
      protocolVersion: 1,
      repositories: [{ repository: 'FlagShark/prospect-fixture', ref: 'c'.repeat(40) }],
      launchDarklyProjectKey: 'production',
      client: { kind: 'github-action', version: 'v2.7.1' },
    })
    expect(requests).toHaveLength(5)
    expect(requests.slice(0, 3).every((request) => request.authorization === `Bearer ${oidc}`)).toBe(true)
    expect(requests.slice(0, 3).every((request) => request.redirect === 'error')).toBe(true)
    expect(requests.slice(3).every((request) => request.authorization === null)).toBe(true)
    expect(requests.slice(3).every((request) => request.redirect === 'error')).toBe(true)
    expect(state.infos.join('\n')).not.toContain('X-Amz-Signature')
    expect(Object.values(state.outputs).join('\n')).not.toContain('X-Amz-Signature')
    expect(state.oidcAudiences).toEqual(['https://api.example.test'])
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  const body = JSON.stringify(value)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}
