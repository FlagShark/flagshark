# Provider-API Integration — Design

**Status:** Design / pending implementation plan
**Date:** 2026-05-13
**Scope:** New cross-reference feature: detected flag references × flag-platform API → new staleness signals
**Initial provider:** LaunchDarkly (architecture is pluggable for later additions)

## 1. Goal

Turn FlagShark from a polyglot grep into a flag-cleanup product. Cross-reference each flag key detected in source code against the flag-management platform's API. Two new signals fall out:

- **`missing-in-platform`** — flag key referenced in code but absent from the platform. Production-risk bug: SDK falls back to default value, behavior diverges from intent. Surfaced as `severity: 'error'`.
- **`archived-in-platform`** — flag exists in the platform but is archived. Combined with existing `age` / `low-usage` signals, this is "confirmed stale" — safe to delete with high confidence. Surfaced as `severity: 'warning'`.

V1 ships LaunchDarkly support. The abstraction is built so that adding Unleash / Statsig / PostHog / etc. is a 3-file PR with no changes to `scan-repo.ts`, `staleness.ts`, or any output formatter.

## 2. Today's state

- `scanRepo()` produces `staleFlags[]` based on two signal sources: `age` (git-blame) and `low-usage` (single-file occurrence). Both are offline, code-only signals.
- 13 flag-provider SDKs are detected from imports in source code. No project today knows whether the detected flag keys correspond to real, live, archived, or deleted entries in the platform.
- No code in the repo authenticates against any external API.

## 3. Approach

Add a `providers/` module under `@flagshark/core` that:

1. Defines a `ProviderDefinition` interface (registry pattern — see Section 5)
2. Ships one concrete implementation: LaunchDarkly REST
3. Wires into `scanRepo` after the detection phase, before staleness analysis
4. Adds a disk-backed cache (XDG-spec location, 24h TTL by default)
5. Adds 2 new signal types (`missing-in-platform`, `archived-in-platform`) with a new `severity` field on `StalenessSignal`
6. Gracefully degrades on API failure — code-only signals always work, even if the API is unreachable

Strict additivity: turning the integration on never makes a scan worse than the v1.3 baseline.

## 4. Architecture & file layout

```
packages/core/src/
  providers/                              # NEW
    index.ts                              # public exports
    interface.ts                          # PlatformProvider + Flag types
    registry.ts                           # static array of ProviderDefinition
    cache.ts                              # disk-backed cache (XDG)
    cross-reference.ts                    # joins detected × platform flags
    launchdarkly/
      definition.ts                       # registry entry
      client.ts                           # REST client
      types.ts                            # Zod schemas for LD API responses
  scan-repo.ts                            # CHANGE — orchestrate provider integration
  staleness.ts                            # CHANGE — accept platformSignals, emit them
  config/schema.ts                        # CHANGE — providers: Record<string, ...> block

packages/core/test/providers/
  launchdarkly/
    client.test.ts                        # fake fetch, no network
    definition.test.ts
  registry.test.ts
  cache.test.ts
  cross-reference.test.ts
  scan-repo-platform.test.ts              # integration with fake provider
```

## 5. Provider registry (the extensibility surface)

Adding a new provider requires touching exactly three files:
1. `packages/core/src/providers/<name>/definition.ts` — Zod config schema + factory
2. `packages/core/src/providers/<name>/client.ts` — REST client
3. `packages/core/src/providers/registry.ts` — one import + one array entry

No changes to `scan-repo.ts`, `staleness.ts`, `config/schema.ts`, or any output formatter.

### Interfaces (`providers/interface.ts`)

```ts
import type { ZodType } from 'zod'

export interface PlatformFlag {
  key: string
  archived: boolean                        // each provider maps its own concept
  lastModified: Date | null
}

export interface PlatformProvider {
  name: string                             // registry key
  displayName: string                      // 'LaunchDarkly'
  listFlags(opts?: { signal?: AbortSignal }): Promise<PlatformFlag[]>
}

export interface ProviderDefinition<TConfig = unknown> {
  name: string                             // YAML key + registry key
  displayName: string
  defaultTokenEnv: string                  // env var read for the secret
  configSchema: ZodType<TConfig>           // provider-specific config validation
  createProvider: (config: TConfig, token: string) => PlatformProvider
}
```

### Registry (`providers/registry.ts`)

