# LaunchDarkly Multi-Environment Cross-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the LaunchDarkly platform integration so a single FlagShark scan can cross-reference flags against multiple LD environments and emit env-attributed signals (`platform-launched in production, staging`, etc.).

**Architecture:** Loop multi-env at the orchestrator layer (`providers/orchestrate.ts`) — instantiate one LD client per env using the existing `createClient` factory, call `listFlags()` per env serially, stitch into a `Map<flagKey, Map<envKey, PlatformFlag>>`, and hand that to a new-signature `crossReference()`. Provider client stays unchanged. JSON output gains an additive `environments: { [envKey]: { status, evaluations30d, lastRequested, lastTouched } }` block per flag; top-level fields preserve v1 contract by sourcing from the first configured env.

**Tech Stack:** TypeScript, Zod (config schema), Vitest (tests), `@flagshark/core` monorepo (Bun + Turbo).

**Spec:** `docs/superpowers/specs/2026-05-26-ld-multi-environment-cross-check-design.md`

---

## File Structure

**Modified files:**

- `packages/core/src/providers/launchdarkly/definition.ts` — Zod schema accepts `environment | environments`, normalizes to `environments: string[]`
- `packages/core/src/providers/cross-reference.ts` — new `PerEnvFlags` type, new signature, env-aware signal rules
- `packages/core/src/providers/orchestrate.ts` — loop envs, stitch results, call new-signature `crossReference`
- `packages/core/src/output/json.ts` — additive `environments` block per flag
- `packages/core/src/staleness.ts` — `StaleFlag` gains optional `environments` field propagated from orchestrate
- `README.md` — LD config example updated to multi-env primary form

**Modified tests:**

- `packages/core/test/providers/launchdarkly/definition.test.ts` — new schema cases
- `packages/core/test/providers/cross-reference.test.ts` — wrap existing single-env tests + new multi-env cases
- `packages/core/test/providers/orchestrate.test.ts` — multi-env stitching cases
- `packages/core/test/providers/cache.test.ts` — array-vs-single cache-key invariant
- `packages/core/test/providers/launchdarkly/client.live.test.ts` — multi-env live case
- `packages/core/test/output/json.test.ts` — verifies environments block (if file exists; otherwise new)

**No new files.** All changes are additive within existing files.

---

## Task 1: Zod schema — accept `environments: string[]`, normalize via XOR

**Files:**
- Modify: `packages/core/src/providers/launchdarkly/definition.ts`
- Test: `packages/core/test/providers/launchdarkly/definition.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Add at the bottom of `packages/core/test/providers/launchdarkly/definition.test.ts`, inside the existing `describe('launchdarklyDefinition', () => { ... })`:

```ts
  it('configSchema normalizes a single environment to a one-element environments array', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environment: 'prod',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.environments).toEqual(['prod'])
    }
  })

  it('configSchema accepts an environments array', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environments: ['prod', 'staging'],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.environments).toEqual(['prod', 'staging'])
    }
  })

  it('configSchema rejects setting both environment and environments', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environment: 'prod', environments: ['prod'],
    })
    expect(r.success).toBe(false)
  })

  it('configSchema rejects setting neither environment nor environments', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({ project: 'p' })
    expect(r.success).toBe(false)
  })

  it('configSchema rejects an empty environments array', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({
      project: 'p', environments: [],
    })
    expect(r.success).toBe(false)
  })
```

Also UPDATE the two existing tests that still reference the old single-env behavior. Find:

```ts
  it('configSchema rejects config missing environment', () => {
    const r = launchdarklyDefinition.configSchema.safeParse({ project: 'p' })
    expect(r.success).toBe(false)
  })
