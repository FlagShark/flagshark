# LaunchDarkly Variation-Aware Cleanup — Design

**Status:** Design / pending implementation plan
**Date:** 2026-05-27
**Issue:** [#31](https://github.com/FlagShark/flagshark/issues/31)
**Scope:** Extend the LaunchDarkly platform integration so it surfaces enough variation + per-env state for downstream cleanup tooling (SaaS Piranha) to substitute the correct value when removing a flag from code.

## 1. Goal

Today FlagShark's LD integration extracts enough data to *identify* stale flags (`platform-launched`, `platform-zero-evaluations`, etc.) but not enough to *clean them up correctly*. When the SaaS Piranha pipeline removes a flag from code, it has to guess the default value — and the guess is often wrong for kill-switches, where the code-side fallback (`client.variation('foo', user, false)`'s `false`) doesn't match LD's actual fallthrough variation. The `personalAccessTokensKillSwitch` "always throw" bug surfaced during the pre-launch Piranha shakedown was this exact failure mode.

The fix is to surface, per flag and per env:

- The set of declared **variations** (so the substitute value can be looked up by index).
- The flag's **`on` state** (whether it's currently serving anything at all).
- The 100%-rollout **fallthrough variation** index, or `null` for split rollouts (in which case SaaS fails closed instead of mechanically substituting).
- The **off variation** index (which gets served when `on: false`).

OSS only plumbs the data through. SaaS Piranha consumes the JSON output and makes the substitution decision — that work is tracked separately.

## 2. Today's state

