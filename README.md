# FlagShark

Find stale feature flags in your codebase. CLI tool + GitHub Action.

```bash
npx flagshark scan
```

```
🦈 FlagShark v1.0.0

Scanned 156 files across 4 languages
Detected providers: LaunchDarkly (JS SDK), Unleash (Go SDK)
Found 23 feature flags, 7 stale

Stale flags:
┌──────────────────┬────────────────────────┬───────────────┬──────────────────────────────┐
│ Flag             │ File                   │ Added         │ Signal                       │
├──────────────────┼────────────────────────┼───────────────┼──────────────────────────────┤
│ CHECKOUT_V2      │ src/checkout.ts:47     │ 14 months ago │ Age > 6 months               │
│ NEW_NAV          │ src/layout.tsx:12      │ 8 months ago  │ Age > 6 months, Single file  │
│ BETA_SEARCH      │ src/search.ts:91      │ 11 months ago │ Single file reference        │
└──────────────────┴────────────────────────┴───────────────┴──────────────────────────────┘

Flag Health Score: 70/100 (7/23 flags are stale)
```

## Install

```bash
# Run without installing
npx flagshark scan

# Or install globally
npm install -g flagshark
```

## CLI Usage

```bash
# Scan current directory
flagshark scan

# JSON output (for piping to other tools)
flagshark scan --json

# Only scan files changed since a git ref
flagshark scan --diff HEAD~1
flagshark scan --diff main

# Custom staleness threshold (default: 6 months)
flagshark scan --threshold 3

# Show all stale flags (default shows top 10)
flagshark scan --verbose
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No stale flags found |
| 1 | Stale flags detected |
| 2 | Runtime error |

## GitHub Action

Add to your workflow:

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
          fetch-depth: 0  # Required for git blame age detection
      - uses: FlagShark/flagshark@v1
```

### Action Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `scan` | `changed` | `changed` (PR files only) or `full` (entire repo) |
| `threshold` | `6` | Staleness threshold in months |
| `fail-threshold` | `0` | Health score below which the check fails (0 = never fail) |

### What the Action does

On every PR, FlagShark comments with a table of stale flags found in the changed files:

> ### 🦈 FlagShark found 3 stale flags
>
> | Flag | File | Added | Signal |
> |------|------|-------|--------|
> | `CHECKOUT_V2` | src/checkout.ts:47 | 14 months ago | Age > 6 months |
> | `NEW_NAV` | src/layout.tsx:12 | 8 months ago | Single file |
>
> **Flag Health:** 70/100

It also sets a GitHub status check that can optionally block merge if health drops below a threshold.

## Supported Languages

FlagShark detects feature flags across 13 languages:

| Language | Extensions |
|----------|-----------|
| TypeScript/JavaScript | .ts, .tsx, .js, .jsx, .mjs, .cjs |
| Go | .go |
| Python | .py |
| Java | .java |
| Kotlin | .kt |
| Swift | .swift |
| Ruby | .rb |
| C# | .cs |
| PHP | .php |
| Rust | .rs |
| C/C++ | .c, .cpp, .h, .hpp |
| Objective-C | .m |

## Supported Providers

Auto-detected from imports (no configuration needed):

- LaunchDarkly
- Unleash
- Flipt
- Split.io
- PostHog
- Flagsmith
- ConfigCat
- Statsig
- GrowthBook
- DevCycle
- Eppo
- Optimizely
- Custom flag implementations

## How Staleness Works

A flag is marked stale if **any** of these signals fires:

1. **Age:** `git blame` shows the flag reference was added more than 6 months ago (configurable with `--threshold`)
2. **Single file:** The flag name appears in only one file across the entire repo, suggesting a completed rollout

FlagShark only checks files that actually import a flag SDK. A function called `isEnabled()` in a file that doesn't import LaunchDarkly/Unleash/etc. won't be flagged. This prevents false positives.

## Configuration

### `.flagsharkignore`

Exclude files or specific flags:

```
# Glob patterns for files
test/**
fixtures/**

# Specific flag names (prefix with flag:)
flag:PERMANENT_ADMIN_OVERRIDE
flag:MAINTENANCE_MODE
```

## License

MIT