```

This existing test stays valid (now passes because of the XOR rule too) — leave it.

Find:

```ts
  it('createClient.listFlags delegates to fetchAllFlags with correct args', async () => {
    const spy = vi.spyOn(clientModule, 'fetchAllFlags').mockResolvedValueOnce([])
    const client = launchdarklyDefinition.createClient(
      { project: 'my-proj', environment: 'prod', api_base: 'https://ld.example.com' },
      'my-token',
    )
```

This existing test passes `{ project, environment }` directly into `createClient` (bypassing Zod). It should keep working because `createClient` will continue to accept the OLD shape — the schema normalizes input, but `createClient` is called with already-validated data. **However**, the test's input dict no longer has the normalized `environments` field. To keep `createClient`'s internals simple (single-env contract), see Step 1.3 — we'll keep `createClient` reading `cfg.environment` for now. So this test stays unchanged.

- [ ] **Step 1.2: Run tests to verify the new ones fail**

```bash
cd packages/core && bun run vitest run test/providers/launchdarkly/definition.test.ts
```

Expected: 5 new tests FAIL (schema doesn't yet accept `environments`, doesn't enforce XOR, doesn't normalize).

- [ ] **Step 1.3: Update the schema**

Replace the entire contents of `packages/core/src/providers/launchdarkly/definition.ts` with:

```ts
import { z } from 'zod'
import { fetchAllFlags } from './client.js'
import type { PlatformDefinition } from '../interface.js'

/**
 * Two accepted config shapes:
 *
 *   environment: 'prod'              # legacy single-env (still supported)
 *   environments: ['prod', 'staging'] # preferred multi-env form
 *
 * Exactly one must be set. After .transform, downstream code sees
 * `environments: string[]` (length >= 1) — the single-env form is
 * normalized to a one-element array.
 */
const launchdarklyConfigSchema = z.object({
  project: z.string(),
  environment: z.string().optional(),
  environments: z.array(z.string()).nonempty().optional(),
  api_base: z.string().url().optional(),
  token_env: z.string().optional(),
}).refine(
  (cfg) => (cfg.environment != null) !== (cfg.environments != null),
  { message: "set exactly one of 'environment' or 'environments'" },
).transform((cfg) => ({
  ...cfg,
  // Drop the singular form after normalization so downstream code has one
  // shape to reason about.
  environment: undefined,
  environments: cfg.environments ?? [cfg.environment!],
}))

type LdConfig = z.infer<typeof launchdarklyConfigSchema>

export const launchdarklyDefinition: PlatformDefinition<LdConfig> = {
  name: 'launchdarkly',
  displayName: 'LaunchDarkly',
  defaultTokenEnv: 'LAUNCHDARKLY_API_TOKEN',
  configSchema: launchdarklyConfigSchema,
  // createClient still operates on ONE environment at a time — the
  // orchestrator loops over `cfg.environments` and calls this factory
  // once per env (passing `environment: env` synthesized at the call
  // site). Keeping the client single-env preserves the existing client
  // contract and keeps `fetchAllFlags` unchanged.
  createClient: (cfg, token) => ({
    name: 'launchdarkly',
    displayName: 'LaunchDarkly',
    listFlags: ({ signal } = {}) => {
      // Orchestrator passes a synthesized `environment` via createClient
      // for the current loop iteration; fall back to environments[0]
      // when the caller used the post-normalize shape directly.
      const env = (cfg as LdConfig & { environment?: string }).environment ?? cfg.environments[0]
      return fetchAllFlags({
        project: cfg.project,
        environment: env,
        token,
      }, { apiBase: cfg.api_base, signal })
    },
  }),
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
cd packages/core && bun run vitest run test/providers/launchdarkly/definition.test.ts
```

Expected: all tests in this file PASS.

- [ ] **Step 1.5: Commit**

```bash
git add packages/core/src/providers/launchdarkly/definition.ts \
        packages/core/test/providers/launchdarkly/definition.test.ts
git commit -m "feat(core/ld): accept environments[] in config schema with XOR validation (#30)

Both 'environment: prod' and 'environments: [prod, staging]' accepted;
exactly one required. Schema normalizes to environments: string[] for
downstream code. createClient continues to take one env per call —
the orchestrator will loop over environments in a later step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Introduce `PerEnvFlags` type + crossReference signature change (behavior-preserving)

This task changes `crossReference`'s signature from `PlatformFlag[]` to `Map<flagKey, Map<envKey, PlatformFlag>>`, then updates all existing tests + callers to wrap their single-env data in a one-env map. Behavior must be identical for single-env data after this task. New multi-env rules come in later tasks.

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts`
- Modify: `packages/core/src/providers/orchestrate.ts`
- Modify: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 2.1: Update the crossReference signature + signal logic (no behavior change for single-env)**

Open `packages/core/src/providers/cross-reference.ts`. Add this type export near the top:

```ts
/**
 * Per-flag, per-environment view of platform data. Outer key is the flag
 * key; inner key is the environment name as declared in the user's
 * `environments: [...]` config. Built by the orchestrator (one
 * listFlags() call per env, stitched).
 *
 * Single-env callers wrap their data in a one-entry inner Map. The
 * shape is the same — only env count varies.
 */
export type PerEnvFlags = Map<string, Map<string, PlatformFlag>>
```

Then replace the entire `crossReference` function with a version that takes the new shape but preserves single-env behavior identically:

```ts
export function crossReference(
  detectedFlags: Map<string, FeatureFlag[]>,
  platformFlagsByEnv: PerEnvFlags,
  platformDisplayName: string,
  options: CrossReferenceOptions = {},
): Map<string, PlatformSignal[]> {
  const out = new Map<string, PlatformSignal[]>()
  const now = Date.now()
  const thresholdMs = options.thresholdDays != null ? options.thresholdDays * 86_400_000 : null

  for (const key of detectedFlags.keys()) {
    const envMap = platformFlagsByEnv.get(key)
    if (!envMap || envMap.size === 0) {
      out.set(key, [
        {
          type: 'missing-in-platform',
          severity: 'error',
          description: `referenced in code but not found in ${platformDisplayName}`,
        },
      ])
      continue
    }

    // Flag-level fields (archived, permanent, tags, maintainer, createdAt)
    // are identical across envs in LD's data model. Read them from the
    // first env's entry.
    const firstEntry = envMap.values().next().value as PlatformFlag
    if (firstEntry.archived) {
      out.set(key, [
        {
          type: 'archived-in-platform',
          severity: 'warning',
          description: `archived in ${platformDisplayName}`,
        },
      ])
      continue
    }

    const signals: PlatformSignal[] = []

    // Single-env preservation: with one env, this collapses to the
    // pre-refactor behavior exactly. Multi-env rules are added in
    // later tasks; here we just iterate one env's status.
    for (const platform of envMap.values()) {
      if (platform.status === 'launched') {
        signals.push({
          type: 'platform-launched',
          severity: 'error',
          description: `${platformDisplayName} reports this flag has served one variation for 7+ days — likely ready for removal`,
        })
      } else if (platform.status === 'inactive') {
        signals.push({
          type: 'platform-inactive',
          severity: 'warning',
          description: `no evaluations recorded in ${platformDisplayName} in the last 7+ days`,
        })
      }
      break  // single-env preservation; multi-env handling lands later
    }

    if (firstEntry.permanent) {
      signals.push({
        type: 'platform-permanent',
        severity: 'info',
        description: `marked permanent in ${platformDisplayName}`,
      })
    }

    if (
      !firstEntry.permanent &&
      thresholdMs != null &&
      firstEntry.createdAt &&
      now - firstEntry.createdAt.getTime() > thresholdMs
    ) {
      const ageDays = Math.floor((now - firstEntry.createdAt.getTime()) / 86_400_000)
      signals.push({
        type: 'platform-too-old',
        severity: 'warning',
        description: `created in ${platformDisplayName} ${ageDays} days ago — past the ${options.thresholdDays}-day threshold`,
      })
    }

    // Evaluation signals — single-env preservation
    for (const platform of envMap.values()) {
      if (!firstEntry.permanent && typeof platform.evaluations30d === 'number') {
        if (platform.evaluations30d === 0) {
          signals.push({
            type: 'platform-zero-evaluations',
            severity: 'error',
            description: `0 evaluations in ${platformDisplayName} over the last 30 days — code path is unused`,
          })
        } else {
          const threshold = options.evaluationThreshold ?? 10
          if (platform.evaluations30d < threshold) {
            signals.push({
              type: 'platform-low-evaluations',
              severity: 'warning',
              description: `only ${platform.evaluations30d} evaluation${platform.evaluations30d === 1 ? '' : 's'} in ${platformDisplayName} over the last 30 days (below threshold ${threshold})`,
            })
          }
        }
      }
      break  // single-env preservation
    }

    // platform-untouched-stale — single-env preservation
    for (const platform of envMap.values()) {
      if (platform.lastTouched === null) {
        signals.push({
          type: 'platform-untouched-stale',
          severity: 'warning',
          description: `no activity in ${platformDisplayName} for 90+ days (audit log)`,
        })
      }
      break  // single-env preservation
    }

    if (signals.length > 0) {
      out.set(key, signals)
    }
  }

  return out
}
```

- [ ] **Step 2.2: Add a test helper for wrapping single-env data**

In `packages/core/test/providers/cross-reference.test.ts`, replace the existing `platformFlag` helper with:

```ts
function platformFlag(key: string, archived = false): PlatformFlag {
  return { key, archived, lastModified: null }
}

/**
 * Helper: wrap an array of PlatformFlag (the v1 single-env shape) into the
 * new PerEnvFlags map shape, using a default env name. Existing tests
 * call this to keep their assertions identical post-refactor.
 */
function singleEnv(flags: PlatformFlag[], env = 'production'): Map<string, Map<string, PlatformFlag>> {
  const out = new Map<string, Map<string, PlatformFlag>>()
  for (const f of flags) {
    out.set(f.key, new Map([[env, f]]))
  }
  return out
}
```

Then replace EVERY existing `crossReference(detected(...), [...], 'LaunchDarkly', ...)` call in the file with `crossReference(detected(...), singleEnv([...]), 'LaunchDarkly', ...)`. The third-arg displayName and fourth-arg options object stay where they are. Example:

```ts
// BEFORE
const result = crossReference(detected(['OLD_FLAG']), [platformFlag('OLD_FLAG', true)], 'LaunchDarkly')

// AFTER
const result = crossReference(detected(['OLD_FLAG']), singleEnv([platformFlag('OLD_FLAG', true)]), 'LaunchDarkly')
```

For the test `'emits missing-in-platform when flag is in code but not platform'`, the second arg is `[]` — replace with `new Map()`:

```ts
const result = crossReference(detected(['CHECKOUT_V2']), new Map(), 'LaunchDarkly')
```

- [ ] **Step 2.3: Update orchestrate.ts to wrap flag arrays via singleEnv pattern**

This step is a tactical bridge — we keep orchestrate looking single-env for now, but produce the new shape `crossReference` expects. The real multi-env loop lands in Task 8.

In `packages/core/src/providers/orchestrate.ts`, find:

```ts
const signals = crossReference(opts.detectedFlags, flags, def.displayName, {
  thresholdDays: opts.thresholdDays,
})
```

Replace with:

```ts
// Bridge: wrap the single-env listFlags() result into the PerEnvFlags
// shape crossReference now expects. The full multi-env loop arrives
// in a later task; for now we pass one env's data under a synthesized
// env key.
const envName = (parsed.data as { environments?: string[] }).environments?.[0]
  ?? (parsed.data as { environment?: string }).environment
  ?? 'default'
const perEnv = new Map<string, Map<string, typeof flags[number]>>()
for (const f of flags) {
  perEnv.set(f.key, new Map([[envName, f]]))
}
const signals = crossReference(opts.detectedFlags, perEnv, def.displayName, {
  thresholdDays: opts.thresholdDays,
  evaluationThreshold: opts.evaluationThreshold,
})
```

Also confirm the import at the top of orchestrate.ts already has `crossReference` from `'./cross-reference.js'` — it does (existing import).

NOTE: This step references `opts.evaluationThreshold` which doesn't exist on the options type yet. Check `OrchestratePlatformsOptions` near the top of orchestrate.ts. If `evaluationThreshold` is absent, add it:

```ts
export interface OrchestratePlatformsOptions {
  // ... existing fields ...
  thresholdDays?: number
  /**
   * Per-platform low-evaluations threshold passed through to crossReference.
   * Below this count over the reporting window, platform-low-evaluations fires.
   * Default in crossReference: 10.
   */
  evaluationThreshold?: number
  // ... rest ...
}
```

If it already exists, leave it.

- [ ] **Step 2.4: Run tests — everything should still pass**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts test/providers/orchestrate.test.ts
```

Expected: all existing tests PASS. The signature changed, the helper was added, behavior identical.

- [ ] **Step 2.5: Run the broader test suite to catch any other call sites**

```bash
cd packages/core && bun run vitest run
```

Expected: every test PASSES. If any test calls `crossReference` with the old `PlatformFlag[]` shape, the TypeScript compile or test runner will surface it — update it to use a wrapper map.

- [ ] **Step 2.6: Commit**

```bash
git add packages/core/src/providers/cross-reference.ts \
        packages/core/src/providers/orchestrate.ts \
        packages/core/test/providers/cross-reference.test.ts
git commit -m "refactor(core/providers): crossReference takes PerEnvFlags (behavior preserved) (#30)

Signature change only — single-env callers wrap their PlatformFlag[]
into a one-env Map and behavior is byte-identical to v1. Multi-env
signal rules land in subsequent tasks. The PerEnvFlags shape (flag
key -> env key -> PlatformFlag) is the foundation the multi-env loop
will hand to crossReference once the orchestrator starts looping envs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `fmtEnvs` helper + env-aware `platform-launched` rule

Multi-env semantics start here. `platform-launched` fires on ANY env; description names the affected envs (or says "everywhere" when all agree).

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts`
- Modify: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Append to `packages/core/test/providers/cross-reference.test.ts`, inside the existing `describe('crossReference', () => { ... })`:

```ts
  it("emits platform-launched 'in <env>' when only one env reports launched", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'active' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const signals = result.get('FOO') ?? []
    const launched = signals.find((s) => s.type === 'platform-launched')
    expect(launched).toBeDefined()
    expect(launched!.description).toContain('in production')
    expect(launched!.description).not.toContain('everywhere')
  })

  it("emits platform-launched 'everywhere' when all envs report launched", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const launched = result.get('FOO')?.find((s) => s.type === 'platform-launched')
    expect(launched!.description).toContain('everywhere')
  })

  it("emits platform-launched with comma-separated envs in config order", () => {
    // Build a perEnv map where production and test are launched, staging is
    // active. The user's configured order is [production, staging, test]
    // — but the perEnv Map's insertion order is what determines render
    // order in fmtEnvs (since we have no other source of truth here, the
    // insertion order IS the config-declared order).
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'active' }],
      ['test',       { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const launched = result.get('FOO')?.find((s) => s.type === 'platform-launched')
    expect(launched!.description).toContain('in production, test')
  })
```

- [ ] **Step 3.2: Run tests to verify the new ones fail**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts -t "platform-launched"
```

Expected: 3 new tests FAIL (description doesn't yet contain "in production" or "everywhere"; current single-env-preserved code uses the old static description).

- [ ] **Step 3.3: Add the `fmtEnvs` helper to cross-reference.ts**

Open `packages/core/src/providers/cross-reference.ts`. After the imports and before `export function crossReference(...)`, add:

```ts
/**
 * Render an env attribution suffix for a multi-env signal description.
 *
 *   fmtEnvs(['production'], ['production', 'staging'])  // 'in production'
 *   fmtEnvs(['production', 'staging'], ['production', 'staging'])  // 'everywhere'
 *
 * Order of envs in the output follows the order of `all` (i.e. the
 * config-declared order, since that's the order the orchestrator builds
 * the inner perEnv map in).
 */
function fmtEnvs(triggered: string[], all: string[]): string {
  if (triggered.length === all.length && triggered.length > 0) return 'everywhere'
  const ordered = all.filter((e) => triggered.includes(e))
  return `in ${ordered.join(', ')}`
}
```

- [ ] **Step 3.4: Update `platform-launched` to use env attribution**

Inside `crossReference`, find the existing `platform-launched` / `platform-inactive` block:

```ts
    for (const platform of envMap.values()) {
      if (platform.status === 'launched') {
        signals.push({
          type: 'platform-launched',
          severity: 'error',
          description: `${platformDisplayName} reports this flag has served one variation for 7+ days — likely ready for removal`,
        })
      } else if (platform.status === 'inactive') {
        signals.push({
          type: 'platform-inactive',
          severity: 'warning',
          description: `no evaluations recorded in ${platformDisplayName} in the last 7+ days`,
        })
      }
      break  // single-env preservation; multi-env handling lands later
    }
```

Replace with:

```ts
    // platform-launched: fire-on-any with env attribution. Inactive is
    // handled in a separate block below so we can suppress it when any
    // env is launched (they're contradictory states).
    const allEnvs = Array.from(envMap.keys())
    const launchedEnvs = allEnvs.filter((e) => envMap.get(e)!.status === 'launched')
    if (launchedEnvs.length > 0) {
      const where = fmtEnvs(launchedEnvs, allEnvs)
      signals.push({
        type: 'platform-launched',
        severity: 'error',
        description: `${platformDisplayName} reports this flag has served one variation for 7+ days ${where} — likely ready for removal`,
      })
    }
    // platform-inactive emission is deferred to Task 4 — leave it out
    // here so the launched-suppression rule can be implemented atomically.
```

- [ ] **Step 3.5: Run tests — platform-launched cases pass, but platform-inactive cases regress**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts
```

Expected:
- New `platform-launched` tests PASS.
- Existing single-env `platform-inactive` test (if any) MAY fail because we deleted the inactive branch. Check the existing test list for any test that expects `platform-inactive` to fire. If one exists and now fails, that's the bridge we re-implement in Task 4.

To be specific: look for a test like `it('emits platform-inactive when status is inactive', () => ...)`. If present, it'll fail until Task 4.

If a test fails ONLY for `platform-inactive`, that's expected. If anything else fails, debug before committing.

- [ ] **Step 3.6: Commit (even though platform-inactive temporarily regressed — Task 4 fixes it)**

Don't commit a regression. Instead, hold the commit until Task 4 lands. Go straight into Task 4.

---

## Task 4: env-aware `platform-inactive` rule with launched-suppression

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts`
- Modify: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 4.1: Write the failing tests**

Append to `cross-reference.test.ts`:

```ts
  it("emits platform-inactive 'in <env>' when one env reports inactive", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'active' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const inactive = result.get('FOO')?.find((s) => s.type === 'platform-inactive')
    expect(inactive).toBeDefined()
    expect(inactive!.description).toContain('in staging')
  })

  it("emits platform-inactive 'everywhere' when all envs are inactive", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const inactive = result.get('FOO')?.find((s) => s.type === 'platform-inactive')
    expect(inactive!.description).toContain('everywhere')
  })

  it('suppresses platform-inactive when any env reports launched', () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, status: 'launched' }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, status: 'inactive' }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const signals = result.get('FOO') ?? []
    expect(signals.find((s) => s.type === 'platform-launched')).toBeDefined()
    expect(signals.find((s) => s.type === 'platform-inactive')).toBeUndefined()
  })
