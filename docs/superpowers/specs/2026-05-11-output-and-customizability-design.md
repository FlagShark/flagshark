# Output & Customizability — Design Spec

**Status:** Draft for review
**Date:** 2026-05-11
**Scope:** Make `flagshark scan` more useful and customizable: add a config file, more output formats (SARIF, markdown, CSV), inline suppression, per-path rules, custom providers, and a better terminal UX. Companion to the tree-sitter spec.
**Coupled spec:** [2026-05-11-tree-sitter-detection-engine-design.md](./2026-05-11-tree-sitter-detection-engine-design.md) — custom providers in config feed both engines; the new `hardcoded` signal (tier 6) must render correctly in all output formats defined here.

---

## 1. Goals

1. **Make output actionable for different audiences.**
   - CLI users want grouped, colorized terminal output they can scan quickly.
   - PR reviewers want focused markdown they can read in 10 seconds.
   - CI/security teams want SARIF that flows into GitHub Code Scanning.
   - Spreadsheet-loving stakeholders want CSV.

2. **Let users tune FlagShark to their codebase.**
   - Ignore generated code, vendor directories, test fixtures.
   - Set stricter thresholds for `src/critical/`, looser for `src/experimental/`.
   - Suppress known-permanent flags (kill-switches) without polluting global state.
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

`ScanRepoResult` gains one optional field:

```ts
export interface ScanRepoResult {
  totalFlags: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Record<string, number>
  healthScore: number
  scanDuration: number
  suppressedCount?: number         // NEW — count of flags hidden by ignore rules (so users know)
}
```

## 4. Config file schema

Single source of truth, zod-validated, all fields optional.

```yaml
# .flagshark.yml — example showing every available key

# Global staleness threshold in months. Overridable per-path.
threshold: 6

# Files and flags to skip entirely.
ignore:
  paths:
    - 'src/legacy/**'        # glob (uses minimatch)
    - '**/*.test.ts'
    - '**/*.generated.ts'
  flags:
    - 'INTERNAL_DEBUG_*'     # glob, matched against flag name
    - 'PERMANENT_KILLSWITCH'

# Per-path overrides — first matching glob wins.
paths:
  - match: 'src/critical/**'
    threshold: 3             # stricter
  - match: 'src/experimental/**'
    threshold: 12            # looser

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

**File discovery:** `loadConfig(cwd)` walks `cwd` upward looking for `.flagshark.yml` or `.flagshark.yaml`. Stops at first hit or at `$HOME`/`/`. Mirrors how `.prettierrc`, `.eslintrc`, etc. behave. The found path is logged at `info` level.

**Validation:** zod errors fail the scan with exit code 2 and a clean error message: `Invalid .flagshark.yml: paths[1].threshold must be a positive integer`.

**`flagshark init` subcommand:** writes a commented starter config to `.flagshark.yml` in cwd. Shows every key with the default value as a comment. Refuses to overwrite an existing file unless `--force`.

## 5. Output formats

### 5.1 Text (terminal)

The current text formatter ships a single fixed layout. The new formatter takes config-driven options:

```
🦈 FlagShark v1.3.0 — scanned 156 files in 2.3s

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

Suppressed 4 flags via .flagshark.yml (run --show-suppressed to see them).

