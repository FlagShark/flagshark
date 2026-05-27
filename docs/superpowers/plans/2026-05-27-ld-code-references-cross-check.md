# LaunchDarkly Code-References Cross-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-check FlagShark's per-flag detection count against LaunchDarkly's code-references count, emit a `coverage-gap-vs-platform` info signal when LD reports more references than FlagShark detected, and log a one-line advisory when LD's code-refs feature isn't configured for the project.

**Architecture:** Add one new aux fetch in the LD client (`GET /api/v2/code-refs/statistics/{project}`, single best-effort call, follows the `fetchFlagStatuses` pattern), populating a new `PlatformFlag.codeReferences?: { count: number } | null` three-state field. The cross-reference layer emits a new `coverage-gap-vs-platform` signal when `codeReferences.count > detectedFlags.get(key).length`. A `ScanLogger` is threaded through `PlatformClient.listFlags` opts so the LD client can emit a one-line advisory when the endpoint returns 401/403/404.

**Tech Stack:** TypeScript, Zod (`.passthrough()` schemas), Vitest (tests), `@flagshark/core` monorepo (Bun + Turbo).

**Spec:** `docs/superpowers/specs/2026-05-27-ld-code-references-cross-check-design.md`

---

## File Structure

**Modified files:**

- `packages/core/src/providers/interface.ts` — `PlatformFlag.codeReferences` field, `PlatformSignal.type` union widens, `PlatformClient.listFlags` opts gains `logger?: ScanLogger`. Type-only import of `ScanLogger` from `../scan-repo.js`.
- `packages/core/src/providers/cache.ts` — `loadPlatformFlagsCached` opts gains `logger?: ScanLogger`, forwards to `listFlags`.
- `packages/core/src/providers/orchestrate.ts` — passes `opts.logger` through to `loadPlatformFlagsCached`; `metadataByFlag` value type gains `codeReferences`; `hasMetadata` widens; populate `codeReferences` in metadata loop.
- `packages/core/src/providers/launchdarkly/definition.ts` — `createClient.listFlags` closure forwards `logger` from opts.
- `packages/core/src/providers/launchdarkly/types.ts` — `CodeRefsStatisticsResponseSchema` added.
- `packages/core/src/providers/launchdarkly/client.ts` — `FetchAllFlagsOptions.logger` field, new `fetchCodeReferences` function, Aux 5 call site in `fetchAllFlags`, advisory log when unavailable.
- `packages/core/src/providers/cross-reference.ts` — emit `coverage-gap-vs-platform` signal.
- `packages/core/src/staleness.ts` — `StalenessSignal.type` union widens, `StaleFlag.codeReferences` field, `StalenessOptions.platformMetadata` value type widens, populate in `analyzeStaleness`.
- `packages/core/src/output/json.ts` — top-level `codeReferences` per-flag conditional spread.

**Modified tests:**

- `packages/core/test/providers/launchdarkly/client.test.ts`
- `packages/core/test/providers/cache.test.ts`
- `packages/core/test/providers/cross-reference.test.ts`
- `packages/core/test/providers/orchestrate.test.ts`
- `packages/core/test/staleness.test.ts`
- `packages/core/test/output/json.test.ts`
- `packages/core/test/providers/launchdarkly/client.live.test.ts`

**No new source files.** All changes additive to existing files.

---

## Task 1: Logger threading through PlatformClient + cache + orchestrate (no behavior change)

This task is pure plumbing — adds `logger?: ScanLogger` to opts at every level so subsequent tasks can use it. No advisory yet, no behavior change.

**Files:**
- Modify: `packages/core/src/providers/interface.ts`
- Modify: `packages/core/src/providers/cache.ts`
- Modify: `packages/core/src/providers/orchestrate.ts`
- Modify: `packages/core/src/providers/launchdarkly/definition.ts`
- Modify: `packages/core/src/providers/launchdarkly/client.ts`
- Test: `packages/core/test/providers/cache.test.ts`

- [ ] **Step 1.1: Write the failing test — `loadPlatformFlagsCached` forwards `logger` to `listFlags`**

In `packages/core/test/providers/cache.test.ts`, append a new test inside the `describe('loadPlatformFlagsCached', () => { ... })` block (search for that describe; if it doesn't exist, append at the file's bottom in a new describe).

```ts
import type { ScanLogger } from '../../src/scan-repo.js'

// ... inside an existing describe (or a new one):
  it('forwards opts.logger to client.listFlags on a cache miss', async () => {
    const logger: ScanLogger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    }
    const listFlags = vi.fn().mockResolvedValue([])
    const client = {
      name: 'fake',
      displayName: 'Fake',
      listFlags,
    }
    await loadPlatformFlagsCached(client, 'key-fwd-logger', { cacheDir, logger })
    expect(listFlags).toHaveBeenCalledWith({ signal: undefined, logger })
  })
```

If `vi` isn't already imported in this file, add the import.

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/providers/cache.test.ts
```

Expected: the new test FAILS — `loadPlatformFlagsCached` doesn't yet accept `logger`, and `listFlags` is called without it.

- [ ] **Step 1.3: Add `logger?: ScanLogger` to `PlatformClient.listFlags` opts**

Open `packages/core/src/providers/interface.ts`. Find the `PlatformClient` interface (around line 130). The current signature:

```ts
export interface PlatformClient {
  name: string
  displayName: string
  listFlags(opts?: { signal?: AbortSignal }): Promise<PlatformFlag[]>
}
```

Replace with:

```ts
export interface PlatformClient {
  name: string
  displayName: string
  listFlags(opts?: { signal?: AbortSignal; logger?: ScanLogger }): Promise<PlatformFlag[]>
}
```

Add a type-only import at the top of the file:

```ts
import type { ScanLogger } from '../scan-repo.js'
```

(Place it next to the existing `import type { ZodType } from 'zod'` line. Using `import type` avoids any runtime dependency cycle.)

- [ ] **Step 1.4: Thread `logger` through `loadPlatformFlagsCached`**

In `packages/core/src/providers/cache.ts`, find `loadPlatformFlagsCached` (around line 110). Current signature:

```ts
export async function loadPlatformFlagsCached(
  client: PlatformClient,
  cacheKey: string,
  opts: CacheOptions & { signal?: AbortSignal } = {},
): Promise<PlatformFlag[]> {
  if (!opts.noCache) {
    const cached = readCache(cacheKey, opts)
    if (cached) return cached.flags
  }
  const flags = await client.listFlags({ signal: opts.signal })
  writeCache(cacheKey, flags, opts)
  return flags
}
```

Replace with:

```ts
export async function loadPlatformFlagsCached(
  client: PlatformClient,
  cacheKey: string,
  opts: CacheOptions & { signal?: AbortSignal; logger?: ScanLogger } = {},
): Promise<PlatformFlag[]> {
  if (!opts.noCache) {
    const cached = readCache(cacheKey, opts)
    if (cached) return cached.flags
  }
  const flags = await client.listFlags({ signal: opts.signal, logger: opts.logger })
  writeCache(cacheKey, flags, opts)
  return flags
}
```

Add a type-only import at the top:

```ts
import type { ScanLogger } from '../scan-repo.js'
```

(Place next to the existing `import type { PlatformClient, PlatformFlag } from './interface.js'` line.)

- [ ] **Step 1.5: Thread `logger` through `orchestratePlatforms`**

In `packages/core/src/providers/orchestrate.ts`, find the `loadPlatformFlagsCached(...)` call inside the env loop. Current:

```ts
const flags = opts.listFlagsOverride
  ? await opts.listFlagsOverride(opts.signal)
  : await loadPlatformFlagsCached(client, cacheKey, {
      noCache: opts.noCache,
      signal: opts.signal,
    })