```ts
import { launchdarklyDefinition } from './launchdarkly/definition.js'

export const providerRegistry: ReadonlyArray<ProviderDefinition> = [
  launchdarklyDefinition,
]

export function findProviderDefinition(name: string): ProviderDefinition | undefined {
  return providerRegistry.find((p) => p.name === name)
}
```

### Top-level config schema (`config/schema.ts`)

```ts
providers: z.record(
  z.string(),
  z.object({ token_env: z.string().optional() }).passthrough()
).optional()
```

The central schema validates only the shared `token_env` field. Each provider's `configSchema` validates its own fields at the point of use.

## 6. LaunchDarkly v1 implementation

### Config

```yaml
# .flagshark.yml
providers:
  launchdarkly:
    project: my-project-key                # required
    environment: production                # required
    api_base: https://app.launchdarkly.com # optional, default shown (for on-prem deploys)
    token_env: LAUNCHDARKLY_API_TOKEN      # optional, default shown
```

### Definition (`providers/launchdarkly/definition.ts`)

```ts
const launchdarklyConfigSchema = z.object({
  project: z.string(),
  environment: z.string(),
  api_base: z.string().url().optional(),
  token_env: z.string().optional(),
})

export const launchdarklyDefinition: ProviderDefinition<LdConfig> = {
  name: 'launchdarkly',
  displayName: 'LaunchDarkly',
  defaultTokenEnv: 'LAUNCHDARKLY_API_TOKEN',
  configSchema: launchdarklyConfigSchema,
  createProvider: (cfg, token) => ({
    name: 'launchdarkly',
    displayName: 'LaunchDarkly',
    listFlags: ({ signal } = {}) => fetchAllFlags({
      project: cfg.project, environment: cfg.environment, token,
    }, { apiBase: cfg.api_base, signal }),
  }),
}
```

### Client (`providers/launchdarkly/client.ts`)

- Endpoint: `GET https://app.launchdarkly.com/api/v2/flags/{projectKey}?env={environmentKey}&limit=100&offset=0&summary=1`
- Auth: `Authorization: <token>` header (LD does NOT use `Bearer ` prefix)
- API version pinned: `LD-API-Version: 20240415` header
- Response validated with Zod against `FlagsResponseSchema`
- Paginates via `_links.next.href`
- `fetch` is dependency-injected for testing (defaults to `globalThis.fetch`)
- `AbortSignal` supported throughout
- Errors thrown as `LdApiError` with HTTP status code attached

### No retry logic in v1

The handful of read requests per scan against a generous rate limit (1000 req/10min) means retries aren't necessary. If the API returns 5xx, the error propagates to `scanRepo`, which logs and falls back to code-only signals. Adding exponential-backoff retry is a follow-up if needed.

## 7. Data flow

```
                          ┌─────────────────────────┐
                          │  scanRepo(opts)         │
                          └────────────┬────────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  │                    │                    │
                  ▼                    ▼                    ▼
        ┌──────────────────┐  ┌────────────────┐  ┌─────────────────────┐
        │ collectFiles     │  │ analyzer       │  │ for each entry in   │
        │ (existing)       │  │ (existing)     │  │ config.providers    │
        └────────┬─────────┘  └───────┬────────┘  └──────────┬──────────┘
                 │                    │                      │
                 │                    ▼                      ▼
                 │          ┌─────────────────────┐  ┌───────────────────┐
                 │          │ totalFlags Map      │  │ loadPlatformFlags │
                 │          │ (Map<key, Flag[]>)  │  │ (cache or API)    │
                 │          └──────────┬──────────┘  └─────────┬─────────┘
                 │                     │                       │
                 │                     └───────────┬───────────┘
                 │                                 │
                 │                                 ▼
                 │                       ┌─────────────────────┐
                 │                       │ crossReference()    │
                 │                       │ → platform signals  │
                 │                       └──────────┬──────────┘
                 │                                  │
                 ▼                                  ▼
        ┌──────────────────────────────────────────────────────┐
        │ analyzeStaleness({ totalFlags, platformSignals? })   │
        │   merges age + low-usage + platform signals          │
        └──────────────────────┬───────────────────────────────┘
                               │
                               ▼
                      ScanRepoResult (existing shape, signals[] grows)
```

### `scan-repo.ts` orchestration

After analyzer completes, before staleness:

