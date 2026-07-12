/**
 * Thin GitHub Actions adapter for the private migration-assessment service.
 *
 * This module intentionally contains no repository acquisition or assessment
 * logic. The public Action submits immutable repository identity to the API,
 * waits through the shared public protocol client, and writes the two
 * server-rendered artifacts to the runner.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

import {
  downloadMigrationAssessmentArtifact,
  redactSensitiveText,
  runMigrationAssessment,
  sanitizeClientVersion,
} from '@flagshark/assessment-client'

declare const __FLAGSHARK_ACTION_VERSION__: string

const DEFAULT_API_URL = 'https://api.flagshark.com/api'
const DEFAULT_OIDC_AUDIENCE = 'https://api.flagshark.com'
const DEFAULT_TIMEOUT_SECONDS = 15 * 60
const MIN_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 60 * 60
const MAX_JOB_SUMMARY_BYTES = 900 * 1024
const MAX_SECRET_BYTES = 16 * 1024
const OIDC_REFRESH_SKEW_MS = 60_000

type Core = typeof import('@actions/core')
type Github = typeof import('@actions/github')

export interface AssessmentActionClient {
  runMigrationAssessment: typeof runMigrationAssessment
  downloadMigrationAssessmentArtifact: typeof downloadMigrationAssessmentArtifact
}

export interface RunAssessmentActionDeps {
  core: Core
  github: Github
  cwd: string
  env?: NodeJS.ProcessEnv
  client?: AssessmentActionClient
  now?: () => number
}

interface WrittenReports {
  directory: string
  markdownPath: string
  jsonPath: string
}

/** Run the migration-assessment Action without top-level process side effects. */
export async function runAssessmentAction(deps: RunAssessmentActionDeps): Promise<void> {
  const {
    core,
    github,
    cwd,
    env = process.env,
    client = { runMigrationAssessment, downloadMigrationAssessmentArtifact },
    now = Date.now,
  } = deps

  try {
    const repository = repositoryFromContext(github)
    const ref = immutableShaFromContext(github)
    const apiBaseUrl = core.getInput('api-url') || DEFAULT_API_URL
    const audience = boundedText(
      core.getInput('oidc-audience') || DEFAULT_OIDC_AUDIENCE,
      'oidc-audience',
      2_048,
    )
    const timeoutSeconds = boundedIntegerInput(
      core.getInput('timeout-seconds'),
      'timeout-seconds',
      DEFAULT_TIMEOUT_SECONDS,
      MIN_TIMEOUT_SECONDS,
      MAX_TIMEOUT_SECONDS,
    )
    const launchDarklyProjectKey = optionalBoundedText(
      core.getInput('launchdarkly-project-key'),
      'launchdarkly-project-key',
      256,
    )
    const includeReportInJobSummary = booleanInput(
      core.getInput('include-report-in-job-summary'),
      'include-report-in-job-summary',
      false,
    )
    const outputDirectory = resolveOutputDirectory({
      cwd,
      runnerTemp: env.RUNNER_TEMP,
      configured: core.getInput('output-directory'),
    })
    const getAccessToken = createAccessTokenProvider({
      core,
      audience,
      env,
      now,
    })
    const publishSubmissionOutputs = (submission: {
      assessmentId: string
      statusUrl: string
    }): { assessmentId: string; statusUrl: string } => {
      const assessmentId = safeAssessmentId(submission.assessmentId)
      const statusUrl = safeStatusUrlForOutput(submission.statusUrl, apiBaseUrl)
      // setOutput is intentionally safe to repeat: the final response is
      // published again after polling, while an accepted submission remains
      // available to later steps if polling fails or times out.
      core.setOutput('assessment-id', assessmentId)
      core.setOutput('status-url', statusUrl)
      return { assessmentId, statusUrl }
    }

    core.info('Requesting a private LaunchDarkly migration assessment')

    const completed = await client.runMigrationAssessment(
      {
        repositories: [{ repository, ref }],
        ...(launchDarklyProjectKey ? { launchDarklyProjectKey } : {}),
        client: {
          kind: 'github-action',
          version: actionVersion(env.GITHUB_ACTION_REF),
        },
      },
      {
        apiBaseUrl,
        getAccessToken,
        timeoutMs: timeoutSeconds * 1_000,
        onSubmitted: publishSubmissionOutputs,
      },
    )

    const [markdown, json] = await Promise.all([
      client.downloadMigrationAssessmentArtifact(completed, 'markdown'),
      client.downloadMigrationAssessmentArtifact(completed, 'json'),
    ])

    const renderedMarkdown = decodeArtifact(markdown, 'Markdown')
    validateJsonArtifact(json)
    const reports = writeReports(outputDirectory, markdown, json)
    const { assessmentId } = publishSubmissionOutputs(completed)

    core.setOutput('markdown-report-path', reports.markdownPath)
    core.setOutput('json-report-path', reports.jsonPath)
    core.setOutput('report-directory', reports.directory)

    if (includeReportInJobSummary) {
      await writeJobSummary(core, markdown, renderedMarkdown)
    }
    core.info(`Migration assessment ${assessmentId} completed`)
    core.info(`Reports written to ${reports.directory}`)
  } catch (error) {
    core.setFailed(`Migration assessment failed: ${safeErrorMessage(error)}`)
  }
}