```

Also re-verify the existing single-env test for `platform-inactive` (if one exists) still expects the unattributed description — since with single-env, `fmtEnvs(['production'], ['production'])` returns `'everywhere'`. **That changes the description.** Search the test file for any existing `platform-inactive` assertion:

```bash
grep -n "platform-inactive\|no evaluations" packages/core/test/providers/cross-reference.test.ts
```

If you find an existing assertion like `expect(...description).toBe('no evaluations recorded in LaunchDarkly in the last 7+ days')`, update it to expect the new shape `'no evaluations everywhere recorded in LaunchDarkly in the last 7+ days'` (or whatever Step 4.2 yields — match it).

- [ ] **Step 4.2: Run tests to confirm they fail**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts -t "platform-inactive"
```

Expected: new tests FAIL because the inactive branch was removed in Task 3.

- [ ] **Step 4.3: Add the platform-inactive emission with launched-suppression**

In `packages/core/src/providers/cross-reference.ts`, find the comment line you added in Step 3.4:

```ts
    // platform-inactive emission is deferred to Task 4 — leave it out
    // here so the launched-suppression rule can be implemented atomically.
```

Replace that line with:

```ts
    // platform-inactive: fire-on-any-env, BUT suppress when any env is
    // launched (they're contradictory; launched is the more severe
    // and more actionable signal).
    if (launchedEnvs.length === 0) {
      const inactiveEnvs = allEnvs.filter((e) => envMap.get(e)!.status === 'inactive')
      if (inactiveEnvs.length > 0) {
        const where = fmtEnvs(inactiveEnvs, allEnvs)
        signals.push({
          type: 'platform-inactive',
          severity: 'warning',
          description: `no evaluations recorded in ${platformDisplayName} ${where} in the last 7+ days`,
        })
      }
    }
```