```ts
const allPlatformSignals = new Map<string, PlatformSignal[]>()
for (const [name, rawConfig] of Object.entries(config.providers ?? {})) {
  const def = findProviderDefinition(name)
  if (!def) {
    logger.warn(`Unknown provider '${name}' — skipping`)
    continue
  }
  const parsed = def.configSchema.safeParse(rawConfig)
  if (!parsed.success) {
    logger.warn(`Invalid config for provider '${name}': ${parsed.error.message}`)
    continue
  }
  const tokenEnv = (rawConfig as { token_env?: string }).token_env ?? def.defaultTokenEnv
  const token = process.env[tokenEnv]
  if (!token) {
    logger.warn(`${def.displayName}: missing ${tokenEnv}; skipping`)
    continue
  }
  const provider = def.createProvider(parsed.data, token)
  try {
    const flags = await loadPlatformFlagsCached(provider, cacheKeyFor(name, parsed.data, token), { noCache: opts.noCache, signal: opts.signal })
    const signals = crossReference(analysisResult.totalFlags, flags, provider.displayName)
    mergePlatformSignals(allPlatformSignals, signals)
  } catch (err) {
    logger.warn(`${def.displayName}: ${(err as Error).message}. Continuing with code-only signals.`)
  }
}

const staleFlags = await analyzeStaleness(
  analysisResult.totalFlags,
  { thresholdMonths: threshold, repoRoot: opts.cwd, platformSignals: allPlatformSignals },
)
```

### `crossReference()` (`providers/cross-reference.ts`)

Pure function — no IO, fully unit-testable:

```ts
export interface PlatformSignal {
  type: 'missing-in-platform' | 'archived-in-platform'
  severity: 'error' | 'warning'
  description: string                      // 'referenced in code but not found in LaunchDarkly'
}

export function crossReference(
  detectedFlags: Map<string, FeatureFlag[]>,
  platformFlags: PlatformFlag[],
  providerDisplayName: string,
): Map<string, PlatformSignal[]> {
  const platformByKey = new Map(platformFlags.map(f => [f.key, f]))
  const out = new Map<string, PlatformSignal[]>()
  for (const key of detectedFlags.keys()) {
    const platform = platformByKey.get(key)
    if (!platform) {
      out.set(key, [{
        type: 'missing-in-platform', severity: 'error',
        description: `referenced in code but not found in ${providerDisplayName}`,
      }])
    } else if (platform.archived) {
      out.set(key, [{
        type: 'archived-in-platform', severity: 'warning',
        description: `archived in ${providerDisplayName}`,
      }])
    }
  }
  return out
}
```

Note: we deliberately do NOT surface platform-only flags (flags in LD with no code reference). That's a different feature ("orphan platform flags") — out of scope for v1.

### `analyzeStaleness` change

Existing per-flag loop currently calls `checkAgeSignal` and `checkLowUsageSignal`. Add a third step that reads `platformSignals.get(flagName)` and appends them to the same `signals[]` array. **Flags with ONLY a platform signal (no age/low-usage) still get included in `staleFlags`** — the platform signal alone is enough.

`StalenessSignal` gains a `severity: 'error' | 'warning'` field. Existing signals (`age`, `low-usage`) map to `'warning'`. Platform signals map per Section 1.

## 8. Cache layer (`providers/cache.ts`)

### Layout

```
$XDG_CACHE_HOME/flagshark/         # or ~/.cache/flagshark/ if XDG_CACHE_HOME unset
  v1-<provider>-<sha256(project+env+token-hash)>.json
```

### Format

```jsonc
{
  "fetchedAt": "2026-05-13T19:00:00Z",
  "providerName": "launchdarkly",
  "flags": [
    { "key": "CHECKOUT_V2", "archived": false, "lastModified": "2026-05-01T..." }
  ]
}
```

### Behavior

- Default TTL: 24h. Configurable per-call.
- `--no-cache` flag (CLI) / `no-cache: true` input (Action) bypasses cache and forces re-fetch.
- Cache miss is silent.
- Cache hit logs at debug level: `[debug] LaunchDarkly cache hit (age: 1h 12m)`.
- Corrupted file: silently re-fetch, overwrite.
- Token hash in cache key: `sha256(token).slice(0, 8)` — different tokens get different cache entries. The token itself never gets written to disk.
- Directory is global (shared across all repos on the machine). Cache key includes `project+environment+token-hash` so repos targeting different projects don't collide.

### Cache-related risks

- CI runs that wipe `$HOME` between jobs never benefit from cache. Acceptable in v1 (the 1-3 API calls per scan are fast). If it becomes a perf issue, users can use the GitHub Actions cache action to persist the cache directory between runs — pure documentation, no FlagShark code change.

## 9. Failure modes

