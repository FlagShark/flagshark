# @flagshark/core

The detection engine behind [FlagShark](https://github.com/FlagShark/flagshark) — finds feature flag references across 13 languages and 13 providers, and identifies stale flags via git blame.

This is the **library**. For a CLI or GitHub Action, install [`flagshark`](https://www.npmjs.com/package/flagshark) instead.

## Install

```bash
npm install @flagshark/core
```

## Quick start

```ts
import { scanRepo } from '@flagshark/core'

const result = await scanRepo({
  cwd: process.cwd(),
  threshold: 6, // months — flag is stale if older than this
})

console.log(`${result.totalFlags} flags, ${result.staleFlags.length} stale`)
console.log(`Health score: ${result.healthScore}/100`)
console.log(`Languages: ${Object.keys(result.languageBreakdown).join(', ')}`)
```

## Detection

For tier-1 languages (TypeScript, JavaScript, Go, Python), detection uses [tree-sitter](https://tree-sitter.github.io/) (via WASM) to parse files into a real AST. That eliminates the false-positive class where regex matched flag-shaped strings inside comments, string literals, or unrelated call expressions. It also handles multi-line calls and resolves const-bound flag keys (`const FLAG = 'X'; client.variation(FLAG, …)`) in TS/JS.

The remaining 9 languages currently use regex-based detection; each migrates to tree-sitter in future releases (no API break).

The engine is a runtime concern, not a public API surface. Consumers calling `scanRepo()` or `createDefaultRegistry()` get the right engine per-language automatically. Override per-detector if needed (see below).

## API

### `scanRepo(options) → Promise<ScanRepoResult>`

Top-level orchestrator. Walks a checked-out repository, detects flags, runs staleness analysis, and returns a summary.

```ts
interface ScanRepoOptions {
  /** Absolute path to the repository being scanned. */
  cwd: string

  /** Staleness threshold in months. Overridden by `config.threshold` if config is supplied. */
  threshold?: number

  /** If set, only scan files changed since this git ref (e.g. `origin/main`). */
  diff?: string

  /** Optional cancellation signal. Cancels file analysis only;
   *  `git blame` subprocesses always run to completion. */
  signal?: AbortSignal

  /** Optional `{ debug, info, warn, error }` logger. Defaults to no-op. */
  logger?: ScanLogger

  /** Explicit FlagsharkConfig. If undefined, scanRepo auto-discovers
   *  `.flagshark.yml` walking upward from `cwd`. */
  config?: FlagsharkConfig

  /** Skip `.flagshark.yml` discovery entirely. */
  noConfig?: boolean

  /** Skip `.flagsharkignore` discovery entirely. */
  noIgnoreFile?: boolean

  /** Populate `result.excludedPaths` with the full list of skipped file paths.
   *  Off by default — counts only. */
  collectExcludedPaths?: boolean
}

interface ScanRepoResult {
  totalFlags: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Record<string, number>
  healthScore: number              // 0–100
  scanDuration: number             // ms
  excludedCount?: number           // files skipped by config + .flagsharkignore
  excludedPaths?: string[]         // set when collectExcludedPaths: true
  effectiveExcludes?: EffectiveRules  // for debug/verbose output
}
```

`scanRepo` walks the local filesystem. If you can't run a git checkout (e.g., a serverless function reading from an API), use the lower-level primitives below.

### Config module

The same config used by the CLI is exported as a building block:

```ts
import {
  buildDefaultConfig,
  loadConfigFile,
  loadIgnoreFile,
  buildExcluder,
  expandPresets,
  PRESETS,
  FlagsharkConfigSchema,
  type FlagsharkConfig,
} from '@flagshark/core'

// Load a .flagshark.yml from disk (validated via zod)
const loaded = await loadConfigFile('/path/to/repo')
const config = loaded?.config ?? buildDefaultConfig()

// Load a .flagsharkignore (separate file at repo root)
const ignoreFile = await loadIgnoreFile('/path/to/repo')

// Build a unified excluder from all sources
const excluder = buildExcluder({
  config,
  ignoreFilePatterns: ignoreFile?.patterns ?? [],
})

// Use it directly:
excluder.shouldExclude('examples/demo.ts')  // true
```

The schema accepts:

```yaml
threshold: 6
excludes:
  paths: []        # gitignore-style globs
  files: []        # same — split is purely organizational
  presets: []      # ['test-files', 'snapshots', 'examples', 'stories', 'fixtures', 'generated']
suppress:
  flags: []        # flag-name globs (post-detection filter)
paths:
  - match: 'src/critical/**'
    threshold: 3
providers: []      # custom provider definitions (see Custom Detectors)
```

### Lower-level primitives

For consumers that fetch file contents elsewhere (GitHub API, S3, in-memory, etc.):

```ts
import { createDefaultRegistry, PolyglotAnalyzer } from '@flagshark/core'

const registry = createDefaultRegistry()           // 13 detectors pre-registered
const analyzer = new PolyglotAnalyzer(registry, logger)

// `files` is a Map<filePath, content>
const result = await analyzer.analyzeFiles(files)
//   .totalFlags: Map<flagName, FeatureFlag[]>
//   .languages:  Map<Language, number>
```

For staleness analysis with a local checkout:

```ts
import { analyzeStaleness } from '@flagshark/core'

const stale = await analyzeStaleness(result.totalFlags, {
  thresholdMonths: 6,
  repoRoot: '/path/to/repo',
})
```

### Custom detectors

`createDefaultRegistry()` returns a `LanguageRegistry`. Register additional detectors that implement the `LanguageDetector` interface:

```ts
import { createDefaultRegistry, LanguageDetector } from '@flagshark/core'

const registry = createDefaultRegistry()
registry.register(new MyCustomDetector())
```

Or import individual detectors and compose your own registry. Each tier-1 detector accepts `{ engine: 'regex' | 'tree-sitter' }`:

```ts
import {
  LanguageRegistry,
  TypeScriptDetector,
  GoDetector,
  type DetectorEngine,
} from '@flagshark/core'

const registry = new LanguageRegistry()
registry.register(new TypeScriptDetector({ engine: 'tree-sitter' }))
registry.register(new GoDetector({ engine: 'regex' }))  // opt back to regex
```

## Supported languages

TypeScript, JavaScript, Go, Python, Java, Kotlin, Swift, Ruby, C#, PHP, Rust, C/C++, Objective-C.

## Supported providers

Auto-detected from imports — no configuration needed:

LaunchDarkly · Unleash · Flipt · Split.io · PostHog · Flagsmith · ConfigCat · Statsig · GrowthBook · DevCycle · Eppo · Optimizely · plus generic custom-flag patterns.

## How detection works

FlagShark only scans files that actually import a flag SDK. A function called `isEnabled()` in a file that doesn't import LaunchDarkly/Unleash/etc. won't be flagged — this prevents false positives from generic identifier names.

Once a file qualifies, the engine (tree-sitter for tier-1, regex for the rest) walks call expressions and extracts the flag-key argument at the configured position for each provider's method signatures. Provider attribution and source location come along automatically.

## How staleness works

A flag is marked stale if **any** signal fires:

1. **`age`** — `git blame` shows the flag's line was last modified more than `threshold` months ago.
2. **`low-usage`** — The flag name appears in only one file across the repo, suggesting a completed rollout.

## License

MIT
