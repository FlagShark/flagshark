# LaunchDarkly Variation-Aware Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the LaunchDarkly platform integration so each scan surfaces enough variation + per-env state for SaaS Piranha to substitute the correct value when removing a flag from code (replacing today's `inferTerminalState(flagName)` heuristic).

**Architecture:** Switch the existing flag-list endpoint from `summary=1` to `summary=0` so LD returns full flag objects (including `variations` flag-level and `fallthrough`/`on`/`offVariation` per env). Extract those into new optional fields on `PlatformFlag` and `PerFlagEnvironmentData`. Stitch through orchestrate → staleness → JSON output. No new endpoints, no aux fetches, no new signals.

**Tech Stack:** TypeScript, Zod (`.passthrough()` schemas), Vitest (tests), `@flagshark/core` monorepo (Bun + Turbo).

**Spec:** `docs/superpowers/specs/2026-05-27-ld-variation-aware-cleanup-design.md`

---

## File Structure

**Modified files:**

- `packages/core/src/providers/launchdarkly/types.ts` — extend Zod schemas (new `VariationSchema`, `FallthroughSchema`; extend `EnvironmentSchema` and `FlagItemSchema`)
- `packages/core/src/providers/launchdarkly/client.ts` — URL param change (`summary=0`) + extraction of new fields in the per-flag loop
- `packages/core/src/providers/interface.ts` — `PlatformFlag` gains four new optional fields
- `packages/core/src/providers/orchestrate.ts` — `PerFlagEnvironmentData` gains three per-env fields; stitching loop extended; `metadataByFlag` gains `variations`
- `packages/core/src/staleness.ts` — `StaleFlag` gains `variations`; populate from `platformMetadata`
- `packages/core/src/output/json.ts` — top-level `variations` per flag + three new per-env fields inside the `environments` block

**Modified tests:**

- `packages/core/test/providers/launchdarkly/client.test.ts` (or `client.integration.test.ts`, depending on where mocked-fetch tests live) — fixture extensions for the new fields
- `packages/core/test/providers/orchestrate.test.ts` — `environmentsByFlag` carries new fields
- `packages/core/test/staleness.test.ts` — `variations` propagates
- `packages/core/test/output/json.test.ts` — top-level + per-env rendering, including the load-bearing-null case
- `packages/core/test/providers/launchdarkly/client.live.test.ts` — new assertions in the existing contract loop

**No new files.**

---

## Task 1: Zod schemas + URL change (summary=0)

**Files:**
- Modify: `packages/core/src/providers/launchdarkly/types.ts`
- Modify: `packages/core/src/providers/launchdarkly/client.ts`
- Test: `packages/core/test/providers/launchdarkly/client.test.ts` (or wherever the existing client mock-fetch tests live — locate via `grep -rln "FlagsResponseSchema\|fetchAllFlags" packages/core/test/providers/launchdarkly/`)

- [ ] **Step 1.1: Locate the existing client tests**

```bash
ls packages/core/test/providers/launchdarkly/
grep -ln "fetchAllFlags\|FlagsResponseSchema" packages/core/test/providers/launchdarkly/*.ts
```

The mock-fetch tests likely live in `client.test.ts` or `client.integration.test.ts`. Note which file holds the fixture for a typical `/api/v2/flags/<project>` mocked response — you'll extend that fixture.

- [ ] **Step 1.2: Write the failing test — schema accepts variations + fallthrough + on + offVariation**

In the file located in Step 1.1, find an existing test that uses a mocked `/api/v2/flags/<project>` response. Add a new test in the same `describe` block:

```ts
it('extracts variations, on, fallthroughVariation, offVariation from summary=0 response', async () => {
  // Mock LD returning a flag with the full (summary=0) shape — variations
  // at top level, plus fallthrough/on/offVariation inside the environments block.
  const fetchFn = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      items: [{
        key: 'FOO',
        archived: false,
        temporary: true,
        creationDate: 1700000000000,
        tags: [],
        variations: [
          { value: false, name: 'off' },
          { value: true, name: 'on' },
        ],
        environments: {
          production: {
            lastModified: 1700000000000,
            on: true,
            fallthrough: { variation: 1 },
            offVariation: 0,
          },
        },
      }],
      totalCount: 1,
    }),
  })
    // The aux endpoints (members, flag-statuses, evaluations, audit-log)
    // need stubs that return ok with empty payloads so the run completes.
    .mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items: [] }),
    })

  const flags = await fetchAllFlags(
    { project: 'p', environment: 'production', token: 'tok' },
    { fetch: fetchFn as unknown as typeof globalThis.fetch },
  )

  expect(flags).toHaveLength(1)
  expect(flags[0].variations).toEqual([
    { value: false, name: 'off' },
    { value: true, name: 'on' },
  ])
  expect(flags[0].on).toBe(true)
  expect(flags[0].fallthroughVariation).toBe(1)
  expect(flags[0].offVariation).toBe(0)
})

it('normalizes fallthrough.rollout (split rollout) to fallthroughVariation: null', async () => {
  const fetchFn = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      items: [{
        key: 'BAR',
        archived: false,
        temporary: true,
        tags: [],
        variations: [{ value: false }, { value: true }],
        environments: {
          production: {
            lastModified: 1700000000000,
            on: true,
            // Split rollout: rollout present, variation absent.
            fallthrough: { rollout: { variations: [
              { variation: 0, weight: 50000 },
              { variation: 1, weight: 50000 },
            ]}},
            offVariation: 0,
          },
        },
      }],
      totalCount: 1,
    }),
  }).mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ items: [] }),
  })

  const flags = await fetchAllFlags(
    { project: 'p', environment: 'production', token: 'tok' },
    { fetch: fetchFn as unknown as typeof globalThis.fetch },
  )

  expect(flags[0].fallthroughVariation).toBeNull()
})

it('normalizes missing fallthrough to fallthroughVariation: null', async () => {
  const fetchFn = vi.fn().mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      items: [{
        key: 'BAZ',
        archived: false,
        temporary: true,
        tags: [],
        variations: [{ value: false }, { value: true }],
        environments: {
          production: {
            lastModified: 1700000000000,
            on: true,
            // fallthrough intentionally omitted
            offVariation: 0,
          },
        },
      }],
      totalCount: 1,
    }),
  }).mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ items: [] }),
  })

  const flags = await fetchAllFlags(
    { project: 'p', environment: 'production', token: 'tok' },
    { fetch: fetchFn as unknown as typeof globalThis.fetch },
  )

  expect(flags[0].fallthroughVariation).toBeNull()
})

it('flag-list URL uses summary=0 to get full flag objects', async () => {
  const fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ items: [] }),
  })

  await fetchAllFlags(
    { project: 'p', environment: 'production', token: 'tok' },
    { fetch: fetchFn as unknown as typeof globalThis.fetch },
  )

  // The very first call should be the flag-list call; assert its URL.
  const firstCallUrl = fetchFn.mock.calls[0][0]
  const url = firstCallUrl instanceof URL ? firstCallUrl.toString() : String(firstCallUrl)
  expect(url).toContain('summary=0')
  expect(url).not.toContain('summary=1')
})
```