All failure modes degrade gracefully — never fail the scan over platform integration issues:

| Condition | Behavior |
|---|---|
| Provider config present, token env var missing | Warn `LaunchDarkly: missing LAUNCHDARKLY_API_TOKEN; skipping`. Exit 0. Code-only signals produced. |
| Network failure / timeout / DNS error | Warn `LaunchDarkly: <error>. Continuing with code-only signals.` Exit 0. |
| HTTP 401 / 403 | Same as above. Token is configured wrong but scan still succeeds. |
| HTTP 404 (project key wrong) | Same — warn and continue. |
| HTTP 5xx | Same — no retry in v1. |
| Response fails Zod validation | Warn with the Zod error message. Continue. (Likely indicates LD API changed; rare.) |
| Cache file corrupted | Silent re-fetch. |
| Unknown provider name in config | Warn `Unknown provider 'foo' — skipping`. Continue. |

The only way platform integration *fails the scan* is if `fail-on-error: true` (default) AND a `missing-in-platform` flag was detected. That's intentional: missing-in-platform is a production-risk bug, not a transient infra issue.

## 10. Output integration

### `StalenessSignal` schema change

Existing:
```ts
{ type: 'age' | 'low-usage', description: string }
```

After:
```ts
{
  type: 'age' | 'low-usage' | 'missing-in-platform' | 'archived-in-platform',
  description: string,
  severity: 'error' | 'warning',
}
```

Severity mapping:
- `missing-in-platform` → `error`
- `archived-in-platform` → `warning`
- `age` → `warning`
- `low-usage` → `warning`

### Per-format behavior

**Text** ([packages/core/src/output/text.ts](packages/core/src/output/text.ts)):
- Sort stale flags by severity DESC, then by age DESC. Errors at top.
- Signal column: `error: missing-in-launchdarkly` (red color if TTY; existing color logic respected).
- One-line header summary: `Found N errors + M stale warnings`.

**Markdown** ([packages/core/src/output/markdown.ts](packages/core/src/output/markdown.ts)):
- Two sections in this order: `### 🚨 Production-risk: flags missing in LaunchDarkly`, then `### 🧹 Stale flags`.
- Missing-in-platform section always renders if any error-severity signals exist, regardless of total stale count.

**JSON** ([packages/core/src/output/json.ts](packages/core/src/output/json.ts)):
- Signals serialize with new `severity` field.
- Top-level result gains `errorCount: number` (count of flags with at least one error-severity signal).
- `staleFlags[i].severity` is the max severity across that flag's signals.

**SARIF** ([packages/core/src/output/sarif.ts](packages/core/src/output/sarif.ts)):
- `result.level` mapping: `error` signals → `level: 'error'`, otherwise `level: 'warning'`.
- New rule IDs: `flagshark/missing-in-platform`, `flagshark/archived-in-platform`.

**CSV** ([packages/core/src/output/csv.ts](packages/core/src/output/csv.ts)):
- Adds `severity` column. Existing columns unchanged.

### `fail-on-error` Action input + CLI flag

New Action input: `fail-on-error` (default: `true`). When true, the action calls `core.setFailed(...)` on any `missing-in-platform` flag — regardless of `fail-threshold`. Matches the "these are real bugs" stance.

CLI gains `--fail-on-error` (default: `true`), `--no-fail-on-error` to opt out.

Health-score math stays the same — no double-weighting. The action fails on errors via the dedicated input, not via the score.

### Backward compatibility

- Existing scans without `providers:` configured produce identical output to v1.3
- Existing consumers reading `staleFlags[i].signals[j]` without checking `.severity` see no breaking change (new field is purely additive)
- Existing `fail-threshold` behavior is unchanged

## 11. Testing

### Test surface