function repositoryFromContext(github: Github): string {
  const { owner, repo } = github.context.repo
  const repository = `${owner}/${repo}`
  if (
    !owner ||
    !repo ||
    owner !== owner.trim() ||
    repo !== repo.trim() ||
    owner.includes('/') ||
    repo.includes('/') ||
    repository.length > 512 ||
    hasUnsafeText(repository)
  ) {
    throw new Error('GitHub Actions did not provide a valid repository identity')
  }
  return repository
}

function immutableShaFromContext(github: Github): string {
  const sha = github.context.sha.trim()
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(sha)) {
    throw new Error('GitHub Actions did not provide an immutable commit SHA')
  }
  return sha.toLowerCase()
}

function actionVersion(value: string | undefined): string {
  const packagedVersion =
    typeof __FLAGSHARK_ACTION_VERSION__ === 'string' ? __FLAGSHARK_ACTION_VERSION__ : 'unknown'
  return sanitizeClientVersion(value || '', packagedVersion)
}

function boundedIntegerInput(
  raw: string,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!raw.trim()) return fallback
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${name} must be a whole number`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function booleanInput(raw: string, name: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase()
  if (!value) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function optionalBoundedText(raw: string, name: string, maximum: number): string | undefined {
  const value = raw.trim()
  return value ? boundedText(value, name, maximum) : undefined
}

function boundedText(raw: string, name: string, maximum: number): string {
  const value = raw.trim()
  if (!value || Buffer.byteLength(value, 'utf8') > maximum || hasUnsafeText(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function hasUnsafeText(value: string): boolean {
  return (
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  )
}

function resolveOutputDirectory(options: {
  cwd: string
  runnerTemp: string | undefined
  configured: string
}): string {
  const configured = options.configured.trim()
  if (configured) {
    const safe = boundedText(configured, 'output-directory', 4_096)
    return isAbsolute(safe) ? resolve(safe) : resolve(options.cwd, safe)
  }
  const base = options.runnerTemp?.trim()
    ? boundedText(options.runnerTemp, 'RUNNER_TEMP', 4_096)
    : options.cwd
  return resolve(base, 'flagshark-migration-assessment')
}

function createAccessTokenProvider(options: {
  core: Core
  audience: string
  env: NodeJS.ProcessEnv
  now: () => number
}): () => Promise<string> {
  const inputToken = options.core.getInput('api-token').trim()
  const environmentToken = options.env.FLAGSHARK_API_TOKEN?.trim() || ''
  const fallbackToken = validateOptionalSecret(inputToken || environmentToken)
  if (fallbackToken) options.core.setSecret(fallbackToken)

  let cachedOidc: { token: string; refreshAt: number } | undefined

  return async () => {
    const currentTime = options.now()
    if (cachedOidc && currentTime < cachedOidc.refreshAt) return cachedOidc.token

    if (typeof options.core.getIDToken === 'function') {
      try {
        const token = validateOptionalSecret(await options.core.getIDToken(options.audience))
        if (token) {
          options.core.setSecret(token)
          const expiry = untrustedJwtExpiry(token)
          // A malformed token is still verified by the server. It simply is not
          // cached, so the next authenticated request obtains a fresh one.
          if (expiry !== undefined && expiry > currentTime + OIDC_REFRESH_SKEW_MS) {
            cachedOidc = { token, refreshAt: expiry - OIDC_REFRESH_SKEW_MS }
          } else {
            cachedOidc = undefined
          }
          return token
        }
      } catch {
        // OIDC is optional for self-hosted/local use. Never expose the SDK's
        // exception because it may contain request URLs or credentials.
      }
    }

    if (fallbackToken) return fallbackToken
    throw new Error('authentication is unavailable; grant id-token: write or configure api-token')
  }
}

function validateOptionalSecret(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES || hasUnsafeText(value)) {
    throw new Error('the configured API credential is invalid')
  }
  return value
}

/** Decode JWT expiry only to decide when to refresh; it is never trusted for authentication. */
function untrustedJwtExpiry(token: string): number | undefined {
  const parts = token.split('.')
  // The whole credential was already bounded before this cache hint is read.
  if (parts.length !== 3) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!isPlainObject(value) || typeof value.exp !== 'number') return undefined
    if (!Number.isSafeInteger(value.exp) || value.exp <= 0) return undefined
    const milliseconds = value.exp * 1_000
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype
}

function writeReports(directory: string, markdown: Uint8Array, json: Uint8Array): WrittenReports {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const markdownPath = join(directory, 'migration-assessment.md')
  const jsonPath = join(directory, 'migration-assessment.json')
  atomicWrite(markdownPath, markdown)
  atomicWrite(jsonPath, json)
  return { directory, markdownPath, jsonPath }
}

function atomicWrite(path: string, content: Uint8Array): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function decodeArtifact(content: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error(`the assessment API returned a non-UTF-8 ${name} artifact`)
  }
}

function validateJsonArtifact(content: Uint8Array): void {
  const json = decodeArtifact(content, 'JSON')
  try {
    const value: unknown = JSON.parse(json)
    if (!isPlainObject(value)) throw new Error('not an object')
  } catch {
    throw new Error('the assessment API returned an invalid JSON artifact')
  }
}

function safeStatusUrlForOutput(raw: string, apiBaseUrl: string): string {
  let statusUrl: URL
  let apiUrl: URL
  try {
    apiUrl = new URL(apiBaseUrl)
    statusUrl = new URL(raw, apiUrl)
  } catch {
    throw new Error('the assessment API returned an invalid status URL')
  }
  if (
    statusUrl.origin !== apiUrl.origin ||
    statusUrl.username ||
    statusUrl.password ||
    statusUrl.search ||
    statusUrl.hash
  ) {
    throw new Error('the assessment API returned a status URL that is unsafe to expose')
  }
  return statusUrl.toString()
}

function safeAssessmentId(value: string): string {
  if (!/^[a-z\d][a-z\d_-]{0,127}$/iu.test(value)) {
    throw new Error('the assessment API returned an invalid assessment ID')
  }
  return value
}

async function writeJobSummary(core: Core, markdown: Uint8Array, rendered: string): Promise<void> {
  core.summary.addHeading('🦈 LaunchDarkly migration assessment', 2)
  if (markdown.byteLength <= MAX_JOB_SUMMARY_BYTES) {
    core.summary.addRaw(`\n${rendered}${rendered.endsWith('\n') ? '' : '\n'}`)
  } else {
    core.summary.addRaw(
      '\nThe report is too large for the GitHub job summary. Use the `markdown-report-path` output.\n',
    )
  }
  await core.summary.write()
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'an unexpected error occurred'
  return redactSensitiveText(message).slice(0, 500) || 'an unexpected error occurred'
}
