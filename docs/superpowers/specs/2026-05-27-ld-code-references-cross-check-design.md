# LaunchDarkly Code-References Cross-Check — Design

**Status:** Design / pending implementation plan
**Date:** 2026-05-27
**Issue:** [#29](https://github.com/FlagShark/flagshark/issues/29)
**Scope:** Cross-check FlagShark's own flag detection against LaunchDarkly's `ld-find-code-refs` output to surface detector blind spots, and nudge customers toward enabling LD code-refs when off.

## 1. Goal

FlagShark's polyglot scanner has language-specific patterns. Patterns miss things — Tier-2 languages we don't support yet, unusual call shapes, dynamic flag-key construction, and so on. We have no way to know what we missed.

LD's code-references feature is a separate product where customers configure the `ld-find-code-refs` CLI in their CI; LD scans repos and aggregates per-flag reference counts. When enabled, that data gives us a second opinion. If LD reports 12 references for flag `foo` and FlagShark detected 8, the 4 unaccounted-for hunks are blind spots in our detector patterns — surface them so we can investigate.

Two diagnostics ship together:

1. **Coverage gap** — when LD reports more references than FlagShark detected for a flag, emit a new `coverage-gap-vs-platform` info signal with the delta math in the description.
2. **"Not configured" advisory** — when the endpoint returns 401/403/404 (tier-gated or unconfigured), the LD client emits a single `logger.info` advisory pointing at LD's setup docs.

## 2. Today's state

- `fetchAllFlags` (`packages/core/src/providers/launchdarkly/client.ts`) runs four aux fetches per env: flag-list, flag-statuses, members, evaluations, audit-log. None hit `/api/v2/code-refs/`.
- `PlatformFlag` has no detection-quality fields. The cross-reference layer compares against the platform's view of the flag (status, evaluations, audit log) but not the platform's view of code references.
- `PlatformSignal.type` union covers 9 types; there's no detection-quality diagnostic signal.
- `PlatformClient.listFlags(opts?: { signal?: AbortSignal })` — `opts` carries the abort signal only, no logger.
- Advisory logs today go through `opts.logger.warn` in `orchestratePlatforms` (auth-error hints, missing-token messages). LD client itself doesn't log — errors propagate as `LdApiError`.

## 3. Approach

One additive aux fetch + one new field + one new signal + one logger-threading change. Strictly additive at the OSS interface; no breaking changes; matches the existing `fetchFlagStatuses` shape (single best-effort call, not concurrency-capped per-flag).

Three small architectural choices baked in:

- **`PlatformFlag.codeReferences: { count: number } | null | undefined`** — three-state. Mirrors the `evaluations30d` convention (number/null/undefined). `null` is load-bearing (LD-says-zero, no gap possible); `undefined` is "feature unavailable, no signal."
- **Signal fires only LD-says-more.** Reverse direction (FlagShark counts more than LD) is expected: `ld-find-code-refs` excludes test files / `node_modules` / vendored code by default; FlagShark scans them. Not actionable.
- **Logger threaded via `PlatformClient.listFlags`'s opts.** Adds one optional field to a public interface. Smaller surface than rewriting `createClient`.

## 4. Endpoint and extraction

### Endpoint

`GET /api/v2/code-refs/statistics/{projectKey}` — single call, no env scoping, returns the whole project's reference data.

**Response shape** (verified against [LD's API docs](https://launchdarkly.com/docs/api/code-references/get-statistics)):

```json
{
  "flags": {
    "personal-access-tokens-kill-switch": [
      { "name": "frontend", "hunkCount": 8, "fileCount": 3, "sourceLink": "...", "type": "github", "enabled": true, "version": 1, "latestCommitTime": 1234567890 },
      { "name": "mobile-app", "hunkCount": 4, "fileCount": 2, "sourceLink": "..." }
    ],
    "another-flag": [...]
  }
}
```

### Zod schema (`launchdarkly/types.ts`)

```ts
/**
 * Per-repo reference statistics for a flag. LD returns several fields
 * per repo entry (name, sourceLink, hunkCount, fileCount, type, …); we
 * extract only hunkCount (which we sum across repos for the count).
 * The rest are passthrough()'d.
 */
const CodeRefsRepoEntrySchema = z.object({
  hunkCount: z.number().optional(),
}).passthrough()

export const CodeRefsStatisticsResponseSchema = z.object({
  flags: z.record(z.string(), z.array(CodeRefsRepoEntrySchema)).optional().default({}),
  _links: z.unknown().optional(),
}).passthrough()
```

### Aux fetch (`launchdarkly/client.ts`)

New function `fetchCodeReferences` follows the `fetchFlagStatuses` pattern (best-effort single call, tier-gate short-circuit):

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
): Promise<Map<string, number> | null>
```

Sum `hunkCount` across the repo entries for each flag. The sum is the per-flag "count" — apples-to-apples with FlagShark's per-occurrence detection count (`detectedFlags.get(key).length`, since `detectedFlags` is `Map<string, FeatureFlag[]>` where the inner array has one entry per occurrence).

### Wiring in `fetchAllFlags`

After the existing four aux fetches:

```ts
// Aux 5: LD code-references (cross-check against our own detection).
// Single project-scoped call; not env-scoped. Surfaces detector blind
// spots when LD finds more references than FlagShark detected. Opt-in
// LD feature; when unavailable we log an advisory pointing customers
// at the setup docs.
const codeRefs = await fetchCodeReferences(config, apiBase, headers, fetchFn, opts.signal)
if (codeRefs === null) {
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

Archived flags get `codeReferences` left `undefined` — LD doesn't index archived flags, and surfacing "0 references in LD" for an archived flag is noise.

## 5. Interface additions

### `providers/interface.ts`

`PlatformFlag` gains:

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

`PlatformSignal.type` union gains `'coverage-gap-vs-platform'`.

The existing JSDoc on `PlatformSignal.type` (which itemizes each signal type's semantics) gets a new bullet:

```
- `coverage-gap-vs-platform` (info): LD's own code-refs feature reports
  more references for this flag than FlagShark detected. Surfaces detector
  blind spots — code patterns LD recognizes that our language detectors
  missed. Doesn't make the flag stale; informational only. Fires only
  when LD count > FlagShark count; reverse direction (FlagShark counts
  more) is expected for projects that test-file-exclude in LD.
```

### `staleness.ts`

`StalenessSignal.type` union gains `'coverage-gap-vs-platform'`.

`StaleFlag` gains:

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

### `PlatformClient` — logger threading

```ts
// providers/interface.ts
export interface PlatformClient {
  name: string
  displayName: string
  listFlags(opts?: { signal?: AbortSignal; logger?: ScanLogger }): Promise<PlatformFlag[]>
}
```

`ScanLogger` already exists in `scan-repo.ts` and is imported elsewhere. Add the import in `interface.ts` (or `import type` to avoid a runtime dependency).

## 6. Signal emission

In `cross-reference.ts`, append a new block after the existing `platform-untouched-stale` emission, inside the per-flag stacking loop:

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
// Three states of codeReferences:
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

**Why the signal is read from `firstEntry`:** `codeReferences` is flag-level (project-scoped in LD's data model), not per-env. The orchestrator's multi-env loop calls `listFlags` once per env, so all envs see the same `codeReferences` value — using `firstEntry` (the first env in the per-flag `Map<envKey, PlatformFlag>`) is canonical and consistent with how `permanent`/`createdAt`/`variations` are read.

**Staleness layer treats the signal as a regular info signal** — not as a control signal like `platform-permanent`. It surfaces alongside other signals on the same flag in text/markdown/JSON output. A reviewer cleaning up a stale flag genuinely benefits from "heads up, we may have missed references — double-check the cleanup PR."

## 7. Advisory log

When `fetchCodeReferences` returns `null` (the unavailable case), the LD client emits a single `logger.info` line. The logger threads through `PlatformClient.listFlags` opts → `loadPlatformFlagsCached` opts → `fetchAllFlags` opts.

### Plumbing changes

```ts
// providers/cache.ts — loadPlatformFlagsCached
export async function loadPlatformFlagsCached(
  client: PlatformClient,
  cacheKey: string,
  opts: CacheOptions & { signal?: AbortSignal; logger?: ScanLogger } = {},
): Promise<PlatformFlag[]> {
  if (!opts.noCache) { ... }
  const flags = await client.listFlags({ signal: opts.signal, logger: opts.logger })
  ...
}
```

```ts
// providers/orchestrate.ts — already has opts.logger; pass it through
const flags = opts.listFlagsOverride
  ? await opts.listFlagsOverride(opts.signal)
  : await loadPlatformFlagsCached(client, cacheKey, {
      noCache: opts.noCache,
      signal: opts.signal,
      logger: opts.logger,    // NEW
    })
```

```ts
// launchdarkly/definition.ts — createClient closure
listFlags: ({ signal, logger } = {}) => {
  const env = cfg.environment ?? cfg.environments[0]
  return fetchAllFlags(
    { project: cfg.project, environment: env, token },
    { apiBase: cfg.api_base, signal, logger },
  )
}
```

```ts
// launchdarkly/client.ts — FetchAllFlagsOptions gains optional logger
export interface FetchAllFlagsOptions {
  apiBase?: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  /** Optional logger for advisory messages (e.g. code-refs not configured). */
  logger?: ScanLogger
}
```

### Severity choice

`logger.info`, not `logger.warn`. The advisory is "FYI, you could get more out of FlagShark by enabling X" — not a problem. Existing `warn` calls are real failures (auth, missing token). Different severity keeps signal-to-noise honest in CI logs.

### Cache hit case

`loadPlatformFlagsCached` skips the underlying `listFlags` call on cache hits, so the advisory only fires when the LD client actually runs. This is correct — the advisory is about LD-side configuration, not a per-scan state, and surfacing it once per fresh fetch (every ~24h with default TTL) is the right cadence. Stale cache hits would re-fire the advisory needlessly.

## 8. JSON output

`output/json.ts` adds one new conditional spread to the per-flag entry, placed right after `variations`:

```ts
...(sf.platformStatus ? { platformStatus: sf.platformStatus } : {}),
...(sf.variations && sf.variations.length > 0 ? { variations: sf.variations } : {}),
// codeReferences uses !== undefined (NOT != null). The null value is
// load-bearing — it signals "LD says zero references for this flag,
// no gap" to consumers, distinct from "field absent / feature not
// configured" (which renders as the key being missing). Same pattern
// as fallthroughVariation; same rationale.
...(sf.codeReferences !== undefined ? { codeReferences: sf.codeReferences } : {}),
...(sf.environments && sf.environments.size > 0 ? { environments: ... } : {}),
```

### Three output states

LD has 12 refs, FlagShark detected 8:
```json
{
  "name": "personal-access-tokens-kill-switch",
  "signals": [
    {
      "type": "coverage-gap-vs-platform",
      "severity": "info",
      "description": "LaunchDarkly detected 12 references for this flag; FlagShark detected 8 (gap: 4)"
    }
  ],
  "codeReferences": { "count": 12 }
}
```

LD says zero (active flag with no current references):
```json
{
  "name": "active-flag-no-refs",
  "codeReferences": null
}
```

Feature unavailable:
```json
{
  "name": "some-flag"
}
```

### Other output formats

- **Text + markdown:** the `coverage-gap-vs-platform` signal-type shows in the existing signal column / list. The description appears in verbose / per-flag rows where existing signals already render in full.
- **CSV + SARIF:** unchanged structurally; the new signal type appears in their type-list / `message.text` automatically.
- **Top-level `codeReferences`:** JSON-only. Text/markdown surfacing of the count is out of scope; consumers who want detail look at JSON.

## 9. Staleness propagation

`metadataByFlag` (`orchestrate.ts`) gains `codeReferences?: { count: number } | null` on its value type, populated from `firstEnvFlags`:

```ts
metadataByFlag.set(flag.key, {
  tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
  maintainer: flag.maintainer,
  status: flag.status,
  variations: flag.variations && flag.variations.length > 0 ? flag.variations : undefined,
  codeReferences: flag.codeReferences,   // NEW
})
```

The `hasMetadata` check widens to treat `codeReferences !== undefined` as a "has metadata" reason — so flags with only `codeReferences` populated still make it into `metadataByFlag`:

```ts
const hasMetadata = (flag.tags && flag.tags.length > 0)
  || flag.maintainer
  || flag.status
  || (flag.variations && flag.variations.length > 0)
  || flag.codeReferences !== undefined
```

`StalenessOptions.platformMetadata` value type gains the same field; `analyzeStaleness` copies it onto `StaleFlag`:

```ts
if (meta.codeReferences !== undefined) stale.codeReferences = meta.codeReferences
```

(Note the `!== undefined`, not `!= null` — same load-bearing-null reason as JSON output. `null` means "LD says zero," which is a meaningful state distinct from "feature unavailable.")

## 10. Tests

### Unit tests

**`packages/core/test/providers/launchdarkly/client.test.ts`** — five new cases:

1. Code-refs endpoint returns populated `flags` → per-flag `codeReferences: { count }` populated (sum across repos).
2. Code-refs endpoint returns 404 → all active flags' `codeReferences` undefined; `opts.logger.info` called once with the advisory string.
3. Code-refs endpoint returns 200 with empty `flags: {}` → active flags get `codeReferences: null` (LD-says-zero); advisory NOT fired.
4. Code-refs endpoint omitted from a flag's response (flag not in `flags` map) → that flag's `codeReferences: null`.
5. Archived flag → `codeReferences` left undefined (skipped).

**`packages/core/test/providers/cross-reference.test.ts`** — four new cases:

1. `codeReferences: { count: 12 }`, FlagShark detected 8 → signal fires; description contains `"12 references"`, `"detected 8"`, `"gap: 4"`.
2. `codeReferences: { count: 8 }`, FlagShark detected 8 → no signal (LD-says-equal).
3. `codeReferences: { count: 4 }`, FlagShark detected 8 → no signal (FlagShark caught more — expected reverse direction).
4. `codeReferences: null`, FlagShark detected 8 → no signal (LD-says-zero is not a gap).
5. `codeReferences: undefined`, FlagShark detected 8 → no signal (feature unavailable).
6. `codeReferences: { count: 1 }`, FlagShark detected 0 → signal fires; singular "reference" (not "references") in description.

**`packages/core/test/providers/orchestrate.test.ts`** — two new cases:

1. Verify `opts.logger` threads through to `listFlags`. Use a real `silentLogger()` and assert that when `listFlagsOverride` is NOT used, the call to `loadPlatformFlagsCached` receives the logger in opts. (If the test uses `listFlagsOverride`, the LD client isn't invoked — so threading test needs the real cache-loaded path. Easier: assert `metadataByFlag` populates `codeReferences`.)
2. `metadataByFlag.codeReferences` populated when `firstEnvFlags[0].codeReferences` is `{ count: 5 }` — pins the propagation through orchestrate.

**`packages/core/test/staleness.test.ts`** — one new case:

- `propagates platformMetadata.codeReferences to StaleFlag.codeReferences` — mirrors the existing `variations` propagation test.

**`packages/core/test/output/json.test.ts`** — three new cases:

1. `codeReferences: { count: 12 }` → renders as object in JSON.
2. `codeReferences: null` → renders as literal `null` (key present). Use `Object.prototype.hasOwnProperty.call` to assert key presence.
3. `codeReferences: undefined` (omitted) → key absent.

### Live LD integration test

In `client.live.test.ts`, extend the existing "every flag has the contract fields populated" loop with ONE assertion guarded by `if (!f.archived)`:

```ts
// codeReferences is optional — feature may not be configured on the
// live test project. Just verify the type contract holds.
expect(
  f.codeReferences === undefined
  || f.codeReferences === null
  || (typeof f.codeReferences === 'object' && typeof f.codeReferences.count === 'number'),
).toBe(true)
```

### Coverage gate

The 100%-branch CI gate is unforgiving. New conditionals to cover:

- `count > 0 ? { count } : null` in the client → both branches.
- `firstEntry.codeReferences && firstEntry.codeReferences.count > 0` and `if (firstEntry.codeReferences.count > detected)` in cross-reference → both branches each. The "no signal" tests above cover the false branches.
- `count === 1 ? '' : 's'` singular/plural in description → both branches; case 6 above covers the singular case.
- `!== undefined` guard in JSON → all three states (number / null / undefined). Existing tests cover.
- `meta.codeReferences !== undefined` in `analyzeStaleness` → both branches.
- `flag.codeReferences !== undefined` in `hasMetadata` → both branches.

Plan task ordering puts coverage verification in the final task.

## 11. SaaS consumer alignment

The OSS additions here are diagnostic — no immediate SaaS Piranha pipeline use. The `coverage-gap-vs-platform` signal informs FlagShark's own detector roadmap (which Tier-2 language patterns need attention, which call shapes the polyglot scanner misses). Surfaced in JSON so the SaaS could (in some future state) aggregate detector-quality metrics across customer scans, but that's an aspirational consumer, not a current one.

The advisory log doesn't reach SaaS at all — it's a CI log line for the customer running FlagShark in their own pipeline. The OSS contract here is: customer enables LD code-refs → richer FlagShark diagnostic output. SaaS pipeline behavior is unchanged.

## 12. Risk and rollback

- **Endpoint payload size:** For a project with thousands of flags scanned by `ld-find-code-refs`, the statistics response could be large (one entry per flag, plus per-repo subentries). Single response, no pagination — if size becomes a concern, LD's API supports filtering via `?flagKey=` per-flag (slow fan-out fallback). Not built today; revisit if a customer hits it.
- **Tier-gating false positives:** the 401/403/404 short-circuit assumes those statuses mean "feature unavailable." If LD ever returns 404 for a transient reason (e.g. project just created, code-refs index not built yet), we'd log the advisory spuriously. Acceptable: the advisory is informational and recovers automatically on the next scan. The cache TTL (24h default) means the advisory fires at most once per day per scan invocation.
- **Backward compatibility:** all new fields are optional. Existing JSON consumers (GitHub Action, custom CI scripts) ignore unknown keys. No schema migrations. Reverting the PRs reverts to the v2.3.x behavior.
- **`PlatformClient.listFlags` opts addition:** adds `logger?: ScanLogger` as optional. Existing callers (and future providers) ignoring the field continue to work; existing tests that mock `listFlags` continue to work because the new field is optional.

## 13. Out of scope

- **Per-file locations.** LD's statistics endpoint returns per-repo aggregates only. The per-repository endpoints (`/api/v2/code-refs/repositories/{name}`) expose richer data but require N additional calls; YAGNI for a v1 diagnostic.
- **`sourceLink` URLs.** LD returns deep links to its UI per repo; we drop them. Customers who want to investigate a gap can navigate to LD directly. Surfacing long URLs in the JSON output clutters it for a feature that's already opt-in.
- **Replacing `ld-find-code-refs`.** LD's CLI integrates into customer CI in ways we don't (PR comments, branch tracking, retention windows). We only cross-check; we don't compete.
- **Multi-platform code-refs cross-check.** Other providers (Unleash, Statsig, etc.) don't have an equivalent feature today. The interface change (`codeReferences` field on PlatformFlag) is provider-agnostic — future providers populate it if they have equivalent data.
- **Coverage-gap stale-flag verdict.** The signal is info-severity by design; it doesn't make a flag stale or affect cleanup decisions. A flag with only a `coverage-gap-vs-platform` signal is NOT in the stale list.
- **Orphan platform flags.** Flags that exist in LD with N code references but FlagShark didn't detect at all (so they're not in `detectedFlags`). The existing cross-reference layer comments mark this as a separate feature ("orphan platform flags"). The diagnostic shipped here only operates on detected flags.
