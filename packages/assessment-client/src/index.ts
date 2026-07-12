import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

export const MIGRATION_ASSESSMENT_PROTOCOL_VERSION = 1 as const

export const DEFAULT_ASSESSMENT_API_BASE_URL = 'https://api.flagshark.com/api/'
export const DEFAULT_ASSESSMENT_TIMEOUT_MS = 10 * 60 * 1_000
export const DEFAULT_ARTIFACT_TIMEOUT_MS = 60 * 1_000
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const MAX_API_RESPONSE_BYTES = 256 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_REPOSITORIES = 20
const MAX_URL_LENGTH = 2_048
const MAX_TOKEN_LENGTH = 16_384
const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const SERVER_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const UNSAFE_DISPLAY_CHARACTER_GLOBAL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const ILL_FORMED_UTF16_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

export type MigrationAssessmentClientKind = 'cli' | 'github-action'
export type MigrationAssessmentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'
export type MigrationAssessmentArtifactFormat = 'markdown' | 'json'

export interface MigrationAssessmentRepository {
  repository: string
  ref?: string
}

export interface MigrationAssessmentClientIdentity {
  kind: MigrationAssessmentClientKind
  version: string
}

export interface MigrationAssessmentInput {
  repositories: readonly MigrationAssessmentRepository[]
  launchDarklyProjectKey?: string
  client: MigrationAssessmentClientIdentity
}

export interface MigrationAssessmentRequest {
  protocolVersion: typeof MIGRATION_ASSESSMENT_PROTOCOL_VERSION
  repositories: MigrationAssessmentRepository[]
  launchDarklyProjectKey?: string
  client: MigrationAssessmentClientIdentity
}

export interface MigrationAssessmentSubmission {
  protocolVersion: typeof MIGRATION_ASSESSMENT_PROTOCOL_VERSION
  assessmentId: string
  status: 'queued'
  statusUrl: string
}

export interface MigrationAssessmentArtifact {
  url: string
  expiresAt: string
}

export interface MigrationAssessmentArtifacts {
  markdown: MigrationAssessmentArtifact
  json: MigrationAssessmentArtifact
}

export interface MigrationAssessmentPendingStatus {
  protocolVersion: typeof MIGRATION_ASSESSMENT_PROTOCOL_VERSION
  assessmentId: string
  status: 'queued' | 'running'
  createdAt: string
  updatedAt: string
}

export interface MigrationAssessmentSucceededStatus {
  protocolVersion: typeof MIGRATION_ASSESSMENT_PROTOCOL_VERSION
  assessmentId: string
  status: 'succeeded'
  createdAt: string
  updatedAt: string
  artifacts: MigrationAssessmentArtifacts
}

export interface MigrationAssessmentStructuredError {
  code: string
  message: string
  retryable?: boolean
}

export interface MigrationAssessmentFailedStatus {
  protocolVersion: typeof MIGRATION_ASSESSMENT_PROTOCOL_VERSION
  assessmentId: string
  status: 'failed'
  createdAt: string
  updatedAt: string
  error: MigrationAssessmentStructuredError
}

export interface MigrationAssessmentExpiredStatus {
  protocolVersion: typeof MIGRATION_ASSESSMENT_PROTOCOL_VERSION
  assessmentId: string
  status: 'expired'
  createdAt: string
  updatedAt: string
}

export type MigrationAssessmentStatusResponse =
  | MigrationAssessmentPendingStatus
  | MigrationAssessmentSucceededStatus
  | MigrationAssessmentFailedStatus
  | MigrationAssessmentExpiredStatus

export interface CompletedMigrationAssessment extends MigrationAssessmentSucceededStatus {
  /** Same-origin polling URL returned by the assessment API. Never log its query string. */
  statusUrl: string
}

export type AssessmentFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type AssessmentSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>

export interface RunMigrationAssessmentOptions {
  apiBaseUrl?: string
  /** Called immediately before every authenticated request. The returned token is never retained. */
  getAccessToken: () => string | Promise<string>
  fetch?: AssessmentFetch
  now?: () => number
  sleep?: AssessmentSleep
  timeoutMs?: number
  initialPollIntervalMs?: number
  maxPollIntervalMs?: number
  /** Non-cryptographic RNG returning [0, 1), injected for deterministic retry tests. */
  random?: () => number
  /** Additive retry jitter ratio from 0 through 0.5 (default: 0.2). */
  retryJitterRatio?: number
  /** Reused for this submission. Supply a stable workflow-scoped value when desired. */
  idempotencyKey?: string
  signal?: AbortSignal
  onSubmitted?: (submission: MigrationAssessmentSubmission) => void
  onStatus?: (status: MigrationAssessmentStatus) => void
}

export interface DownloadMigrationAssessmentArtifactOptions {
  fetch?: AssessmentFetch
  now?: () => number
  sleep?: AssessmentSleep
  timeoutMs?: number
  maxBytes?: number
  initialRetryIntervalMs?: number
  maxRetryIntervalMs?: number
  random?: () => number
  retryJitterRatio?: number
  /** Exact additional HTTPS DNS hostnames trusted for artifact downloads. */
  allowedArtifactHosts?: readonly string[]
  signal?: AbortSignal
}