- **`providers/launchdarkly/client.test.ts`** — `fetch` is dependency-injected; tests pass a fake `fetch` returning canned LD API responses. Covers: single page, paginated (3 pages via `_links.next`), 401, 403, 404, 5xx, malformed JSON (Zod rejection), abort via `AbortSignal`.
- **`providers/launchdarkly/definition.test.ts`** — token resolution from env, missing-token error, custom `token_env`, config validation.
- **`providers/registry.test.ts`** — lookup hit, lookup miss, list shape.
- **`providers/cache.test.ts`** — hit, miss, TTL expiry, corrupted file (re-fetch), `noCache: true`, token-hash isolation (two tokens don't collide), XDG path resolution.
- **`providers/cross-reference.test.ts`** — pure-function unit tests: missing-in-platform, archived-in-platform, both intact (no signal), no platform flags (treats all as missing), multi-provider (signals stack per flag).
- **`scan-repo-platform.test.ts`** — integration: build fixture repo, inject a fake provider via a new `opts.providers` injection point (mirrors the existing `scanRepoFn` injection used for Action E2E), assert signals appear in result, assert health-score correct, assert error-severity surfaces.
- **Output formatter tests** — each existing formatter test file extends to cover the new signal types + severity rendering.
- **Action E2E** — extends `packages/action/test/e2e/` with `platform-integration.test.ts`: drives the new code path through `runAction` with a fake LD response; covers `fail-on-error: true` and `fail-on-error: false`.

### Coverage gate

100% on all packages, enforced. No new `v8 ignore` annotations expected — the new code is straightforward control flow with clear error paths.

## 12. Acceptance criteria

- [ ] User adds `providers.launchdarkly: { project, environment }` to `.flagshark.yml`, exports `LAUNCHDARKLY_API_TOKEN`, runs `flagshark scan`, sees platform signals in output
- [ ] Scan without `providers:` configured produces identical output to v1.3 (no regression)
- [ ] All 4 API failure modes (missing token, network error, 401/403, malformed response) emit a clear warning and exit 0
- [ ] Cache works: second consecutive scan against same project+env hits the cache (no network call)
- [ ] `--no-cache` forces re-fetch
- [ ] Adding a hypothetical 2nd provider (`dummy` provider for test purposes) requires touching exactly the 3 files in Section 5's checklist — verified by writing such a stub provider in tests
- [ ] All 5 output formats render the new signals correctly (text/json/markdown/csv/sarif)
- [ ] GitHub Action `fail-on-error: true` (default) calls `core.setFailed` when any `missing-in-platform` flag is found
- [ ] CLI `--fail-on-error` (default true) exits with code 1 on missing-in-platform; `--no-fail-on-error` returns to normal exit code semantics
- [ ] 100% coverage gate still passes on all packages
- [ ] All existing 616 tests still pass

## 13. Out of scope (deferred)

- Other providers (Unleash, Statsig, PostHog, etc.) — registry is ready; adding them is follow-up PRs per Section 5's checklist
- Multi-environment scans against one provider (e.g., LD `prod` AND `staging` in one run). The current `providers: Record<string, ...>` schema requires unique keys; this would need `providers: Array<...>` instead. v2.
- "Orphan platform flags" (flags in LD with no code reference). Different data shape; v2.
- Auto-removal PRs for archived-in-both flags
- Provider-specific dashboards or hosted UIs
- Cross-CI-run cache persistence (users can wire it up via `actions/cache` if they need it)
- Webhooks / proactive notifications (Slack, Linear, etc.)
- Exponential-backoff retry on transient API errors
- Dynamic plugin loading (third-party providers via `node_modules/flagshark-plugin-*`). Registry pattern would accommodate this in v2 by swapping the static array for a discovery function.

## 14. Risks & mitigations

- **Risk:** LaunchDarkly API changes break us silently. **Mitigation:** Zod validation on responses; pinned `LD-API-Version: 20240415` header. If LD breaks the schema, we get a clear error.
- **Risk:** Users put their API token in `.flagshark.yml`. **Mitigation:** Config schema doesn't accept a `token` field — only `token_env` (the *name* of an env var). Trying to put `token: <secret>` will fail Zod validation with a clear error pointing users to env vars.
- **Risk:** Cache lives in `~/.cache/flagshark/` indefinitely; stale entries pile up. **Mitigation:** Each cache key embeds project+env+token-hash, so adding/removing/rotating only adds entries; total disk footprint is small (small JSON files). A future `flagshark cache clear` command can be added in v2 if needed.
- **Risk:** Adding the `severity` field to `StalenessSignal` breaks downstream JSON consumers. **Mitigation:** Additive field; existing readers ignore unknown fields. Documented in CHANGELOG.

## 15. Steady-state — what "done" looks like

- `flagshark scan` with provider config emits 0-many `missing-in-platform` errors and 0-many `archived-in-platform` warnings, in addition to existing `age` / `low-usage` signals
- Adding Unleash support is a 3-file PR, no central-code changes
- All test suites green, 100% coverage, threshold enforced in CI
- Documentation update covers: env var setup, `.flagshark.yml` `providers:` block, `fail-on-error` behavior, the new signal types + severity, troubleshooting (cache flush, API failures)