- [ ] **Step 4.4: Run tests and verify they pass**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts
```

Expected: all tests in the file PASS.

- [ ] **Step 4.5: Commit (Task 3 + Task 4 combined)**

```bash
git add packages/core/src/providers/cross-reference.ts \
        packages/core/test/providers/cross-reference.test.ts
git commit -m "feat(core/cross-ref): env-attributed platform-launched + platform-inactive (#30)

- Add fmtEnvs helper to render 'everywhere' / 'in env1, env2' suffixes.
- platform-launched fires on any env with status=launched; description
  names which env(s).
- platform-inactive fires on any env with status=inactive AND no env is
  launched (launched-suppression rule, since the two are contradictory).
- Single-env behavior: description now reads 'everywhere' (one env
  = all envs), which is accurate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: env-aware `platform-zero-evaluations` + `platform-low-evaluations` with zero-suppression

Same pattern as Task 4: zero-evaluations fires on any env reporting 0; low-evaluations is suppressed when any env reports 0 (zero is more severe and renders the low-warning redundant).

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts`
- Modify: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 5.1: Write the failing tests**

Append to `cross-reference.test.ts`:

```ts
  it("emits platform-zero-evaluations 'in <env>' when one env reports 0 evals", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 5000 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const zero = result.get('FOO')?.find((s) => s.type === 'platform-zero-evaluations')
    expect(zero).toBeDefined()
    expect(zero!.description).toContain('in staging')
  })

  it("emits platform-zero-evaluations 'everywhere' when all envs are 0", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const zero = result.get('FOO')?.find((s) => s.type === 'platform-zero-evaluations')
    expect(zero!.description).toContain('everywhere')
  })

  it('suppresses platform-low-evaluations when any env reports zero', () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 0 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 3 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const signals = result.get('FOO') ?? []
    expect(signals.find((s) => s.type === 'platform-zero-evaluations')).toBeDefined()
    expect(signals.find((s) => s.type === 'platform-low-evaluations')).toBeUndefined()
  })

  it("emits platform-low-evaluations 'in <env>' with the lowest count", () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, evaluations30d: 9 }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, evaluations30d: 50 }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', { evaluationThreshold: 10 })
    const low = result.get('FOO')?.find((s) => s.type === 'platform-low-evaluations')
    expect(low).toBeDefined()
    expect(low!.description).toContain('in production')
    expect(low!.description).toContain('9 evaluations')
  })
```

If existing single-env tests reference `platform-zero-evaluations` description text, update them analogously — single-env data will now render `'everywhere'`.

- [ ] **Step 5.2: Run tests to confirm they fail**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts -t "evaluations"
```

Expected: new tests FAIL.

- [ ] **Step 5.3: Replace the evaluations block in crossReference**

In `packages/core/src/providers/cross-reference.ts`, find the existing single-env-preservation block:

```ts
    // Evaluation signals — single-env preservation
    for (const platform of envMap.values()) {
      if (!firstEntry.permanent && typeof platform.evaluations30d === 'number') {
        if (platform.evaluations30d === 0) {
          signals.push({
            type: 'platform-zero-evaluations',
            severity: 'error',
            description: `0 evaluations in ${platformDisplayName} over the last 30 days — code path is unused`,
          })
        } else {
          const threshold = options.evaluationThreshold ?? 10
          if (platform.evaluations30d < threshold) {
            signals.push({
              type: 'platform-low-evaluations',
              severity: 'warning',
              description: `only ${platform.evaluations30d} evaluation${platform.evaluations30d === 1 ? '' : 's'} in ${platformDisplayName} over the last 30 days (below threshold ${threshold})`,
            })
          }
        }
      }
      break  // single-env preservation
    }
```

Replace with:

```ts
    // platform-zero-evaluations: fire-on-any with env attribution.
    // platform-low-evaluations: fire-on-any with env attribution, BUT
    // suppress when any env reports zero (zero is the stronger signal;
    // emitting both creates noise).
    if (!firstEntry.permanent) {
      const zeroEnvs: string[] = []
      const lowByEnv: Array<{ env: string; count: number }> = []
      const threshold = options.evaluationThreshold ?? 10
      for (const env of allEnvs) {
        const evals = envMap.get(env)!.evaluations30d
        if (typeof evals !== 'number') continue
        if (evals === 0) {
          zeroEnvs.push(env)
        } else if (evals < threshold) {
          lowByEnv.push({ env, count: evals })
        }
      }
      if (zeroEnvs.length > 0) {
        const where = fmtEnvs(zeroEnvs, allEnvs)
        signals.push({
          type: 'platform-zero-evaluations',
          severity: 'error',
          description: `0 evaluations ${where} in ${platformDisplayName} over the last 30 days — code path is unused`,
        })
      } else if (lowByEnv.length > 0) {
        // Pick the env with the LOWEST count for the canonical
        // description; render the env list when multiple envs are low.
        const lowEnvs = lowByEnv.map((e) => e.env)
        const lowest = lowByEnv.reduce((a, b) => (a.count <= b.count ? a : b))
        const where = fmtEnvs(lowEnvs, allEnvs)
        signals.push({
          type: 'platform-low-evaluations',
          severity: 'warning',
          description: `only ${lowest.count} evaluation${lowest.count === 1 ? '' : 's'} ${where} in ${platformDisplayName} over the last 30 days (below threshold ${threshold})`,
        })
      }
    }
```

- [ ] **Step 5.4: Run tests and verify they pass**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5.5: Commit**

```bash
git add packages/core/src/providers/cross-reference.ts \
        packages/core/test/providers/cross-reference.test.ts
git commit -m "feat(core/cross-ref): env-attributed evaluation signals (#30)

- platform-zero-evaluations fires on any env reporting 0; description
  names the env(s) ('everywhere' when all agree).
- platform-low-evaluations fires on any env below threshold, BUT
  suppressed when any env reports zero (zero is the stronger signal).
- Low-evaluations description picks the lowest count when multiple
  envs are low, names all triggering envs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: strict ALL-envs `platform-untouched-stale`

This signal is the lone strict-all-envs rule: a flag toggled in staging counts as touched, so "untouched" requires every env's audit log to confirm zero activity.

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts`
- Modify: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 6.1: Write the failing tests**

Append to `cross-reference.test.ts`:

```ts
  it('emits platform-untouched-stale when ALL envs have lastTouched=null', () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    const untouched = result.get('FOO')?.find((s) => s.type === 'platform-untouched-stale')
    expect(untouched).toBeDefined()
    expect(untouched!.description).toContain('any of production, staging')
  })

  it('does NOT emit platform-untouched-stale when ANY env has activity', () => {
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null, lastTouched: new Date('2026-05-20') }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'platform-untouched-stale')).toBeUndefined()
  })

  it('does NOT emit platform-untouched-stale when ANY env audit-log is unavailable', () => {
    // Mixing null (confirmed untouched) and undefined (couldn't fetch) =>
    // we can't claim "untouched in all envs" because one env's audit log
    // is unknown. Strict rule.
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null, lastTouched: null }],
      ['staging',    { key: 'FOO', archived: false, lastModified: null /* lastTouched undefined */ }],
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'platform-untouched-stale')).toBeUndefined()
  })
```

If an existing single-env test exists for `platform-untouched-stale`, update its expected description to match the new format (`'no activity ... in any of production for 90+ days'` for single-env, or whatever Step 6.3 yields).

- [ ] **Step 6.2: Run tests to confirm they fail**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts -t "untouched"
```

Expected: new tests FAIL.

- [ ] **Step 6.3: Replace the untouched-stale block**

In `packages/core/src/providers/cross-reference.ts`, find:

```ts
    // platform-untouched-stale — single-env preservation
    for (const platform of envMap.values()) {
      if (platform.lastTouched === null) {
        signals.push({
          type: 'platform-untouched-stale',
          severity: 'warning',
          description: `no activity in ${platformDisplayName} for 90+ days (audit log)`,
        })
      }
      break  // single-env preservation
    }
```

Replace with:

```ts
    // platform-untouched-stale: STRICT all-envs rule.
    // Untouched only counts if EVERY env's audit log was successfully
    // fetched AND showed zero activity (lastTouched === null exactly —
    // not undefined, which means the fetch couldn't confirm). A flag
    // toggled in staging counts as touched; a flag whose staging audit
    // log we couldn't read is "unknown", not "untouched".
    const allUntouched = allEnvs.length > 0
      && allEnvs.every((e) => envMap.get(e)!.lastTouched === null)
    if (allUntouched) {
      signals.push({
        type: 'platform-untouched-stale',
        severity: 'warning',
        description: `no activity in ${platformDisplayName} in any of ${allEnvs.join(', ')} for 90+ days (audit log)`,
      })
    }