export class MigrationAssessmentClientError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly httpStatus?: number

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; httpStatus?: number } = {},
  ) {
    super(message)
    this.name = 'MigrationAssessmentClientError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.httpStatus = options.httpStatus
  }
}

function sanitizedVersionCandidate(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._+-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
}

/** Normalize build/ref strings to the server's public client-version contract. */
export function sanitizeClientVersion(value: string, fallback = 'unknown'): string {
  const candidate = sanitizedVersionCandidate(value)
  if (candidate && CLIENT_VERSION_PATTERN.test(candidate)) return candidate

  const fallbackCandidate = sanitizedVersionCandidate(fallback)
  return fallbackCandidate && CLIENT_VERSION_PATTERN.test(fallbackCandidate)
    ? fallbackCandidate
    : 'unknown'
}

/** Return a URL safe for logs by dropping credentials, query parameters, and fragments. */
export function redactUrlForLogs(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

/** Redact URL secrets, bearer values, and explicit secret strings from an error message. */
export function redactSensitiveText(message: string, secrets: readonly string[] = []): string {
  const exactSecrets = secrets.filter((secret) => secret.length > 0)
  // Remove caller-supplied secrets before any normalization. Otherwise a
  // URL-shaped credential loses its query string, or a delimiter-bearing
  // bearer value is split before the later exact match can see it.
  let redacted = message
  for (const secret of exactSecrets) {
    redacted = redacted.split(secret).join('[redacted]')
  }

  redacted = redacted.replace(
    UNSAFE_DISPLAY_CHARACTER_GLOBAL_PATTERN,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  )
  redacted = redacted.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  redacted = redacted.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;!?]+$/)?.[0] ?? ''
    const rawUrl = trailing ? candidate.slice(0, -trailing.length) : candidate
    return `${redactUrlForLogs(rawUrl)}${trailing}`
  })
  // A transformation can itself produce text equal to another configured
  // secret, so repeat the exact pass before returning the diagnostic.
  for (const secret of exactSecrets) {
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted.slice(0, 2_000)
}

function fail(
  code: string,
  message: string,
  options: ConstructorParameters<typeof MigrationAssessmentClientError>[2] = {},
): never {
  throw new MigrationAssessmentClientError(code, message, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string,
  errorCode = 'INVALID_RESPONSE',
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail(errorCode, `${path} must be an object`)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  const keys = Object.keys(value)
  for (const required of requiredKeys) {
    if (!Object.hasOwn(value, required)) fail(errorCode, `${path}.${required} is required`)
  }
  for (const key of keys) {
    if (!allowed.has(key)) fail(errorCode, `${path}.${key} is not part of protocol v1`)
  }
}

function assertBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  pattern?: RegExp,
  errorCode = 'INVALID_RESPONSE',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value) ||
    ILL_FORMED_UTF16_PATTERN.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    fail(errorCode, `${path} is invalid`)
  }
}

function assertProtocolVersion(value: unknown, path: string): asserts value is 1 {
  if (value !== MIGRATION_ASSESSMENT_PROTOCOL_VERSION) {
    fail('UNSUPPORTED_PROTOCOL', `${path} must be ${MIGRATION_ASSESSMENT_PROTOCOL_VERSION}`)
  }
}

function validateRepository(value: unknown, path: string): MigrationAssessmentRepository {
  assertExactObject(value, ['repository'], ['ref'], path, 'INVALID_REQUEST')
  assertBoundedString(
    value.repository,
    `${path}.repository`,
    200,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'INVALID_REQUEST',
  )
  if (value.ref !== undefined) {
    assertBoundedString(
      value.ref,
      `${path}.ref`,
      512,
      /^[^\s\u0000-\u001f\u007f]+$/u,
      'INVALID_REQUEST',
    )
  }
  return {
    repository: value.repository,
    ...(value.ref === undefined ? {} : { ref: value.ref }),
  }
}

function validateClientIdentity(value: unknown, path: string): MigrationAssessmentClientIdentity {
  assertExactObject(value, ['kind', 'version'], [], path, 'INVALID_REQUEST')
  if (value.kind !== 'cli' && value.kind !== 'github-action') {
    fail('INVALID_REQUEST', `${path}.kind is invalid`)
  }
  assertBoundedString(
    value.version,
    `${path}.version`,
    64,
    CLIENT_VERSION_PATTERN,
    'INVALID_REQUEST',
  )
  return { kind: value.kind, version: value.version }
}