```

Replace with:

```ts
const flags = opts.listFlagsOverride
  ? await opts.listFlagsOverride(opts.signal)
  : await loadPlatformFlagsCached(client, cacheKey, {
      noCache: opts.noCache,
      signal: opts.signal,
      logger: opts.logger,
    })
```

No new imports needed — `ScanLogger` is already in scope via the existing `OrchestratePlatformsOptions.logger` field.

- [ ] **Step 1.6: Forward `logger` in `createClient` closure**

In `packages/core/src/providers/launchdarkly/definition.ts`, find the `createClient` factory. Current `listFlags` closure:

```ts
createClient: (cfg, token) => ({
  name: 'launchdarkly',
  displayName: 'LaunchDarkly',
  listFlags: ({ signal } = {}) => {
    // ... comment block ...
    const env = cfg.environment ?? cfg.environments[0]
    return fetchAllFlags(
      { project: cfg.project, environment: env, token },
      { apiBase: cfg.api_base, signal },
    )
  },
}),
```

Replace with:

```ts
createClient: (cfg, token) => ({
  name: 'launchdarkly',
  displayName: 'LaunchDarkly',
  listFlags: ({ signal, logger } = {}) => {
    // ... existing comment block stays ...
    const env = cfg.environment ?? cfg.environments[0]
    return fetchAllFlags(
      { project: cfg.project, environment: env, token },
      { apiBase: cfg.api_base, signal, logger },
    )
  },
}),
```

- [ ] **Step 1.7: Accept `logger` in `FetchAllFlagsOptions`**

In `packages/core/src/providers/launchdarkly/client.ts`, find `FetchAllFlagsOptions` (around line 49). Current:

```ts
export interface FetchAllFlagsOptions {
  apiBase?: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}
```

Replace with:

```ts
export interface FetchAllFlagsOptions {
  apiBase?: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  /**
   * Optional logger for one-line advisory messages emitted by aux
   * fetches (e.g. code-refs not configured). When unset, advisories
   * are silently dropped — useful for tests and direct callers that
   * don't go through the orchestrator.
   */
  logger?: ScanLogger
}
```

Add the type-only import at the top of the file:

```ts
import type { ScanLogger } from '../../scan-repo.js'
```

(Place near the existing `import type { PlatformFlag } from '../interface.js'` line.)

- [ ] **Step 1.8: Run tests + tsc**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run
cd /Users/joe/projects/flagshark/packages/core && bunx tsc --noEmit
```

Expected: all 969 existing tests pass + 1 new (the cache logger-forwarding test) → 970. tsc clean.

- [ ] **Step 1.9: Commit**

```bash
cd /Users/joe/projects/flagshark
git add packages/core/src/providers/interface.ts \
        packages/core/src/providers/cache.ts \
        packages/core/src/providers/orchestrate.ts \
        packages/core/src/providers/launchdarkly/definition.ts \
        packages/core/src/providers/launchdarkly/client.ts \
        packages/core/test/providers/cache.test.ts
git commit -m "refactor(core/providers): thread ScanLogger through listFlags opts (#29)

Pure plumbing — adds an optional logger field to PlatformClient.listFlags
opts, threaded through loadPlatformFlagsCached and orchestratePlatforms,
forwarded by the LD client's createClient closure into fetchAllFlags.
No behavior change yet; subsequent tasks use it for advisory messages
(notably the code-refs-not-configured nudge).

ScanLogger imported as type-only to avoid the providers/interface ->
scan-repo -> providers/orchestrate cycle at runtime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Zod schema + `fetchCodeReferences` aux + PlatformFlag field + advisory log

**Files:**
- Modify: `packages/core/src/providers/interface.ts` (PlatformFlag.codeReferences field)
- Modify: `packages/core/src/providers/launchdarkly/types.ts` (CodeRefsStatisticsResponseSchema)
- Modify: `packages/core/src/providers/launchdarkly/client.ts` (fetchCodeReferences + Aux 5 call site + advisory log)
- Test: `packages/core/test/providers/launchdarkly/client.test.ts`

- [ ] **Step 2.1: Add `codeReferences` to `PlatformFlag`**

In `packages/core/src/providers/interface.ts`, find the `PlatformFlag` interface. Append a new field after the existing fields (after `offVariation?: number` which #31 added — or wherever is the last per-flag field). Add:

```ts
  /**
   * Cross-check data from LaunchDarkly's own code-references feature.
   * LD's `ld-find-code-refs` CLI scans repos and reports how many code
   * references exist for each flag. FlagShark cross-checks LD's count
   * against its own detection count to surface detector blind spots —
   * flags LD found 12 references for but FlagShark only found 8 indicate
   * 4 hunks our patterns missed.
   *
   * Three-state (matches the evaluations30d convention):
   *   - undefined → feature not available (tier-gated, not configured for
   *                 this project, or the aux fetch errored). No signal
   *                 emitted; the LD client logs a single advisory per scan.
   *   - null      → feature available; LD has zero references for this
   *                 flag. No signal — zero refs cannot be a "gap"; FlagShark's
   *                 detection count is necessarily ≥ 0.
   *   - { count } → LD found `count` references for this flag (sum of
   *                 hunkCount across all repos LD scanned).
   *
   * Used by cross-reference to emit `coverage-gap-vs-platform` when
   * count > FlagShark's detection count. LD-says-more direction only —
   * reverse direction is expected: FlagShark scans test files that
   * ld-find-code-refs excludes by default.
   */
  codeReferences?: { count: number } | null
