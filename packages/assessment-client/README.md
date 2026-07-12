# `@flagshark/assessment-client`

Public, dependency-free protocol-v1 client for FlagShark migration assessments.
It contains request/status runtime validation, bounded polling and downloads,
credential-safe URL handling, and no analysis or report-generation logic.

```ts
import {
  runMigrationAssessment,
  downloadMigrationAssessmentArtifact,
} from '@flagshark/assessment-client'

const completed = await runMigrationAssessment({
  repositories: [{ repository: 'owner/repository', ref: commitSha }],
  client: { kind: 'cli', version: '2.7.1' },
}, {
  getAccessToken: () => process.env.FLAGSHARK_API_TOKEN!,
})

const markdown = await downloadMigrationAssessmentArtifact(completed, 'markdown')
```

`getAccessToken` is called before every authenticated API request so clients
such as GitHub Actions can refresh short-lived OIDC tokens. Artifact downloads
are deliberately unauthenticated and accept only HTTPS URLs (with a localhost
HTTP exception for tests). API redirects are rejected, status URLs must remain
same-origin, response bodies are streamed under fixed size limits, and signed
URL queries are removed from client-generated diagnostics.

Submissions use one idempotency key per invocation and safely retry ambiguous
network failures, including a connection reset while reading the `202` body.
Assessment polling and artifact downloads each enforce a hard timeout boundary,
even when an injected fetch, sleep, token provider, or response stream ignores
its abort signal. Structured API errors retry only when permitted by their
`retryable` field; non-retryable quota failures are surfaced immediately.

Production artifact downloads fail closed to HTTPS AWS S3 hostnames because the
private service returns S3 presigned URLs. A caller integrating another trusted
artifact service must pass its exact DNS hostname in `allowedArtifactHosts`.
Loopback artifact URLs are accepted only when the assessment status URL is also
loopback. Fetch, response-stream, `429`, and `5xx` failures use bounded additive
jitter and never carry the assessment API authorization header.
