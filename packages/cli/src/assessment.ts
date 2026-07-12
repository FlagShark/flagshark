import { execFile } from 'node:child_process'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_ASSESSMENT_API_BASE_URL,
  DEFAULT_ARTIFACT_TIMEOUT_MS,
  downloadMigrationAssessmentArtifact,
  MigrationAssessmentClientError,
  redactSensitiveText,
  redactUrlForLogs,
  runMigrationAssessment,
  type AssessmentFetch,
  type AssessmentSleep,
  type MigrationAssessmentArtifactFormat,
} from '@flagshark/assessment-client'
import { writeStream } from './write-stream.js'

const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const GIT_TIMEOUT_MS = 5_000
const GIT_MAX_OUTPUT_BYTES = 16 * 1024

export interface AssessCommandArgs {
  repositories: string[]
  ref?: string
  launchDarklyProjectKey?: string
  apiBaseUrl?: string
  tokenEnvironmentVariable: string
  format: MigrationAssessmentArtifactFormat
  output?: string
  timeoutMs: number
}

export interface AssessmentCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  cwd: string
}

export type RunGit = (arguments_: readonly string[], cwd: string) => Promise<string>

export interface AssessmentCommandDependencies {
  fetch?: AssessmentFetch
  now?: () => number
  sleep?: AssessmentSleep
  env?: Readonly<Record<string, string | undefined>>
  runGit?: RunGit
  signal?: AbortSignal
}

export const defaultRunGit: RunGit = (arguments_, cwd) =>
  new Promise<string>((resolvePromise, reject) => {
    execFile(
      'git',
      [...arguments_],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(new Error('Git command failed'))
        else resolvePromise(stdout)
      },
    )
  })

function parseRepositoryPath(pathname: string): string | undefined {
  if (pathname.includes('%')) return undefined
  const withoutSlashes = pathname.replace(/^\/+|\/+$/g, '')
  const withoutGitSuffix = withoutSlashes.endsWith('.git')
    ? withoutSlashes.slice(0, -4)
    : withoutSlashes
  return GITHUB_REPOSITORY_PATTERN.test(withoutGitSuffix) ? withoutGitSuffix : undefined
}

/** Parse a credential-free github.com HTTPS or SSH remote into owner/repository form. */
export function parseGitHubOrigin(remote: string): string | undefined {
  const value = remote.trim()
  if (!value || /[\r\n]/.test(value)) return undefined

  const scpMatch = /^git@github\.com:([^?#]+)$/i.exec(value)
  if (scpMatch) return parseRepositoryPath(scpMatch[1])

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash || url.password) {
    return undefined
  }
  if (url.protocol === 'https:') {
    if (url.username || url.port) return undefined
  } else if (url.protocol === 'ssh:') {
    if (url.username !== 'git' || (url.port && url.port !== '22')) return undefined
  } else {
    return undefined
  }
  return parseRepositoryPath(url.pathname)
}

function validCommitSha(value: string): string | undefined {
  const candidate = value.trim()
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate) ? candidate.toLowerCase() : undefined
}

export async function resolveAssessmentRepositories(
  args: Pick<AssessCommandArgs, 'repositories' | 'ref'>,
  cwd: string,
  runGit: RunGit = defaultRunGit,
): Promise<Array<{ repository: string; ref?: string }>> {
  let repositories = [...args.repositories]
  const repositoryWasInferred = repositories.length === 0
  if (repositoryWasInferred) {
    let remote: string
    try {
      remote = await runGit(['remote', 'get-url', 'origin'], cwd)
    } catch {
      throw new Error('Could not infer --repo: the current directory has no readable Git origin')
    }
    const inferred = parseGitHubOrigin(remote)
    if (!inferred) {
      throw new Error('Could not infer --repo: origin must be a credential-free github.com HTTPS or SSH URL')
    }
    repositories = [inferred]
  }

  let ref = args.ref
  if (ref === undefined && repositoryWasInferred) {
    try {
      const inferredRef = validCommitSha(await runGit(['rev-parse', '--verify', 'HEAD'], cwd))
      if (!inferredRef) throw new Error('Invalid commit SHA')
      ref = inferredRef
    } catch {
      throw new Error('Could not infer --ref: the current Git checkout has no valid HEAD commit')
    }
  }

  return repositories.map((repository) => ({
    repository,
    ...(ref === undefined ? {} : { ref }),
  }))
}

