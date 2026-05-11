# Output & Customizability — Design Spec

**Status:** Draft for review
**Date:** 2026-05-11
**Scope:** Make `flagshark scan` more useful and customizable: add a config file, more output formats (SARIF, markdown, CSV), inline suppression, per-path rules, custom providers, a `.flagsharkignore` file, exclusion presets, and a better terminal UX. Companion to the tree-sitter spec.
**Coupled spec:** [2026-05-11-tree-sitter-detection-engine-design.md](./2026-05-11-tree-sitter-detection-engine-design.md) — custom providers in config feed both engines; the new `hardcoded` signal (tier 6) must render correctly in all output formats defined here.
**Tracking issue:** [FlagShark/flagshark#2](https://github.com/FlagShark/flagshark/issues/2) — `.flagsharkignore` + `excludes:` block. Sections §6 and §11 below resolve this issue in full.

---

## 1. Goals

1. **Make output actionable for different audiences.**
   - CLI users want grouped, colorized terminal output they can scan quickly.
   - PR reviewers want focused markdown they can read in 10 seconds.
   - CI/security teams want SARIF that flows into GitHub Code Scanning.
   - Spreadsheet-loving stakeholders want CSV.

2. **Let users tune FlagShark to their codebase.**
   - **Exclude** generated code, vendor directories, test fixtures, examples, and snapshot files from scanning (issue #2). Today's hardcoded `SKIP_DIRS` only catches `node_modules`/`dist`/`coverage` etc. — projects with `examples/` or `*.test.ts` flag references currently get heavy false-positive noise (the issue documents 17/17 false positives in one real scan).
   - Set stricter thresholds for `src/critical/`, looser for `src/experimental/`.
   - **Suppress** known-permanent flags (kill-switches) from results without polluting global state.
   - Register in-house flag SDKs without forking the project.

3. **Maintain zero-config default behavior.**
   - `npx flagshark scan` still works with no setup, no config file.
   - `.flagshark.yml` is purely additive — every key has a sensible default.

## 2. Non-goals

- **Auto-fix / cleanup PRs.** Generating a PR that deletes a stale flag's dead branch is a separate, larger spec (out of scope).
- **Web dashboard or hosted service.** Different product.
- **Flag-state pulling from provider APIs.** Different product.
- **A query-authoring UI.** Power users can write tree-sitter queries by hand (advanced section in README); we don't ship a playground.
- **Multiple config file formats.** YAML only. Not TOML, not JSON, not JS.
- **Schema versioning on the config file.** v1 ships an unversioned schema; if we ever break it, we add a `version: 2` field then.

## 3. Architecture

### 3.1 Module layout

```
packages/core/src/
  config/
    schema.ts           # zod schemas for FlagsharkConfig + sub-types
    loader.ts           # find + parse .flagshark.yml from cwd upward
    defaults.ts         # buildDefaultConfig()
    merge.ts            # cli flags override config; config overrides defaults
    apply.ts            # turn config into runtime decisions (path matchers, suppression matchers, etc.)
  scan-repo.ts          # gains an optional `config: FlagsharkConfig` parameter

packages/cli/src/
  cli.ts                # loads config (or accepts --config) before calling scanRepo
  formatter/
    text.ts             # was formatter.ts — moves into a folder, gains colors + groupBy + sortBy
    json.ts             # was formatter.ts — pure-JSON output, unchanged
    sarif.ts            # NEW — emits SARIF v2.1.0
    markdown.ts         # NEW — emits markdown report (reused by Action's PR comment)
    csv.ts              # NEW — emits CSV
    index.ts            # selectFormatter(name): Formatter

packages/action/src/
  index.ts              # uses markdown formatter for PR comment; can emit SARIF too
```

### 3.2 Public API additions (no breaks)

`@flagshark/core` v1.x:

```ts
// New exports — additive only
export type {
  FlagsharkConfig,
  IgnoreConfig,
  PathRuleConfig,
  HealthScoreConfig,
  OutputConfig,
} from './config/schema.js'

export {
  loadConfig,           // (cwd) => Promise<FlagsharkConfig | null>
  buildDefaultConfig,   // () => FlagsharkConfig
  mergeConfig,          // (base, override) => FlagsharkConfig
  applyPathRules,       // (config, filePath) => EffectiveRules
} from './config/index.js'

// scanRepo gains an optional config field; current call sites still compile
export interface ScanRepoOptions {
  cwd: string
  threshold?: number              // deprecated soft: still works, but config.threshold wins if set
  diff?: string
  signal?: AbortSignal
  logger?: ScanLogger
  config?: FlagsharkConfig        // NEW
}
```

`ScanRepoResult` gains optional fields:

```ts
export interface ScanRepoResult {
  totalFlags: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Record<string, number>
  healthScore: number
  scanDuration: number
  excludedCount?: number           // NEW — files skipped by .flagsharkignore + excludes:
  suppressedCount?: number         // NEW — flags hidden by suppress.flags or inline comments
}
```

## 4. Config file schema

Single source of truth, zod-validated, all fields optional. Two distinct filter concepts kept *semantically separate*:

- **`excludes:`** — input filter. Files matching these patterns are **never scanned**. Use for test fixtures, generated code, examples, snapshots. (Resolves issue #2.)
- **`suppress:`** — output filter. Files are scanned, but matching flag names are filtered out of the report. Use for permanent kill-switches, internal debug flags that shouldn't count toward health score.

```yaml
# .flagshark.yml — example showing every available key

# Global staleness threshold in months. Overridable per-path.
threshold: 6

# Excludes: input filter — files never scanned (issue #2).
excludes:
  paths:
    - 'examples/**'         # glob — uses the `ignore` npm package, gitignore semantics
    - 'e2e/**'
  files:
    - '**/*.test.ts'
    - '**/*.spec.ts'
    - '**/__tests__/**'
  presets:                  # named bundles of common patterns — see §6.5
    - 'test-files'          # *.test.*, *.spec.*, *_test.go, test_*.py, etc.
    - 'snapshots'           # *.snap, __snapshots__/

# Suppress: output filter — flag names hidden from results.
suppress:
  flags:
    - 'INTERNAL_DEBUG_*'    # glob, matched against flag name
    - 'PERMANENT_KILLSWITCH'

# Per-path overrides — first matching glob wins.
paths:
  - match: 'src/critical/**'
    threshold: 3            # stricter
  - match: 'src/experimental/**'
    threshold: 12           # looser

# Add custom providers (in-house SDKs). Merged with built-in providers per language.
providers:
  - language: typescript
    name: 'In-house Flags'
    importPattern: '@mycompany/flags'
    methods:
      - { name: 'getFlag', flagKeyIndex: 0 }
      - { name: 'isOn',    flagKeyIndex: 0 }

# Output defaults — overridable by CLI flags.
output:
  format: text              # text | json | sarif | markdown | csv
  groupBy: file             # file | provider | signal | none
  sortBy: age               # age | name | count
  color: auto               # auto | always | never
  maxDisplay: 10            # text format only

# Health score weights — let users decide which signals matter more.
healthScore:
  weights:
    age: 1.0
    lowUsage: 0.5
    hardcoded: 2.0          # heavier weight on the new tree-sitter signal

# Engine override — escape hatch for tree-sitter migration (mirrors tree-sitter spec §10).
engine:
  typescript: tree-sitter   # default in T1; can force back to 'regex'
  go: tree-sitter
```

**Config discovery:** `loadConfig(cwd)` walks `cwd` upward looking for `.flagshark.yml` or `.flagshark.yaml`. Stops at first hit or at `$HOME`/`/`. Mirrors how `.prettierrc`, `.eslintrc`, etc. behave. The found path is logged at `info` level.

**`.flagsharkignore` discovery:** parallel walk for `.flagsharkignore` (see §6.2). Patterns from this file are *unioned* with `excludes.paths` and `excludes.files`. If both exist, both apply.

**Hardcoded safety net (preserved):** the existing `SKIP_DIRS` set in [packages/core/src/scanner.ts](../../packages/core/src/scanner.ts) (`node_modules`, `.git`, `dist`, `build`, `coverage`, `__pycache__`, `.next`, `.turbo`, `vendor`) remains unconditional — users cannot opt back into scanning these. Config-based `excludes:` and `.flagsharkignore` layer *on top* of this baseline.

**Validation:** zod errors fail the scan with exit code 2 and a clean error message: `Invalid .flagshark.yml: paths[1].threshold must be a positive integer`.

**`flagshark init` subcommand:** writes a commented starter config to `.flagshark.yml` in cwd. Shows every key with the default value as a comment. Refuses to overwrite an existing file unless `--force`.

## 5. Output formats

### 5.1 Text (terminal)

The current text formatter ships a single fixed layout. The new formatter takes config-driven options:

```
🦈 FlagShark v1.3.0 — scanned 156 files in 2.3s
                       (47 excluded via .flagsharkignore + test-files preset)

Detected providers: LaunchDarkly (JS SDK), Unleash (Go SDK)
Found 23 feature flags · 7 stale · health 70/100  ⚠️

Stale by FILE (groupBy: file, sortBy: age):

  src/checkout.ts
    L47   CHECKOUT_V2     14mo ago    age
    L92   PROMO_BANNER    11mo ago    age, low-usage

  src/layout.tsx
    L12   NEW_NAV          8mo ago    age

  src/search.ts
    L91   BETA_SEARCH     11mo ago    age, low-usage

Suppressed 4 flags via suppress.flags (run --show-suppressed to see them).

Exit code: 1 (stale flags found)
```

- **Colors:** flag name = bright, age = yellow when ≥ threshold (red when ≥ 2× threshold), provider = dim, signals = colored by severity (`age` yellow, `low-usage` cyan, `hardcoded` red). Implemented with `picocolors` (zero deps, tiny). Respects `NO_COLOR`, `--no-color`, `output.color: never`.
- **`--show-suppressed`:** prints suppressed flags in a faded section. Useful for auditing the config.
- **`--verbose`:** drops the `maxDisplay` cap (existing behavior).

### 5.2 JSON

Unchanged shape (`ScanRepoResult` serialized). Used by the Action and by piping to `jq`. New optional fields: `excludedCount` and `suppressedCount` (see §3.2). With `--show-excluded`, an `excluded: string[]` field is added with the full list of skipped paths. JSON output is the **stable API** — downstream tooling can rely on it.

### 5.3 SARIF (v2.1.0)

Standard SARIF JSON — directly consumable by `github/codeql-action/upload-sarif`. Each stale flag becomes one `result`:

```jsonc
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "FlagShark",
          "version": "1.3.0",
          "informationUri": "https://flagshark.com",
          "rules": [
            { "id": "stale-age",       "name": "Stale by age",       "shortDescription": { "text": "Flag reference older than threshold" } },
            { "id": "stale-low-usage", "name": "Stale by usage",     "shortDescription": { "text": "Flag appears in only one file" } },
            { "id": "stale-hardcoded", "name": "Stale by hardcode",  "shortDescription": { "text": "Flag's default is hardcoded" } }
          ]
        }
      },
      "results": [
        {
          "ruleId": "stale-age",
          "level": "warning",
          "message": { "text": "Flag CHECKOUT_V2 last modified 14 months ago (threshold 6 months)" },
          "locations": [{
            "physicalLocation": {
              "artifactLocation": { "uri": "src/checkout.ts" },
              "region": { "startLine": 47 }
            }
          }],
          "properties": {
            "flag": "CHECKOUT_V2",
            "provider": "launchdarkly-node-server-sdk",
            "age": "14 months ago"
          }
        }
      ]
    }
  ]
}
```

`level` mapping: 1 signal → `note`, 2 signals → `warning`, 3+ signals → `error`. (Configurable via `healthScore.weights` thresholds — out of v1 scope; can hard-code for now.)

### 5.4 Markdown

Used in two places:

1. **GitHub Action PR comment.** Replaces the current hard-coded template in `packages/action/src/index.ts`. Action gains an `output-format: sarif | markdown` input (markdown stays the default).
2. **`flagshark scan --format markdown > REPORT.md`** for users who want a sharable digest (Slack, email, README badge generation).

Layout:

```markdown
### 🦈 FlagShark scan

**156 files** · **23 flags** · **7 stale** · Health **70/100** ⚠️

| Flag | File | Added | Signals |
|------|------|-------|---------|
| `CHECKOUT_V2` | [src/checkout.ts:47](src/checkout.ts#L47) | 14 months ago | age |
| `PROMO_BANNER` | [src/checkout.ts:92](src/checkout.ts#L92) | 11 months ago | age, low-usage |
| `NEW_NAV` | [src/layout.tsx:12](src/layout.tsx#L12) | 8 months ago | age |

<details>
<summary>Detected providers</summary>

- LaunchDarkly (JavaScript)
- Unleash (Go)
</details>

<sub>Scanned in 2.3s. <a href="https://flagshark.com">Learn more</a>.</sub>
```

Configurable via `output.groupBy` and `output.sortBy` — same options as text. When the markdown is rendered in a PR comment, file paths are linkified relative to the repo's GitHub URL (Action knows the URL; CLI omits the link host and uses relative paths).

### 5.5 CSV

Plain comma-separated, RFC 4180-compliant (quoted fields, escaped quotes):

```csv
flag,file,line,language,provider,signals,age,added_at
"CHECKOUT_V2","src/checkout.ts",47,"typescript","launchdarkly-node-server-sdk","age","14 months ago","2024-12-11T03:42:19Z"
"PROMO_BANNER","src/checkout.ts",92,"typescript","launchdarkly-node-server-sdk","age, low-usage","11 months ago","2025-04-22T17:11:02Z"
```

Header row required. `added_at` is the git-blame-derived ISO timestamp (we already have this — currently only the human-readable `age` is surfaced; CSV gets the machine-readable timestamp too).

## 6. Excludes & Suppression

Three layered filtering mechanisms with clear semantic boundaries:

| Mechanism | What it does | Where | When applied |
|---|---|---|---|
| **`.flagsharkignore`** | Skip files entirely (input filter) | repo root | Before reading file content |
| **`excludes:` config** | Skip files entirely (input filter) | `.flagshark.yml` | Before reading file content |
| **`suppress:` config** | Hide specific flag names (output filter) | `.flagshark.yml` | After detection |
| **Inline comments** | Hide specific occurrences (output filter) | source code | After detection |

All four are independent and compose. A scanner pass logs at `--verbose`: "Excluded 47 files via .flagsharkignore + 12 via excludes:; suppressed 3 flags via suppress.flags; skipped 1 occurrence via inline comment."

### 6.1 Inline comment suppression

Two forms, both parsed by the same regex (engine-agnostic — works whether the file is being analyzed by tree-sitter or regex):

```ts
// flagshark-ignore-next-line
if (await client.variation('LEGACY_FLAG', user, false)) { ... }

// flagshark-ignore-next-line: reason about why this is permanent
if (await client.variation('PERM_FLAG', user, false)) { ... }

// Or specific to one flag (when multiple flags are on the next line):
// flagshark-ignore-next-line: LEGACY_FLAG
if (await client.variation('LEGACY_FLAG', user, false) && await client.variation('OTHER', user, false)) { ... }
```

**Comment styles per language** (the regex tolerates them all):

- C-family (`//`, `/* */`): TS, JS, Go, Java, Kotlin, Swift, C#, PHP, Rust, C, C++, ObjC
- Python: `#`
- Ruby: `#`

Suppression applies to **the next line containing a detected flag**. The detector emits all flags; a post-pass filter drops those whose line is preceded by a suppression comment on the line immediately above (skipping blank lines).

Specific-flag suppression (`// flagshark-ignore-next-line: FLAG_NAME`) only suppresses that named flag; other flags on that line still emit.

We do **not** support block-level suppression (`// flagshark-ignore-block-start ... // flagshark-ignore-block-end`) in v1. If users ask for it, easy to add.

### 6.2 `.flagsharkignore` file (issue #2)

A separate file at the repo root, gitignore-style syntax, parsed with the `ignore` npm package (battle-tested, what `npm`/`eslint`/`prettier` use). Patterns are relative to the file's directory (`.flagsharkignore` at repo root → patterns relative to repo root).

```gitignore
# .flagsharkignore
examples/
**/*.test.ts
**/*.spec.ts
**/__tests__/
**/__fixtures__/
**/__snapshots__/
**/*.stories.tsx
!examples/important.ts        # !-prefix re-includes
```

**Why a separate file from `.flagshark.yml`?** Two reasons:

1. **Familiar mental model.** Anyone who's used `.gitignore`, `.eslintignore`, `.dockerignore`, `.npmignore` understands the syntax instantly. Glob patterns + `!` for negation + `#` for comments.
2. **Diff-friendly.** `.flagsharkignore` is a flat list of patterns; YAML structure makes line-by-line diffs noisier. Users edit `.flagsharkignore` more frequently than the rest of the config.

**Discovery and merging:**

- `loadConfig(cwd)` looks for `.flagsharkignore` at the same level as `.flagshark.yml` (walks upward from cwd).
- Found patterns merge with `excludes.paths` + `excludes.files` from `.flagshark.yml`. Union semantics: a file is excluded if *any* source excludes it.
- On conflict (one says exclude, another says re-include via `!`), the `.flagsharkignore` file's later-in-file rule wins — standard gitignore semantics.

### 6.3 `excludes:` config block (issue #2)

For users who want one source of truth in YAML, or who don't want to ship a second dotfile:

```yaml
excludes:
  paths:
    - 'examples/**'
    - 'e2e/**'
  files:
    - '**/*.test.ts'
    - '**/*.spec.ts'
    - '**/__tests__/**'
  presets:
    - 'test-files'
    - 'snapshots'
```

`paths` and `files` are semantically identical at the matcher level (both go to `ignore` package); the split is purely organizational — `paths` for directory-shape patterns, `files` for file-shape patterns. Authors of the issue prefer this split; we honor it.

### 6.4 `suppress:` config block

Output-side flag-name filter — file IS scanned, but matching flag names are dropped from the report:

```yaml
suppress:
  flags:
    - 'INTERNAL_DEBUG_*'      # glob, matched against flag name
    - 'PERMANENT_KILLSWITCH'
    - 'TEST_*'
```

Globs follow the same syntax as `excludes` (via `ignore`/`minimatch`). Suppressed flags are counted (`suppressedCount` in result, see §3.2) so users know how many they're hiding.

### 6.5 Built-in presets

Named bundles of common exclude patterns, expanded at config-load time. Defined in [packages/core/src/config/presets.ts](../../packages/core/src/config/presets.ts):

```ts
export const PRESETS = {
  'test-files': [
    '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
    '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
    '**/*_test.go', '**/*_test.py', '**/test_*.py',
    '**/*Test.java', '**/*Test.kt', '**/*Tests.swift',
    '**/*_spec.rb', '**/spec/**/*.rb',
    '**/*Test.cs', '**/*Tests.cs',
    '**/__tests__/**', '**/tests/**', '**/test/**',
  ],
  'snapshots': [
    '**/*.snap',
    '**/__snapshots__/**',
  ],
  'examples': [
    'examples/**', 'example/**',
    'demo/**', 'demos/**',
  ],
  'stories': [
    '**/*.stories.ts', '**/*.stories.tsx',
    '**/*.stories.js', '**/*.stories.jsx',
    '**/*.story.ts', '**/*.story.tsx',
  ],
  'fixtures': [
    '**/__fixtures__/**', '**/fixtures/**',
  ],
  'generated': [
    '**/*.generated.ts', '**/*.generated.js',
    '**/*.gen.go', '**/generated/**',
  ],
} as const
```

**Opt-in, not default.** The issue's author leans opt-in to avoid silently changing scan results for existing users — we agree. The starter `flagshark init` template *suggests* `presets: ['test-files']` as a comment, and the verbose scan output prints `Detected 47 *.test.* files; add 'test-files' to excludes.presets to skip them` so users discover the option naturally. But no preset applies unless explicitly listed.

Implementation note: the issue references a `packages/shared/lib/test-files.ts` `isTestFile()` helper in the private `flag-shark` monorepo with comprehensive language coverage — that pattern set is the source for our `test-files` preset. We don't import the file (the public engine can't depend on the private monorepo); we copy the pattern list at preset-definition time and credit the source in a comment.

### 6.6 Counts in result

The result shape (§3.2) gains tracked counts so JSON consumers and the text formatter can show what was filtered:

```ts
export interface ScanRepoResult {
  // ... existing fields ...
  excludedCount?: number       // files skipped by .flagsharkignore + excludes:
  suppressedCount?: number     // flags hidden by suppress.flags or inline comments
}
```

The text formatter shows: `Excluded 47 files. Suppressed 3 flags. Run --show-excluded / --show-suppressed for details.`

JSON output never lists every excluded file by default (could be thousands of lines) — `--show-excluded` adds an `excluded: string[]` field with the paths.

## 7. Per-path rules

```yaml
paths:
  - match: 'src/critical/**'
    threshold: 3
  - match: 'src/experimental/**'
    threshold: 12
```

First-match-wins. The default threshold (`config.threshold`, or 6) applies if no pattern matches. The `paths:` block applies *only to files that survived `excludes:` filtering* — excluded files never reach threshold evaluation.

`paths[].threshold` is currently the only overridable field. We **don't** add per-path engine selection, per-path provider lists, or per-path signal weights in v1 — those add complexity without a clear ask. Easy to extend later.

## 8. CLI changes

New flags:

```
flagshark scan
  --config <path>          # use this config file (override discovery)
  --no-config              # ignore any .flagshark.yml; use built-in defaults
  --no-ignore-file         # ignore .flagsharkignore (config-only)
  --format <fmt>           # text | json | sarif | markdown | csv
  --output <file>          # write to file instead of stdout
  --group-by <key>         # file | provider | signal | none
  --sort-by <key>          # age | name | count
  --no-color               # disable colors (NO_COLOR env var also honored)
  --show-suppressed        # show suppressed flags in text output (faded)
  --show-excluded          # show excluded file list (faded; off by default)
  --engine <eng>           # regex | tree-sitter — see tree-sitter spec §6.4

flagshark init             # write a starter .flagshark.yml in cwd
```

Existing flags (`--json`, `--diff`, `--threshold`, `--verbose`) keep working:

- `--json` is shorthand for `--format json`. Kept for backwards compat; deprecated in v2.
- `--threshold N` overrides `config.threshold`. Kept.
- `--verbose` prints the effective exclude rules at scan start (per issue #2's debug request): `Effective excludes: examples/**, **/*.test.ts (from .flagsharkignore + excludes:test-files preset)`.

**Precedence:** CLI flag > config file > built-in default.

## 9. Action changes

New inputs in `action.yml`:

```yaml
inputs:
  config:
    description: 'Path to .flagshark.yml (default: auto-discover)'
    required: false
  output-format:
    description: 'PR comment format: markdown (default) | none'
    required: false
    default: 'markdown'
  sarif:
    description: 'Write SARIF to this path (default: do not write)'
    required: false
```

If `sarif:` is set, the Action writes `flagshark.sarif` and the consumer can chain:

```yaml
- uses: FlagShark/flagshark@v1
  with:
    sarif: flagshark.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: flagshark.sarif
```

GitHub then surfaces stale flags in the repo's **Security → Code Scanning** tab — same UX as CodeQL, ESLint with SARIF output, etc.

## 10. Health score (revisited)

Today's health score is `(totalFlags - uniqueStaleNames) / totalFlags * 100`. It treats every stale signal equally and weighs every flag equally. We extend:

```
healthScore = 100 - clamp(0..100, sum(staleFlag * signalWeights) / totalFlags * 100)
```

Where `signalWeights` defaults to:

```yaml
healthScore:
  weights:
    age: 1.0
    lowUsage: 0.5
    hardcoded: 2.0    # active in T6+ (tree-sitter spec)
```

This gives `hardcoded` flags 4× the impact of `lowUsage` flags — reflecting the truth that a hardcoded flag is *definitely* dead, while low-usage is *suggestive*. Users can rebalance.

Backwards compat: the default weights produce a score very close to today's, so existing PRs don't suddenly fail their `fail-threshold` gate.

## 11. Phasing

Since the v1.2.0 release (commit `3069587`), `@flagshark/core` and `flagshark` (CLI) ship at the same version. Each release below bumps both packages together. Phases interleave with tree-sitter tiers (see the companion spec); a single release version may bundle one tree-sitter tier *and* one output-spec phase. Version numbers below are illustrative, not exclusive.

| Phase | Deliverable | Release |
|---|---|---|
| P0 | This spec | (this doc) |
| P1 | Implementation plan (writing-plans skill) | docs/superpowers/plans/ |
| P2 | **Excludes (resolves issue #2):** config loader + zod schema + `.flagsharkignore` + `excludes:` block + presets + `--show-excluded`/`--no-ignore-file`/`--verbose` rule listing. Highest user impact — removes the dominant source of false positives. | `v1.3.0` (alongside tree-sitter T1) |
| P3 | Markdown + CSV formatters; refactor Action PR comment to use markdown formatter. | `v1.4.0` |
| P4 | SARIF output + Action `sarif:` input + Code Scanning docs. | `v1.5.0` |
| P5 | Inline suppression comments + `suppress.flags` config + `--show-suppressed`. | `v1.6.0` |
| P6 | Per-path rules (threshold overrides per glob). | `v1.7.0` |
| P7 | `flagshark init` subcommand + colorized text output + `--group-by`/`--sort-by`. | `v1.8.0` |
| P8 | Health score weights surface (paired with tree-sitter T6 `hardcoded` signal). | `v1.9.0` |

Phases are sized to ship every 1–2 weeks. They can interleave with tree-sitter tiers since they touch different modules.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| YAML parsing pulls in a heavyweight dep (`js-yaml` is ~150KB) | Acceptable — only loaded when a config file exists. Alternative: `yaml@2.x` (smaller). |
| zod adds bundle weight to CLI | Zod is already a runtime dep; we're using it for parsing CLI args today. |
| SARIF schema drift | Pin the schema URL to the 2.1.0 version we test against. Re-validate annually. |
| Suppression syntax differs from other tools (eslint-disable, etc.) | Document the syntax clearly in README. Consider also accepting `// eslint-disable-next-line flagshark` if users ask. |
| Globs behave subtly different across platforms | Use `minimatch` (battle-tested, what npm/eslint use). Document case sensitivity. |
| Users override engine to regex and then complain about false positives | Document: `engine: regex` is an escape hatch, not a recommended setting. |
| Config file shape becomes load-bearing across versions | Until v2, never break the schema. Add fields only. Validate strictly so typos error loudly. |

## 13. Open questions

1. **YAML library choice — `yaml@2.x` vs `js-yaml`?** `yaml` is smaller and more modern. `js-yaml` is more battle-tested. *Lean: `yaml@2.x`.*

2. **Should `suppress.flags` accept regex as well as glob?** Globs cover most cases. *Lean: glob only in v1; regex behind `flag_regex:` later if asked.*

3. **Suppression comment syntax — `flagshark-ignore-next-line` or shorter (`flagshark-ignore`, `fs-ignore`)?** Shorter is friendlier but ambiguous. *Lean: `flagshark-ignore-next-line` (explicit, follows eslint convention).*

4. **`flagshark init` — what should the starter file look like?** Pure-comment template showing every option, or a minimal `threshold: 6` only? *Lean: minimal default with `presets: ['test-files']` commented out as a hint (mirrors what verbose output suggests on first scan).*

5. **Action's `output-format: none`** — does it disable the PR comment entirely (e.g., for users who only want SARIF)? *Yes — that's the use case.*

6. **Markdown formatter output for the CLI vs the Action — should they diverge?** Action's links are absolute (`https://github.com/owner/repo/blob/sha/...`); CLI's are relative (`src/checkout.ts#L47`). One formatter with a `linkPrefix` option, or two formatters? *Lean: one formatter, `linkPrefix` option.*

7. **(From issue #2) Should `test-files` ship in a default-on preset?** *Lean: no — opt-in only. Silently changing scan results breaks existing users. Compromise: print a hint on first scan when any `*.test.*` or `__tests__/**` files are detected.*

8. **(From issue #2) Should excluded files appear in JSON output by default?** *Lean: no — count only (`excludedCount`). `--show-excluded` adds the full list when needed. Avoids bloating typical JSON output with thousands of paths.*

9. **`excludes.paths` vs `excludes.files` — keep the conceptual split or merge into one `excludes.patterns` list?** The issue author proposed the split. Both keys are matcher-identical; the split is organizational. *Lean: honor the split (paths for directory-shape, files for file-shape) — costs us nothing, matches the issue.*

10. **Should `.flagsharkignore` support multiple files (per-directory, like `.gitignore`)?** Git allows nested `.gitignore` files in subdirectories. *Lean: no for v1 — only one `.flagsharkignore` at repo root. Walks-upward from cwd. Nested-files behavior can be added later if asked.*

## 14. Out-of-scope follow-ups (for next major)

- Block-level suppression (`// flagshark-ignore-block-start ... -end`)
- Per-path engine selection
- Per-path provider lists
- Auto-fix / cleanup PR generation
- Live provider-API enrichment (LaunchDarkly REST → augment results with rollout %)
- Web dashboard
- Telemetry / usage metrics