- `fetchAllFlags` (`packages/core/src/providers/launchdarkly/client.ts`) calls `/api/v2/flags/{project}?env=...&summary=1`. The `summary=1` query param returns flag summaries — key, archived, tags, creationDate, and per-env `lastModified` — but excludes `variations`, `fallthrough`, `on`, `offVariation`, and other detail fields.
- `FlagItemSchema` (`packages/core/src/providers/launchdarkly/types.ts`) uses `.passthrough()` on every nested shape, so switching to `summary=0` (full flag objects) won't break the existing Zod parse.
- `PlatformFlag` (`packages/core/src/providers/interface.ts`) has no variation-related fields.
- `PerFlagEnvironmentData` (`packages/core/src/providers/orchestrate.ts`, introduced in #30) carries `status`, `evaluations30d`, `lastRequested`, `lastTouched` per env. No variation state.
- JSON output (`packages/core/src/output/json.ts`) renders the per-env `environments` block from `PerFlagEnvironmentData` plus flag-level metadata (`tags`, `maintainer`, `platformStatus`). No variation data is surfaced anywhere.
- SaaS Piranha (`flag-shark/packages/backend-core/src/processor/cleanup/cleanup-pr-creator.ts`) currently uses a heuristic `inferTerminalState(flagName)` that guesses `treated: true | false` from flag-name patterns. That heuristic is the gap this work closes — but the fix lives on the SaaS side once OSS provides the data.

## 3. Approach

Three additive changes in the existing LD integration paths:

1. **Switch `summary=1` → `summary=0` on the flag-list call.** Same endpoint, same pagination, same Zod schemas (each `.passthrough()`s extra fields). Per-page response grows by ~1-5KB per flag — well within reasonable for the existing paginated flow.
2. **Extract four new fields** in the per-flag loop:
   - `variations` (flag-level)
   - `on`, `fallthroughVariation`, `offVariation` (per env, attached to the same `PlatformFlag` the loop already builds for the configured env).
3. **Surface them in JSON output** — `variations` at top level (via the existing `metadataByFlag` → `StaleFlag` flow), and the three per-env fields inside the `environments` block introduced in #30.

No new endpoints. No new aux fetches. No new signals. Pure data plumbing.

Why not a separate per-flag `/api/v2/flags/{proj}/{key}` aux fetch (option B from brainstorming)? That would mean N flags × N envs = N² round trips, each concurrency-capped, vs. one paginated flag-list call. `summary=0` is the obvious win for an OSS scan that already does four aux fetches per env.

Why include `on` + `offVariation` beyond what the issue asks (option 2 from brainstorming)? LD's `platform-launched` signal fires whether the served variation is the on-fallthrough OR the off-variation. Without `on`, SaaS can't distinguish the two — and would substitute the wrong value for kill-switches where the flag is `on: false` and served via `offVariation`. The issue's narrower scope (`fallthroughVariation` only) is sufficient for "feature flag rolled out" cleanup but leaves kill-switch cleanup ambiguous. Closing both gaps in one PR is strictly additive on OSS.

## 4. Data extraction (`launchdarkly/client.ts` + `types.ts`)

### URL parameter change

In the existing `buildFirstPath` (or wherever the flag-list URL is constructed), replace `summary: '1'` with `summary: '0'`:

```ts
const params = new URLSearchParams({
  env: environment,
  limit: '100',
  offset: '0',
  summary: '0',   // CHANGED — was '1'; need full flag objects for variations + fallthrough
})
```

### Zod schema extensions (`types.ts`)

The existing `FlagItemSchema` and `EnvironmentSchema` extend with the new fields. `.passthrough()` is preserved on every level so further unrelated fields LD adds don't break parsing.

```ts
const VariationSchema = z.object({
  value: z.unknown(),
  name: z.string().optional(),
}).passthrough()

const FallthroughSchema = z.object({
  // 100% rollout: { variation: <index> }
  variation: z.number().optional(),
  // Split rollout: { rollout: { variations: [...] } }. We only care
  // about the absence of `variation` here; rollout's shape is opaque
  // for our purposes (SaaS fails closed on any non-100% fallthrough).
  rollout: z.unknown().optional(),
}).passthrough()

const EnvironmentSchema = z.object({
  lastModified: z.number().optional(),
  on: z.boolean().optional(),
  fallthrough: FallthroughSchema.optional(),
  offVariation: z.number().optional(),
}).passthrough()

const FlagItemSchema = z.object({
  // ...existing fields unchanged...
  variations: z.array(VariationSchema).optional(),
  environments: z.record(z.string(), EnvironmentSchema).optional(),
}).passthrough()
```

### Per-flag extraction (`client.ts`)

In the existing `for (const item of parsed.items) { out.push({ ... }) }` loop, populate the new fields directly:

```ts
out.push({
  key: item.key,
  archived: item.archived,
  lastModified: envData?.lastModified != null ? new Date(envData.lastModified) : null,
  permanent: !item.temporary,
  createdAt: item.creationDate != null ? new Date(item.creationDate) : null,
  tags: item.tags,
  maintainer: item.maintainerId,
  // NEW: flag-level variations.
  // - Always an array when summary=0 returns it. Boolean flags have
  //   length=2; multivariate has length>=2. Undefined only if LD
  //   omits the field for some unexpected reason — defensive guard.
  variations: item.variations,
  // NEW: per-env LD configuration state, extracted from the configured env.
  // The orchestrator's per-env loop calls fetchAllFlags once per env,
  // so each call's `envData` is correct for that single env's view.
  on: envData?.on,
  // fallthrough.variation is set for 100% rollouts; absent (or
  // fallthrough.rollout present) means split or unset. Normalize to
  // null in those cases so downstream consumers can distinguish "split
  // rollout, can't substitute" from "unknown".
  fallthroughVariation: envData?.fallthrough?.variation ?? null,
  offVariation: envData?.offVariation,
})
```

## 5. Type additions

### `providers/interface.ts`

```ts
export interface PlatformFlag {
  // ...existing fields unchanged...

  /**
   * Variation definitions for this flag — flag-level (identical across envs).
   * Indexed by the same integer the per-env `fallthroughVariation` and
   * `offVariation` fields point at. SaaS-side cleanup pipelines look up
   * the substitute value via these indices instead of guessing from
   * code-side default arguments.
   */
  variations?: Array<{ value: unknown; name?: string }>

  /**
   * Whether the flag is enabled in the configured env. When false, the
   * flag serves `offVariation` regardless of fallthrough/targeting.
   */
  on?: boolean

  /**
   * Variation index served by fallthrough when no targeting/rule matches
   * AND `on: true`. `null` indicates a split rollout (`fallthrough.rollout`
   * present rather than `fallthrough.variation`) or absent fallthrough —
   * SaaS-side cleanup should fail closed in either case rather than
   * mechanically substituting one variation.
   */
  fallthroughVariation?: number | null

  /**
   * Variation index served when `on: false`. Every active LD flag has one
   * (LD requires it); undefined indicates either an archived flag (no
   * meaningful off state) or an unexpected API response.
   */
  offVariation?: number
}
```

### `providers/orchestrate.ts`

```ts
export interface PerFlagEnvironmentData {
  status?: 'new' | 'active' | 'inactive' | 'launched'
  evaluations30d?: number | null
  lastRequested?: Date | null
  lastTouched?: Date | null
  // NEW: per-env LD configuration. See PlatformFlag for field semantics.
  on?: boolean
  fallthroughVariation?: number | null
  offVariation?: number
}
```

## 6. Orchestrator stitching

`orchestrate.ts` already stitches per-env `PlatformFlag` data into `Map<flagKey, Map<envKey, PerFlagEnvironmentData>>`. Two small changes:

1. Extend the inner `inner.set(env, { ... })` call to copy the three new per-env fields:

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

2. Widen the "skip envs with no enrichment" guard so an env that has only the new fields (not the four originals) isn't incorrectly dropped:

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

3. `metadataByFlag` already carries `tags`, `maintainer`, `status` flag-level. Add `variations` to that flow:

```ts
metadataByFlag.set(flag.key, {
  tags: flag.tags && flag.tags.length > 0 ? flag.tags : undefined,
  maintainer: flag.maintainer,
  status: flag.status,
  variations: flag.variations && flag.variations.length > 0 ? flag.variations : undefined,
})
```

And the `metadataByFlag` value type (currently inline in the `OrchestrateResult` interface) gains the matching field.

## 7. StaleFlag propagation

`StaleFlag` (`packages/core/src/staleness.ts`) gains:

```ts
/**
 * Variation definitions from the platform. Populated when a platform
 * integration is active AND the flag matched. Output formatters surface
 * this so cleanup pipelines can substitute the correct value into code.
 */
variations?: Array<{ value: unknown; name?: string }>
```

`analyzeStaleness` populates it from `platformMetadata` in the same block that copies `tags`, `maintainer`, `platformStatus`:

```ts
if (meta.variations && meta.variations.length > 0) stale.variations = meta.variations
```

## 8. JSON output

### Flag-level (top-level per flag)

`packages/core/src/output/json.ts` — extend the per-flag entry build, immediately after the existing `platformStatus` line:

```ts
...(sf.variations && sf.variations.length > 0 ? { variations: sf.variations } : {}),
```

Output sample:

```json
{
  "name": "personal-access-tokens-kill-switch",
  "platformStatus": "launched",
  "variations": [
    { "value": false, "name": "off" },
    { "value": true,  "name": "on"  }
  ],
  "environments": { ... }
}
```

### Per-env (inside `environments` block)

Extend the existing per-env entry build in the same file:

```ts
{
  ...(data.status != null ? { status: data.status } : {}),
  ...(data.evaluations30d != null ? { evaluations30d: data.evaluations30d } : {}),
  ...(data.lastRequested != null ? { lastRequested: data.lastRequested.toISOString() } : {}),
  ...(data.lastTouched != null ? { lastTouched: data.lastTouched.toISOString() } : {}),
  // NEW per-env fields:
  ...(data.on != null ? { on: data.on } : {}),
  ...(data.fallthroughVariation !== undefined
    ? { fallthroughVariation: data.fallthroughVariation }
    : {}),
  ...(data.offVariation != null ? { offVariation: data.offVariation } : {}),
}
```

**Crucial subtlety:** `fallthroughVariation` uses `!== undefined`, NOT `!= null`. The `null` value is **load-bearing** — it signals "split rollout, can't substitute" to SaaS. Omitting it would be indistinguishable from "field absent" and would cause SaaS to fall back to its heuristic, breaking the whole point of this work. The other two new fields use `!= null` because neither has a meaningful null state.

Output sample:

```json
{
  "production": {
    "status": "launched",
    "evaluations30d": 12000,
    "lastRequested": "2026-05-25T00:00:00.000Z",
    "lastTouched": "2026-04-01T00:00:00.000Z",
    "on": true,
    "fallthroughVariation": 1,
    "offVariation": 0
  },
  "staging": {
    "status": "inactive",
    "on": true,
    "fallthroughVariation": null,
    "offVariation": 0
  }
}
```

### Other formats (text/markdown/CSV/SARIF)

Unchanged. None render structured per-env or per-variation data; the new fields surface only in JSON, which is the SaaS Piranha consumer's contract.

## 9. Tests

### Unit tests

- **`packages/core/test/providers/launchdarkly/client.test.ts`** — extend fixtures to include `variations`, `environments.<env>.on`, `environments.<env>.fallthrough.variation`, and `environments.<env>.offVariation`. New cases:
  - All four fields populated → `PlatformFlag` carries each correctly.
  - `fallthrough.rollout` set (no `fallthrough.variation`) → `fallthroughVariation: null`.
  - `fallthrough` absent → `fallthroughVariation: null`.
  - `summary=0` URL is what gets called (regression check — easy to flip back accidentally).

- **`packages/core/test/providers/orchestrate.test.ts`** — extend the existing "populates environmentsByFlag from per-env enrichment data" test so the listFlagsOverride returns flags with the new fields; assert they appear inside `environmentsByFlag.get(flagKey).get(envKey)`.

- **`packages/core/test/output/json.test.ts`** — three new tests:
  - `variations` top-level field present when populated, omitted when absent.
  - Per-env block carries `on`/`fallthroughVariation`/`offVariation` when set.
  - **`fallthroughVariation: null` is preserved in JSON output** (the load-bearing-null regression test) while `on: undefined` and `offVariation: undefined` are omitted.

- **`packages/core/test/staleness.test.ts`** — extend the existing platformMetadata test to also verify `stale.variations` is populated.

### Live LD integration test

`packages/core/test/providers/launchdarkly/client.live.test.ts` — add assertions to the existing "every flag has the contract fields populated" loop:

```ts
expect(Array.isArray(f.variations)).toBe(true)
expect((f.variations ?? []).length).toBeGreaterThanOrEqual(2)
expect(typeof f.on).toBe('boolean')
expect(typeof f.offVariation).toBe('number')
expect(
  f.fallthroughVariation === null || typeof f.fallthroughVariation === 'number',
).toBe(true)
```

### Coverage gate

The 100%-branch CI gate (the one that caught us on #30) is unforgiving. Every new conditional in `client.ts`, `orchestrate.ts`, `staleness.ts`, and `json.ts` needs tests hitting both sides. The implementation plan will sequence per-task coverage checks rather than discovering gaps at PR time.

## 10. SaaS consumer alignment

The OSS additions here are exactly what the SaaS Piranha pipeline needs to replace its current `inferTerminalState(flagName)` heuristic. Concretely, the SaaS decision logic becomes:

1. Read `environments.<configured-prod-env>` from the OSS JSON output.
2. If `on === false` → substitute `variations[offVariation].value` (kill-switch turned off case).
3. If `on === true` AND `fallthroughVariation` is a number → substitute `variations[fallthroughVariation].value` (100%-rolled-out case).
4. If `on === true` AND `fallthroughVariation === null` → emit `cleanup-needs-review` diagnostic; do not auto-substitute (split rollout case).
5. If multi-env config and envs disagree on the chosen substitute → emit `cleanup-needs-review`; do not auto-substitute.

None of that logic lives in OSS. The OSS contract is: surface the data accurately, preserve `fallthroughVariation: null` literally in JSON, never invent fields the platform didn't return. The SaaS-side cleanup PR (`flag-shark` repo) is the consumer.

## 11. Risk and rollback

- **`summary=0` payload size:** ~1-5KB per flag (estimate; varies with rule count). For a 200-flag project that's ~200KB-1MB across paginated calls — well within reasonable. No specific projection for >1000-flag projects, but the LD list endpoint paginates so memory pressure stays bounded.
- **Schema drift:** `.passthrough()` on every shape means LD adding fields to the response doesn't break us. The risk direction is LD *removing* `variations`, `fallthrough`, or `offVariation` — extremely unlikely; these are documented core fields.
- **Backward compatibility:** all new fields are optional. Existing JSON consumers (the GitHub Action, custom CI scripts) keep working — they just ignore the new keys.
- **Rollback:** revert the four PRs (or the single squashed merge). Reverting flips `summary=0` back to `summary=1`, removes the four new fields from `PlatformFlag`, and removes the JSON additions. No schema migrations.

## 12. Out of scope

- **Cleanup substitution logic.** That's the SaaS Piranha PR; tracked separately. This work just provides the data.
- **Targeting rules and per-user/segment targets** — option C from brainstorming (`hasTargets`/`hasRules` flags). YAGNI: SaaS can defer to `platform-launched`'s 7-day single-variation criterion as a heuristic that a flag is effectively in fallthrough, even with rule definitions present. If the heuristic proves insufficient in practice, we add `hasTargets`/`hasRules` then — but not pre-emptively.
- **Variation `description` and `_id` fields.** YAGNI: SaaS needs the value (for substitution) and the name (for diagnostics). Neither description nor LD's internal `_id` informs the substitution.
- **Multi-platform variation support.** This design commits LD to variation surfacing; other providers (Unleash, Statsig, etc.) will add equivalent fields when added. The interface is named generically (`variations`, not `ldVariations`) so future providers fit without renaming.
- **Caching the new fields.** The existing `packages/core/src/providers/cache.ts` only persists `{key, archived, lastModified}`; variation data is fetched fresh every scan. Caching is out of scope here — and the existing cache TTL (24h) already means scans are mostly cache-hits for non-enrichment data, so the additional fetch overhead from `summary=0` is amortized.