Adapt the imports at the top of the file as needed (`fetchAllFlags`, `vi` from vitest). If the test file already imports those, reuse them.

- [ ] **Step 1.3: Run the failing tests**

```bash
cd packages/core && bun run vitest run test/providers/launchdarkly/client.test.ts
```

Expected: the 4 new tests FAIL (the schema doesn't extract the new fields yet; URL still has `summary=1`).

- [ ] **Step 1.4: Update the Zod schemas**

In `packages/core/src/providers/launchdarkly/types.ts`, locate the existing `EnvironmentSchema` (around line 3) and `FlagItemSchema` (around line 7). Replace `EnvironmentSchema` with:

```ts
/**
 * Fallthrough configuration for a flag in a single env. LD's API returns
 * one of two shapes here:
 *   - { variation: <index> }                       → 100% rollout to one variation
 *   - { rollout: { variations: [...], bucketBy } } → split rollout
 *
 * We surface `variation` directly; SaaS-side cleanup tools normalize
 * `rollout`-shape responses to fallthroughVariation: null and fail closed.
 * Other fields (`mode`, etc.) are tolerated via .passthrough().
 */
const FallthroughSchema = z.object({
  variation: z.number().optional(),
  rollout: z.unknown().optional(),
}).passthrough()

const EnvironmentSchema = z.object({
  lastModified: z.number().optional(),
  // NEW: flag's enabled-state in this env. When false, LD serves
  // offVariation regardless of fallthrough/targeting.
  on: z.boolean().optional(),
  // NEW: see FallthroughSchema above.
  fallthrough: FallthroughSchema.optional(),
  // NEW: variation index served when on=false. Required by LD on every
  // active flag; optional here for defensive parsing.
  offVariation: z.number().optional(),
}).passthrough()
```

Then locate `FlagItemSchema` and add the `variations` field. Find:

```ts
const FlagItemSchema = z.object({
  key: z.string(),
  archived: z.boolean(),
  ...
  maintainerId: z.string().optional(),
  environments: z.record(z.string(), EnvironmentSchema).optional(),
}).passthrough()
```

Add `variations` immediately before `environments`:

```ts
const FlagItemSchema = z.object({
  key: z.string(),
  archived: z.boolean(),
  temporary: z.boolean().optional().default(true),
  creationDate: z.number().optional(),
  tags: z.array(z.string()).optional().default([]),
  maintainerId: z.string().optional(),
  // NEW: flag-level variation definitions. Always present in summary=0
  // responses for active flags (boolean = 2, multivariate = N). Each
  // entry has at minimum a `value`; `name` is user-defined in the LD
  // UI. We deliberately drop description and _id (YAGNI).
  variations: z.array(z.object({
    value: z.unknown(),
    name: z.string().optional(),
  }).passthrough()).optional(),
  environments: z.record(z.string(), EnvironmentSchema).optional(),
}).passthrough()
```

- [ ] **Step 1.5: Switch summary=1 → summary=0 in the URL**

In `packages/core/src/providers/launchdarkly/client.ts`, find `buildFirstPath` (the function that constructs the initial flag-list URL — around line 269). Find:

```ts
const params = new URLSearchParams({
  env: environment,
  limit: '100',
  offset: '0',
  summary: '1',
})
```

Change `summary: '1'` to `summary: '0'`:

```ts
const params = new URLSearchParams({
  env: environment,
  limit: '100',
  offset: '0',
  // summary=0 returns full flag objects with variations + per-env
  // fallthrough/on/offVariation. summary=1 (the previous default) only
  // returned key/tags/lastModified, which was insufficient for SaaS
  // Piranha to substitute the correct value during cleanup. Payload
  // grows ~1-5KB per flag — well within reasonable for paginated fetch.
  summary: '0',
})
```

- [ ] **Step 1.6: Run the tests to verify they pass**

```bash
cd packages/core && bun run vitest run test/providers/launchdarkly/client.test.ts
```

Expected: all 4 new tests PASS (and any existing tests continue to pass — the schema is strictly additive).

- [ ] **Step 1.7: Run the full core suite + tsc**

```bash
cd packages/core && bun run vitest run
cd packages/core && bunx tsc --noEmit
```

Expected: all tests pass, tsc clean. Note: at this point, `PlatformFlag` does NOT yet have the new fields; the test assertions like `flags[0].variations` work because TypeScript permits property access via `any` casts during fetchAllFlags's PlatformFlag-typed return. If tsc complains about property access on PlatformFlag, defer the fix to Task 2 — Task 1 commits with schema extraction working but the typed interface not yet widened.

Actually: the tests above will fail to type-check because `flags[0].variations` doesn't exist on `PlatformFlag` yet. To keep Task 1 self-contained, write the tests with type assertions to silence tsc:

```ts
// In the assertions for Step 1.2, replace direct property access with:
expect((flags[0] as PlatformFlag & {
  variations?: Array<{ value: unknown; name?: string }>
  on?: boolean
  fallthroughVariation?: number | null
  offVariation?: number
}).variations).toEqual([
  { value: false, name: 'off' },
  { value: true, name: 'on' },
])
```

Apply the same cast to `.on`, `.fallthroughVariation`, `.offVariation` assertions in Step 1.2's test code. This is a temporary scaffolding cast — Task 2 widens `PlatformFlag` and the casts can be removed in that task's tests (or left as-is; they remain correct after the interface widens).

- [ ] **Step 1.8: Commit**

```bash
git add packages/core/src/providers/launchdarkly/types.ts \
        packages/core/src/providers/launchdarkly/client.ts \
        packages/core/test/providers/launchdarkly/client.test.ts
git commit -m "feat(core/ld): switch flag-list to summary=0 + extract variations/fallthrough (#31)

Zod schemas extend to extract variations (flag-level) and per-env
fallthrough/on/offVariation from the now-richer summary=0 response.
Existing extractions unchanged (.passthrough() schemas tolerate the
larger payload). Fallthrough normalization: { variation: N } maps to
fallthroughVariation: N; { rollout: ... } and absent fallthrough both
map to null (load-bearing null — SaaS uses it to fail closed on split
rollouts).

The PlatformFlag interface gets the new fields in the next task; this
task just establishes extraction works end-to-end via tests with
typed casts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add new fields to `PlatformFlag` + populate in client extraction

**Files:**
- Modify: `packages/core/src/providers/interface.ts`
- Modify: `packages/core/src/providers/launchdarkly/client.ts`
- Test: `packages/core/test/providers/launchdarkly/client.test.ts` (cleanup the Task-1 casts)

- [ ] **Step 2.1: Extend `PlatformFlag`**

In `packages/core/src/providers/interface.ts`, locate the `PlatformFlag` interface. After the `lastTouched` field (the last existing field before the closing `}`), add:

```ts
  /**
   * Variation definitions for this flag — flag-level (identical across envs
   * in LD's data model). Indexed by the same integer the per-env
   * `fallthroughVariation` and `offVariation` fields point at. SaaS-side
   * cleanup pipelines look up the substitute value via these indices
   * instead of guessing from code-side default arguments.
   *
   * Surfaced in PerFlagEnvironmentData consumers (mainly JSON output)
   * because cleanup decisions need both the variation index and its value.
   *
   * Undefined when the platform doesn't expose variation data (other
   * providers without an equivalent concept) or when the flag-list
   * response unexpectedly omits the field.
   */
  variations?: Array<{ value: unknown; name?: string }>

  /**
   * Whether the flag is enabled in the configured env. When false, LD
   * serves `offVariation` regardless of fallthrough/targeting rules.
   * Per-env field — the LD client populates this from the configured env's
   * data on each per-env fetch the orchestrator runs.
   */
  on?: boolean

  /**
   * Variation index served by fallthrough when no targeting/rule matches
   * AND `on: true`.
   *   - number → 100% rollout to that variation
   *   - null   → split rollout (`fallthrough.rollout` shape) or fallthrough
   *              absent. **Preserve null literally in output** — SaaS uses
   *              it to detect "can't substitute" and fail closed.
   */
  fallthroughVariation?: number | null

  /**
   * Variation index served when `on: false`. Required by LD on every
   * active flag (LD's API rejects flag creation without it). Undefined
   * when the platform omits the field (archived flags or unexpected API
   * responses).
   */
  offVariation?: number