export function createMigrationAssessmentRequest(
  input: MigrationAssessmentInput,
): MigrationAssessmentRequest {
  assertExactObject(
    input,
    ['repositories', 'client'],
    ['launchDarklyProjectKey'],
    'request',
    'INVALID_REQUEST',
  )
  if (
    !Array.isArray(input.repositories) ||
    input.repositories.length === 0 ||
    input.repositories.length > MAX_REPOSITORIES
  ) {
    fail(
      'INVALID_REQUEST',
      `request.repositories must contain between 1 and ${MAX_REPOSITORIES} entries`,
    )
  }
  for (let index = 0; index < input.repositories.length; index += 1) {
    if (!Object.hasOwn(input.repositories, index)) {
      fail('INVALID_REQUEST', 'request.repositories must be a dense array')
    }
  }
  const repositories = input.repositories.map((repository, index) =>
    validateRepository(repository, `request.repositories[${index}]`),
  )
  const duplicate = repositories.find(
    (repository, index) =>
      repositories.findIndex(
        (candidate) => candidate.repository.toLowerCase() === repository.repository.toLowerCase(),
      ) !== index,
  )
  if (duplicate)
    fail('INVALID_REQUEST', 'request.repositories contains a duplicate repository/ref pair')

  if (input.launchDarklyProjectKey !== undefined) {
    assertBoundedString(
      input.launchDarklyProjectKey,
      'request.launchDarklyProjectKey',
      256,
      undefined,
      'INVALID_REQUEST',
    )
    if (input.launchDarklyProjectKey !== input.launchDarklyProjectKey.trim()) {
      fail(
        'INVALID_REQUEST',
        'request.launchDarklyProjectKey must not contain surrounding whitespace',
      )
    }
  }

  return {
    protocolVersion: MIGRATION_ASSESSMENT_PROTOCOL_VERSION,
    repositories,
    ...(input.launchDarklyProjectKey === undefined
      ? {}
      : { launchDarklyProjectKey: input.launchDarklyProjectKey }),
    client: validateClientIdentity(input.client, 'request.client'),
  }
}

export function parseMigrationAssessmentSubmission(value: unknown): MigrationAssessmentSubmission {
  assertExactObject(
    value,
    ['protocolVersion', 'assessmentId', 'status', 'statusUrl'],
    [],
    'response',
  )
  assertProtocolVersion(value.protocolVersion, 'response.protocolVersion')
  assertBoundedString(value.assessmentId, 'response.assessmentId', 128, /^[A-Za-z0-9_-]+$/)
  if (value.status !== 'queued') fail('INVALID_RESPONSE', "response.status must be 'queued'")
  assertBoundedString(value.statusUrl, 'response.statusUrl', MAX_URL_LENGTH)
  return {
    protocolVersion: value.protocolVersion,
    assessmentId: value.assessmentId,
    status: value.status,
    statusUrl: value.statusUrl,
  }
}

function parseArtifact(value: unknown, path: string): MigrationAssessmentArtifact {
  assertExactObject(value, ['url', 'expiresAt'], [], path)
  assertBoundedString(value.url, `${path}.url`, MAX_URL_LENGTH)
  const expiresAt = parseTimestamp(value.expiresAt, `${path}.expiresAt`)
  validateArtifactUrl(value.url)
  return { url: value.url, expiresAt }
}

function parseTimestamp(value: unknown, path: string): string {
  assertBoundedString(value, path, 64)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail('INVALID_RESPONSE', `${path} must be an ISO-8601 UTC timestamp`)
  }
  return value
}

