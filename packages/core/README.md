# @flagshark/core

The detection engine behind [FlagShark](https://github.com/FlagShark/flagshark) — finds feature flag references across 13 languages and 12+ providers, and identifies stale flags via git blame.

This is the **library**. If you want a CLI or GitHub Action, install [`flagshark`](https://www.npmjs.com/package/flagshark) instead.

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

## API

### `scanRepo(options) → Promise<ScanRepoResult>`

Top-level orchestrator. Walks a checked-out repository, detects flags, and runs staleness analysis.

```ts
interface ScanRepoOptions {
  /** Absolute path to the repository being scanned. */
  cwd: string

  /** Staleness threshold in months. Default: 6. */
  threshold?: number

  /** If set, only scan files changed since this git ref (e.g. `origin/main`). */
  diff?: string

  /** Optional cancellation signal. Cancels file analysis only;
   *  `git blame` subprocesses always run to completion. */
  signal?: AbortSignal

  /** Optional `{ debug, info, warn, error }` logger. Defaults to no-op. */
  logger?: ScanLogger
}

interface ScanRepoResult {
  totalFlags: number
  filesScanned: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Record<string, number>
  healthScore: number       // 0–100
  scanDuration: number      // ms
}
```

`scanRepo` walks the local filesystem. If you can't run a git checkout (e.g., serverless function reading from an API), use the lower-level primitives below.

### Lower-level primitives

For consumers that fetch file contents elsewhere (GitHub API, S3, in-memory, etc.):

```ts
import { createDefaultRegistry, PolyglotAnalyzer } from '@flagshark/core'

const registry = createDefaultRegistry()           // 13 detectors pre-registered
const analyzer = new PolyglotAnalyzer(registry)

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

Or import individual detectors and compose your own registry:

```ts
import { LanguageRegistry, GoDetector, TypeScriptDetector } from '@flagshark/core'

const registry = new LanguageRegistry()
registry.register(new GoDetector())
registry.register(new TypeScriptDetector())
```

## Supported languages

TypeScript/JavaScript, Go, Python, Java, Kotlin, Swift, Ruby, C#, PHP, Rust, C/C++, Objective-C.

## Supported providers

Auto-detected from imports — no configuration needed: LaunchDarkly, Unleash, Flipt, Split.io, PostHog, Flagsmith, ConfigCat, Statsig, GrowthBook, DevCycle, Eppo, Optimizely, plus generic custom-flag patterns.

## How detection works

For each file, FlagShark looks for an import of a flag SDK. If none is found, the file is skipped — this prevents false positives from generic functions named `isEnabled()` etc. Once a file qualifies, language-specific regex patterns extract flag references along with provider attribution and source location.

## How staleness works

A flag is marked stale if **any** signal fires:

1. **Age:** `git blame` says the flag was added more than `threshold` months ago.
2. **Single file:** The flag name appears in only one file across the repo, suggesting a completed rollout.

## License

MIT