```

- [ ] **Step 2.2: Populate in the LD client per-flag loop**

In `packages/core/src/providers/launchdarkly/client.ts`, find the `out.push({ ... })` block inside the flag-list loop (around line 100). The existing block ends with `maintainer: item.maintainerId,`. Replace the entire `out.push({...})` with:

```ts
      out.push({
        key: item.key,
        archived: item.archived,
        lastModified: envData?.lastModified != null ? new Date(envData.lastModified) : null,
        // LD's `temporary` is true when the user wants the flag removed
        // eventually, false when it's permanent. We invert so downstream
        // logic doesn't have to re-reason the polarity every time.
        permanent: !item.temporary,
        createdAt: item.creationDate != null ? new Date(item.creationDate) : null,
        tags: item.tags,
        // Resolved below from the /members lookup; left as the opaque id
        // for now so the producer/consumer split stays clean.
        maintainer: item.maintainerId,
        // Flag-level variation definitions. Same shape across envs.
        variations: item.variations,
        // Per-env LD configuration state — extracted from the env this
        // client instance was configured for. The orchestrator's per-env
        // loop calls fetchAllFlags once per configured env, so each call's
        // `envData` is correct for that single env's view.
        on: envData?.on,
        // 100% rollout: fallthrough.variation is a number.
        // Split rollout: fallthrough.rollout is present, fallthrough.variation
        // absent → we surface null so SaaS cleanup can fail closed.
        // No fallthrough at all (rare) → also null.
        fallthroughVariation: envData?.fallthrough?.variation ?? null,
        offVariation: envData?.offVariation,
      })