```

Also widen the `PlatformSignal.type` union. Find it in the same file (the JSDoc-decorated union with all signal types). Add `'coverage-gap-vs-platform'` at the end:

```ts
  type:
    | 'missing-in-platform'
    | 'archived-in-platform'
    | 'platform-permanent'
    | 'platform-too-old'
    | 'platform-inactive'
    | 'platform-launched'
    | 'platform-zero-evaluations'
    | 'platform-low-evaluations'
    | 'platform-untouched-stale'
    | 'coverage-gap-vs-platform'   // NEW
```

And add a new bullet to the JSDoc above the union (which itemizes each signal's semantics):

```
   * - `coverage-gap-vs-platform` (info): LD's own code-refs feature reports
   *   more references for this flag than FlagShark detected. Surfaces detector
   *   blind spots — code patterns LD recognizes that our language detectors
   *   missed. Doesn't make the flag stale; informational only. Fires only
   *   when LD count > FlagShark count; reverse direction (FlagShark counts
   *   more) is expected for projects that test-file-exclude in LD.
```

- [ ] **Step 2.2: Write the failing tests for `fetchCodeReferences`**

In `packages/core/test/providers/launchdarkly/client.test.ts`, append five new tests inside the existing `describe('fetchAllFlags', () => { ... })` block (or wherever the existing `fetchAllFlags` mock-fetch tests live):

```ts
  it('populates codeReferences from /code-refs/statistics response (per-flag hunkCount sum)', async () => {
    // Sets up: one flag list result with FOO, and a code-refs response
    // returning two repo entries for FOO with hunkCounts 8 and 4 -> sum 12.
    const fetchFn = vi.fn()
      // 1st call: flags (active)
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          items: [{
            key: 'FOO', archived: false, temporary: true, tags: [],
            variations: [{ value: false }, { value: true }],
            environments: { production: { lastModified: 1700000000000 } },
          }],
          totalCount: 1,
        }),
      })
      // 2nd call: flags (archived) — empty
      .mockResolvedValueOnce({
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [], totalCount: 0 }),
      })
      // Aux: members, flag-statuses, evaluations, audit-log — all empty/ok
      .mockResolvedValue({
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [] }),
      })

    // Override: insert the code-refs response into the mock chain. Since
    // mockResolvedValue is the catch-all, we need to interleave more
    // precisely. Easier: assert via call inspection that the URL ending
    // with /code-refs/statistics/p is called, and that the mock returned
    // the right payload.
    //
    // Simpler approach: use mockImplementation to dispatch on the URL.
    const responses = new Map<string, () => unknown>()
    responses.set('/api/v2/flags/p', () => ({ items: [{
      key: 'FOO', archived: false, temporary: true, tags: [],
      variations: [{ value: false }, { value: true }],
      environments: { production: { lastModified: 1700000000000 } },
    }], totalCount: 1 }))
    responses.set('/api/v2/code-refs/statistics/p', () => ({
      flags: {
        FOO: [
          { name: 'frontend', hunkCount: 8 },
          { name: 'mobile-app', hunkCount: 4 },
        ],
      },
    }))

    const fetchFn2 = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      for (const [path, body] of responses) {
        if (url.includes(path)) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => body(),
          } as unknown as Response
        }
      }
      // Default: 200 with empty items (covers members, flag-statuses,
      // evaluations, audit-log).
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [] }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn2 as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].codeReferences).toEqual({ count: 12 })
  })

  it('sets codeReferences to null when code-refs response has empty flags map', async () => {
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            items: [{
              key: 'BAR', archived: false, temporary: true, tags: [],
              variations: [{ value: false }, { value: true }],
              environments: { production: { lastModified: 1700000000000 } },
            }],
            totalCount: 1,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ flags: {} }),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [] }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].codeReferences).toBeNull()
  })

  it('sets codeReferences to null when a flag is absent from the code-refs response', async () => {
    // BAR is in the flag list but not in the code-refs flags map → LD says 0 refs.
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            items: [{
              key: 'BAR', archived: false, temporary: true, tags: [],
              variations: [{ value: false }, { value: true }],
              environments: { production: { lastModified: 1700000000000 } },
            }],
            totalCount: 1,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ flags: { OTHER: [{ name: 'r', hunkCount: 5 }] } }),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [] }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].codeReferences).toBeNull()
  })

  it('leaves codeReferences undefined and logs advisory when code-refs returns 404', async () => {
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    }
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            items: [{
              key: 'BAR', archived: false, temporary: true, tags: [],
              variations: [{ value: false }, { value: true }],
              environments: { production: { lastModified: 1700000000000 } },
            }],
            totalCount: 1,
          }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: false, status: 404, statusText: 'Not Found',
          json: async () => ({}),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [] }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch, logger },
    )

    expect(flags[0].codeReferences).toBeUndefined()
    expect(logger.info).toHaveBeenCalledOnce()
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('code-references not available')
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('launchdarkly.com/docs')
  })

  it('leaves codeReferences undefined for archived flags', async () => {
    const fetchFn = vi.fn(async (urlOrReq: URL | string | Request) => {
      const url = urlOrReq instanceof URL ? urlOrReq.toString()
        : typeof urlOrReq === 'string' ? urlOrReq
        : urlOrReq.url
      if (url.includes('/api/v2/flags/p')) {
        // Both passes return the archived flag for the archived=true branch.
        if (url.includes('archived=true')) {
          return {
            ok: true, status: 200, statusText: 'OK',
            json: async () => ({
              items: [{
                key: 'OLD', archived: true, temporary: true, tags: [],
                variations: [{ value: false }, { value: true }],
                environments: { production: { lastModified: 1700000000000 } },
              }],
              totalCount: 1,
            }),
          } as unknown as Response
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ items: [], totalCount: 0 }),
        } as unknown as Response
      }
      if (url.includes('/api/v2/code-refs/statistics/p')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ flags: { OLD: [{ name: 'r', hunkCount: 7 }] } }),
        } as unknown as Response
      }
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ items: [] }),
      } as unknown as Response
    })

    const flags = await fetchAllFlags(
      { project: 'p', environment: 'production', token: 'tok' },
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    )

    expect(flags[0].key).toBe('OLD')
    expect(flags[0].archived).toBe(true)
    expect(flags[0].codeReferences).toBeUndefined()
  })