export function parseMigrationAssessmentStatus(value: unknown): MigrationAssessmentStatusResponse {
  if (!isPlainObject(value)) fail('INVALID_RESPONSE', 'response must be an object')
  const status = value.status
  if (status === 'queued' || status === 'running') {
    assertExactObject(
      value,
      ['protocolVersion', 'assessmentId', 'status', 'createdAt', 'updatedAt'],
      [],
      'response',
    )
  } else if (status === 'succeeded') {
    assertExactObject(
      value,
      ['protocolVersion', 'assessmentId', 'status', 'createdAt', 'updatedAt', 'artifacts'],
      [],
      'response',
    )
  } else if (status === 'failed') {
    assertExactObject(
      value,
      ['protocolVersion', 'assessmentId', 'status', 'createdAt', 'updatedAt', 'error'],
      [],
      'response',
    )
  } else if (status === 'expired') {
    assertExactObject(
      value,
      ['protocolVersion', 'assessmentId', 'status', 'createdAt', 'updatedAt'],
      [],
      'response',
    )
  } else {
    fail('INVALID_RESPONSE', 'response.status is invalid')
  }

  assertProtocolVersion(value.protocolVersion, 'response.protocolVersion')
  assertBoundedString(value.assessmentId, 'response.assessmentId', 128, /^[A-Za-z0-9_-]+$/)
  const createdAt = parseTimestamp(value.createdAt, 'response.createdAt')
  const updatedAt = parseTimestamp(value.updatedAt, 'response.updatedAt')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail('INVALID_RESPONSE', 'response.updatedAt must not precede response.createdAt')
  }

  if (status === 'queued' || status === 'running') {
    return {
      protocolVersion: value.protocolVersion,
      assessmentId: value.assessmentId,
      status,
      createdAt,
      updatedAt,
    }
  }

  if (status === 'succeeded') {
    assertExactObject(value.artifacts, ['markdown', 'json'], [], 'response.artifacts')
    return {
      protocolVersion: value.protocolVersion,
      assessmentId: value.assessmentId,
      status,
      createdAt,
      updatedAt,
      artifacts: {
        markdown: parseArtifact(value.artifacts.markdown, 'response.artifacts.markdown'),
        json: parseArtifact(value.artifacts.json, 'response.artifacts.json'),
      },
    }
  }

  if (status === 'expired') {
    return {
      protocolVersion: value.protocolVersion,
      assessmentId: value.assessmentId,
      status,
      createdAt,
      updatedAt,
    }
  }

  assertExactObject(value.error, ['code', 'message'], ['retryable'], 'response.error')
  assertBoundedString(value.error.code, 'response.error.code', 64, SERVER_ERROR_CODE_PATTERN)
  assertBoundedString(value.error.message, 'response.error.message', 2_000)
  if (value.error.retryable !== undefined && typeof value.error.retryable !== 'boolean') {
    fail('INVALID_RESPONSE', 'response.error.retryable must be a boolean')
  }
  return {
    protocolVersion: value.protocolVersion,
    assessmentId: value.assessmentId,
    status,
    createdAt,
    updatedAt,
    error: {
      code: value.error.code,
      message: value.error.message,
      ...(value.error.retryable === undefined ? {} : { retryable: value.error.retryable }),
    },
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

function ipLiteralVersion(hostname: string): number {
  const candidate =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(candidate)
}

function validateTransportUrl(url: URL, kind: 'API base' | 'status' | 'artifact'): void {
  if (url.username || url.password) fail('INVALID_URL', `${kind} URL must not contain credentials`)
  if (url.hash) fail('INVALID_URL', `${kind} URL must not contain a fragment`)
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return
  fail('INVALID_URL', `${kind} URL must use HTTPS (HTTP is allowed only for localhost)`)
}

export function normalizeAssessmentApiBaseUrl(value: string): URL {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    ILL_FORMED_UTF16_PATTERN.test(value)
  ) {
    fail('INVALID_URL', 'API base URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('INVALID_URL', 'API base URL is invalid')
  }
  validateTransportUrl(url, 'API base')
  if (url.search) fail('INVALID_URL', 'API base URL must not contain a query string')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function resolveStatusUrl(value: string, apiBaseUrl: URL): URL {
  let url: URL
  try {
    url = new URL(value, apiBaseUrl)
  } catch {
    fail('INVALID_URL', 'Assessment status URL is invalid')
  }
  validateTransportUrl(url, 'status')
  if (url.origin !== apiBaseUrl.origin) {
    fail('INVALID_URL', 'Assessment status URL must use the assessment API origin')
  }
  if (url.search) fail('INVALID_URL', 'Assessment status URL must not contain a query string')
  return url
}

function validateArtifactUrl(value: string): URL {
  if (ILL_FORMED_UTF16_PATTERN.test(value)) {
    fail('INVALID_URL', 'Assessment artifact URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('INVALID_URL', 'Assessment artifact URL is invalid')
  }
  validateTransportUrl(url, 'artifact')
  return url
}

function validateArtifactHostAllowlist(value: readonly string[] | undefined): Set<string> {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > 32) {
    fail('INVALID_OPTIONS', 'allowedArtifactHosts must contain at most 32 hostnames')
  }
  const hosts = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail('INVALID_OPTIONS', 'allowedArtifactHosts must be dense')
    const host = value[index]
    if (
      typeof host !== 'string' ||
      host.length === 0 ||
      host.length > 253 ||
      host !== host.toLowerCase() ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      ipLiteralVersion(host) !== 0
    ) {
      fail('INVALID_OPTIONS', 'allowedArtifactHosts contains an invalid hostname')
    }
    hosts.add(host)
  }
  return hosts
}

function isAwsS3Hostname(hostname: string): boolean {
  return /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com(?:\.cn)?$/.test(hostname)
}

function validateArtifactTrust(
  artifactUrl: URL,
  statusUrlValue: string,
  allowedHosts: ReadonlySet<string>,
): void {
  if (ILL_FORMED_UTF16_PATTERN.test(statusUrlValue)) {
    fail('INVALID_URL', 'Completed assessment status URL is invalid')
  }
  let statusUrl: URL
  try {
    statusUrl = new URL(statusUrlValue)
  } catch {
    fail('INVALID_URL', 'Completed assessment status URL is invalid')
  }
  validateTransportUrl(statusUrl, 'status')
  if (statusUrl.search || statusUrl.hash) {
    fail('INVALID_URL', 'Completed assessment status URL must not contain a query or fragment')
  }

  const statusIsLoopback = isLoopbackHostname(statusUrl.hostname)
  const artifactIsLoopback = isLoopbackHostname(artifactUrl.hostname)
  if (statusIsLoopback && artifactIsLoopback) return

  if (artifactUrl.protocol !== 'https:' || artifactUrl.port) {
    fail('UNTRUSTED_ARTIFACT_URL', 'Assessment artifact URL is not a trusted HTTPS endpoint')
  }
  const hostname = artifactUrl.hostname.toLowerCase()
  if (
    artifactIsLoopback ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    ipLiteralVersion(hostname) !== 0
  ) {
    fail('UNTRUSTED_ARTIFACT_URL', 'Assessment artifact URL uses a local or literal IP host')
  }
  if (!isAwsS3Hostname(hostname) && !allowedHosts.has(hostname)) {
    fail('UNTRUSTED_ARTIFACT_URL', 'Assessment artifact URL host is not trusted')
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  didTimeOut: () => boolean,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  const declaredLength =
    contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    fail('RESPONSE_TOO_LARGE', `Response exceeds the ${maximumBytes}-byte limit`)
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  let bytes = new Uint8Array(declaredLength ?? Math.min(64 * 1024, maximumBytes))
  let total = 0
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        const pendingRead = reader.read()
        read = await waitForValueOrAbort(pendingRead, signal)
      } catch {
        if (signal.aborted) throwAbort(didTimeOut)
        fail('NETWORK_ERROR', 'Response body stream failed', {
          retryable: true,
        })
      }
      const { done, value } = read
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        /* v8 ignore start -- built-in readers return a promise; protects nonstandard runtimes */
        try {
          void reader.cancel().catch(() => undefined)
        } catch {}
        /* v8 ignore stop */
        fail('RESPONSE_TOO_LARGE', `Response exceeds the ${maximumBytes}-byte limit`)
      }
      const offset = total - value.byteLength
      if (total > bytes.byteLength) {
        let capacity = Math.max(bytes.byteLength, 1)
        while (capacity < total) capacity = Math.min(maximumBytes, capacity * 2)
        const expanded = new Uint8Array(capacity)
        expanded.set(bytes)
        bytes = expanded
      }
      bytes.set(value, offset)
    }
  } finally {
    reader.releaseLock()
  }
  return bytes.subarray(0, total)
}

