# 🦈 flagshark

**Find stale feature flags in your codebase.** Polyglot CLI + GitHub Action. 13 languages, 13 providers, zero config.

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

- **Zero install, zero config.** `npx flagshark scan` works on any repo today.
- **Polyglot.** TypeScript, JavaScript, Go, Python, Java, Kotlin, Swift, Ruby, C#, PHP, Rust, C/C++, Objective-C.
- **Provider-aware.** Auto-detects 13 flag SDKs — no custom rules to maintain.
- **AST-based detection** for TS/JS/Go/Python via [tree-sitter](https://tree-sitter.github.io/). Flag names inside strings, comments, and unrelated calls aren't false positives.
- **Two staleness signals** — `git blame` age + single-file usage. Both run automatically.
- **MIT licensed.** No account, no token, no telemetry.

## Install

```bash
# Recommended — run without installing
npx flagshark scan

# Or globally
npm install -g flagshark
```

## CLI

```bash
flagshark scan [options]

Scan options:
  --diff <ref>             Only scan files changed since this git ref (e.g. main, HEAD~1)
  --threshold <days>       Staleness age threshold (default: 30, or config.threshold)
  --verbose                Show all stale flags + effective exclude rules

Output:
  --json                   Emit JSON to stdout (stable schema for tooling)

Configuration:
  --config <path>          Use this config file (overrides .flagshark.yml discovery)
  --no-config              Skip .flagshark.yml discovery
  --no-ignore-file         Skip .flagsharkignore discovery
  --show-excluded          List excluded files in the output
```

Example invocations:

```bash
# Scan current directory, default 30-day threshold
flagshark scan

# Scan only files changed since main
flagshark scan --diff main

# Stricter threshold + JSON for piping
flagshark scan --threshold 7 --json | jq '.staleFlags'

# Use a custom config file
flagshark scan --config ./tooling/flagshark.yml
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No stale flags found |
| 1 | Stale flags detected |
| 2 | Runtime or configuration error |

## Configuration

FlagShark is zero-config by default. When you want more control, two files compose:

### `.flagsharkignore` — skip files entirely

Drop a `.flagsharkignore` at your repo root. Same syntax as `.gitignore`:

```gitignore
examples/
**/*.test.ts
**/*_test.go
**/test_*.py
!examples/important-flag-test.ts   # Re-include with `!`
```

### `.flagshark.yml` — full config

```yaml
threshold: 30

excludes:
  paths:
    - 'examples/**'
  files:
    - '**/*.test.ts'
  presets:
    - test-files                 # Curated bundles — see table below
    - snapshots

suppress:
  flags:
    - 'INTERNAL_DEBUG_*'         # Don't report these flag names
    - 'PERMANENT_KILLSWITCH'

paths:                           # Per-path threshold overrides
  - match: 'src/critical/**'
    threshold: 90                # stricter for critical code (days)
  - match: 'src/experimental/**'
    threshold: 365               # looser for experiments (days)
```

The unconditional baseline — `node_modules`, `.git`, `dist`, `build`, `coverage`, `__pycache__`, `vendor`, `.next`, `.turbo` — is always skipped.

### Built-in presets

| Preset | Covers |
|---|---|
| `test-files` | `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*Test.java`, `*_spec.rb`, `__tests__/**`, etc. |
| `snapshots` | `*.snap`, `__snapshots__/**` |
| `examples` | `examples/**`, `demo/**` |
| `stories` | `*.stories.{ts,tsx,js,jsx}` (Storybook) |
| `fixtures` | `__fixtures__/**`, `fixtures/**` |
| `generated` | `*.generated.{ts,js}`, `*.gen.go`, `generated/**` |

## GitHub Action

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
          fetch-depth: 0
      - uses: FlagShark/flagshark@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

See the [main repo README](https://github.com/FlagShark/flagshark) for action inputs and full docs.

## Library usage

Building a tool on top of the engine? Use [`@flagshark/core`](https://www.npmjs.com/package/@flagshark/core) directly:

```ts
import { scanRepo } from '@flagshark/core'

const result = await scanRepo({ cwd: process.cwd(), threshold: 30 })
console.log(`${result.staleFlags.length} stale of ${result.totalFlags}`)
```

## License

MIT
