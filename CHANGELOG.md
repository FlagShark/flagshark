# Changelog

## v2.5.0 — C# and PHP join tier-1: AST (tree-sitter) detection

- **New: C# and PHP use tree-sitter (AST) detection by default**, joining TypeScript, JavaScript, Go, Python, and Java. Tier-1 is now **seven** languages; the remaining six stay on regex.
- Same precision win: flag-shaped text in comments and string literals no longer false-positives, and method calls are matched structurally (`client.BoolVariation(...)` in C#, `$client->variation(...)` in PHP).
- Engine internals: the shared query runner now unwraps C#/PHP `argument` nodes and recognizes PHP `encapsed_string` literals, so both languages reuse the same generic AST pipeline.
- The GitHub Action bundles the C# and PHP grammars (`tree-sitter-c_sharp.wasm`, `tree-sitter-php.wasm`) and queries, so `.cs`/`.php` detection runs with no extra setup.
- Backward compatible and additive: existing C#/PHP consumers see fewer false positives, not fewer real detections. Const-bound flag keys are not yet resolved for these languages (a later tier).

## v2.4.0 — Java joins tier-1: AST (tree-sitter) detection

- **New: Java uses tree-sitter (AST) detection by default.** Java moves from regex to a real syntax tree, the same engine as TypeScript, JavaScript, Go, and Python. Flag-shaped text in comments and string literals no longer false-positives, and multi-line `client.boolVariation(...)` calls are detected reliably. Tier-1 is now **five** languages; the remaining eight stay on regex (migrating in future minor releases).
- The GitHub Action bundles the Java grammar (`tree-sitter-java.wasm`) and query, so `.java` detection runs with no extra setup.
- Backward compatible and additive: existing Java consumers see strictly **fewer false positives**, not fewer real detections. Const-bound flag keys (`static final String FLAG = "x"`) are not yet resolved for Java — that follows in a later tier, same as the other newly-migrated languages.

## v2.3.2 — Republish fix: CLI now actually depends on @flagshark/core@2.3.x

- **Hotfix:** `flagshark@2.3.0` and `flagshark@2.3.1` shipped depending on `@flagshark/core@2.2.1` — `bun install` against a pre-existing lockfile treats a workspace `version` bump as a no-op and leaves the lockfile's `workspaces` section pinned to the previous release, which `bun pm pack` then reads when rewriting `workspace:*`. As a result, every CLI feature added since v2.2.1 (multi-env, variation-aware cleanup, code-references cross-check, the v2.3.1 LaunchDarkly React Web SDK detection + token preflight) was unreachable via `npx flagshark@latest scan`. Republished with a corrected lockfile so `npx flagshark@latest` now actually runs the current detection engine.
- **Tooling:** `scripts/bump-version.sh` now deletes `bun.lock` before reinstalling and verifies the `workspaces` section reports the new version. A new lockstep test asserts that `bun.lock` workspaces metadata matches `package.json` so this class of bug fails CI on the next bump instead of shipping silently.

## v2.3.1 — LaunchDarkly React Web SDK v4 + clearer 401s

- **Fix: detect `@launchdarkly/react-sdk` (the current React Web SDK).** LaunchDarkly's React SDK is now published under a new package name (`@launchdarkly/react-sdk`, v4+) with a new typed-hook surface. Projects on this package were returning "No feature flags detected" because the detector only matched the older `@launchdarkly/react-client-sdk`. Now detects the new package plus its full hook surface: `useBoolVariation`, `useStringVariation`, `useNumberVariation`, `useJsonVariation`, and the matching `*Detail` variants. Old `@launchdarkly/react-client-sdk` + `useFlag` / `useFlags` keeps working.
- **New: token-shape preflight for LaunchDarkly.** When `LAUNCHDARKLY_API_TOKEN` looks like an SDK key (`sdk-…`) or mobile key (`mob-…`) instead of an API access token (`api-…`), FlagShark now emits a pointed warning up-front instead of leaving users to guess from the eventual 401. The 401 hint itself is also smarter: if the token shape already looks correct, it steers toward project key vs. display name (the next-most-likely cause) rather than repeating the SDK-key advice.

## v2.3.0 — LaunchDarkly integration: multi-env, variation-aware, code-refs cross-check

- **New: multi-environment cross-check.** Configure `environments: [production, staging, test]` (or keep the legacy single-`environment` form) and FlagShark cross-references each flag against every configured env. Signals carry env attribution: `launched in production`, `inactive everywhere`, `zero evaluations in staging`. A flag has to be stale in EVERY env to be a cleanup candidate — mid-rollout flags (`launched` in one env, still `active` in another) get surfaced for human review instead of bad mechanical substitution.
- **New: variation-aware data in JSON output.** Each flag carries its `variations` array (the declared `{ value, name? }` entries), plus per-env `on` / `fallthroughVariation` / `offVariation`. This is what downstream cleanup pipelines (SaaS Piranha) need to substitute the correct value when removing a flag from code — replaces today's heuristic that guesses `treated: true | false` from flag-name patterns. `fallthroughVariation: null` is load-bearing in JSON output: it signals a split rollout where SaaS should fail-closed, distinct from the field being absent.
- **New: code-references cross-check.** When LD's `ld-find-code-refs` feature reports more references for a flag than FlagShark detected, emits a new `coverage-gap-vs-platform` info signal (info severity — surfaces detector blind spots without making a flag stale). When LD's code-refs feature isn't configured for the project, the scan logs a one-line advisory pointing at LD's setup docs.
- New: top-level `variations`, `environments`, and `codeReferences` fields on each flag in JSON output. All optional and additive.
- Backward compatibility: all new fields are optional. Single-env users see no behavior change. Existing JSON consumers ignore unknown keys. Legacy `environment: 'prod'` config still accepted and equivalent to `environments: [prod]`.

## v2.2.1 — Workspace dep fix

- **Fix:** the CLI's `package.json` now declares its `@flagshark/core` dependency as `workspace:*`. The previous literal-pin variant caused a silent regression where v2.1.0 and v2.2.0 of the CLI shipped pointing at older `@flagshark/core` versions. Lockstep behavior is now also asserted in CI (see #28).

## v2.2.0 — Audit-log untouched signal + test-only files + verbose mode

- **New: `platform-untouched-stale` (warning)** — LaunchDarkly's audit log confirms zero activity (no toggles, no edit, no targeting changes) for the flag within the lookback window (default 90 days). Catches flags that are functionally abandoned even when evaluation telemetry is unreliable or unavailable.
- **New: `test-only-references` signal** — every detected occurrence of the flag is in a test file. Production code no longer uses it; the tests are the last thing keeping the flag alive. Pairs with `age` and platform signals to qualify for cleanup.
- **New: `--verbose` rich output** — verbose mode now shows per-flag detail cards with the full signal description (not truncated), platform metadata (tags / maintainer / status), env attribution, and detection confidence. Structured so you can grep it. The default non-verbose table stays compact.

## v2.1.1 — Evaluation signals + low-usage policy fix

- **New: `platform-zero-evaluations` (error)** — LD reports zero evaluations recorded for the flag in the last 30 days. Real runtime data, not a heuristic — strongest possible stale signal because it confirms the code path is actually unused.
- **New: `platform-low-evaluations` (warning)** — LD reports evaluations below a configured threshold (default 10/30d). Set higher for high-traffic prod environments.
- **Fix: `low-usage` is now contributing-only.** A flag that has only `low-usage` as its signal is no longer marked stale on its own — it must pair with another signal (e.g. age or a platform-side verdict) to qualify. Avoids a category of false positives where a flag appearing in only one file just meant the rollout was always scoped narrowly, not that it's done.

## v2.1.0 — Wrapper-aware detection + runtime-loaded SDKs + deep LaunchDarkly

- **New: wrapper-aware detection.** FlagShark now traces transitive imports. If `lib/wrapper.ts` imports `launchdarkly-js-client-sdk` and `src/page.tsx` imports `lib/wrapper.ts`, calls in `page.tsx` get detected. Closes the gap where teams had wrapped their flag SDK in a thin internal library and FlagShark missed every call.
- **New: runtime-loaded SDK support.** Some SDKs attach to a global (`window.posthog`) rather than via `import`. FlagShark now detects `window.posthog.isFeatureEnabled(...)` and equivalent patterns. Matches are tagged `confidence: medium` so cleanup pipelines can route them to manual review.
- **New: `custom_detectors` config.** Codebases with their own typed flag system (Mattermost-shape `server.Config().FeatureFlags.EnableX`) declare an access pattern in `.flagshark.yml` and FlagShark scans for it. Matches are tagged `confidence: low` — you opted in; precision is your call.
- **New: confidence tier on every detected flag** (`high` / `medium` / `low`). Surfaces in JSON output via the `confidence` field. Cleanup PR pipelines should gate auto-merge on `confidence === 'high'`.
- **New: React SDK detection patterns** for LaunchDarkly's React provider — handles `useFlags()`, `useFlag()`, and the wrapper hook shapes.
- **New: deep LaunchDarkly integration.** `platform-too-old`, `platform-inactive`, `platform-launched`, `platform-permanent` signals derived from LD's flag-statuses and flag-list endpoints, plus per-flag tags and maintainer name surfacing.

## v2.0.0 — Staleness threshold in days (BREAKING)

- **BREAKING:** Staleness threshold is now measured in DAYS (was months). Default changed from 6 months to 30 days.
- **BREAKING:** `StalenessOptions.thresholdMonths` renamed to `thresholdDays`.
- The `--threshold` CLI flag, the `threshold` Action input, and the `threshold` / per-path `threshold` config values now all mean **days**.
- The internal age formula dropped the `30.44` days-per-month conversion; thresholds are now an exact `days * 24h` window.
- **Migration:** existing `.flagshark.yml` `threshold:` values now mean days — multiply your old month value by ~30 to keep the same behavior (e.g. `threshold: 6` → `threshold: 180`). Likewise update `--threshold` and the Action `threshold` input, and rename any `analyzeStaleness({ thresholdMonths })` calls to `thresholdDays`.

## v1.4.0 — Platform integration (LaunchDarkly)

- New: cross-reference detected flag keys against LaunchDarkly's API
- New: signals `missing-in-platform` (error) and `archived-in-platform` (warning)
- New: `severity` field on `StalenessSignal` (additive — existing JSON consumers unaffected)
- New: `--no-cache` and `--fail-on-error` CLI flags
- New: `no-cache` and `fail-on-error` Action inputs
- New: `errorCount` field on JSON output; `error-count` Action output
- Pluggable: `platforms:` block in `.flagshark.yml` supports a registry of platform providers; adding Unleash / Statsig / etc. is a 3-file PR