function decodeUtf8(bytes: Uint8Array, kind: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('INVALID_RESPONSE', `${kind} is not valid UTF-8`)
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  didTimeOut: () => boolean,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, MAX_API_RESPONSE_BYTES, signal, didTimeOut)
  const text = decodeUtf8(bytes, 'API response')
  try {
    return JSON.parse(text) as unknown
  } catch {
    fail('INVALID_RESPONSE', 'Assessment API returned malformed JSON')
  }
}

async function readHttpError(
  response: Response,
  signal: AbortSignal,
  didTimeOut: () => boolean,
  redact: (message: string) => string,
): Promise<MigrationAssessmentClientError> {
  let message = `Assessment API returned HTTP ${response.status}`
  let code = 'HTTP_ERROR'
  let explicitRetryable: boolean | undefined
  try {
    const value = await readBoundedJson(response, signal, didTimeOut)
    if (isPlainObject(value) && isPlainObject(value.error)) {
      const error = value.error
      if (
        typeof error.code === 'string' &&
        SERVER_ERROR_CODE_PATTERN.test(error.code) &&
        error.code.length <= 64
      ) {
        code = error.code
      }
      if (typeof error.message === 'string' && error.message.length > 0) {
        message = redact(error.message)
      }
      if (typeof error.retryable === 'boolean') explicitRetryable = error.retryable
    }
  } catch (error) {
    if (
      error instanceof MigrationAssessmentClientError &&
      ['RESPONSE_TOO_LARGE', 'ABORTED', 'ASSESSMENT_TIMEOUT'].includes(error.code)
    ) {
      throw error
    }
    // The status code remains the bounded diagnostic for non-contract error bodies.
  }
  return new MigrationAssessmentClientError(code, message, {
    httpStatus: response.status,
    retryable: explicitRetryable ?? (response.status === 429 || response.status >= 500),
  })
}

interface AuthenticatedResponse {
  response: Response
  /** Redact the one-use credential attached to this exact request. */
  redact: (message: string) => string
}

