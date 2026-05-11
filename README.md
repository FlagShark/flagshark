# 🦈 FlagShark

**Find stale feature flags in your codebase.** Free CLI + GitHub Action. Works with 13 languages and 13 flag providers. Zero config.

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
| `threshold` | `6` | Staleness threshold in months |
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
threshold: 6                     # Staleness threshold in months

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
    threshold: 3                 # stricter for critical code
  - match: 'src/experimental/**'
    threshold: 12                # looser for experiments
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

## CLI reference

```bash
flagshark scan [options]

Scan options:
  --diff <ref>             Only scan files changed since this git ref (e.g. main, HEAD~1)
  --threshold <months>     Staleness age threshold (default: 6, or config.threshold)
  --verbose                Show all stale flags + effective exclude rules

Output:
  --json                   Emit JSON to stdout (stable schema for tooling)

Configuration:
  --config <path>          Use this config file (overrides .flagshark.yml discovery)
  --no-config              Skip .flagshark.yml discovery
  --no-ignore-file         Skip .flagsharkignore discovery
  --show-excluded          List excluded files in the output
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No stale flags found |
| 1 | Stale flags detected |
| 2 | Runtime or configuration error |

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

1. **`age`** — `git blame` shows the flag's line was last modified more than `threshold` months ago (configurable per-path).
2. **`low-usage`** — The flag name appears in only one file across the repo, suggesting a completed rollout.

## Library usage

Building your own tool on top of FlagShark? The engine ships as a separate package:

```ts
import { scanRepo } from '@flagshark/core'

const result = await scanRepo({
  cwd: process.cwd(),
  threshold: 6,
})

console.log(`${result.totalFlags} flags, ${result.staleFlags.length} stale`)
```

See [`@flagshark/core`](packages/core/README.md) for the full API including custom providers and lower-level primitives.

## License

MIT