export async function writeFileAtomically(path: string, bytes: Uint8Array, cwd: string): Promise<void> {
  const destination = resolve(cwd, path)
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.flagshark-${process.pid}-${randomUUID()}.tmp`,
  )
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    /* v8 ignore next -- best-effort cleanup errors must not mask the original write/rename error */
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function runAssessCommand(
  args: AssessCommandArgs,
  io: AssessmentCommandIO,
  clientVersion: string,
  dependencies: AssessmentCommandDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env
  const tokenVariable = args.tokenEnvironmentVariable
  const getAccessToken = () => {
    const token = env[tokenVariable]
    if (!token) throw new Error(`Environment variable ${tokenVariable} is not set`)
    return token
  }
  if (!env[tokenVariable]) {
    io.stderr.write(`[error] ${tokenVariable} is required to run a migration assessment\n`)
    return 2
  }

  try {
    const repositories = await resolveAssessmentRepositories(
      args,
      io.cwd,
      dependencies.runGit ?? defaultRunGit,
    )
    const now = dependencies.now ?? Date.now
    const startedAt = now()
    if (!Number.isFinite(startedAt)) {
      throw new MigrationAssessmentClientError(
        'INVALID_OPTIONS',
        'now() must return a finite timestamp',
      )
    }
    if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new MigrationAssessmentClientError(
        'INVALID_OPTIONS',
        'timeoutMs must be a positive integer',
      )
    }
    const deadline = startedAt + args.timeoutMs
    const remainingTimeoutMs = (): number => {
      const current = now()
      if (!Number.isFinite(current)) {
        throw new MigrationAssessmentClientError(
          'INVALID_OPTIONS',
          'now() must return a finite timestamp',
        )
      }
      const remaining = Math.min(args.timeoutMs, Math.ceil(deadline - current))
      if (remaining <= 0) {
        throw new MigrationAssessmentClientError(
          'ASSESSMENT_TIMEOUT',
          'Migration assessment timed out',
          { retryable: true },
        )
      }
      return remaining
    }
    const completed = await runMigrationAssessment(
      {
        repositories,
        ...(args.launchDarklyProjectKey === undefined
          ? {}
          : { launchDarklyProjectKey: args.launchDarklyProjectKey }),
        client: { kind: 'cli', version: clientVersion },
      },
      {
        apiBaseUrl: args.apiBaseUrl ?? env.FLAGSHARK_API_BASE_URL ?? DEFAULT_ASSESSMENT_API_BASE_URL,
        getAccessToken,
        fetch: dependencies.fetch,
        now,
        sleep: dependencies.sleep,
        timeoutMs: remainingTimeoutMs(),
        signal: dependencies.signal,
        onSubmitted: (submission) => {
          io.stderr.write(
            `[info] Migration assessment ${submission.assessmentId} submitted: ${redactUrlForLogs(submission.statusUrl)}\n`,
          )
        },
        onStatus: (status) => {
          io.stderr.write(`[info] Migration assessment ${status}\n`)
        },
      },
    )
    const artifact = await downloadMigrationAssessmentArtifact(completed, args.format, {
      fetch: dependencies.fetch,
      now,
      sleep: dependencies.sleep,
      timeoutMs: Math.min(remainingTimeoutMs(), DEFAULT_ARTIFACT_TIMEOUT_MS),
      signal: dependencies.signal,
    })

    if (args.output && args.output !== '-') {
      await writeFileAtomically(args.output, artifact, io.cwd)
      io.stderr.write(`[info] Migration assessment written to ${args.output}\n`)
    } else {
      await writeStream(io.stdout, artifact)
    }
    return 0
  } catch (error) {
    let message: string
    if (error instanceof Error) message = error.message
    else message = String(error)
    io.stderr.write(`[error] ${redactSensitiveText(message, [env[tokenVariable] ?? ''])}\n`)
    return 2
  }
}