function assertPositiveInteger(value: number, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail('INVALID_OPTIONS', `${path} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

function remainingMilliseconds(deadline: number, now: () => number): number {
  const current = now()
  if (!Number.isFinite(current)) fail('INVALID_OPTIONS', 'now() must return a finite timestamp')
  return Math.max(0, deadline - current)
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export const defaultAssessmentSleep: AssessmentSleep = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
  })

function createBoundedSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): {
  signal: AbortSignal
  didTimeOut: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(abortError())
  }, timeoutMs)

  const onExternalAbort = () => controller.abort(abortError())
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  if (externalSignal?.aborted) onExternalAbort()

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function throwAbort(didTimeOut: () => boolean): never {
  if (didTimeOut())
    fail('ASSESSMENT_TIMEOUT', 'Migration assessment timed out', {
      retryable: true,
    })
  fail('ABORTED', 'Migration assessment was aborted', { retryable: true })
}

function waitForValueOrAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => settle(() => reject(abortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the cross-realm abort race between registration and this recheck */
    if (signal.aborted) onAbort()
    value.then(
      (result) => settle(() => resolve(result)),
      (error: unknown) => settle(() => reject(error)),
    )
  })
}

async function accessToken(
  getAccessToken: RunMigrationAssessmentOptions['getAccessToken'],
  signal: AbortSignal,
  didTimeOut: () => boolean,
): Promise<string> {
  let token: string
  if (signal.aborted) throwAbort(didTimeOut)
  try {
    token = await waitForValueOrAbort(Promise.resolve().then(getAccessToken), signal)
  } catch {
    if (signal.aborted) throwAbort(didTimeOut)
    fail('AUTH_TOKEN_UNAVAILABLE', 'Could not obtain an assessment API access token')
  }
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    token !== token.trim() ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(token) ||
    ILL_FORMED_UTF16_PATTERN.test(token)
  ) {
    fail('AUTH_TOKEN_INVALID', 'Assessment API access token is invalid')
  }
  return token
}

async function authenticatedRequest(
  url: URL,
  init: RequestInit,
  fetchImplementation: AssessmentFetch,
  getAccessToken: RunMigrationAssessmentOptions['getAccessToken'],
  signal: AbortSignal,
  didTimeOut: () => boolean,
): Promise<AuthenticatedResponse> {
  const token = await accessToken(getAccessToken, signal, didTimeOut)
  try {
    const response = await waitForValueOrAbort(
      Promise.resolve().then(() =>
        fetchImplementation(url, {
          ...init,
          headers: {
            accept: 'application/json',
            ...init.headers,
            authorization: `Bearer ${token}`,
          },
          redirect: 'error',
          signal,
        }),
      ),
      signal,
    )
    return {
      response,
      redact: (message) => redactSensitiveText(message, [token]),
    }
  } catch (cause) {
    if (signal.aborted) throwAbort(didTimeOut)
    const detail =
      cause instanceof Error ? redactSensitiveText(cause.message, [token]) : 'unknown network error'
    fail('NETWORK_ERROR', `Assessment API request failed: ${detail}`, {
      retryable: true,
    })
  }
}

function retryAfterMilliseconds(response: Response, now: () => number): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : Number.NaN
  if (Number.isFinite(seconds)) return Math.ceil(seconds * 1_000)
  const date = Date.parse(header)
  if (!Number.isFinite(date)) return undefined
  const current = now()
  if (!Number.isFinite(current)) fail('INVALID_OPTIONS', 'now() must return a finite timestamp')
  return Math.max(0, date - current)
}

function pollingDelay(attempt: number, initial: number, maximum: number): number {
  return Math.min(maximum, initial * 2 ** Math.min(attempt, 20))
}

function validateJitterRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 0.5) {
    fail('INVALID_OPTIONS', 'retryJitterRatio must be between 0 and 0.5')
  }
  return value
}

function jitteredRetryDelay(baseDelay: number, random: () => number, jitterRatio: number): number {
  if (jitterRatio === 0) return baseDelay
  let sample: number
  try {
    sample = random()
  } catch {
    fail('INVALID_OPTIONS', 'random() failed while calculating retry jitter')
  }
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    fail(
      'INVALID_OPTIONS',
      'random() must return a finite number from 0 up to (but not including) 1',
    )
  }
  return baseDelay + Math.max(1, Math.floor(baseDelay * jitterRatio * sample))
}

function isRetryableNetworkError(error: unknown): error is MigrationAssessmentClientError {
  return (
    error instanceof MigrationAssessmentClientError &&
    error.code === 'NETWORK_ERROR' &&
    error.retryable
  )
}

export async function runMigrationAssessment(
  input: MigrationAssessmentInput,
  options: RunMigrationAssessmentOptions,
): Promise<CompletedMigrationAssessment> {
  const request = createMigrationAssessmentRequest(input)
  const apiBaseUrl = normalizeAssessmentApiBaseUrl(
    options.apiBaseUrl ?? DEFAULT_ASSESSMENT_API_BASE_URL,
  )
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultAssessmentSleep
  const timeoutMs = assertPositiveInteger(
    options.timeoutMs ?? DEFAULT_ASSESSMENT_TIMEOUT_MS,
    'timeoutMs',
    60 * 60 * 1_000,
  )
  const initialPollIntervalMs = assertPositiveInteger(
    options.initialPollIntervalMs ?? 1_000,
    'initialPollIntervalMs',
    60_000,
  )
  const maxPollIntervalMs = assertPositiveInteger(
    options.maxPollIntervalMs ?? 10_000,
    'maxPollIntervalMs',
    60_000,
  )
  const random = options.random ?? Math.random
  const jitterRatio = validateJitterRatio(options.retryJitterRatio ?? 0.2)
  if (initialPollIntervalMs > maxPollIntervalMs) {
    fail('INVALID_OPTIONS', 'initialPollIntervalMs must not exceed maxPollIntervalMs')
  }
  const startedAt = now()
  if (!Number.isFinite(startedAt)) fail('INVALID_OPTIONS', 'now() must return a finite timestamp')
  const deadline = startedAt + timeoutMs
  const bounded = createBoundedSignal(timeoutMs, options.signal)
  const idempotencyKey = options.idempotencyKey ?? randomUUID()
  assertBoundedString(
    idempotencyKey,
    'idempotencyKey',
    128,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'INVALID_OPTIONS',
  )

  try {
    const createUrl = new URL('v1/migration-assessments', apiBaseUrl)
    const waitForRetry = async (attempt: number, retryAfter?: number): Promise<number> => {
      const remaining = remainingMilliseconds(deadline, now)
      if (remaining === 0)
        fail('ASSESSMENT_TIMEOUT', 'Migration assessment timed out', {
          retryable: true,
        })
      const delay = Math.min(
        remaining,
        jitteredRetryDelay(
          Math.max(
            pollingDelay(attempt, initialPollIntervalMs, maxPollIntervalMs),
            retryAfter ?? 0,
          ),
          random,
          jitterRatio,
        ),
      )
      try {
        await waitForValueOrAbort(
          Promise.resolve().then(() => sleep(delay, bounded.signal)),
          bounded.signal,
        )
      } catch {
        if (bounded.signal.aborted) throwAbort(bounded.didTimeOut)
        fail('POLLING_ERROR', 'Assessment retry delay failed', {
          retryable: true,
        })
      }
      return attempt + 1
    }

    let submission: MigrationAssessmentSubmission | undefined
    let createAttempt = 0
    while (submission === undefined) {
      let authenticatedCreateResponse: AuthenticatedResponse
      try {
        authenticatedCreateResponse = await authenticatedRequest(
          createUrl,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': idempotencyKey,
            },
            body: JSON.stringify(request),
          },
          fetchImplementation,
          options.getAccessToken,
          bounded.signal,
          bounded.didTimeOut,
        )
      } catch (error) {
        if (!isRetryableNetworkError(error)) throw error
        createAttempt = await waitForRetry(createAttempt)
        continue
      }
      const { response: createResponse, redact } = authenticatedCreateResponse

      if (createResponse.status === 429 || createResponse.status >= 500) {
        const retryAfter = retryAfterMilliseconds(createResponse, now)
        const apiError = await readHttpError(
          createResponse,
          bounded.signal,
          bounded.didTimeOut,
          redact,
        )
        if (!apiError.retryable) throw apiError
        createAttempt = await waitForRetry(createAttempt, retryAfter)
        continue
      }
      if (createResponse.status !== 202) {
        throw await readHttpError(createResponse, bounded.signal, bounded.didTimeOut, redact)
      }
      try {
        submission = parseMigrationAssessmentSubmission(
          await readBoundedJson(createResponse, bounded.signal, bounded.didTimeOut),
        )
      } catch (error) {
        if (!isRetryableNetworkError(error)) throw error
        createAttempt = await waitForRetry(createAttempt)
      }
    }
    const statusUrl = resolveStatusUrl(submission.statusUrl, apiBaseUrl)
    const normalizedSubmission = {
      ...submission,
      statusUrl: statusUrl.toString(),
    }
    options.onSubmitted?.(normalizedSubmission)
    options.onStatus?.('queued')

    let attempt = 0
    let lastStatus: MigrationAssessmentStatus = 'queued'
    let createdAt: string | undefined
    let lastUpdatedAt: string | undefined
    while (true) {
      if (bounded.signal.aborted) throwAbort(bounded.didTimeOut)
      if (remainingMilliseconds(deadline, now) === 0) {
        fail('ASSESSMENT_TIMEOUT', 'Migration assessment timed out', {
          retryable: true,
        })
      }

      let authenticatedStatusResponse: AuthenticatedResponse
      try {
        authenticatedStatusResponse = await authenticatedRequest(
          statusUrl,
          { method: 'GET' },
          fetchImplementation,
          options.getAccessToken,
          bounded.signal,
          bounded.didTimeOut,
        )
      } catch (error) {
        if (!isRetryableNetworkError(error)) throw error
        attempt = await waitForRetry(attempt)
        continue
      }
      const { response, redact } = authenticatedStatusResponse

      let retryAfter: number | undefined
      if (response.status === 429 || response.status >= 500) {
        retryAfter = retryAfterMilliseconds(response, now)
        const apiError = await readHttpError(response, bounded.signal, bounded.didTimeOut, redact)
        if (!apiError.retryable) throw apiError
      } else {
        if (response.status !== 200) {
          throw await readHttpError(response, bounded.signal, bounded.didTimeOut, redact)
        }
        let status: MigrationAssessmentStatusResponse
        try {
          status = parseMigrationAssessmentStatus(
            await readBoundedJson(response, bounded.signal, bounded.didTimeOut),
          )
        } catch (error) {
          if (!isRetryableNetworkError(error)) throw error
          attempt = await waitForRetry(attempt)
          continue
        }
        if (status.assessmentId !== submission.assessmentId) {
          fail('INVALID_RESPONSE', 'Assessment status response has a different assessmentId')
        }
        if (createdAt !== undefined && status.createdAt !== createdAt) {
          fail('INVALID_RESPONSE', 'Assessment status response changed createdAt')
        }
        if (
          lastUpdatedAt !== undefined &&
          Date.parse(status.updatedAt) < Date.parse(lastUpdatedAt)
        ) {
          fail('INVALID_RESPONSE', 'Assessment status response moved updatedAt backwards')
        }
        createdAt ??= status.createdAt
        lastUpdatedAt = status.updatedAt
        if (lastStatus === 'running' && status.status === 'queued') {
          fail('INVALID_RESPONSE', 'Assessment status regressed from running to queued')
        }
        if (status.status !== lastStatus) {
          lastStatus = status.status
          options.onStatus?.(status.status)
        }
        if (status.status === 'failed') {
          fail(status.error.code, redact(status.error.message), {
            retryable: status.error.retryable,
          })
        }
        if (status.status === 'expired') {
          fail(
            'ASSESSMENT_EXPIRED',
            'Migration assessment expired before its artifacts were downloaded',
            {
              retryable: true,
            },
          )
        }
        if (status.status === 'succeeded') {
          return { ...status, statusUrl: statusUrl.toString() }
        }
      }

      attempt = await waitForRetry(attempt, retryAfter)
    }
  } finally {
    bounded.cleanup()
  }
}

export async function downloadMigrationAssessmentArtifact(
  completed: CompletedMigrationAssessment,
  format: MigrationAssessmentArtifactFormat,
  options: DownloadMigrationAssessmentArtifactOptions = {},
): Promise<Uint8Array> {
  if (format !== 'markdown' && format !== 'json')
    fail('INVALID_OPTIONS', 'Artifact format is invalid')
  const artifact = completed.artifacts[format]
  const now = options.now ?? Date.now
  const url = validateArtifactUrl(artifact.url)
  const allowedArtifactHosts = validateArtifactHostAllowlist(options.allowedArtifactHosts)
  validateArtifactTrust(url, completed.statusUrl, allowedArtifactHosts)
  const timeoutMs = assertPositiveInteger(
    options.timeoutMs ?? DEFAULT_ARTIFACT_TIMEOUT_MS,
    'timeoutMs',
    10 * 60 * 1_000,
  )
  const maximumBytes = assertPositiveInteger(
    options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    'maxBytes',
    MAX_ARTIFACT_BYTES,
  )
  const initialRetryIntervalMs = assertPositiveInteger(
    options.initialRetryIntervalMs ?? 500,
    'initialRetryIntervalMs',
    60_000,
  )
  const maxRetryIntervalMs = assertPositiveInteger(
    options.maxRetryIntervalMs ?? 5_000,
    'maxRetryIntervalMs',
    60_000,
  )
  const random = options.random ?? Math.random
  const jitterRatio = validateJitterRatio(options.retryJitterRatio ?? 0.2)
  if (initialRetryIntervalMs > maxRetryIntervalMs) {
    fail('INVALID_OPTIONS', 'initialRetryIntervalMs must not exceed maxRetryIntervalMs')
  }
  const startedAt = now()
  if (!Number.isFinite(startedAt)) fail('INVALID_OPTIONS', 'now() must return a finite timestamp')
  const deadline = startedAt + timeoutMs
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis)
  const sleep = options.sleep ?? defaultAssessmentSleep
  const bounded = createBoundedSignal(timeoutMs, options.signal)
  try {
    const waitForRetry = async (attempt: number, retryAfter?: number): Promise<number> => {
      const remaining = remainingMilliseconds(deadline, now)
      if (remaining === 0)
        fail('ASSESSMENT_TIMEOUT', 'Migration assessment artifact download timed out', {
          retryable: true,
        })
      const delay = Math.min(
        remaining,
        jitteredRetryDelay(
          Math.max(
            pollingDelay(attempt, initialRetryIntervalMs, maxRetryIntervalMs),
            retryAfter ?? 0,
          ),
          random,
          jitterRatio,
        ),
      )
      try {
        await waitForValueOrAbort(
          Promise.resolve().then(() => sleep(delay, bounded.signal)),
          bounded.signal,
        )
      } catch {
        if (bounded.signal.aborted) throwAbort(bounded.didTimeOut)
        fail('ARTIFACT_RETRY_ERROR', 'Assessment artifact retry delay failed', {
          retryable: true,
        })
      }
      return attempt + 1
    }

    const cancelResponseBestEffort = (response: Response) => {
      if (!response.body) return
      /* v8 ignore start -- built-in response streams return a promise */
      try {
        void response.body.cancel().catch(() => undefined)
      } catch {}
      /* v8 ignore stop */
    }

    let attempt = 0
    while (true) {
      const current = now()
      if (!Number.isFinite(current)) fail('INVALID_OPTIONS', 'now() must return a finite timestamp')
      if (Date.parse(artifact.expiresAt) <= current) {
        fail('ARTIFACT_EXPIRED', 'Migration assessment artifact URL has expired', {
          retryable: true,
        })
      }
      if (remainingMilliseconds(deadline, now) === 0) {
        fail('ASSESSMENT_TIMEOUT', 'Migration assessment artifact download timed out', {
          retryable: true,
        })
      }

      let response: Response
      try {
        response = await waitForValueOrAbort(
          Promise.resolve().then(() =>
            fetchImplementation(url, {
              method: 'GET',
              headers: {
                accept: format === 'markdown' ? 'text/markdown' : 'application/json',
              },
              redirect: 'error',
              signal: bounded.signal,
            }),
          ),
          bounded.signal,
        )
      } catch {
        if (bounded.signal.aborted) throwAbort(bounded.didTimeOut)
        attempt = await waitForRetry(attempt)
        continue
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = retryAfterMilliseconds(response, now)
        cancelResponseBestEffort(response)
        attempt = await waitForRetry(attempt, retryAfter)
        continue
      }
      if (response.status !== 200) {
        cancelResponseBestEffort(response)
        fail(
          'ARTIFACT_DOWNLOAD_FAILED',
          `Assessment artifact download returned HTTP ${response.status}`,
          {
            httpStatus: response.status,
          },
        )
      }

      let bytes: Uint8Array
      try {
        bytes = await readBoundedBytes(response, maximumBytes, bounded.signal, bounded.didTimeOut)
      } catch (error) {
        if (!isRetryableNetworkError(error)) throw error
        attempt = await waitForRetry(attempt)
        continue
      }
      if (bytes.byteLength === 0) fail('INVALID_ARTIFACT', 'Migration assessment artifact is empty')
      const text = decodeUtf8(bytes, 'Migration assessment artifact')
      if (format === 'json') {
        try {
          JSON.parse(text)
        } catch {
          fail('INVALID_ARTIFACT', 'Migration assessment JSON artifact is malformed')
        }
      }
      return bytes
    }
  } finally {
    bounded.cleanup()
  }
}