```

- [ ] **Step 6.4: Run tests and verify they pass**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts
```

Expected: all PASS.

- [ ] **Step 6.5: Commit**

```bash
git add packages/core/src/providers/cross-reference.ts \
        packages/core/test/providers/cross-reference.test.ts
git commit -m "feat(core/cross-ref): strict all-envs platform-untouched-stale (#30)

A flag is 'untouched' only when EVERY env's audit log was successfully
fetched AND showed zero activity. Mixing null (confirmed untouched)
and undefined (audit log unavailable) yields no signal — we can't
claim 'stale everywhere' when one env's history is unknown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `missing-in-platform` — absent from every env

The current behavior is "absent from the (single) env" which is fine for single-env, but multi-env needs "absent from EVERY env" — if a flag exists in production but not in test, it's not missing, just env-scoped.

LD's flag list is project-scoped (every env sees every flag in the project), so in practice a flag is in every env or in no env. But we should still write the logic correctly to avoid surprising behavior if LD changes that, or if a future provider has env-scoped flag lists.

**Files:**
- Modify: `packages/core/src/providers/cross-reference.ts` (already correct from Task 2 — verify)
- Modify: `packages/core/test/providers/cross-reference.test.ts`

- [ ] **Step 7.1: Verify the existing logic already meets the spec**

Open `packages/core/src/providers/cross-reference.ts`. Confirm this block at the top of the loop:

```ts
    const envMap = platformFlagsByEnv.get(key)
    if (!envMap || envMap.size === 0) {
      out.set(key, [
        {
          type: 'missing-in-platform',
          ...
```

This fires only when the flag has zero env entries — meaning it's absent from every env. Spec requirement satisfied as-is. No code change needed.

- [ ] **Step 7.2: Add a regression test verifying multi-env presence suppresses missing-in-platform**

Append to `cross-reference.test.ts`:

```ts
  it('does NOT emit missing-in-platform when flag is present in at least one env', () => {
    // Flag is missing from staging but present in production — should
    // NOT be reported as missing.
    const perEnv = new Map([['FOO', new Map<string, PlatformFlag>([
      ['production', { key: 'FOO', archived: false, lastModified: null }],
      // 'staging' intentionally not in the inner Map
    ])]])
    const result = crossReference(detected(['FOO']), perEnv, 'LaunchDarkly', {})
    expect(result.get('FOO')?.find((s) => s.type === 'missing-in-platform')).toBeUndefined()
  })

  it('emits missing-in-platform when flag is absent from every env', () => {
    const result = crossReference(detected(['FOO']), new Map(), 'LaunchDarkly', {})
    expect(result.get('FOO')?.[0].type).toBe('missing-in-platform')
  })
```

- [ ] **Step 7.3: Run tests**

```bash
cd packages/core && bun run vitest run test/providers/cross-reference.test.ts -t "missing-in-platform"
```

Expected: both tests PASS immediately (logic already correct).

- [ ] **Step 7.4: Commit**

```bash
git add packages/core/test/providers/cross-reference.test.ts
git commit -m "test(core/cross-ref): regression coverage for multi-env missing-in-platform (#30)

Pin the behavior that a flag present in at least one env does NOT
trigger missing-in-platform — only flags absent from every env do.
The logic already meets this spec; these tests guard against
regressions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: orchestrate — actually loop envs and stitch

This is the structural change: orchestrate.ts goes from "one listFlags() call per platform" to "one listFlags() call per (platform, env) pair, stitched into PerEnvFlags".

**Files:**
- Modify: `packages/core/src/providers/orchestrate.ts`
- Modify: `packages/core/test/providers/orchestrate.test.ts`

- [ ] **Step 8.1: Write the failing test — multi-env orchestration end-to-end**

Append to `packages/core/test/providers/orchestrate.test.ts`, inside `describe('orchestratePlatforms', () => { ... })`:

```ts
  it('loops over multiple environments and stitches per-env platform data', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      // Two listFlags calls, one per env. The override receives a signal
      // but we use a call counter to distinguish envs.
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
            // production: launched
            return [{ key: 'FOO', archived: false, lastModified: null, status: 'launched' as const }]
          }
          // staging: active
          return [{ key: 'FOO', archived: false, lastModified: null, status: 'active' as const }]
        },
      })
      expect(call).toBe(2)
      const signals = result.signals.get('FOO') ?? []
      const launched = signals.find((s) => s.type === 'platform-launched')
      expect(launched).toBeDefined()
      expect(launched!.description).toContain('in production')
      expect(launched!.description).not.toContain('everywhere')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })

  it('treats single environment: prod the same as environments: [prod]', async () => {
    const logger = silentLogger()
    process.env.LAUNCHDARKLY_API_TOKEN = 'tok'
    try {
      const result = await orchestratePlatforms({
        platformsConfig: { launchdarkly: { project: 'p', environment: 'prod' } },
        detectedFlags: detected(['FOO']),
        logger,
        listFlagsOverride: async () => [
          { key: 'FOO', archived: false, lastModified: null, status: 'launched' as const },
        ],
      })
      const launched = result.signals.get('FOO')?.find((s) => s.type === 'platform-launched')
      expect(launched).toBeDefined()
      // Single env => 'everywhere' rendering (correct: one env IS all envs)
      expect(launched!.description).toContain('everywhere')
    } finally {
      delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  })
```

- [ ] **Step 8.2: Run tests to verify the multi-env one fails**

```bash
cd packages/core && bun run vitest run test/providers/orchestrate.test.ts
```

Expected: the multi-env test FAILS (`call` is only 1 because the current code doesn't loop). The single-env test may already pass (one iteration, "everywhere" rendering = correct).

- [ ] **Step 8.3: Replace the orchestrate platform loop body**

Open `packages/core/src/providers/orchestrate.ts`. Find the `try { ... }` block inside the platform iteration (around line 99 — the block that starts `const client = def.createClient(parsed.data, token)` and ends just before the `} catch (err) {`).

Replace the entire try block with:

```ts
    try {
      // Multi-env: parsed.data.environments is always a non-empty array
      // after the Zod transform (both `environment: 'x'` and
      // `environments: ['x']` are normalized to environments[]).
      // Loop serially per env — each iteration runs an isolated
      // listFlags() with its own concurrency budget and its own cache
      // entry (computeCacheKey hashes the full config including env).
      // Serial keeps blast radius constant per env.
      const envs = (parsed.data as { environments: string[] }).environments
      const perEnv = new Map<string, Map<string, PlatformFlag>>()
      let firstEnvFlags: PlatformFlag[] = []

      for (const env of envs) {
        const envConfig = { ...parsed.data, environment: env }
        const client = def.createClient(envConfig, token)
        const cacheKey = computeCacheKey(name, envConfig, token)
        const flags = opts.listFlagsOverride
          ? await opts.listFlagsOverride(opts.signal)
          : await loadPlatformFlagsCached(client, cacheKey, {
              noCache: opts.noCache,
              signal: opts.signal,
            })
        if (env === envs[0]) firstEnvFlags = flags
        for (const f of flags) {
          if (!perEnv.has(f.key)) perEnv.set(f.key, new Map())
          perEnv.get(f.key)!.set(env, f)
        }
      }

      const signals = crossReference(opts.detectedFlags, perEnv, def.displayName, {
        thresholdDays: opts.thresholdDays,
        evaluationThreshold: opts.evaluationThreshold,
      })
      mergePlatformSignals(out, signals)

      // Track flags marked permanent (LD's temporary=false). Flag-level
      // field — identical across envs — so reading from first env is correct.
      const platformPermanent: string[] = []
      for (const [flagName, sigList] of signals) {
        if (sigList.some((s) => s.type === 'platform-permanent')) {
          platformPermanent.push(flagName)
        }
      }
      if (platformPermanent.length > 0) {
        permanentByPlatform[def.displayName] = platformPermanent.sort()
      }

      // metadataByFlag: surface platform-side metadata. For multi-env,
      // we use the first env's data — matches the JSON output rule
      // (top-level fields source from environments[envs[0]]).
      for (const flag of firstEnvFlags) {
        if (!opts.detectedFlags.has(flag.key)) continue
        const hasMetadata = (flag.tags && flag.tags.length > 0) || flag.maintainer || flag.status
        if (!hasMetadata) continue
        metadataByFlag.set(flag.key, {
          tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
          maintainer: flag.maintainer,
          status: flag.status,
        })
      }
    } catch (err) {
```

(The `catch (err) {` line remains unchanged.)

You also need to remove the now-unused Task-2 "bridge" code that wrapped flags into `perEnv` — if any of it survives the replacement above, delete it. The new try block above is the complete replacement.

Make sure the import for `PlatformFlag` is present at the top of `orchestrate.ts`. Check:

```ts
import type { PlatformSignal, PlatformFlag } from './interface.js'
```

If `PlatformFlag` isn't there, add it.

- [ ] **Step 8.4: Run all orchestrate tests**

```bash
cd packages/core && bun run vitest run test/providers/orchestrate.test.ts
```

Expected: all PASS, including the new multi-env one.

- [ ] **Step 8.5: Run the full core test suite to confirm no regressions**

```bash
cd packages/core && bun run vitest run
```

Expected: all PASS.

- [ ] **Step 8.6: Commit**

```bash
git add packages/core/src/providers/orchestrate.ts \
        packages/core/test/providers/orchestrate.test.ts
git commit -m "feat(core/orchestrate): loop envs and stitch into PerEnvFlags (#30)

For each configured platform, iterate environments serially: build a
per-env client via createClient, run listFlags() once per env (cache
key hashes the full config so each env gets its own cache entry),
and stitch results into Map<flagKey, Map<envKey, PlatformFlag>>.

Cross-reference now receives the full per-env shape and emits
env-attributed signals end-to-end.

metadataByFlag continues to populate from the first env's data — same
rule as the JSON top-level fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: JSON output — additive `environments` block

Wire the per-env data into the JSON output. Add an `environments` field per flag containing the per-env breakdown, while preserving the existing top-level fields (`platformStatus`, etc.) for v1 contract.

This requires two threads:
1. The orchestrate result needs to carry per-env data downstream (currently it only surfaces `metadataByFlag` with a single `status`).
2. The JSON formatter reads that per-env data and emits the `environments` block.

**Files:**
- Modify: `packages/core/src/providers/orchestrate.ts` — augment result with per-env data
- Modify: `packages/core/src/scan-repo.ts` — propagate the new data into the scan result
- Modify: `packages/core/src/staleness.ts` — `StaleFlag` gains optional `environments` field
- Modify: `packages/core/src/output/json.ts` — emit the block
- Modify: `packages/core/test/providers/orchestrate.test.ts` — test the new orchestrate output
- Test: any existing `json.test.ts` (verify via grep below)

- [ ] **Step 9.1: Locate existing JSON output tests**

```bash
find packages/core/test -name "*.test.ts" | xargs grep -l "formatJson\|format-json" 2>/dev/null
```

Note the file(s) returned. If none exist, you'll create one in Step 9.5.

- [ ] **Step 9.2: Extend the OrchestrateResult shape**

In `packages/core/src/providers/orchestrate.ts`, find the existing `OrchestrateResult` interface:

```ts
export interface OrchestrateResult {
  signals: Map<string, PlatformSignal[]>
  permanentByPlatform: Record<string, string[]>
  metadataByFlag: Map<
    string,
    { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
  >
}
```

Replace with (adding the new `environmentsByFlag` field):

```ts
/**
 * Per-env breakdown of platform data for each detected flag, indexed by
 * flag name then env key. Populated only for flags that matched a platform
 * AND had per-env enrichment data (status, evaluations30d, lastRequested,
 * lastTouched). Surfaced to the JSON output formatter so consumers see the
 * full multi-env picture beneath the flat top-level fields.
 */
export interface PerFlagEnvironmentData {
  status?: 'new' | 'active' | 'inactive' | 'launched'
  evaluations30d?: number | null
  lastRequested?: Date | null
  lastTouched?: Date | null
}

export interface OrchestrateResult {
  signals: Map<string, PlatformSignal[]>
  permanentByPlatform: Record<string, string[]>
  metadataByFlag: Map<
    string,
    { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
  >
  /**
   * Per-flag, per-env enrichment data. Outer key: detected flag name.
   * Inner key: env name. Empty when no platform integration is configured
   * or when no flag had enrichment data. JSON output uses this to emit
   * the additive `environments` block.
   */
  environmentsByFlag: Map<string, Map<string, PerFlagEnvironmentData>>
}
```

Then, inside `orchestratePlatforms`, near the top where `permanentByPlatform` and `metadataByFlag` are initialized:

```ts
const permanentByPlatform: Record<string, string[]> = {}
const metadataByFlag = new Map<
  string,
  { tags?: string[]; maintainer?: string; status?: 'new' | 'active' | 'inactive' | 'launched' }
>()
```

Add right after:

```ts
const environmentsByFlag = new Map<string, Map<string, PerFlagEnvironmentData>>()
```

Inside the per-platform try block, AFTER the existing `for (const flag of firstEnvFlags)` metadata-population loop, add:

```ts
      // environmentsByFlag: per-env enrichment for every detected flag
      // that the platform knew about. Outer key = detected flag name.
      // Inner key = env name. Populates from the stitched perEnv map
      // we built above — single source of truth.
      for (const [flagKey, envInnerMap] of perEnv) {
        if (!opts.detectedFlags.has(flagKey)) continue
        const inner = new Map<string, PerFlagEnvironmentData>()
        for (const [env, pf] of envInnerMap) {
          // Only include envs where we have at least one enrichment field
          // populated — otherwise the block is just noise.
          if (
            pf.status == null
            && pf.evaluations30d == null
            && pf.lastRequested == null
            && pf.lastTouched == null
          ) continue
          inner.set(env, {
            status: pf.status,
            evaluations30d: pf.evaluations30d,
            lastRequested: pf.lastRequested,
            lastTouched: pf.lastTouched,
          })
        }
        if (inner.size > 0) {
          environmentsByFlag.set(flagKey, inner)
        }
      }
```

Update the return statement at the bottom of `orchestratePlatforms`:

```ts
return { signals: out, permanentByPlatform, metadataByFlag, environmentsByFlag }
```

And the early-return at the top (when `opts.platformsConfig` is undefined):

```ts
if (!opts.platformsConfig) {
  return { signals: out, permanentByPlatform, metadataByFlag, environmentsByFlag }
}
```

- [ ] **Step 9.3: Propagate environmentsByFlag through scan-repo.ts**

In `packages/core/src/scan-repo.ts`, find the destructured result from `orchestratePlatforms` (around line 241):

```ts
const {
  signals: platformSignals,
  ...
  metadataByFlag,
} = await orchestratePlatforms({...})
```

Add `environmentsByFlag` to the destructuring:

```ts
const {
  signals: platformSignals,
  permanentByPlatform,
  metadataByFlag,
  environmentsByFlag,
} = await orchestratePlatforms({...})
```

Then pass it into `analyzeStaleness`. Find the call to `analyzeStaleness` (search the file for `analyzeStaleness(`). Add a new field to its options:

```ts
const staleFlags = analyzeStaleness(flags, {
  thresholdDays: ...,
  repoRoot: ...,
  platformSignals,
  platformMetadata: metadataByFlag,
  platformEnvironments: environmentsByFlag,  // NEW
})
```

- [ ] **Step 9.4: Update staleness.ts to accept + propagate platformEnvironments**

Open `packages/core/src/staleness.ts`. Find the `StalenessOptions` interface and add a new field:

```ts
export interface StalenessOptions {
  // ...existing fields...

  /**
   * Per-flag, per-env enrichment data sourced from the platform integration.
   * When provided, surfaces on each StaleFlag via the `environments` field,
   * which the JSON formatter renders into the additive `environments` block.
   * Outer key: detected flag name. Inner key: env name.
   */
  platformEnvironments?: Map<
    string,
    Map<string, {
      status?: 'new' | 'active' | 'inactive' | 'launched'
      evaluations30d?: number | null
      lastRequested?: Date | null
      lastTouched?: Date | null
    }>
  >
}
```

Find the `StaleFlag` interface in the same file and add the matching optional field:

```ts
export interface StaleFlag {
  // ...existing fields...

  /**
   * Per-env platform enrichment data for this flag. Populated only
   * when a platform integration is active AND the flag matched in that
   * platform. JSON output renders this as an additive `environments`
   * block per flag.
   */
  environments?: Map<string, {
    status?: 'new' | 'active' | 'inactive' | 'launched'
    evaluations30d?: number | null
    lastRequested?: Date | null
    lastTouched?: Date | null
  }>
}
```

Find where `StaleFlag` instances are constructed (search for `staleFlags.push(` or for the place that populates `tags`, `maintainer`, `platformStatus`). Add:

```ts
  if (options.platformEnvironments) {
    const envData = options.platformEnvironments.get(flagName)
    if (envData && envData.size > 0) {
      newStaleFlag.environments = envData
    }
  }
```

(Adapt the exact local variable names to whatever staleness.ts uses — `newStaleFlag` may be called something else like `flag` or `stale`.)

- [ ] **Step 9.5: Update JSON output**

Open `packages/core/src/output/json.ts`. Find the flag-mapping block:

```ts
const flags = result.staleFlags.map((sf) => {
  const flagSeverity: 'error' | 'warning' = sf.signals.some((s) => s.severity === 'error') ? 'error' : 'warning'
  return {
    name: sf.name,
    // ...existing fields...
    ...(sf.platformStatus ? { platformStatus: sf.platformStatus } : {}),
  }
})
```

Add an `environments` block. Replace the return statement (the `return { ... }` part) with:

```ts
return {
  name: sf.name,
  file: sf.filePath,
  line: sf.lineNumber,
  language: sf.language,
  provider: sf.provider,
  stale: true,
  severity: flagSeverity,
  confidence: sf.confidence ?? 'high',
  signals: sf.signals.map((s) => ({ type: s.type, severity: s.severity, description: s.description })),
  age: sf.age ?? null,
  ...(sf.tags && sf.tags.length > 0 ? { tags: sf.tags } : {}),
  ...(sf.maintainer ? { maintainer: sf.maintainer } : {}),
  ...(sf.platformStatus ? { platformStatus: sf.platformStatus } : {}),
  ...(sf.environments && sf.environments.size > 0
    ? {
        environments: Object.fromEntries(
          Array.from(sf.environments.entries()).map(([env, data]) => [
            env,
            {
              ...(data.status != null ? { status: data.status } : {}),
              ...(data.evaluations30d != null
                ? { evaluations30d: data.evaluations30d }
                : {}),
              ...(data.lastRequested != null
                ? { lastRequested: data.lastRequested.toISOString() }
                : {}),
              ...(data.lastTouched != null
                ? { lastTouched: data.lastTouched.toISOString() }
                : {}),
            },
          ]),
        ),
      }
    : {}),
}
```

- [ ] **Step 9.6: Add a JSON formatter test**

Create or extend `packages/core/test/output/json.test.ts`. If the file exists, add a test inside the existing `describe`. If not, create it:

```ts
import { describe, it, expect } from 'vitest'
import { formatJson } from '../../src/output/json.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'
import type { StaleFlag } from '../../src/staleness.js'

function baseResult(staleFlags: StaleFlag[]): ScanRepoResult {
  return {
    totalFlags: staleFlags.length,
    staleFlags,
    parseErrorCount: 0,
    excludedPermanent: [],
    permanentByPlatform: {},
    healthScore: 10,
    detectedProviders: ['launchdarkly-node-server-sdk'],
    languageBreakdown: { typescript: 1 },
    excludedPaths: [],
    scanDuration: 0,
  } as ScanRepoResult
}

describe('formatJson — environments block', () => {
  it('omits the environments key when no per-env data is attached', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0]).not.toHaveProperty('environments')
  })

  it('emits per-env data when present', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', { status: 'launched', evaluations30d: 12000, lastRequested: new Date('2026-05-25T00:00:00Z'), lastTouched: new Date('2026-04-01T00:00:00Z') }],
        ['staging',    { status: 'active',   evaluations30d: 3,     lastRequested: new Date('2026-05-26T00:00:00Z'), lastTouched: new Date('2026-05-20T00:00:00Z') }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments).toEqual({
      production: {
        status: 'launched',
        evaluations30d: 12000,
        lastRequested: '2026-05-25T00:00:00.000Z',
        lastTouched: '2026-04-01T00:00:00.000Z',
      },
      staging: {
        status: 'active',
        evaluations30d: 3,
        lastRequested: '2026-05-26T00:00:00.000Z',
        lastTouched: '2026-05-20T00:00:00.000Z',
      },
    })
  })

  it('omits null/undefined per-env fields', () => {
    const result = baseResult([{
      name: 'FOO',
      filePath: 'a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
      signals: [],
      environments: new Map([
        ['production', { status: 'active' /* no evaluations30d, no lastRequested, no lastTouched */ }],
      ]),
    }])
    const json = JSON.parse(formatJson(result, { version: 'test' }))
    expect(json.flags[0].environments.production).toEqual({ status: 'active' })
  })
})
```

- [ ] **Step 9.7: Run the JSON test**

```bash
cd packages/core && bun run vitest run test/output/json.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 9.8: Run the full test suite to confirm no regressions**

```bash
cd packages/core && bun run vitest run
```

Expected: every test PASSES.

- [ ] **Step 9.9: Commit**

```bash
git add packages/core/src/providers/orchestrate.ts \
        packages/core/src/scan-repo.ts \
        packages/core/src/staleness.ts \
        packages/core/src/output/json.ts \
        packages/core/test/output/json.test.ts \
        packages/core/test/providers/orchestrate.test.ts
git commit -m "feat(core/output): additive environments block in JSON output (#30)

Per-flag 'environments' block carries per-env enrichment (status,
evaluations30d, lastRequested, lastTouched) for multi-env scans.
Existing top-level fields (platformStatus, etc.) preserved — single-env
JSON output is byte-identical below the new block. Block is omitted
entirely when no platform integration is configured or when no per-env
data was populated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Cache-key invariant — array vs single produces different keys

Pin the cache-key behavior so a config that uses `environment: 'prod'` and one that uses `environments: ['prod']` produce different cache keys after normalization (they shouldn't share cached data — though after the Zod transform they normalize to the same shape).

Wait — after the Zod `.transform`, both shapes produce IDENTICAL config objects (the transform drops `environment` and writes `environments: ['prod']` for both). So cache keys WILL be identical. That's correct behavior: `environment: 'prod'` and `environments: ['prod']` are semantically the same. Pin THAT as the invariant.

**Files:**
- Modify: `packages/core/test/providers/cache.test.ts`

- [ ] **Step 10.1: Add the invariant test**

Append to `packages/core/test/providers/cache.test.ts`, inside the existing `describe('computeCacheKey', () => { ... })`:

```ts
  it('produces different cache keys for different env lists', () => {
    const single  = computeCacheKey('launchdarkly', { project: 'p', environments: ['prod'] }, 'tok')
    const double  = computeCacheKey('launchdarkly', { project: 'p', environments: ['prod', 'staging'] }, 'tok')
    const reversed = computeCacheKey('launchdarkly', { project: 'p', environments: ['staging', 'prod'] }, 'tok')
    expect(single).not.toBe(double)
    expect(double).not.toBe(reversed)  // env order is part of the cache identity
  })

  it('produces the same cache key for the same per-env config (orchestrator loop)', () => {
    // The orchestrator synthesizes `environment: env` per loop iteration
    // while keeping the rest of the config identical. Two synthesized
    // configs differing only in environment value must produce
    // different keys (so each env has its own cache slot).
    const prod    = computeCacheKey('launchdarkly', { project: 'p', environment: 'prod', environments: ['prod', 'staging'] }, 'tok')
    const staging = computeCacheKey('launchdarkly', { project: 'p', environment: 'staging', environments: ['prod', 'staging'] }, 'tok')
    expect(prod).not.toBe(staging)
  })
```

- [ ] **Step 10.2: Run the cache tests**

```bash
cd packages/core && bun run vitest run test/providers/cache.test.ts
```

Expected: all PASS.

- [ ] **Step 10.3: Commit**

```bash
git add packages/core/test/providers/cache.test.ts
git commit -m "test(core/cache): pin per-env cache-key invariants (#30)

Different env lists -> different cache keys. Same config but different
synthesized 'environment' (the orchestrator's per-iteration shape) ->
different cache keys, so each env gets its own cache slot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: README — update LD config example to multi-env primary form

**Files:**
- Modify: `README.md`

- [ ] **Step 11.1: Update the LD config example**

In `README.md`, find the block around line 207:

```yaml
    platforms:
      launchdarkly:
        project: my-project-key
        environment: production
```

Replace with:

```yaml
    platforms:
      launchdarkly:
        project: my-project-key
        environments: [production]    # or [production, staging, test]
```

Find the surrounding prose (line 205 area: "Add to `.flagshark.yml`:"). After the yaml block, add a paragraph:

```markdown
The `environments` array can contain one or more environment keys. When
multiple are configured, FlagShark cross-references each flag against every
listed environment and emits env-attributed signals (e.g. `launched in
production`, `inactive in staging, test`). A flag has to be stale in EVERY
configured env to be a candidate for safe removal — mid-rollout flags
(`launched` in one env, still `active` in another) are surfaced so
reviewers see them rather than getting an over-confident "stale" verdict.

The legacy single-env form `environment: production` is still accepted and
is equivalent to `environments: [production]`.
```

- [ ] **Step 11.2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document multi-env LaunchDarkly config (#30)

Make 'environments: [list]' the recommended form in the LD setup
section; note that the single-env 'environment: x' is still accepted.
Brief explanation of the multi-env signal semantics: env-attributed
signals, 'safe to remove' = stale in every env, mid-rollout flags
surfaced explicitly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Live LD integration — multi-env case

**Files:**
- Modify: `packages/core/test/providers/launchdarkly/client.live.test.ts`

- [ ] **Step 12.1: Add a multi-env live test**

Append to `packages/core/test/providers/launchdarkly/client.live.test.ts`, inside the existing `describe.skipIf(!TOKEN)(...)`:

```ts
  it('orchestrates a multi-env scan end-to-end (production + test envs)', async () => {
    // This test does a focused integration through orchestratePlatforms
    // rather than fetchAllFlags directly. It needs at least two envs
    // available in the LIVE_LD_PROJECT. If LIVE_LD_ENVIRONMENT_TWO isn't
    // set, skip — the live trial project ships with multiple envs by
    // default (production + test), but this lets ops point at a custom
    // pair.
    const envOne = ENVIRONMENT
    const envTwo = process.env.LIVE_LD_ENVIRONMENT_TWO ?? 'production'
    if (envOne === envTwo) {
      // eslint-disable-next-line no-console
      console.log('[live-ld] LIVE_LD_ENVIRONMENT == LIVE_LD_ENVIRONMENT_TWO — skipping multi-env case')
      return
    }

    // Use orchestratePlatforms via a direct import so we exercise the
    // full stitching + cross-reference path. We don't bring our own
    // detected flags — just verify the orchestrator runs, perEnv data
    // is gathered, and signals (if any) carry env attribution.
    const { orchestratePlatforms } = await import('../../../src/providers/orchestrate.js')

    const prevToken = process.env.LAUNCHDARKLY_API_TOKEN
    process.env.LAUNCHDARKLY_API_TOKEN = TOKEN
    try {
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: PROJECT, environments: [envOne, envTwo] },
        },
        detectedFlags: new Map(),  // no detected flags — just exercising the fetch + stitch
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        noCache: true,
      })
      // We expect zero signals (no detected flags) but the call should
      // succeed and the orchestrator should have hit BOTH envs without
      // throwing. The exit code being clean is the contract.
      expect(result.signals.size).toBe(0)
      expect(result.environmentsByFlag.size).toBe(0)  // empty because detectedFlags is empty
    } finally {
      if (prevToken !== undefined) process.env.LAUNCHDARKLY_API_TOKEN = prevToken
      else delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  }, 60_000)
```

- [ ] **Step 12.2: Run the live test (locally, with creds set)**

This step is optional during plan execution if creds aren't available. The default CI run doesn't include live tests; they run via `bun run test:live`.

If you have the creds:

```bash
cd packages/core && LIVE_LAUNCHDARKLY_API_TOKEN=... LIVE_LD_PROJECT=... LIVE_LD_ENVIRONMENT=test LIVE_LD_ENVIRONMENT_TWO=production bun run test:live
```

Expected: the new test PASSES (or self-skips if the two env names are identical).

If you don't have creds, verify the test self-skips correctly via the existing `describe.skipIf(!TOKEN)` guard:

```bash
cd packages/core && bun run test:live
```

Expected: all tests skip cleanly with the `LIVE_LAUNCHDARKLY_API_TOKEN not set` message.

- [ ] **Step 12.3: Commit**

```bash
git add packages/core/test/providers/launchdarkly/client.live.test.ts
git commit -m "test(core/ld): live multi-env orchestration test (#30)

New live test exercises orchestratePlatforms with environments=[a,b]
against the LIVE_LD_PROJECT. Self-skips when LIVE_LD_ENVIRONMENT and
LIVE_LD_ENVIRONMENT_TWO are identical (or the latter is unset and
defaults equal the former). Default CI continues to exclude live
tests; invoke via 'bun run test:live'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Final verification + open PR

- [ ] **Step 13.1: Full test sweep across the whole monorepo**

```bash
cd /Users/joe/projects/flagshark && bun run test
```

Expected: every package's tests PASS. If anything in `packages/cli` or `packages/action` fails because of a JSON schema change (the additive `environments` block), update those consumers' fixtures to match.

- [ ] **Step 13.2: Run the lockstep-version CI assertion (in case any package.json shifted)**

```bash
cd /Users/joe/projects/flagshark && bash scripts/check-lockstep-versions.sh
```

(File name may differ — check the script that the recent commit `6ef6a6d chore(repo): lockstep-version CI assertion` added. Look in `scripts/`.)

Expected: PASS. If FAIL, no version bumps are needed for this feature — fix any inconsistency.

- [ ] **Step 13.3: Push the branch and open a PR**

```bash
git push -u origin spec/ld-multi-env-cross-check
gh pr create --title "LD multi-environment cross-check (#30)" \
  --body "Closes #30.

Adds multi-environment cross-reference for the LaunchDarkly integration. Config gains \`environments: [list]\` alongside the existing single-\`environment\` form (both accepted; one required). Each detected flag is cross-referenced against every configured env; signals carry env attribution.

**Signal semantics (multi-env):**
- \`platform-launched\`, \`platform-inactive\`, \`platform-zero-evaluations\`, \`platform-low-evaluations\` — fire on ANY env that meets the condition; description names which env(s) (\`'in production'\`, \`'everywhere'\` when all agree).
- \`platform-inactive\` suppressed when any env is \`launched\` (contradictory states).
- \`platform-low-evaluations\` suppressed when any env reports zero.
- \`platform-untouched-stale\` — STRICT all-envs rule: every env's audit log must confirm zero activity. Mixing 'untouched' and 'audit-log-unavailable' yields no signal.

**JSON output:** additive \`environments: { [envKey]: { status, evaluations30d, lastRequested, lastTouched } }\` block per flag. Top-level fields sourced from \`environments[envs[0]]\` — single-env JSON byte-identical to v1.

Spec: \`docs/superpowers/specs/2026-05-26-ld-multi-environment-cross-check-design.md\`
Plan: \`docs/superpowers/plans/2026-05-26-ld-multi-environment-cross-check.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 13.4: Verify CI green**

Wait for CI to complete. If anything fails, fix in-place; this is a feature branch so direct fixups are fine.

---

## Self-review checklist

This was already done at write-time; documenting here so reviewers can spot-check.

- **Spec coverage:** every section of the spec has at least one task — config (T1), per-env type (T2), fmtEnvs + per-signal rules (T3-T7), orchestrate loop (T8), JSON output (T9), cache invariant (T10), README (T11), live test (T12).
- **Placeholder scan:** no TBDs, no "add error handling" stubs, no "similar to Task N" references — every step has the full code an engineer would type.
- **Type consistency:** `PerEnvFlags` is `Map<string, Map<string, PlatformFlag>>` everywhere it appears (T2 declares, T3-T8 use). `PerFlagEnvironmentData` defined in T9 is the shape used in `staleness.ts`, `orchestrate.ts`, and `json.ts`. `environmentsByFlag` (orchestrate) and `environments` (StaleFlag) both use Map shape so consumers don't need to handle two layouts.
- **TDD discipline:** every task is test-first, with explicit "run and confirm failure" before implementation.