```

- [ ] **Step 2.3: Remove the temporary casts from Task 1 tests**

In the Task 1 test additions in `packages/core/test/providers/launchdarkly/client.test.ts`, the assertions used `as PlatformFlag & { ... }` casts to silence tsc. Now that `PlatformFlag` has the fields, the casts are unnecessary. Replace:

```ts
expect((flags[0] as PlatformFlag & {
  variations?: Array<{ value: unknown; name?: string }>
  on?: boolean
  fallthroughVariation?: number | null
  offVariation?: number
}).variations).toEqual(...)
```

with:

```ts
expect(flags[0].variations).toEqual(...)
expect(flags[0].on).toBe(true)
expect(flags[0].fallthroughVariation).toBe(1)
expect(flags[0].offVariation).toBe(0)
```

Apply to all four Task 1 tests.

- [ ] **Step 2.4: Run tests + tsc**

```bash
cd packages/core && bun run vitest run test/providers/launchdarkly/client.test.ts
cd packages/core && bun run vitest run
cd packages/core && bunx tsc --noEmit
```

Expected: all tests pass, tsc clean.

- [ ] **Step 2.5: Commit**

```bash
git add packages/core/src/providers/interface.ts \
        packages/core/src/providers/launchdarkly/client.ts \
        packages/core/test/providers/launchdarkly/client.test.ts
git commit -m "feat(core/providers): PlatformFlag gains variations + per-env config fields (#31)

Four new optional fields on PlatformFlag:
- variations (flag-level): the canonical list of variation values
- on, fallthroughVariation, offVariation (per env, populated from the
  configured env in each fetchAllFlags call)

The LD client's existing per-flag loop populates them directly from
the summary=0 response. Cleans up the Task 1 test casts now that the
interface carries the fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extend `PerFlagEnvironmentData` + orchestrate stitching

**Files:**
- Modify: `packages/core/src/providers/orchestrate.ts`
- Test: `packages/core/test/providers/orchestrate.test.ts`

- [ ] **Step 3.1: Write the failing test**