Exit code: 1 (stale flags found)
```

- **Colors:** flag name = bright, age = yellow when ≥ threshold (red when ≥ 2× threshold), provider = dim, signals = colored by severity (`age` yellow, `low-usage` cyan, `hardcoded` red). Implemented with `picocolors` (zero deps, tiny). Respects `NO_COLOR`, `--no-color`, `output.color: never`.
- **`--show-suppressed`:** prints suppressed flags in a faded section. Useful for auditing the config.
- **`--verbose`:** drops the `maxDisplay` cap (existing behavior).

### 5.2 JSON

Unchanged shape (`ScanRepoResult` serialized). Used by the Action and by piping to `jq`. The one addition: `suppressedCount` if any suppression occurred. JSON output is the **stable API** — downstream tooling can rely on it.

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

## 6. Suppression

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

### 6.2 Config-level ignore patterns

`ignore.paths` filters out files before they're scanned (cheaper). `ignore.flags` filters out flags after detection. Both support globs:

- `paths`: minimatch globs against the file path (e.g., `src/legacy/**`).
- `flags`: minimatch globs against the flag name (e.g., `INTERNAL_DEBUG_*`).

Suppressed-count is reported in the result so users know how much they're hiding.

## 7. Per-path rules

```yaml
paths:
  - match: 'src/critical/**'
    threshold: 3
  - match: 'src/experimental/**'
    threshold: 12
```

First-match-wins. The default threshold (`config.threshold`, or 6) applies if no pattern matches.

`paths[].threshold` is currently the only overridable field. We **don't** add per-path engine selection, per-path provider lists, or per-path signal weights in v1 — those add complexity without a clear ask. Easy to extend later.

## 8. CLI changes

New flags:

```
flagshark scan
  --config <path>          # use this config file (override discovery)
  --no-config              # ignore any .flagshark.yml; use built-in defaults
  --format <fmt>           # text | json | sarif | markdown | csv
  --output <file>          # write to file instead of stdout
  --group-by <key>         # file | provider | signal | none
  --sort-by <key>          # age | name | count
  --no-color               # disable colors (NO_COLOR env var also honored)
  --show-suppressed        # show suppressed flags in text output (faded)
  --engine <eng>           # regex | tree-sitter — see tree-sitter spec §6.4

flagshark init             # write a starter .flagshark.yml in cwd
```

Existing flags (`--json`, `--diff`, `--threshold`, `--verbose`) keep working:

- `--json` is shorthand for `--format json`. Kept for backwards compat; deprecated in v2.
- `--threshold N` overrides `config.threshold`. Kept.

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
| P2 | Config loader + zod schema + `--config`/`--no-config` flags. No behavior change for users without a config file. | `v1.3.0` (alongside tree-sitter T1) |
| P3 | Markdown + CSV formatters; refactor Action PR comment to use markdown formatter. | `v1.4.0` |
| P4 | SARIF output + Action `sarif:` input + Code Scanning docs. | `v1.5.0` |
| P5 | Inline suppression comments + `ignore.flags` config. | `v1.6.0` |
| P6 | Per-path rules + `ignore.paths` config. | `v1.7.0` |
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

2. **Should `ignore.flags` accept regex as well as glob?** Globs cover most cases. *Lean: glob only in v1; regex behind `flag_regex:` later if asked.*

3. **Suppression comment syntax — `flagshark-ignore-next-line` or shorter (`flagshark-ignore`, `fs-ignore`)?** Shorter is friendlier but ambiguous. *Lean: `flagshark-ignore-next-line` (explicit, follows eslint convention).*

4. **`flagshark init` — what should the starter file look like?** Pure-comment template showing every option, or a minimal `threshold: 6` only? *Lean: minimal default with a comment pointing at the docs; users add what they need.*

5. **Action's `output-format: none`** — does it disable the PR comment entirely (e.g., for users who only want SARIF)? *Yes — that's the use case.*

6. **Markdown formatter output for the CLI vs the Action — should they diverge?** Action's links are absolute (`https://github.com/owner/repo/blob/sha/...`); CLI's are relative (`src/checkout.ts#L47`). One formatter with a `linkPrefix` option, or two formatters? *Lean: one formatter, `linkPrefix` option.*

## 14. Out-of-scope follow-ups (for next major)

- Block-level suppression (`// flagshark-ignore-block-start ... -end`)
- Per-path engine selection
- Per-path provider lists
- Auto-fix / cleanup PR generation
- Live provider-API enrichment (LaunchDarkly REST → augment results with rollout %)
- Web dashboard
- Telemetry / usage metrics
