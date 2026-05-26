# LaunchDarkly Multi-Environment Cross-Check — Design

**Status:** Design / pending implementation plan
**Date:** 2026-05-26
**Issue:** [#30](https://github.com/FlagShark/flagshark/issues/30)
**Scope:** Extend the LaunchDarkly platform integration so a single scan can cross-reference flags against multiple LD environments and emit env-attributed signals.

## 1. Goal

Today FlagShark's LD integration queries a single environment per scan, so every platform-side signal (`platform-inactive`, `platform-launched`, `platform-zero-evaluations`, `platform-untouched-stale`) carries the implicit caveat "in `production`" — and the reviewer has to take it on faith.

The question a cleanup-PR reviewer actually asks is:

> Is this flag stale **everywhere**, or just in test?

A flag that's `launched` in production but `active` in staging is mid-rollout — don't touch it. A flag that's `inactive` in **every** environment is genuinely dead. Today we can't tell the difference. This design closes that gap.

## 2. Today's state

- `launchdarklyConfigSchema` (`packages/core/src/providers/launchdarkly/definition.ts`) takes a single `environment: string`.
- `fetchAllFlags(config)` (`packages/core/src/providers/launchdarkly/client.ts`) fans out four aux fetches all scoped to that one env: flag-statuses, members, evaluations (per-flag, concurrency-capped), audit-log (`spec=proj/{proj}:env/{env}:flag/*`).
- `crossReference()` (`packages/core/src/providers/cross-reference.ts`) emits one of 8 signal types per flag, derived from that one env's data.
- Cache key (`computeCacheKey`) hashes the full config object → naturally invalidates when env list changes.
- Output formatters consume `StaleFlag.signals[]` with no env context.

## 3. Approach

Loop multi-env at the **orchestrate** layer; leave the LD provider unchanged.

Why: the LD provider's `listFlags()` contract is "the flag list as the platform sees it in the configured env." Multi-env is a higher-level concept — the orchestrator instantiates one client per env (the existing `createClient(config, token)` factory takes env as part of `config`), calls `listFlags()` N times, stitches into a per-env map, and hands that to a new-signature `crossReference()`.

This keeps three properties:

1. **Provider untouched.** Zero changes to `launchdarkly/client.ts` in v1. Future providers (Unleash, Statsig, PostHog) get multi-env "for free" from the orchestrator.
2. **Cache layer untouched.** Each env hashes to a distinct cache key already.
3. **Existing single-env users see byte-identical output.** All single-env configs continue to work; their JSON / text / markdown output is unchanged.

The minor cost — re-fetching `/members` once per env — is one extra round-trip; not worth optimizing.

## 4. Config schema

```yaml
platforms:
  launchdarkly:
    project: my-project
    environments: [production, staging, test]    # NEW preferred form
    # environment: production                    # still accepted (single)
```

Updated Zod schema (`packages/core/src/providers/launchdarkly/definition.ts`):

```ts
const launchdarklyConfigSchema = z.object({
  project: z.string(),
  environment: z.string().optional(),
  environments: z.array(z.string()).nonempty().optional(),
  api_base: z.string().url().optional(),
  token_env: z.string().optional(),
}).refine(
  (cfg) => !!cfg.environment !== !!cfg.environments,
  { message: "set exactly one of 'environment' or 'environments'" },
).transform((cfg) => ({
  ...cfg,
  environments: cfg.environments ?? [cfg.environment!],
}))
```

Behavior:

- Exactly one of `environment` / `environments` must be set (XOR via `.refine`).
- After `.transform`, the rest of the codebase sees `environments: string[]` with length ≥ 1.
- Empty arrays rejected by `.nonempty()`.
- No deprecation warning for `environment` — the project is young; we keep both forms in the README with `environments` as the recommended example.

## 5. Orchestrate: loop envs, stitch results

The provider's `listFlags()` signature is unchanged. The new logic lives in `packages/core/src/providers/orchestrate.ts`:

```ts
// Stitched representation: flag key → env key → that env's PlatformFlag.
type PerEnvFlags = Map<string, Map<string, PlatformFlag>>
```

Loop (pseudocode inside `orchestratePlatforms`):

```ts
const envs = parsed.data.environments           // string[], length ≥ 1
const perEnv: PerEnvFlags = new Map()

for (const env of envs) {
  const envConfig = { ...parsed.data, environment: env }
  const client = def.createClient(envConfig, token)
  const cacheKey = computeCacheKey(name, envConfig, token)
  const flags = opts.listFlagsOverride
    ? await opts.listFlagsOverride(opts.signal)
    : await loadPlatformFlagsCached(client, cacheKey, { noCache, signal })

  for (const f of flags) {
    if (!perEnv.has(f.key)) perEnv.set(f.key, new Map())
    perEnv.get(f.key)!.set(env, f)
  }
}

const signals = crossReference(detectedFlags, perEnv, def.displayName, {
  thresholdDays, evaluationThreshold,
})
```

Decisions baked in:

- **Serial, not parallel.** Each env runs to completion before the next. Keeps API budget per-env identical to today; doesn't multiply the existing `EVALUATIONS_CONCURRENCY=5` fan-out across envs. Two envs ≈ 2× wall-clock — acceptable for a CI tool. A `/* parallelize if this becomes painful */` comment marks the knob for future-us.
- **Cache key is per-env naturally.** `computeCacheKey` hashes the full config object; `{ ...cfg, environment: env }` produces a distinct key per env. No cache changes needed.
- **Flag-level fields use first-env-wins.** `archived`, `permanent`, `tags`, `maintainer`, `createdAt` are identical across envs by LD's data model. When we need to surface them at a flag level (e.g. the `archived-in-platform` signal), we read from the first env entry — they'll match.
- **`PlatformFlag` interface gains nothing new.** The per-env data lives only in the orchestrate-level `PerEnvFlags` map and the new `crossReference` parameter. The interface stays simple.

## 6. Cross-reference signal aggregation

New signature:

```ts
export function crossReference(
  detectedFlags: Map<string, FeatureFlag[]>,
  platformFlagsByEnv: PerEnvFlags,           // changed from PlatformFlag[]
  platformDisplayName: string,
  options: CrossReferenceOptions = {},
): Map<string, PlatformSignal[]>
```

Per-signal firing rules:

| Signal | Fires when | Description rendering |
|---|---|---|
| `missing-in-platform` | flag absent from EVERY env's flag list | unchanged |
| `archived-in-platform` | `archived: true` (flag-level, same across envs) | unchanged |
| `platform-permanent` | `permanent: true` (flag-level) | unchanged |
| `platform-too-old` | `createdAt` > threshold (flag-level) | unchanged |
| `platform-launched` | ANY env has `status: 'launched'` | `"launched everywhere"` if all envs agree, else `"launched in <envs>"` |
| `platform-inactive` | ANY env has `status: 'inactive'` AND no env is `'launched'` | `"inactive everywhere"` / `"inactive in <envs>"` |
| `platform-zero-evaluations` | ANY env has `evaluations30d === 0` | `"0 evaluations everywhere over the last 30 days"` / `"0 evaluations in <envs> over the last 30 days"` |
| `platform-low-evaluations` | ANY env has `0 < evaluations30d < threshold` AND no env hits zero | `"only N in <env> (below threshold T)"` (per env when mixed) |
| `platform-untouched-stale` | ALL envs have `lastTouched: null` (audit log fetched successfully in each) | `"no activity in any of <envs> for 90+ days"` |

**Why `platform-untouched-stale` is the lone "ALL envs" exception:** a flag toggled in staging counts as touched — the audit log is the most precise activity signal we have, and the "stale everywhere" rule should apply strictly to it. The other signals are state verdicts that carry env attribution in their description so reviewers can decide.

**Why `platform-inactive` is suppressed when any env is `launched`:** they're contradictory states (no recent evals vs. fully rolled out). The `launched` signal already wins on severity (error vs. warning) and is more actionable; emitting both creates table noise without adding information.

Description helper:

```ts
function fmtEnvs(triggered: string[], all: string[]): string {
  if (triggered.length === all.length) return 'everywhere'
  const ordered = all.filter((e) => triggered.includes(e))   // preserve config-declared order
  return `in ${ordered.join(', ')}`
}
```

Output examples: `"launched everywhere"`, `"launched in production"`, `"inactive in staging, test"`.

**Signal-stacking unchanged.** A single flag can still carry multiple signals (e.g. `platform-launched in production` + `platform-inactive in staging`) — they live side-by-side in the existing `signals: PlatformSignal[]` array.

## 7. Output rendering

### JSON (`output/json.ts`) — the SaaS consumer contract

Add a sibling `environments` block per flag, preserve top-level fields for v1 compat:

```json
{
  "name": "personal-access-tokens-kill-switch",
  "file": "src/auth.ts",
  "line": 42,
  "platformStatus": "launched",
  "environments": {
    "production": {
      "status": "launched",
      "evaluations30d": 12000,
      "lastRequested": "2026-05-25T00:00:00.000Z",
      "lastTouched": "2026-04-01T00:00:00.000Z"
    },
    "staging": {
      "status": "active",
      "evaluations30d": 3,
      "lastRequested": "2026-05-26T00:00:00.000Z",
      "lastTouched": "2026-05-20T00:00:00.000Z"
    }
  },
  "signals": [
    {
      "type": "platform-launched",
      "severity": "error",
      "description": "LaunchDarkly reports this flag has served one variation for 7+ days in production — likely ready for removal"
    }
  ]
}
```

Top-level fields (`platformStatus`, `evaluations30d`-equivalent, `lastTouched`, `lastRequested`) source from `environments[envs[0]]` — the first env in the user's configured list. Single-env configs produce JSON byte-identical to v1.3 below the `environments` block (the new block is the only addition).

### Text (`output/text.ts`) — terminal table

The signal-column cell is currently 28 chars and already ellipsizes long content. Appending env attribution would explode it. Two minimal changes:

1. **Table cell continues to show the signal *type* only** — no layout change.
2. **In `--verbose` mode (per-flag detail card)**, the description prints in full — env attribution appears verbatim under `Signals:`.

Result: non-verbose table output is byte-identical for single-env users; multi-env users see attribution in `--verbose`.

### Markdown (`output/markdown.ts`)

Same rule as text — type in the table cell, full description in the per-flag detail rows where it already appears.

### CSV / SARIF

Unchanged. CSV mirrors the text-table type list; SARIF's `message.text` embeds the full description and inherits env attribution for free.

### `metadataByFlag` in orchestrate.ts

Currently surfaces a single `status` (LD's per-env activity verdict). Multi-env keeps it as the first-env value, matching the JSON top-level rule. The compact second-row text rendering (`platform-status: launched`) stays unchanged. Full per-env breakdown is JSON-only — text stays compact.

## 8. Tests

### Unit tests

```
packages/core/test/providers/
  cross-reference.test.ts            # EXTEND
  orchestrate.test.ts                # EXTEND
  cache.test.ts                      # EXTEND (one assertion)
  launchdarkly/
    definition.test.ts               # EXTEND (config schema)
```

`cross-reference.test.ts` — for each of the 5 env-sensitive signal types, add 4 cases:

1. Single env (regression — current behavior unchanged)
2. All envs agree → `"everywhere"` rendering
3. Mixed envs → `"in <list>"` rendering with config-declared order
4. Per-signal edge cases:
   - `platform-untouched-stale` fires only when ALL envs have `lastTouched: null`
   - `platform-inactive` suppressed when any env is `launched`
   - `platform-low-evaluations` suppressed when any env has zero

`orchestrate.test.ts` — stub `listFlagsOverride` returning distinct `PlatformFlag[]` per env, assert the stitched `PerEnvFlags` shape and end-to-end signal emission with env attribution.

`definition.test.ts` — Zod schema cases:

- Single `environment: 'prod'` → normalizes to `['prod']`
- Array `environments: ['prod', 'staging']` → passes through
- Both set → Zod rejection with the XOR error
- Neither set → Zod rejection
- Empty `environments: []` → rejected by `.nonempty()`

`cache.test.ts` — assert `environments: ['prod']` (array of one) produces a different cache key from `environment: 'prod'` (single), so no cross-config cache hits.

### Output formatter tests

```
packages/core/test/output/
  json.test.ts                       # EXTEND
  text.test.ts                       # regression — single-env snapshot must be byte-identical
  markdown.test.ts                   # same
```

`json.test.ts` — new fixture with 2-env data; assert `environments` block present, top-level fields equal `environments[envs[0]]`.

`text.test.ts` + `markdown.test.ts` — existing single-env snapshots remain byte-identical. (Proves backward compat at the output layer.)

### Live LD integration test

Location: wherever the existing live LD tests live (confirmed during implementation — likely `packages/core/test-live/` or `packages/core/test/integration/launchdarkly.live.test.ts`).

One new case: configure 2 envs against the live LD test project, assert (a) at least one signal carries env attribution, (b) the JSON output has an `environments` block populated for ≥1 flag, (c) the existing single-env live test continues to pass unchanged.

### README

Replace the LD config example with `environments: [...]` as the primary form. Footnote that `environment: '...'` (single) is also accepted.

## 9. SaaS consumer alignment

The sibling SaaS repo (`/Users/joe/projects/flag-shark`) consumes `@flagshark/core` programmatically — it imports `PolyglotAnalyzer` from `packages/core` for file-level flag detection, but does **not** invoke `scanRepo()` and does **not** parse OSS JSON output. The SaaS runs its own LD sync (`lambdas/ld-sync`) against DynamoDB-stored `LDConnection` records and makes its own Piranha cleanup decisions.

This means:

- **Zero SaaS breakage risk from this design.** The SaaS doesn't import `orchestratePlatforms`, `crossReference`, or `PlatformFlag`. All changes here are internal to the OSS provider layer.
- **The SaaS already has a parallel multi-env concept.** `LDConnection.criticalEnvironments: string[]` (in `packages/backend-core/src/processor/ldsync/ld-sync-service.ts`) — same shape, different scope (per-customer, not per-scan). Not in conflict.
- **The SaaS's Piranha cleanup currently uses heuristic terminal-state inference** (`inferTerminalState(flagName)` in `packages/backend-core/src/piranha/terminal-state.ts`). It does not consult OSS platform signals. The eventual shift to OSS-derived signals — gated by `platform-launched` per env, with the fallthrough variation pulled from the correct env — is what issue [#31](https://github.com/FlagShark/flagshark/issues/31) is filed to enable. The per-env structure introduced here (`environments: { [envKey]: { status, evaluations30d, ... } }`) is exactly the data shape that #31's variation-aware cleanup will read.

In short: this design unblocks #31 cleanly. The SaaS doesn't need to change for #30 to ship, but when it does eventually consume OSS signals for cleanup decisions, the JSON shape we're committing to here is the shape it'll want.

## 10. Risk and rollback

**Backward compatibility:** single-env configs (`environment: 'prod'`) produce byte-identical text/markdown/CSV/SARIF output and additive-only JSON (the `environments` block is new; top-level fields unchanged). Existing live tests cover the single-env path as a regression canary.

**API budget:** N envs = N× the existing per-env API calls. Serial execution keeps blast radius constant per env; users opting into N envs are opting into N× wall-clock and N× rate-limit risk. Documented in the README and the comment on the env loop.

**Rollback:** the design is additive at every layer — no signals removed, no JSON fields removed, no config keys removed. Reverting the orchestrate-layer change reverts the whole feature; no schema migrations to undo.

## 11. Out of scope

- **Per-env API tokens.** All envs use the same `token_env`. LD's API tokens are project-scoped, not env-scoped, so this matches the platform's reality.
- **Provider-side multi-env optimizations** (e.g. wildcard audit-log spec `proj/{proj}:env/*:flag/*`). The orchestrate-layer loop costs one extra `/members` round-trip per env; not worth a provider-layer rework. Revisit if multi-env scans become common and the cost becomes painful.
- **The "safe to remove" verdict** as a first-class signal (separate from the per-env `platform-launched` / `platform-zero-evaluations` signals). The signals carry enough info for downstream tools to derive it; emitting a synthesized verdict is a separate UX decision.
- **Multi-env support for non-LD providers.** The orchestrate-layer loop is provider-agnostic and will work for any future provider whose `createClient(config, token)` factory takes env as part of `config`. The signal-aggregation rules in `crossReference` are platform-display-name agnostic too. But this design only commits LD to multi-env; other providers adopt it when they're added.