```

- [ ] **Step 2.3: Run tests to verify failure**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/providers/launchdarkly/client.test.ts
```

Expected: 5 new tests FAIL — `codeReferences` is not yet populated.

- [ ] **Step 2.4: Add the Zod schema**

In `packages/core/src/providers/launchdarkly/types.ts`, append (or place near the other response schemas):

```ts
// ── Code references (cross-check FlagShark's detection against LD's) ──
//
// Endpoint: GET /api/v2/code-refs/statistics/{projectKey}
// Response shape: { flags: { [flagKey]: [{ name, hunkCount, fileCount, sourceLink, ... }] } }
//
// We extract hunkCount per repo entry and sum across repos for the
// per-flag count. Other fields are tolerated via .passthrough().

const CodeRefsRepoEntrySchema = z.object({
  hunkCount: z.number().optional(),
}).passthrough()

export const CodeRefsStatisticsResponseSchema = z.object({
  flags: z.record(z.string(), z.array(CodeRefsRepoEntrySchema)).optional().default({}),
  _links: z.unknown().optional(),
}).passthrough()

export type CodeRefsStatisticsResponse = z.infer<typeof CodeRefsStatisticsResponseSchema>
```

- [ ] **Step 2.5: Add `fetchCodeReferences` to the client**

In `packages/core/src/providers/launchdarkly/client.ts`, add the import at the top:

```ts
import {
  AuditLogResponseSchema,
  CodeRefsStatisticsResponseSchema,
  EvaluationsResponseSchema,
  FlagsResponseSchema,
  FlagStatusesResponseSchema,
  MembersResponseSchema,
} from './types.js'
```

(Merge with the existing import; just add the `CodeRefsStatisticsResponseSchema` line.)

Then append a new helper function near the existing `fetchLastTouchedMap` / `fetchFlagStatuses` helpers (toward the end of the file):

```ts
/**
 * Best-effort fetch of LD's per-flag code-references statistics.
 *
 * Returns:
 *   - Map<flagKey, totalHunkCount> on success (possibly empty if no flag
 *     has refs yet — e.g. CI ran but matched nothing)
 *   - null when:
 *       - 401/403/404 (tier-gated / not configured for this project)
 *       - 5xx / 429 (transient errors)
 *       - network or JSON parse failure
 *
 * Caller distinguishes:
 *   - null               → feature unavailable; leave codeReferences undefined
 *                          per flag AND emit the "not configured" advisory
 *   - empty Map          → feature available but no refs yet; flags get null
 *   - populated Map      → join by flag key; flags absent get null
 */
async function fetchCodeReferences(
  config: FetchAllFlagsConfig,
  apiBase: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<Map<string, number> | null> {
  try {
    const url = new URL(
      `/api/v2/code-refs/statistics/${encodeURIComponent(config.project)}`,
      apiBase,
    )
    const res = await fetchFn(url, { headers, signal })
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return null
    }
    if (!res.ok) return null
    const parsed = CodeRefsStatisticsResponseSchema.parse(await res.json())
    const out = new Map<string, number>()
    for (const [flagKey, repoEntries] of Object.entries(parsed.flags)) {
      let total = 0
      for (const entry of repoEntries) {
        if (typeof entry.hunkCount === 'number') total += entry.hunkCount
      }
      out.set(flagKey, total)
    }
    return out
  } catch {
    /* v8 ignore start — defensive catch for malformed JSON / schema
       drift; not exercised by current fixtures. */
    return null
    /* v8 ignore stop */
  }
}
```

- [ ] **Step 2.6: Add the Aux 5 call site in `fetchAllFlags`**

In `packages/core/src/providers/launchdarkly/client.ts`, find the end of `fetchAllFlags` (after the existing Aux 4 audit-log block, before the `return out` line). Add:

```ts
  // Aux 5: LD code-references (cross-check against our own detection).
  // Single project-scoped call; not env-scoped. Surfaces detector blind
  // spots when LD finds more references than FlagShark detected. Opt-in
  // LD feature; when unavailable we log an advisory pointing customers
  // at the setup docs.
  const codeRefs = await fetchCodeReferences(config, apiBase, headers, fetchFn, opts.signal)
  if (codeRefs === null) {
    // Feature unavailable — single advisory line. info-severity (not
    // warn) because this isn't a failure, just a missed-opportunity
    // nudge. The existing logger threading from Task 1 delivers it
    // through the orchestrator into the scan output.
    opts.logger?.info(
      `LaunchDarkly code-references not available for this project — enable it in LD ` +
      `(Code references → Connect repository) to get coverage-gap diagnostics. ` +
      `See https://launchdarkly.com/docs/home/observability/code-references for setup.`,
    )
  } else {
    for (const flag of out) {
      if (flag.archived) continue
      const count = codeRefs.get(flag.key) ?? 0
      flag.codeReferences = count > 0 ? { count } : null
    }
  }
```

- [ ] **Step 2.7: Run tests + tsc**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/providers/launchdarkly/client.test.ts
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run
cd /Users/joe/projects/flagshark/packages/core && bunx tsc --noEmit
```

Expected: 5 new tests pass; 975 total (970 + 5 new). tsc clean.

- [ ] **Step 2.8: Commit**

```bash
cd /Users/joe/projects/flagshark
git add packages/core/src/providers/interface.ts \
        packages/core/src/providers/launchdarkly/types.ts \
        packages/core/src/providers/launchdarkly/client.ts \
        packages/core/test/providers/launchdarkly/client.test.ts
git commit -m "feat(core/ld): fetch code-references statistics + populate PlatformFlag.codeReferences (#29)

New Aux 5 fetch hits /api/v2/code-refs/statistics/{project} — single
best-effort call, follows the fetchFlagStatuses pattern. Sums hunkCount
across repo entries per flag.

Three-state codeReferences semantics on PlatformFlag (matches
evaluations30d convention):
- undefined → feature unavailable (401/403/404 or error); logger.info
              advisory fires once with setup docs link
- null      → LD says zero references for this flag
- { count } → LD found N references

Archived flags skip the field entirely. PlatformSignal.type union gains
'coverage-gap-vs-platform' for the next task's emission rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Cross-reference emits `coverage-gap-vs-platform` signal

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts`
- Test: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 3.1: Write the failing tests**

In `packages/core/test/providers/cross-reference.test.ts`, append six new tests inside the existing `describe('crossReference', () => { ... })` block:

```ts
  it("emits coverage-gap-vs-platform when LD count > FlagShark count", () => {
    const detectedMap = new Map<string, FeatureFlag[]>([
      ['FOO', new Array(8).fill(null).map(() => flag('FOO'))],
    ])
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', {
        key: 'FOO', archived: false, lastModified: null,
        codeReferences: { count: 12 },
        fallthroughVariation: null,
      }],
    ])]])
    const result = crossReference(detectedMap, perEnv, 'LaunchDarkly', {})
    const gap = result.get('FOO')?.find((s) => s.type === 'coverage-gap-vs-platform')
    expect(gap).toBeDefined()
    expect(gap!.severity).toBe('info')
    expect(gap!.description).toContain('12 references')
    expect(gap!.description).toContain('detected 8')
    expect(gap!.description).toContain('gap: 4')
  })

  it("does NOT emit coverage-gap-vs-platform when LD count equals FlagShark count", () => {
    const detectedMap = new Map<string, FeatureFlag[]>([
      ['FOO', new Array(8).fill(null).map(() => flag('FOO'))],
    ])
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', {
        key: 'FOO', archived: false, lastModified: null,
        codeReferences: { count: 8 },
        fallthroughVariation: null,
      }],
    ])]])
    const result = crossReference(detectedMap, perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'coverage-gap-vs-platform')).toBeUndefined()
  })

  it("does NOT emit coverage-gap-vs-platform when LD count < FlagShark count (reverse direction)", () => {
    const detectedMap = new Map<string, FeatureFlag[]>([
      ['FOO', new Array(8).fill(null).map(() => flag('FOO'))],
    ])
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', {
        key: 'FOO', archived: false, lastModified: null,
        codeReferences: { count: 4 },
        fallthroughVariation: null,
      }],
    ])]])
    const result = crossReference(detectedMap, perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'coverage-gap-vs-platform')).toBeUndefined()
  })

  it("does NOT emit coverage-gap-vs-platform when codeReferences is null (LD-says-zero)", () => {
    const detectedMap = new Map<string, FeatureFlag[]>([
      ['FOO', new Array(8).fill(null).map(() => flag('FOO'))],
    ])
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', {
        key: 'FOO', archived: false, lastModified: null,
        codeReferences: null,
        fallthroughVariation: null,
      }],
    ])]])
    const result = crossReference(detectedMap, perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'coverage-gap-vs-platform')).toBeUndefined()
  })

  it("does NOT emit coverage-gap-vs-platform when codeReferences is undefined (feature unavailable)", () => {
    const detectedMap = new Map<string, FeatureFlag[]>([
      ['FOO', new Array(8).fill(null).map(() => flag('FOO'))],
    ])
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      // codeReferences omitted from PlatformFlag literal — treated as undefined
      ['production', {
        key: 'FOO', archived: false, lastModified: null,
        fallthroughVariation: null,
      }],
    ])]])
    const result = crossReference(detectedMap, perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'coverage-gap-vs-platform')).toBeUndefined()
  })

  it("emits coverage-gap-vs-platform with singular 'reference' when LD count is 1", () => {
    // FlagShark detected 0 (flag in detected map but with empty array — edge
    // case in normal use, but worth pinning); LD found 1.
    const detectedMap = new Map<string, FeatureFlag[]>([
      ['FOO', []],  // detected once but no occurrences? Treat as detection count 0.
    ])
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', {
        key: 'FOO', archived: false, lastModified: null,
        codeReferences: { count: 1 },
        fallthroughVariation: null,
      }],
    ])]])
    const result = crossReference(detectedMap, perEnv, 'LaunchDarkly', {})
    const gap = result.get('FOO')?.find((s) => s.type === 'coverage-gap-vs-platform')
    expect(gap).toBeDefined()
    expect(gap!.description).toContain('1 reference')
    expect(gap!.description).not.toContain('1 references')   // singular, no 's'
  })
```

The test file should already have helpers like `flag(name)`, `detected(...)`, `singleEnv(...)`. Use them if compatible; the snippets above construct `Map<string, PlatformFlag>` inline for clarity.

- [ ] **Step 3.2: Run tests to verify failure**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/providers/cross-reference.test.ts
```

Expected: 6 new tests fail (the signal isn't emitted yet).

- [ ] **Step 3.3: Emit the signal in cross-reference**

In `packages/core/src/providers/cross-reference.ts`, find the per-flag stacking loop. The existing structure emits signals like `platform-launched`, `platform-inactive`, `platform-zero-evaluations`, `platform-low-evaluations`, `platform-untouched-stale` one after another.

After the `platform-untouched-stale` emission block (the strict all-envs rule from #30), add:

```ts
    // coverage-gap-vs-platform: LD's code-refs feature reports more
    // references for this flag than FlagShark detected. The delta is
    // detector blind spots — code patterns LD recognizes that our
    // language detectors missed. Info severity: doesn't make the flag
    // stale, just surfaces a detection-quality issue for triage.
    //
    // Fires only LD-says-more. Reverse direction (FlagShark finds more)
    // is expected: LD's ld-find-code-refs CLI excludes test files,
    // node_modules, etc. by default — FlagShark scans them.
    //
    // Three states of codeReferences (read from firstEntry — the field
    // is flag-level, identical across envs in LD's data model):
    //   - undefined → feature unavailable, no signal
    //   - null      → LD says 0 (no gap possible — FlagShark count is ≥ 0)
    //   - { count } → compare count vs FlagShark's detection count
    if (firstEntry.codeReferences && firstEntry.codeReferences.count > 0) {
      const detected = detectedFlags.get(key)?.length ?? 0
      if (firstEntry.codeReferences.count > detected) {
        const gap = firstEntry.codeReferences.count - detected
        const platCount = firstEntry.codeReferences.count
        signals.push({
          type: 'coverage-gap-vs-platform',
          severity: 'info',
          description:
            `${platformDisplayName} detected ${platCount} reference${platCount === 1 ? '' : 's'} ` +
            `for this flag; FlagShark detected ${detected} (gap: ${gap})`,
        })
      }
    }
```

- [ ] **Step 3.4: Run tests + tsc**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/providers/cross-reference.test.ts
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run
cd /Users/joe/projects/flagshark/packages/core && bunx tsc --noEmit
```

Expected: all 6 new tests pass; 981 total (975 + 6). tsc clean.

- [ ] **Step 3.5: Commit**

