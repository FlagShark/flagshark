# 🦈 FlagShark

**Find stale feature flags in your codebase.** Free CLI + GitHub Action. Works with 13 languages and 13 flag providers. Zero config.

📚 **Full documentation: [flagshark.com/docs/getting-started/introduction](https://flagshark.com/docs/getting-started/introduction/)**

```bash
npx flagshark scan
```

```
🦈 FlagShark v1.3.0 — scanned 156 files in 2.3s
                       (47 excluded via .flagsharkignore + test-files preset)

Detected providers: LaunchDarkly (Node SDK), Unleash, PostHog
Found 23 feature flags · 7 stale · health 70/100 ⚠️

┌──────────────────┬────────────────────────┬───────────────┬──────────────────────────────┐
│ Flag             │ File                   │ Added         │ Signal                       │
├──────────────────┼────────────────────────┼───────────────┼──────────────────────────────┤
│ CHECKOUT_V2      │ src/checkout.ts:47     │ 14 months ago │ age                          │
│ NEW_NAV          │ src/layout.tsx:12      │ 8 months ago  │ age, low-usage               │
│ BETA_SEARCH      │ src/search.ts:91       │ 11 months ago │ low-usage                    │
└──────────────────┴────────────────────────┴───────────────┴──────────────────────────────┘

Exit code: 1 (stale flags found)
```

## Why FlagShark

**Feature flags accumulate.** Most teams have dozens of flags that shipped a release ago and never got cleaned up. Cleanup is manual, easy to skip, and nobody owns it. Flag-management platforms make it easy to *add* flags; they don't make it easy to *find* the ones you forgot.

- **Zero install, zero config.** `npx flagshark scan` runs on any repo today. No `.flagshark.yml` required.
- **Polyglot.** 13 languages out of the box — including the awkward monorepo where half is TS and half is Go.
- **Provider-aware.** Auto-detects 13 flag SDKs (LaunchDarkly, Unleash, Statsig, PostHog, Flagsmith, GrowthBook, ConfigCat, Split.io, Flipt, DevCycle, Eppo, Optimizely, plus generic patterns). No custom rules to maintain.
- **AST-based detection** for TypeScript, JavaScript, Go, and Python via [tree-sitter](https://tree-sitter.github.io/). Flag names inside strings, comments, error messages, and unrelated calls aren't false positives.
- **Two staleness signals.** `git blame` age + single-file usage. Both run automatically — no setup.
- **Open source, MIT licensed.** No account, no token, no telemetry.

## Install

```bash
# Run without installing — recommended
npx flagshark scan

# Or install globally
npm install -g flagshark
```

Building a tool on top of the engine? Use [`@flagshark/core`](https://www.npmjs.com/package/@flagshark/core) directly.

## GitHub Action

Add to your workflow — runs on every PR and posts a comment with stale flags:

```yaml
name: FlagShark
on: [pull_request]

permissions:
  contents: read
  pull-requests: write

jobs:
  flagshark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for git blame (staleness) and changed-file scanning
      - uses: FlagShark/flagshark@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Action inputs

| Input | Default | Description |
|-------|---------|-------------|
| `scan` | `changed` | `changed` (PR files only — fast) or `full` (entire repo — full health score) |
| `threshold` | `30` | Staleness threshold in days |
| `fail-threshold` | `0` | Fail the check if health drops below this score (0 = never fail) |
| `output-format` | `markdown` | PR comment format: `markdown` or `none` |
| `sarif` | (unset) | Write SARIF v2.1.0 to this path — pair with `codeql-action/upload-sarif` |

### PR comment

> ### 🦈 FlagShark found 3 stale flags
>
> | Flag | File | Added | Signal |
> |------|------|-------|--------|
> | `CHECKOUT_V2` | src/checkout.ts:47 | 14 months ago | age |
> | `NEW_NAV` | src/layout.tsx:12 | 8 months ago | age, low-usage |
>
> **Flag Health:** 70/100

A GitHub status check is also set, which can block merge if `fail-threshold` is configured.

### Upload to GitHub Code Scanning (Security tab)

Set the `sarif:` input and chain `codeql-action/upload-sarif`:

```yaml
- uses: FlagShark/flagshark@v1
  with:
    sarif: flagshark.sarif
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: flagshark.sarif
```

Stale flags now appear in your repo's **Security → Code Scanning** tab — same UX as CodeQL or ESLint with SARIF output.

## Configuration

FlagShark works with zero configuration. When you want more control, two files compose:

### `.flagsharkignore` — skip files entirely

Drop a `.flagsharkignore` at your repo root. Same syntax as `.gitignore`:

```gitignore
# Skip the examples directory entirely
examples/
demo/

# Skip test files across the polyglot codebase
**/*.test.ts
**/*_test.go
**/test_*.py

# But still scan the one important test file
!examples/important-flag-test.ts
```

### `.flagshark.yml` — full config

```yaml
threshold: 30                    # Staleness threshold in days

excludes:                        # Files NOT scanned (input filter)
  paths:
    - 'examples/**'
    - 'e2e/**'
  files:
    - '**/*.test.ts'
  presets:
    - test-files                 # See "Built-in presets" below
    - snapshots

suppress:                        # Flags hidden from results (output filter)
  flags:
    - 'INTERNAL_DEBUG_*'         # glob — keep this flag out of reports forever
    - 'PERMANENT_KILLSWITCH'

paths:                           # Per-path threshold overrides
  - match: 'src/critical/**'
    threshold: 90                # stricter for critical code (days)
  - match: 'src/experimental/**'
    threshold: 365               # looser for experiments (days)
```

The unconditional baseline — `node_modules`, `.git`, `dist`, `build`, `coverage`, `__pycache__`, `vendor`, `.next`, `.turbo` — is always skipped. You don't need to repeat those.

### Built-in presets

Opt-in via `excludes.presets`. Each preset expands to a curated list of common patterns:

| Preset | Covers |
|---|---|
| `test-files` | `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*Test.java`, `*_spec.rb`, `*Test.cs`, `__tests__/**`, etc. |
| `snapshots` | `*.snap`, `__snapshots__/**` |
| `examples` | `examples/**`, `demo/**` |
| `stories` | `*.stories.{ts,tsx,js,jsx}` (Storybook) |
| `fixtures` | `__fixtures__/**`, `fixtures/**` |
| `generated` | `*.generated.{ts,js}`, `*.gen.go`, `generated/**` |

## Platform integration (cross-reference against your flag platform)

FlagShark can cross-reference detected flag keys against your flag-management platform's API to surface two extra signals:

- **`missing-in-platform`** — flag is referenced in code but doesn't exist in the platform → production-risk bug (SDK falls back to defaults)
- **`archived-in-platform`** — flag exists but is archived → safe to remove

### LaunchDarkly setup

1. Create a read-only API access token in LaunchDarkly: Account settings → Authorization → Access tokens. Recommended permissions: `flag:read` on the project + environment you'll scan.

2. Add to `.flagshark.yml`:

    ```yaml
    platforms:
      launchdarkly:
        project: my-project-key
        environment: production
    ```

3. Export the token (CI: secrets; local: shell env or `.envrc`):

    ```bash
    export LAUNCHDARKLY_API_TOKEN="api-..."
    ```

4. Run `flagshark scan`. The result now includes platform signals.

### Behavior on errors

If the LaunchDarkly API is unreachable, the token is missing, or the request fails, the scan continues with **code-only signals** and prints a warning. Platform integration is strictly additive — it never makes a scan worse.

### Caching

Platform flag lists are cached locally for 24h at `$XDG_CACHE_HOME/flagshark/` (default `~/.cache/flagshark/`). Pass `--no-cache` to force a fresh fetch.

### GitHub Action inputs

| Input | Default | Description |
|---|---|---|
| `no-cache` | `false` | Skip the platform-flag cache |
| `fail-on-error` | `true` | Fail the build on any `missing-in-platform` flag |

## CLI reference

```bash
flagshark scan [options]

Scan options:
  --diff <ref>             Only scan files changed since this git ref (e.g. main, HEAD~1)
  --threshold <days>       Staleness age threshold (default: 30, or config.threshold)
  --verbose                Show all stale flags + effective exclude rules

Output:
  --json                   Emit JSON to stdout (stable schema for tooling — see note below)

Configuration:
  --config <path>          Use this config file (overrides .flagshark.yml discovery)
  --no-config              Skip .flagshark.yml discovery
  --no-ignore-file         Skip .flagsharkignore discovery
  --show-excluded          List excluded files in the output

Platform:
  --no-cache               Skip the local platform-flag cache (force fresh API fetch)
  --fail-on-error          Exit code 1 if any missing-in-platform flags are found
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No stale flags found |
| 1 | Stale flags detected |
| 2 | Runtime or configuration error |

### JSON output — two superficially-similar count fields

The JSON output exposes two fields whose names sound alike but mean very different things. They are NOT interchangeable:

| Field | What it counts |
|---|---|
| `errorCount` | Stale flags carrying an **error-severity signal** (e.g. `missing-in-platform` — flag is referenced in code but not in the flag platform). Drives the CI gate when `--fail-on-error` is set. |
| `parseErrorCount` | Source **files** where the parser failed (tree-sitter abort, syntax error, etc.). Surfaced so a quarter of your repo can't silently get skipped. |

`errorCount` is about flag-level signals; `parseErrorCount` is about whether the file made it through the parser at all. CI scripts that gate on "any errors" usually want `errorCount`; observability dashboards usually want `parseErrorCount` to spot tree-sitter / language-coverage drift.

Each entry in `flags[]` also carries a `confidence` field — see the "Detection confidence tiers" section below for what `high` / `medium` / `low` mean and which to auto-merge.

## Supported languages

| Language | Extensions | Detection |
|----------|-----------|-----------|
| TypeScript | `.ts`, `.tsx` | AST (tree-sitter) |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | AST (tree-sitter) |
| Go | `.go` | AST (tree-sitter) |
| Python | `.py` | AST (tree-sitter) |
| Java | `.java` | Regex |
| Kotlin | `.kt` | Regex |
| Swift | `.swift` | Regex |
| Ruby | `.rb` | Regex |
| C# | `.cs` | Regex |
| PHP | `.php` | Regex |
| Rust | `.rs` | Regex |
| C / C++ | `.c`, `.cpp`, `.h`, `.hpp` | Regex |
| Objective-C | `.m` | Regex |

Remaining languages migrate to AST detection in future tiers ([roadmap](docs/superpowers/specs/2026-05-11-tree-sitter-detection-engine-design.md#4-tier-rollout)).

## Supported providers

Auto-detected from imports — no configuration needed:

LaunchDarkly · Unleash · Flipt · Split.io · PostHog · Flagsmith · ConfigCat · Statsig · GrowthBook · DevCycle · Eppo · Optimizely · Custom flag implementations

## How detection works

FlagShark only scans files that actually import a flag SDK. A function called `isEnabled()` in a file that doesn't import LaunchDarkly/Unleash/etc. won't be flagged. This prevents false positives.

For tier-1 languages (TS, JS, Go, Python), detection uses tree-sitter to parse the file into a real AST. That eliminates the entire category of false positives where regex would match flag-shaped strings inside comments, string literals, or unrelated identifier paths. It also handles multi-line calls and resolves const-bound flag keys (`const FLAG = 'X'; client.variation(FLAG, ...)`) in TS/JS.

For the remaining 9 languages, regex-based detection is used today. Each language migrates to tree-sitter in future minor releases (no breaking changes).

## How staleness works

A flag is marked stale if **any** signal fires:

1. **`age`** — `git blame` shows the flag's line was last modified more than `threshold` days ago (configurable per-path).
2. **`low-usage`** — The flag name appears in only one file across the repo, suggesting a completed rollout.

## Detection confidence tiers

The JSON output tags every detected flag with a `confidence` field that tells you how strict the gate that matched it was:

| Tier | What it means | When to auto-merge cleanup PRs |
|---|---|---|
| `high` | File statically imports the SDK and the method call matches the provider's declared shape. False positives are very rare. | Safe to auto-merge in most pipelines. |
| `medium` | The SDK wasn't statically imported but a runtime-load symbol (`window.posthog.X(`, etc.) was present — see "Runtime-loaded SDKs" below. Likely real, slightly wider gate. | Route through manual review; don't auto-merge by default. |
| `low` | Detected via a user-declared `custom_detectors` regex (see "Custom detectors" below). Heuristic match. | Always review by hand. |

Cleanup PR pipelines should gate on `confidence === 'high'` for auto-merge and surface lower tiers for review.

## Runtime-loaded SDKs

Some codebases load the flag SDK from a `<script>` tag rather than `import`-ing it. PostHog's canonical snippet attaches the SDK to `window.posthog`; n8n's editor-ui and PostHog's own dashboard work this way. Consumer files contain `window.posthog.isFeatureEnabled('flag')` but never `import 'posthog-js'`.

FlagShark detects this automatically via per-provider runtime-symbol patterns. PostHog's TypeScript provider, for example, matches `window.posthog.`, `posthog.isFeatureEnabled(`, `posthog.getFeatureFlag(`, and `posthog.getFeatureFlagPayload(`. Matches go through the same flag-key extraction as static-import detection, but the resulting flags are tagged `confidence: 'medium'` so downstream tooling can route them appropriately.

This is bypass-only — files with neither a static import nor a runtime-symbol match still get skipped, so the precision floor stays intact.

## Custom detectors (config-struct flag systems)

Some codebases don't use a flag SDK at all. Mattermost-shape Go code, for example, uses a typed config struct: `if server.Config().FeatureFlags.EnableX { ... }`. There's no SDK call to match.

Declare an access pattern in `.flagshark.yml` and FlagShark will scan for it:

```yaml
custom_detectors:
  - type: struct-field-access
    language: go
    access_pattern: '\.FeatureFlags\.([A-Z]\w+)'
    name: "Internal feature-flag config"   # optional
```

The capture group `([A-Z]\w+)` is the flag name. Each match becomes a detected flag with `confidence: 'low'` (you opted in; precision is your call). The detector only runs against files of the declared language — same regex in a `.ts` file is ignored when `language: go` is declared.

## Known limitations

FlagShark trades recall for precision by default — when it reports a flag, the flag is real. A few real-world patterns currently get **under**-counted:

- **Runtime-loaded SDKs we don't yet have built-in coverage for.** PostHog has runtime-symbol patterns shipped; LaunchDarkly's `window.LDClient` snippet, Statsig's `window.statsig.client`, etc. don't have them yet. Workaround: drop a thin module that does `import 'launchdarkly-js-client-sdk'` (or equivalent) for its side effects; transitive wrapper detection covers the rest.
- **TypeScript path aliases that don't follow `tsconfig.json` compilerOptions.paths.** Aliases declared via the standard `paths` config ARE resolved (as of B1). Aliases via Vite/webpack aliasing without a matching tsconfig entry, or `extends`-chained tsconfigs, may still under-count.
- **Auto-discovery of config-struct flags.** The `custom_detectors` escape hatch above covers the explicit case. We deliberately don't auto-discover (every codebase invents its own struct shape; chasing all of them doesn't scale). See [docs/superpowers/specs/2026-05-24-static-config-flag-detection.md](docs/superpowers/specs/2026-05-24-static-config-flag-detection.md) for the design discussion.

Detection precision in tree-sitter mode is high — the gate is the recall ceiling, not noise. If you see a result that looks wrong in the other direction (false positive), [open an issue](https://github.com/FlagShark/flagshark/issues) with the source snippet.

## Library usage

Building your own tool on top of FlagShark? The engine ships as a separate package:

```ts
import { scanRepo } from '@flagshark/core'

const result = await scanRepo({
  cwd: process.cwd(),
  threshold: 30,
})

console.log(`${result.totalFlags} flags, ${result.staleFlags.length} stale`)
```

See [`@flagshark/core`](packages/core/README.md) for the full API including custom providers and lower-level primitives. If you're **bundling** `@flagshark/core` into a Lambda, container, or edge function, the [Bundling and WASM resolution](packages/core/README.md#bundling-and-wasm-resolution) section covers the three deployment shapes (Node + external grammars, flattened-WASM-dir, non-Node target) and which one you want.

## License

MIT