In `packages/core/test/providers/orchestrate.test.ts`, find the existing test `'populates environmentsByFlag from per-env enrichment data'` (added at the end of #30's polish). Append a new test in the same `describe` block:

```ts
  it('populates environmentsByFlag with on/fallthroughVariation/offVariation', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      let call = 0
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environments: ['production', 'staging'] },
        },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => {
          call++
          if (call === 1) {
            // production: launched, on, 100% to variation 1
            return [{
              key: 'FOO',
              archived: false,
              lastModified: null,
              status: 'launched' as const,
              on: true,
              fallthroughVariation: 1,
              offVariation: 0,
            }]
          }
          // staging: split rollout — fallthroughVariation null
          return [{
            key: 'FOO',
            archived: false,
            lastModified: null,
            status: 'active' as const,
            on: true,
            fallthroughVariation: null,
            offVariation: 0,
          }]
        },
      })
      const fooEnvs = result.environmentsByFlag.get('FOO')
      expect(fooEnvs).toBeDefined()
      expect(fooEnvs!.size).toBe(2)
      expect(fooEnvs!.get('production')?.on).toBe(true)
      expect(fooEnvs!.get('production')?.fallthroughVariation).toBe(1)
      expect(fooEnvs!.get('production')?.offVariation).toBe(0)
      expect(fooEnvs!.get('staging')?.fallthroughVariation).toBeNull()
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('keeps env in environmentsByFlag when only the new fields (no status/evals) are populated', async () => {
    // Regression: the "skip env with no enrichment" guard must include the
    // new fields, otherwise an env that only has variation/fallthrough
    // data would be incorrectly dropped from environmentsByFlag.
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: 'p', environment: 'production' },
        },
        detectedFlags: detected(['BAR']),
        logger,
        listFlagsOverride: async () => [{
          key: 'BAR',
          archived: false,
          lastModified: null,
          // No status, evaluations30d, lastRequested, lastTouched
          on: false,
          fallthroughVariation: null,
          offVariation: 0,
        }],
      })
      const barEnvs = result.environmentsByFlag.get('BAR')
      expect(barEnvs).toBeDefined()
      expect(barEnvs!.get('production')?.on).toBe(false)
      expect(barEnvs!.get('production')?.offVariation).toBe(0)
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd packages/core && bun run vitest run test/providers/orchestrate.test.ts
```

Expected: both new tests FAIL (`environmentsByFlag` doesn't carry the new fields yet; the skip guard doesn't account for them).

- [ ] **Step 3.3: Extend `PerFlagEnvironmentData`**

In `packages/core/src/providers/orchestrate.ts`, find the `PerFlagEnvironmentData` interface (introduced in #30). Add three new optional fields:

```ts
export interface PerFlagEnvironmentData {
  status?: 'new' | 'active' | 'inactive' | 'launched'
  evaluations30d?: number | null
  lastRequested?: Date | null
  lastTouched?: Date | null
  /**
   * Per-env LD configuration. Surfaced for SaaS-side cleanup pipelines
   * that need to substitute the correct variation value into code.
   * See PlatformFlag for field semantics.
   */
  on?: boolean
  fallthroughVariation?: number | null
  offVariation?: number
}
```

- [ ] **Step 3.4: Extend the stitching loop**

In the same file, find the `for (const [flagKey, envInnerMap] of perEnv)` loop (added in #30). Inside it, find:

```ts
inner.set(env, {
  status: pf.status,
  evaluations30d: pf.evaluations30d,
  lastRequested: pf.lastRequested,
  lastTouched: pf.lastTouched,
})
```

Extend to copy the three new fields:

```ts
inner.set(env, {
  status: pf.status,
  evaluations30d: pf.evaluations30d,
  lastRequested: pf.lastRequested,
  lastTouched: pf.lastTouched,
  on: pf.on,
  fallthroughVariation: pf.fallthroughVariation,
  offVariation: pf.offVariation,
})
```

- [ ] **Step 3.5: Widen the empty-env skip guard**

In the same loop, find the existing skip check:

```ts
if (
  pf.status == null
  && pf.evaluations30d == null
  && pf.lastRequested == null
  && pf.lastTouched == null
) continue
```

Add the three new fields to the predicate so an env populated with only variation/fallthrough data isn't dropped:

```ts
if (
  pf.status == null
  && pf.evaluations30d == null
  && pf.lastRequested == null
  && pf.lastTouched == null
  && pf.on == null
  && pf.fallthroughVariation == null
  && pf.offVariation == null
) continue
```

- [ ] **Step 3.6: Run tests + tsc**

```bash
cd packages/core && bun run vitest run test/providers/orchestrate.test.ts
cd packages/core && bun run vitest run
cd packages/core && bunx tsc --noEmit
```

Expected: all PASS, tsc clean.

- [ ] **Step 3.7: Commit**

```bash
git add packages/core/src/providers/orchestrate.ts \
        packages/core/test/providers/orchestrate.test.ts
git commit -m "feat(core/orchestrate): stitch on/fallthroughVariation/offVariation per env (#31)

PerFlagEnvironmentData gains three per-env fields. The stitching loop
copies them through from PlatformFlag, and the empty-env skip guard
widens to include them so envs with only the new fields aren't dropped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `StaleFlag.variations` propagation + JSON top-level rendering

**Files:**
- Modify: `packages/core/src/providers/orchestrate.ts` (`metadataByFlag` gains `variations`)
- Modify: `packages/core/src/staleness.ts` (`StaleFlag` gains `variations`)
- Modify: `packages/core/src/output/json.ts` (top-level `variations` per flag)
- Test: `packages/core/test/output/json.test.ts`, `packages/core/test/staleness.test.ts`

- [ ] **Step 4.1: Write the failing tests**

In `packages/core/test/output/json.test.ts`, append to the existing `describe('formatJson — environments block', ...)` (or in a new describe in the same file):

```ts
describe('formatJson — variations', () => {
  it('emits top-level variations when populated', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      variations: [
        { value: false, name: 'off' },
        { value: true, name: 'on' },
      ],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].variations).toEqual([
      { value: false, name: 'off' },
      { value: true, name: 'on' },
    ])
  })

  it('omits variations when absent', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('variations')
  })

  it('omits variations when present but empty', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      variations: [],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('variations')
  })
})
```

In `packages/core/test/staleness.test.ts`, find the existing test `'propagates platformEnvironments to StaleFlag.environments'` (added during #30's coverage gap fix). Append a new test in the same describe:

```ts
  it('propagates platform variations to StaleFlag.variations via platformMetadata', () => {
    // Reuse the existing "force a flag stale" pattern from the
    // platformEnvironments test in this file. Adapt fixture as needed.
    const platformMetadata = new Map([
      ['FOO', {
        variations: [
          { value: false, name: 'off' },
          { value: true, name: 'on' },
        ],
      }],
    ])
    // ... call analyzeStaleness with detection that produces a stale FOO ...
    // (Use whatever fixture-building helpers the file uses for the
    // existing platformEnvironments test.)
    // Then assert: stale.variations is populated.
    // Adapt this skeleton to the actual fixture pattern.
  })