```bash
cd /Users/joe/projects/flagshark
git add packages/core/src/providers/cross-reference.ts \
        packages/core/test/providers/cross-reference.test.ts
git commit -m "feat(core/cross-ref): emit coverage-gap-vs-platform info signal (#29)

Fires when codeReferences.count > FlagShark detection count. LD-says-more
direction only — reverse direction is expected for projects where
ld-find-code-refs excludes test files. Three suppression cases tested:
LD-says-equal, LD-says-less, codeReferences null/undefined.

Singular vs plural 'reference' handled per count.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Staleness propagation (`StaleFlag.codeReferences`)

**Files:**
- Modify: `packages/core/src/providers/orchestrate.ts` (metadataByFlag value type, hasMetadata, populate)
- Modify: `packages/core/src/staleness.ts` (StalenessSignal type union, StalenessOptions.platformMetadata type, StaleFlag.codeReferences, populate in analyzeStaleness)
- Test: `packages/core/test/staleness.test.ts`
- Test: `packages/core/test/providers/orchestrate.test.ts`

- [ ] **Step 4.1: Write the failing tests**

In `packages/core/test/staleness.test.ts`, find the existing test `'propagates platform variations to StaleFlag.variations via platformMetadata'` (added in #31). Append a sibling test after it:

```ts
  it('propagates platform codeReferences to StaleFlag.codeReferences via platformMetadata', () => {
    // Mirror the existing variations propagation test — adapt to use
    // codeReferences in platformMetadata and assert it surfaces on the
    // resulting StaleFlag.
    //
    // Read the existing variations test in this file and copy its
    // fixture setup. The only changes:
    //  1. platformMetadata entry has codeReferences: { count: 5 } instead
    //     of variations
    //  2. Assert staleFlags[0].codeReferences toEqual({ count: 5 })
  })
```

The skeleton above is illustrative. Read the existing variations propagation test in `staleness.test.ts`, copy its exact setup (which platform signal forces the flag stale, the detection map, the `analyzeStaleness` call), and replace `variations` with `codeReferences: { count: 5 }`.

In `packages/core/test/providers/orchestrate.test.ts`, append a new test inside the existing `describe('orchestratePlatforms', () => { ... })` block:

```ts
  it('populates metadataByFlag.codeReferences from firstEnvFlags[0].codeReferences', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'production' } },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => [{
          key: 'FOO',
          archived: false,
          lastModified: null,
          fallthroughVariation: null,
          codeReferences: { count: 5 },
        }],
      })
      const meta = result.metadataByFlag.get('FOO')
      expect(meta).toBeDefined()
      expect(meta!.codeReferences).toEqual({ count: 5 })
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('treats codeReferences: null as a "has metadata" reason (does NOT skip the flag)', async () => {
    // Regression: if hasMetadata only checked != undefined, codeReferences: null
    // (LD-says-zero) would still pass; ensure that's the case.
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'production' } },
        detectedFlags: detected(['BAR']),
        logger,
        listFlagsOverride: async () => [{
          key: 'BAR',
          archived: false,
          lastModified: null,
          fallthroughVariation: null,
          codeReferences: null,  // LD-says-zero, but field IS present
        }],
      })
      const meta = result.metadataByFlag.get('BAR')
      expect(meta).toBeDefined()
      expect(meta!.codeReferences).toBeNull()
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })
```

- [ ] **Step 4.2: Run tests to verify failure**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/staleness.test.ts test/providers/orchestrate.test.ts
```

Expected: 3 new tests fail — `codeReferences` not propagated.

- [ ] **Step 4.3: Extend `metadataByFlag` in orchestrate.ts**

In `packages/core/src/providers/orchestrate.ts`, find the existing `metadataByFlag` value type. It appears in TWO places (the `OrchestrateResult.metadataByFlag` interface field AND the local `metadataByFlag = new Map<...>()` initialization).

Currently the value type is:

```ts
{
  tags?: string[]
  maintainer?: string
  status?: 'new' | 'active' | 'inactive' | 'launched'
  variations?: FlagVariation[]
}
```

Add `codeReferences?: { count: number } | null`:

```ts
{
  tags?: string[]
  maintainer?: string
  status?: 'new' | 'active' | 'inactive' | 'launched'
  variations?: FlagVariation[]
  codeReferences?: { count: number } | null
}
```

Apply to both occurrences.

- [ ] **Step 4.4: Update the `hasMetadata` check and `metadataByFlag.set` call**

In the same file, find the `for (const flag of firstEnvFlags)` loop. The current `hasMetadata` check:

```ts
const hasMetadata = (flag.tags && flag.tags.length > 0)
  || flag.maintainer
  || flag.status
  || (flag.variations && flag.variations.length > 0)
```

Widen to include `codeReferences`:

```ts
const hasMetadata = (flag.tags && flag.tags.length > 0)
  || flag.maintainer
  || flag.status
  || (flag.variations && flag.variations.length > 0)
  || flag.codeReferences !== undefined
```

(`!== undefined` is deliberate — `codeReferences: null` is a meaningful state, distinct from "field absent / feature unavailable.")

Then find the `metadataByFlag.set(flag.key, {...})` call right below it:

```ts
metadataByFlag.set(flag.key, {
  tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
  maintainer: flag.maintainer,
  status: flag.status,
  variations: flag.variations && flag.variations.length > 0 ? flag.variations : undefined,
})
```

Add `codeReferences`:

```ts
metadataByFlag.set(flag.key, {
  tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
  maintainer: flag.maintainer,
  status: flag.status,
  variations: flag.variations && flag.variations.length > 0 ? flag.variations : undefined,
  codeReferences: flag.codeReferences,
})
```

- [ ] **Step 4.5: Extend `StalenessSignal.type` union**

In `packages/core/src/staleness.ts`, find the `StalenessSignal.type` union. The current shape:

```ts
type:
  | 'age'
  | 'hardcoded'
  | 'low-usage'
  | 'test-only-references'
  | 'missing-in-platform'
  | 'archived-in-platform'
  | 'platform-too-old'
  | 'platform-inactive'
  | 'platform-launched'
  | 'platform-zero-evaluations'
  | 'platform-low-evaluations'
  | 'platform-untouched-stale'
```

Append `| 'coverage-gap-vs-platform'`.

Then find the `severity` field on the same union. The existing type is `'error' | 'warning'`. Widen to `'error' | 'warning' | 'info'`:

```ts
severity: 'error' | 'warning' | 'info'
```

(The `info` severity already exists on `PlatformSignal.severity`; `StalenessSignal` needs to widen to absorb the new signal.)

- [ ] **Step 4.6: Extend `StalenessOptions.platformMetadata` value type**

Find `StalenessOptions.platformMetadata`. Current shape:

```ts
platformMetadata?: Map<
  string,
  {
    tags?: string[]
    maintainer?: string
    status?: 'new' | 'active' | 'inactive' | 'launched'
    variations?: FlagVariation[]
  }
>
```

Add `codeReferences`:

```ts
platformMetadata?: Map<
  string,
  {
    tags?: string[]
    maintainer?: string
    status?: 'new' | 'active' | 'inactive' | 'launched'
    variations?: FlagVariation[]
    codeReferences?: { count: number } | null
  }
>
```

- [ ] **Step 4.7: Extend `StaleFlag` and populate in `analyzeStaleness`**

Find the `StaleFlag` interface. Add after `variations`:

```ts
/**
 * Cross-check count from the platform's own code-references feature.
 * Populated when the platform exposes the feature AND it's available
 * for the project. Surfaced in JSON output for SaaS consumers and
 * verbose text output for human review.
 *
 * See PlatformFlag.codeReferences for the three-state semantics
 * (undefined / null / { count }).
 */
codeReferences?: { count: number } | null
```

Then find the meta-copy block in `analyzeStaleness` (the block that copies `tags`, `maintainer`, `platformStatus`, `variations` from `meta` onto the new StaleFlag — variable named `stale` in #30/#31's code). Add a new line after the variations copy:

```ts
if (meta.variations && meta.variations.length > 0) stale.variations = meta.variations
if (meta.codeReferences !== undefined) stale.codeReferences = meta.codeReferences
```

(`!== undefined` again — preserves the null state.)

- [ ] **Step 4.8: Run tests + tsc**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run
cd /Users/joe/projects/flagshark/packages/core && bunx tsc --noEmit
```

Expected: all 3 new propagation tests pass; 984 total (981 + 3). tsc clean.

- [ ] **Step 4.9: Commit**

```bash
cd /Users/joe/projects/flagshark
git add packages/core/src/providers/orchestrate.ts \
        packages/core/src/staleness.ts \
        packages/core/test/providers/orchestrate.test.ts \
        packages/core/test/staleness.test.ts
git commit -m "feat(core/staleness): propagate codeReferences through metadataByFlag -> StaleFlag (#29)

PlatformFlag.codeReferences -> metadataByFlag -> StaleFlag.codeReferences,
mirroring the existing tags/maintainer/platformStatus/variations flow.
hasMetadata check uses !== undefined so null (LD-says-zero) is treated
as a 'has metadata' reason — distinct from absent (feature unavailable).

StalenessSignal type union gains 'coverage-gap-vs-platform' so the new
signal propagates through to output formatters. StalenessSignal.severity
widens to include 'info'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: JSON output — top-level `codeReferences` per flag

**Files:**
- Modify: `packages/core/src/output/json.ts`
- Test: `packages/core/test/output/json.test.ts`

- [ ] **Step 5.1: Write the failing tests**

In `packages/core/test/output/json.test.ts`, append a new `describe` block:

```ts
describe('formatJson — codeReferences', () => {
  it('emits codeReferences as object when populated', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      codeReferences: { count: 12 },
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].codeReferences).toEqual({ count: 12 })
  })

  it('preserves codeReferences: null literally (LD-says-zero is meaningful)', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      codeReferences: null,
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].codeReferences).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(
      json.flags[0],
      'codeReferences',
    )).toBe(true)
  })

  it('omits codeReferences when undefined (feature unavailable)', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      // codeReferences intentionally undefined
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('codeReferences')
  })
})
```

- [ ] **Step 5.2: Run tests to verify failure**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/output/json.test.ts
```

Expected: 3 new tests fail — `codeReferences` not yet emitted.

- [ ] **Step 5.3: Add the conditional spread to JSON output**

In `packages/core/src/output/json.ts`, find the per-flag mapping. The existing block has spreads for `tags`, `maintainer`, `platformStatus`, `variations`, then the `environments` block. Add `codeReferences` immediately after `variations`:

```ts
...(sf.platformStatus ? { platformStatus: sf.platformStatus } : {}),
...(sf.variations && sf.variations.length > 0 ? { variations: sf.variations } : {}),
// codeReferences uses !== undefined (NOT != null). The null value is
// load-bearing — it signals "LD says zero references for this flag"
// (no gap possible). Omitting null would conflate it with "field
// absent / feature unavailable" (no advisory data). Same pattern as
// fallthroughVariation; same rationale.
...(sf.codeReferences !== undefined ? { codeReferences: sf.codeReferences } : {}),
...(sf.environments && sf.environments.size > 0
  ? { /* existing environments block */ }
  : {}),
```

(Don't touch the existing `environments` block — just add the `codeReferences` line above it.)

- [ ] **Step 5.4: Run tests + tsc + coverage**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run test/output/json.test.ts
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run
cd /Users/joe/projects/flagshark/packages/core && bunx tsc --noEmit
cd /Users/joe/projects/flagshark/packages/core && bun run test:coverage 2>&1 | tail -10
```

Expected: 3 new tests pass; 987 total (984 + 3). tsc clean. Coverage at 100% on json.ts (the three states are covered by the three new tests).

- [ ] **Step 5.5: Commit**

```bash
cd /Users/joe/projects/flagshark
git add packages/core/src/output/json.ts \
        packages/core/test/output/json.test.ts
git commit -m "feat(core/output): top-level codeReferences per flag in JSON (#29)

Conditional spread placed between variations and environments. Uses
!== undefined (not != null) so null is preserved literally — LD-says-zero
is a meaningful state distinct from feature-unavailable. Test pins
this with Object.prototype.hasOwnProperty.call to confirm the key is
present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Live LD contract assertion

**Files:**
- Modify: `packages/core/test/providers/launchdarkly/client.live.test.ts`

- [ ] **Step 6.1: Locate the existing contract loop**

Read `packages/core/test/providers/launchdarkly/client.live.test.ts`. Find the test `'every flag has the contract fields populated'` (or similarly named). Its body iterates `flags` and asserts type contracts.

- [ ] **Step 6.2: Add the codeReferences contract assertion**

Inside the test's `for (const f of flags) { ... }` body, AFTER the existing per-flag assertions (key, archived, variations, on, fallthroughVariation, offVariation from #31), add:

```ts
      // codeReferences is optional — LD's code-refs feature may not be
      // configured on the live test project. Just verify the type
      // contract holds (one of: undefined, null, or { count: number }).
      expect(
        f.codeReferences === undefined
        || f.codeReferences === null
        || (typeof f.codeReferences === 'object' && typeof f.codeReferences.count === 'number'),
      ).toBe(true)
```

- [ ] **Step 6.3: Verify the live test self-skips without credentials**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run test:live 2>&1 | tail -15
```

Expected: all live tests self-skip with `LIVE_LAUNCHDARKLY_API_TOKEN not set`. The new assertion only runs when the suite is unskipped.

- [ ] **Step 6.4: Verify the default suite passes**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run vitest run 2>&1 | tail -5
cd /Users/joe/projects/flagshark/packages/core && bunx tsc --noEmit
```

Expected: 987 tests pass (live tests excluded), tsc clean.

- [ ] **Step 6.5: Commit**

```bash
cd /Users/joe/projects/flagshark
git add packages/core/test/providers/launchdarkly/client.live.test.ts
git commit -m "test(core/ld): live contract assertion for codeReferences (#29)

Extends the existing contract loop with one assertion verifying the
three-state shape of codeReferences (undefined | null | { count: number }).
Self-skips with the rest of the live suite when LIVE_LAUNCHDARKLY_API_TOKEN
is unset; verifies against the live test project when set (most likely
the field is undefined because code-refs isn't enabled on the trial
project — the assertion still passes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification + open PR

- [ ] **Step 7.1: Full monorepo test sweep**

```bash
cd /Users/joe/projects/flagshark && bun run test
```

Expected: every package's tests pass.

- [ ] **Step 7.2: Coverage check (the gate that caught us in #30)**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run test:coverage 2>&1 | tail -30
```

Expected: 100% across statements / branches / lines / functions. Watch for:
- The `count > 0 ? { count } : null` ternary in `client.ts` — both branches needed.
- The `firstEntry.codeReferences && firstEntry.codeReferences.count > 0` and `if (... > detected)` in `cross-reference.ts` — both branches each. The five suppression tests (equal, less, null, undefined, archived) cover false-branch.
- The `count === 1 ? '' : 's'` plural toggle in cross-reference — both branches.
- `!== undefined` guards in json.ts and analyzeStaleness — both branches.
- `flag.codeReferences !== undefined` in `hasMetadata` — both branches.

If any gaps surface, add targeted tests before pushing.

- [ ] **Step 7.3: Typecheck + build**

```bash
cd /Users/joe/projects/flagshark && bun run typecheck
cd /Users/joe/projects/flagshark && bun run build 2>&1 | tail -10
```

Expected: PASS across all 3 packages. (Pre-existing esbuild `import.meta.url` warning is known and unrelated.)

- [ ] **Step 7.4: Push the branch and open a PR**

```bash
cd /Users/joe/projects/flagshark
git push -u origin spec/ld-code-references-cross-check
gh pr create --title "feat(ld): code-references cross-check + coverage-gap diagnostic (#29)" \
  --body "Closes #29.

Cross-checks FlagShark's own detection count against LD's \`ld-find-code-refs\` reference count per flag. When LD reports more references than FlagShark detected, emits a new \`coverage-gap-vs-platform\` info signal — the delta is detector blind spots. When the LD endpoint is unavailable (tier-gated or unconfigured), the LD client emits a one-line \`logger.info\` advisory pointing at LD's setup docs.

## What ships

**\`PlatformFlag.codeReferences?: { count: number } | null\`** — three-state field:
- \`undefined\` → feature unavailable (no signal)
- \`null\` → LD says zero references (no gap possible)
- \`{ count }\` → LD found N references

**New aux fetch** \`/api/v2/code-refs/statistics/{project}\` — single best-effort call, sums \`hunkCount\` across repo entries per flag. 401/403/404 → returns null → triggers the advisory.

**New signal** \`coverage-gap-vs-platform\` (info severity) — fires only when LD count > FlagShark count. Reverse direction is expected because \`ld-find-code-refs\` excludes test files by default.

**JSON output** gains top-level \`codeReferences\` per flag. \`!== undefined\` guard preserves \`null\` literally (load-bearing).

**Logger threading** — \`PlatformClient.listFlags\` opts gains \`logger?: ScanLogger\`. Threaded through \`loadPlatformFlagsCached\` and \`orchestratePlatforms\`. Forwarded by the LD client's \`createClient\` closure.

## Backward compatibility

All new fields are optional. Existing JSON consumers ignore unknown keys. \`PlatformClient.listFlags\` opts additions are optional. No schema migrations. The advisory is informational — it fires once per scan when the feature is off and doesn't affect any other behavior.

## SaaS alignment

Diagnostic signal only — no SaaS Piranha pipeline consumer today. Informs FlagShark's own detector roadmap (which patterns the polyglot scanner misses). The OSS contract is the customer enables LD code-refs in CI → richer FlagShark output. SaaS pipeline behavior unchanged.

Spec: \`docs/superpowers/specs/2026-05-27-ld-code-references-cross-check-design.md\`
Plan: \`docs/superpowers/plans/2026-05-27-ld-code-references-cross-check.md\`

## Testing

987 tests across the monorepo, all green. 100% coverage across statements / branches / lines / functions. Live LD contract assertion self-skips without credentials.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 7.5: Watch CI**

```bash
gh pr checks <pr-number>
```

If anything fails, fix in-place.

---

## Self-review checklist

This was done at write-time; documenting here for reviewers.

- **Spec coverage:** every section of the spec maps to at least one task. Section 4 (endpoint+extraction) → T2; Section 5 (interface) → T2+T4; Section 6 (signal emission) → T3; Section 7 (advisory log) → T1+T2; Section 8 (JSON output) → T5; Section 9 (staleness propagation) → T4; Section 10 (tests) → distributed; Section 11 (SaaS alignment) → noted in PR body.
- **Placeholder scan:** no TBDs. Step 4.1's staleness-test skeleton is marked illustrative because the existing fixture pattern in the file is the source of truth — explicit instruction, not a placeholder.
- **Type consistency:** `codeReferences: { count: number } | null` consistent across `PlatformFlag`, `metadataByFlag`, `StalenessOptions.platformMetadata`, `StaleFlag`. The `!== undefined` (not `!= null`) guard used identically in `hasMetadata`, `analyzeStaleness`, and `output/json.ts`. The `coverage-gap-vs-platform` signal name and `'info'` severity consistent across `PlatformSignal.type`, `StalenessSignal.type`, and the cross-reference emission.
- **TDD discipline:** every task is test-first; the load-bearing-null case in T5 has its own dedicated assertion (`Object.prototype.hasOwnProperty.call`).