```

**Important:** the staleness test skeleton above is illustrative. Read the existing `'propagates platformEnvironments...'` test in `staleness.test.ts` and copy its exact setup (which platform signal it uses to force the flag stale, how it constructs the detection map, the `analyzeStaleness` call). Mirror that pattern with `platformMetadata` instead of `platformEnvironments`.

- [ ] **Step 4.2: Run tests to verify failures**

```bash
cd packages/core && bun run vitest run test/output/json.test.ts test/staleness.test.ts
```

Expected: new tests FAIL — `variations` not on `StaleFlag`, not in JSON output, not propagated by `metadataByFlag`.

- [ ] **Step 4.3: Extend `metadataByFlag` to carry variations**

In `packages/core/src/providers/orchestrate.ts`, find the existing `metadataByFlag` type declaration. It currently has:

```ts
metadataByFlag: Map<
  string,
  { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
>
```

Replace with:

```ts
metadataByFlag: Map<
  string,
  {
    tags?: string[]
    maintainer?: string
    status?: 'new' | 'active' | 'inactive' | 'launched'
    variations?: Array<{ value: unknown; name?: string }>
  }
>
```

(This appears once in `OrchestrateResult` and once in the local `metadataByFlag` declaration inside `orchestratePlatforms`. Update both occurrences.)

Then find the `metadataByFlag.set(flag.key, {...})` call inside the `for (const flag of firstEnvFlags)` loop. The existing block:

```ts
metadataByFlag.set(flag.key, {
  tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
  maintainer: flag.maintainer,
  status: flag.status,
})
```

Extend to include `variations`:

```ts
metadataByFlag.set(flag.key, {
  tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
  maintainer: flag.maintainer,
  status: flag.status,
  variations: flag.variations && flag.variations.length > 0 ? flag.variations : undefined,
})
```

Also update the `hasMetadata` check above this set call to include variations as a "has metadata" reason:

```ts
const hasMetadata = (flag.tags && flag.tags.length > 0)
  || flag.maintainer
  || flag.status
  || (flag.variations && flag.variations.length > 0)
if (!hasMetadata) continue
```

- [ ] **Step 4.4: Extend `StalenessOptions.platformMetadata` and `StaleFlag` types**

In `packages/core/src/staleness.ts`, find `StalenessOptions.platformMetadata`. Currently:

```ts
platformMetadata?: Map<
  string,
  { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
>
```

Replace with:

```ts
platformMetadata?: Map<
  string,
  {
    tags?: string[]
    maintainer?: string
    status?: 'new' | 'active' | 'inactive' | 'launched'
    variations?: Array<{ value: unknown; name?: string }>
  }
>
```

Then find the `StaleFlag` interface and add (after `platformStatus`):

```ts
/**
 * Variation definitions for this flag from the platform integration.
 * Populated only when the platform exposes variation data (LD does;
 * others may not). Surfaced in JSON output as a top-level per-flag
 * field so cleanup pipelines can look up the substitute value by
 * variation index.
 */
variations?: Array<{ value: unknown; name?: string }>
```

Then find the block in `analyzeStaleness` that copies fields from `meta` onto `stale` (around the `if (meta.tags && meta.tags.length > 0) stale.tags = meta.tags` line):

```ts
if (meta.tags && meta.tags.length > 0) stale.tags = meta.tags
if (meta.maintainer) stale.maintainer = meta.maintainer
if (meta.status) stale.platformStatus = meta.status
```

Add after:

```ts
if (meta.variations && meta.variations.length > 0) stale.variations = meta.variations
```

- [ ] **Step 4.5: Extend JSON output**

In `packages/core/src/output/json.ts`, find the per-flag mapping. After the existing line:

```ts
...(sf.platformStatus ? { platformStatus: sf.platformStatus } : {}),
```

Add (before the `environments` spread):

```ts
...(sf.variations && sf.variations.length > 0 ? { variations: sf.variations } : {}),
```

- [ ] **Step 4.6: Run tests + tsc**

```bash
cd packages/core && bun run vitest run
cd packages/core && bunx tsc --noEmit
```

Expected: all PASS, tsc clean.

- [ ] **Step 4.7: Commit**

```bash
git add packages/core/src/providers/orchestrate.ts \
        packages/core/src/staleness.ts \
        packages/core/src/output/json.ts \
        packages/core/test/output/json.test.ts \
        packages/core/test/staleness.test.ts
git commit -m "feat(core/output): top-level variations in JSON output (#31)

PlatformFlag.variations -> metadataByFlag -> StaleFlag.variations ->
JSON top-level 'variations' per flag. Follows the same flow as
tags/maintainer/platformStatus. Omitted when absent or empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: JSON per-env block extension (on/fallthroughVariation/offVariation)

**Files:**
- Modify: `packages/core/src/output/json.ts`
- Test: `packages/core/test/output/json.test.ts`

- [ ] **Step 5.1: Write the failing tests**

In `packages/core/test/output/json.test.ts`, append a new `describe` block (or extend the existing `'formatJson — environments block'` describe):

```ts
describe('formatJson — per-env variation config', () => {
  it('emits on/fallthroughVariation/offVariation when populated', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          status: 'launched',
          on: true,
          fallthroughVariation: 1,
          offVariation: 0,
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).toMatchObject({
      on: true,
      fallthroughVariation: 1,
      offVariation: 0,
    })
  })

  it('preserves fallthroughVariation: null literally (load-bearing for split rollouts)', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          status: 'active',
          on: true,
          fallthroughVariation: null,  // split rollout
          offVariation: 0,
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    // Crucial: null must survive serialization, NOT be omitted.
    // SaaS uses null vs absent to distinguish "split rollout, fail closed"
    // from "field unknown".
    expect(json.flags[0].environments.production.fallthroughVariation).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(
      json.flags[0].environments.production,
      'fallthroughVariation',
    )).toBe(true)
  })

  it('omits on/offVariation when undefined while preserving other fields', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', {
          status: 'active',
          // on intentionally undefined
          // offVariation intentionally undefined
        }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).not.toHaveProperty('on')
    expect(json.flags[0].environments.production).not.toHaveProperty('offVariation')
    expect(json.flags[0].environments.production.status).toBe('active')
  })
})
```

- [ ] **Step 5.2: Run tests to verify failures**

```bash
cd packages/core && bun run vitest run test/output/json.test.ts
```

Expected: new tests FAIL — the JSON output doesn't include `on`/`fallthroughVariation`/`offVariation` yet.

- [ ] **Step 5.3: Extend the per-env JSON entry**

In `packages/core/src/output/json.ts`, find the per-env entry build inside the `environments` Object.fromEntries call. Current shape:

```ts
{
  ...(data.status != null ? { status: data.status } : {}),
  ...(data.evaluations30d != null ? { evaluations30d: data.evaluations30d } : {}),
  ...(data.lastRequested != null ? { lastRequested: data.lastRequested.toISOString() } : {}),
  ...(data.lastTouched != null ? { lastTouched: data.lastTouched.toISOString() } : {}),
}
```

Extend (add lines BEFORE the closing `}`):

```ts
{
  ...(data.status != null ? { status: data.status } : {}),
  ...(data.evaluations30d != null ? { evaluations30d: data.evaluations30d } : {}),
  ...(data.lastRequested != null ? { lastRequested: data.lastRequested.toISOString() } : {}),
  ...(data.lastTouched != null ? { lastTouched: data.lastTouched.toISOString() } : {}),
  ...(data.on != null ? { on: data.on } : {}),
  // NB: fallthroughVariation uses !== undefined (NOT != null). The null
  // value is LOAD-BEARING — it signals "split rollout, fail-closed" to
  // SaaS-side cleanup. Omitting null would be indistinguishable from
  // "field absent" and would cause SaaS to fall back to its heuristic,
  // defeating the whole point of this work. Other fields use != null
  // because neither has a meaningful null state.
  ...(data.fallthroughVariation !== undefined
    ? { fallthroughVariation: data.fallthroughVariation }
    : {}),
  ...(data.offVariation != null ? { offVariation: data.offVariation } : {}),
}
```

- [ ] **Step 5.4: Run tests + tsc**

```bash
cd packages/core && bun run vitest run
cd packages/core && bunx tsc --noEmit
```

Expected: all PASS, tsc clean.

- [ ] **Step 5.5: Verify coverage**

```bash
cd packages/core && bun run test:coverage 2>&1 | tail -30
```

The new conditionals (`data.on != null`, `data.fallthroughVariation !== undefined`, `data.offVariation != null`) each need both branches covered. The three tests in Step 5.1 cover:
- `on` populated AND undefined (covers both branches)
- `fallthroughVariation: number` AND `null` AND `undefined` (covers all three states; the `!== undefined` check has both branches hit)
- `offVariation` populated AND undefined

If coverage drops below 100%, the test set is incomplete — add the missing case before committing.

- [ ] **Step 5.6: Commit**

```bash
git add packages/core/src/output/json.ts \
        packages/core/test/output/json.test.ts
git commit -m "feat(core/output): per-env on/fallthroughVariation/offVariation in JSON (#31)

Three new fields inside each env's entry in the environments block.
on and offVariation use != null (omit both null and undefined).
fallthroughVariation uses !== undefined — null is LOAD-BEARING for
SaaS Piranha (signals 'split rollout, fail closed'). Test pins this
distinction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Live LD integration test

**Files:**
- Modify: `packages/core/test/providers/launchdarkly/client.live.test.ts`

- [ ] **Step 6.1: Locate the existing contract loop**

Read `packages/core/test/providers/launchdarkly/client.live.test.ts`. Find the existing test `'every flag has the contract fields populated'` (or similar — a test that iterates `flags` and asserts each one has `key`, `archived`, `lastModified` of the right types).

- [ ] **Step 6.2: Extend the existing contract loop**

Inside that test's `for (const f of flags) { ... }` body, add new assertions at the bottom (after the existing field assertions):

```ts
      // Variation fields (#31). Active LD flags always have variations
      // (at least 2 for boolean). Archived flags may not — guard against
      // that.
      if (!f.archived) {
        expect(Array.isArray(f.variations)).toBe(true)
        expect((f.variations ?? []).length).toBeGreaterThanOrEqual(2)
        // Every variation entry has a value; name is optional.
        for (const v of (f.variations ?? [])) {
          expect(v).toHaveProperty('value')
        }
        // Per-env fields populated for active flags.
        expect(typeof f.on).toBe('boolean')
        expect(typeof f.offVariation).toBe('number')
        // fallthroughVariation is either a number (100% rollout) or
        // null (split rollout / absent). Never undefined for active flags
        // — the client normalizes missing fallthrough to null.
        expect(
          f.fallthroughVariation === null
          || typeof f.fallthroughVariation === 'number',
        ).toBe(true)
      }
```

- [ ] **Step 6.3: Verify the live test self-skips without credentials**

```bash
cd packages/core && bun run test:live 2>&1 | tail -15
```

Expected: all live tests skip with the `LIVE_LAUNCHDARKLY_API_TOKEN not set` message. The new assertions only execute when the suite is unskipped.

- [ ] **Step 6.4: Run the default suite to confirm no regressions**

```bash
cd packages/core && bun run vitest run 2>&1 | tail -5
cd packages/core && bunx tsc --noEmit
```

Expected: all tests pass (live tests not in the default run), tsc clean.

- [ ] **Step 6.5: Commit**

```bash
git add packages/core/test/providers/launchdarkly/client.live.test.ts
git commit -m "test(core/ld): live contract assertions for variations + per-env config (#31)

Extends the existing 'every flag has the contract fields populated'
loop with assertions for variations, on, fallthroughVariation, and
offVariation. Active flags only — archived flags may have variations
absent. Self-skips with the rest of the live suite when
LIVE_LAUNCHDARKLY_API_TOKEN is unset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification + open PR

- [ ] **Step 7.1: Full monorepo test sweep**

```bash
cd /Users/joe/projects/flagshark && bun run test
```

Expected: every package's tests PASS.

- [ ] **Step 7.2: Coverage check (the gate that caught us in #30)**

```bash
cd /Users/joe/projects/flagshark/packages/core && bun run test:coverage 2>&1 | tail -30
```

Expected: **100% across statements / branches / lines / functions.** If any uncovered branches surface, add targeted tests before pushing. Common gaps to watch for:
- `fallthroughVariation !== undefined` — needs both `!== undefined` true case (populated) and false case (omitted). The `null` case counts as defined.
- `data.on != null` and `data.offVariation != null` — both branches needed.
- The widened skip guard in `orchestrate.ts` — covered by Task 3's "keep env with only new fields" test.

- [ ] **Step 7.3: Typecheck across the monorepo**

```bash
cd /Users/joe/projects/flagshark && bun run typecheck
```

Expected: PASS across all 3 packages.

- [ ] **Step 7.4: Build across the monorepo**

```bash
cd /Users/joe/projects/flagshark && bun run build 2>&1 | tail -10
```

Expected: PASS across all 3 packages. (A pre-existing esbuild warning about `import.meta.url` in CJS is unrelated and known — ignore.)

- [ ] **Step 7.5: Push the branch and open a PR**

```bash
cd /Users/joe/projects/flagshark
git push -u origin spec/ld-variation-aware-cleanup
gh pr create --title "feat(ld): variation-aware cleanup data plumbing (#31)" \
  --body "Closes #31.

Plumbs LD's variation data through to the JSON output so SaaS Piranha can substitute the correct value when removing a flag from code — replacing today's heuristic \`inferTerminalState(flagName)\` which guesses \`treated: true | false\` from flag-name patterns.

## What ships

**\`PlatformFlag\` gains four optional fields:**
- \`variations\` (flag-level): \`Array<{ value: unknown; name?: string }>\`
- \`on\` (per-env): \`boolean\`
- \`fallthroughVariation\` (per-env): \`number | null\` — null means split rollout
- \`offVariation\` (per-env): \`number\`

**\`PerFlagEnvironmentData\` gains the three per-env fields.** Stitched into \`environmentsByFlag\` and surfaced inside the JSON \`environments\` block.

**\`StaleFlag.variations\` flows via the existing \`metadataByFlag\` flow.** Renders as a top-level \`variations\` field per flag in JSON output.

## Data source

\`summary=1\` → \`summary=0\` on the existing \`/api/v2/flags/{project}\` endpoint. Same pagination, same Zod schemas (\`.passthrough()\` tolerates the larger payload), no new endpoints.

## Load-bearing null

\`fallthroughVariation: null\` is preserved literally in JSON output (the per-env block uses \`!== undefined\` rather than \`!= null\`). SaaS uses null vs absent to distinguish 'split rollout, fail-closed' from 'field unknown'. Test pins this.

## SaaS alignment

The SaaS Piranha pipeline (\`flag-shark/packages/backend-core/src/piranha/terminal-state.ts\`) already has a \`terminalStateSources\` chain with \`'platform-metadata'\` explicitly reserved as a source name. The shape we're shipping slots into that seam directly when SaaS adds the consumer.

## Backward compatibility

All new fields are optional. Existing JSON consumers (the GitHub Action, CLI scripts) ignore unknown keys. No new signals. No schema migrations.

Spec: \`docs/superpowers/specs/2026-05-27-ld-variation-aware-cleanup-design.md\`
Plan: \`docs/superpowers/plans/2026-05-27-ld-variation-aware-cleanup.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 7.6: Watch CI**

```bash
gh pr checks <pr-number>
```

Wait for the run to complete. If anything fails (coverage gap, lint, or otherwise), fix in-place.

---

## Self-review checklist

This was done at write-time; documented here for reviewers.

- **Spec coverage:** every section of the spec maps to at least one task — Section 4 (extraction) → T1+T2; Section 5 (types) → T2+T3; Section 6 (orchestrate) → T3; Section 7 (staleness) → T4; Section 8 (JSON output) → T4+T5; Section 9 (tests) → distributed; Section 10 (SaaS alignment) → noted in PR body.
- **Placeholder scan:** no TBDs. Step 4.1's staleness-test skeleton is marked as illustrative because the existing test file's fixture pattern is the source of truth — explicit instruction, not a TODO.
- **Type consistency:** `PerFlagEnvironmentData`, `PlatformFlag`, `StaleFlag` references match across tasks; field names (`on`, `fallthroughVariation`, `offVariation`, `variations`) consistent throughout; `metadataByFlag` value shape extended in lockstep between `orchestrate.ts` and `staleness.ts` (T4 updates both).
- **TDD discipline:** every task is test-first; the load-bearing-null case in T5 has its own dedicated test.
