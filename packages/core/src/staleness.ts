import { execFileSync, execSync } from 'child_process'

import { type FeatureFlag } from './detection/feature-flag.js'
import type { PerFlagEnvironmentData } from './providers/orchestrate.js'
import type { FlagVariation } from './providers/interface.js'

// ── Public interfaces ──────────────────────────────────────────────

export interface StalenessSignal {
  // Code-side signals: 'age', 'hardcoded', 'low-usage'.
  // Platform-side signals (from cross-reference): 'missing-in-platform',
  // 'archived-in-platform', 'platform-too-old', 'platform-inactive',
  // 'platform-launched', 'coverage-gap-vs-platform'.
  type:
    | 'age'
    | 'hardcoded'
    | 'low-usage'
    | 'test-only-references'
    | 'missing-in-platform'
    | 'archived-in-platform'
    | 'platform-too-old'
    | 'platform-inactive'
    | 'platform-launched'
    | 'platform-zero-evaluations'
    | 'platform-low-evaluations'
    | 'platform-untouched-stale'
    | 'coverage-gap-vs-platform'
  severity: 'error' | 'warning' | 'info'
  description: string
}

export interface StaleFlag {
  name: string
  filePath: string
  lineNumber: number
  language: string
  provider: string
  signals: StalenessSignal[]
  /** Human-readable age, e.g. "14 months ago" */
  age?: string
  /**
   * Detection-quality tier inherited from the underlying FeatureFlag.
   * See FlagConfidence in detection/feature-flag.ts for what the values
   * mean. Absent = `'high'`. Surfaced here so consumers of the stale-flag
   * list (the JSON output, the GitHub Action's PR comment) can route
   * medium-confidence flags to manual review rather than auto-cleanup.
   */
  confidence?: 'high' | 'medium' | 'low'

  /**
   * Platform-side metadata propagated through from the cross-reference
   * layer. Populated only when a platform integration is active AND the
   * platform exposed the data. Output formatters surface these
   * alongside each flag so reviewers see who owns it and how the
   * platform classifies it without a context switch.
   */
  tags?: string[]
  maintainer?: string
  /** LD's per-environment activity verdict; see PlatformFlag.status. */
  platformStatus?: 'new' | 'active' | 'inactive' | 'launched'

  /**
   * Variation definitions for this flag from the platform integration.
   * Populated only when the platform exposes variation data (LD does;
   * others may not). Surfaced in JSON output as a top-level per-flag
   * field so cleanup pipelines can look up the substitute value by
   * variation index.
   */
  variations?: FlagVariation[]

  /**
   * Cross-check count from the platform's own code-references feature.
   * Populated when the platform exposes the feature AND it's available
   * for the project. Surfaced in JSON output for SaaS consumers and
   * verbose text output for human review.
   *
   * See PlatformFlag.codeReferences for the three-state semantics
   * (undefined / null / { count }).
   */
  codeReferences?: { count: number } | null

  /**
   * Per-env platform enrichment data for this flag. Populated only
   * when a platform integration is active AND the flag matched in that
   * platform. JSON output renders this as an additive `environments`
   * block per flag.
   */
  environments?: Map<string, PerFlagEnvironmentData>
}

export interface StalenessOptions {
  /** Flag lines older than this are considered stale. Default: 30. */
  thresholdDays: number
  /** Absolute path to the git repository root. */
  repoRoot: string
  /** Optional: pre-computed platform signals keyed by flag name. */
  platformSignals?: Map<string, import('./providers/interface.js').PlatformSignal[]>
  /**
   * Optional: per-flag platform metadata surfaced by the orchestrator.
   * Drives the tags / maintainer / platformStatus fields on each
   * emitted StaleFlag. Keyed by detected flag name; values come
   * straight from the matched PlatformFlag.
   */
  platformMetadata?: Map<
    string,
    {
      tags?: string[]
      maintainer?: string
      status?: 'new' | 'active' | 'inactive' | 'launched'
      variations?: FlagVariation[]
      codeReferences?: { count: number } | null
    }
  >

  /**
   * Per-flag, per-env enrichment data sourced from the platform integration.
   * When provided, surfaces on each StaleFlag via the `environments` field,
   * which the JSON formatter renders into the additive `environments` block.
   * Outer key: detected flag name. Inner key: env name.
   */
  platformEnvironments?: Map<string, Map<string, PerFlagEnvironmentData>>
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Returns true when the repository is a shallow clone (git blame timestamps
 * would all point to the checkout commit and be meaningless).
 */
function isShallowRepo(repoRoot: string): boolean {
  try {
    const out = execSync('git rev-parse --is-shallow-repository', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return out === 'true'
  } catch {
    // Not a git repo at all – caller will handle.
    return false
  }
}

/**
 * Parse `git blame --porcelain` output and return a map of
 * 1-based line number → author-time (unix seconds).
 *
 * Porcelain format per-line group:
 *   <sha> <orig-line> <final-line> [<group-size>]
 *   author ...
 *   author-mail ...
 *   author-time <unix-ts>
 *   ...
 *   \t<content line>
 */
function parseBlamePortcelain(output: string): Map<number, number> {
  const lineAges = new Map<number, number>()
  const lines = output.split('\n')

  let currentLine = 0
  let currentAuthorTime = 0

  for (const line of lines) {
    // Group header: <40-char sha> <orig> <final> [count]
    const headerMatch = line.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)(?:\s+\d+)?$/)
    if (headerMatch) {
      currentLine = parseInt(headerMatch[1], 10)
      continue
    }

    // author-time line
    if (line.startsWith('author-time ')) {
      currentAuthorTime = parseInt(line.slice('author-time '.length), 10)
      continue
    }

    // Content line (starts with tab) – marks end of this group's metadata.
    if (line.startsWith('\t')) {
      if (currentLine > 0 && currentAuthorTime > 0) {
        lineAges.set(currentLine, currentAuthorTime)
      }
    }
  }

  return lineAges
}

/**
 * Run `git blame --porcelain` for a single file and return line → unix-ts map.
 * Returns null on any failure (untracked file, binary, non-git dir, etc.).
 */
function blameFile(filePath: string, repoRoot: string): Map<number, number> | null {
  try {
    const out = execFileSync('git', ['blame', '--porcelain', '--', filePath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10 MB – large files
    })
    return parseBlamePortcelain(out)
  } catch {
    // Untracked, binary, or other git error – skip gracefully.
    return null
  }
}

/**
 * Convert a unix timestamp to a human-readable relative age string,
 * e.g. "14 months ago", "3 years ago", "29 days ago".
 */
function formatAge(unixSeconds: number): string {
  const nowMs = Date.now()
  const thenMs = unixSeconds * 1000
  const diffMs = nowMs - thenMs

  const seconds = Math.floor(diffMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const months = Math.floor(days / 30.44) // average days/month
  const years = Math.floor(days / 365.25)

  if (years >= 1) {
    return `${years} year${years === 1 ? '' : 's'} ago`
  }
  if (months >= 1) {
    return `${months} month${months === 1 ? '' : 's'} ago`
  }
  if (days >= 1) {
    return `${days} day${days === 1 ? '' : 's'} ago`
  }
  return 'less than a day ago'
}

// ── Signal detectors ───────────────────────────────────────────────

/**
 * Check whether a flag's line is older than the threshold.
 * Returns the signal + age string, or null if the signal doesn't fire.
 */
function checkAgeSignal(
  authorTime: number | undefined,
  thresholdDays: number,
): { signal: StalenessSignal; age: string } | null {
  if (authorTime === undefined) {
    return null
  }

  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000
  const ageMs = Date.now() - authorTime * 1000

  if (ageMs < thresholdMs) {
    return null
  }

  const age = formatAge(authorTime)
  return {
    signal: {
      type: 'age' as const,
      severity: 'warning' as const,
      description: `Flag reference last modified ${age} (threshold: ${thresholdDays} days)`,
    },
    age,
  }
}

/**
 * Check whether a flag appears in only one file.
 */
function checkLowUsageSignal(flagName: string, occurrences: FeatureFlag[]): StalenessSignal | null {
  const uniqueFiles = new Set(occurrences.map((o) => o.filePath))
  if (uniqueFiles.size > 1) {
    return null
  }

  return {
    type: 'low-usage' as const,
    severity: 'warning' as const,
    description: `Flag "${flagName}" only appears in 1 file — may have been fully rolled out`,
  }
}

/**
 * Patterns that identify a path as a TEST file across the languages
 * FlagShark detects flags in. The patterns are deliberately tight —
 * we'd rather miss a test file than misclassify a production file as
 * a test (which would suppress a real staleness verdict).
 *
 * Coverage:
 *   - `.test.<ext>` and `.spec.<ext>` (JS/TS, common in the JS ecosystem)
 *   - `_test.go` (Go convention)
 *   - `test_<name>.py` (Python pytest convention)
 *   - `<Name>Test.java` / `<Name>Tests.java` (Java JUnit convention)
 *   - Anything inside `__tests__/`, `__mocks__/`, `/test/`, `/tests/`,
 *     or `/spec/` directories
 *
 * Not covered (false negative is the safer failure mode here): unusual
 * test-naming conventions like Ruby `*_spec.rb` (different path conventions
 * across Ruby projects), or single-file scripts that happen to be tests.
 */
const TEST_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /[._-]test\.[jt]sx?$/i, // foo.test.ts, foo-test.ts, foo_test.ts
  /[._-]spec\.[jt]sx?$/i, // foo.spec.ts
  /_test\.go$/, // Go: foo_test.go
  /(^|\/)test_[^/]+\.py$/i, // Python: test_foo.py
  /(^|\/)[A-Z][a-zA-Z0-9]*Tests?\.java$/, // Java: FooTest.java / FooTests.java
  /(^|\/)__(tests|mocks)__\//, // __tests__/ / __mocks__/
  /(^|\/)(test|tests|spec)\//, // /test/, /tests/, /spec/
]

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath))
}

/**
 * Check whether ALL references for a flag are in test/spec files. When
 * yes, the flag is unlikely to be a real production toggle — most often
 * it's an SDK-integration test fixture, a prototype that was never
 * deployed, or a leftover from an experiment. Emit a primary stale
 * signal so the user knows.
 *
 * Deliberately requires EVERY reference to be in a test file, not "any".
 * A flag with both test and production references is real production
 * code; this signal is for the all-test-files case only.
 */
function checkTestOnlyReferencesSignal(
  flagName: string,
  occurrences: FeatureFlag[],
): StalenessSignal | null {
  // Defensive guard. The detection pipeline only produces entries in
  // the flags map when at least one occurrence exists, so this branch
  // is unreachable from a real scan; we keep it so the function is
  // safe to call independently from tests or future code paths.
  /* v8 ignore next */
  if (occurrences.length === 0) return null
  if (!occurrences.every((o) => isTestFile(o.filePath))) return null
  return {
    type: 'test-only-references' as const,
    severity: 'warning' as const,
    description: `Flag "${flagName}" is referenced only in test/spec files — likely a forgotten test fixture or never-deployed prototype`,
  }
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Analyze a set of detected feature flags for staleness signals.
 *
 * @param flags  Map of flag name → all occurrences across the codebase.
 * @param options  Staleness configuration (threshold, repo root).
 * @returns Array of flags that have at least one staleness signal.
 */
export async function analyzeStaleness(
  flags: Map<string, FeatureFlag[]>,
  options: StalenessOptions,
): Promise<StaleFlag[]> {
  const { thresholdDays = 30, repoRoot } = options

  // ── 1. Determine whether we can use git blame at all ──
  const shallow = isShallowRepo(repoRoot)

  // ── 2. Collect unique files that need blaming ──
  const fileBlames = new Map<string, Map<number, number> | null>()

  if (!shallow) {
    const filesToBlame = new Set<string>()
    for (const occurrences of flags.values()) {
      for (const flag of occurrences) {
        filesToBlame.add(flag.filePath)
      }
    }

    for (const file of filesToBlame) {
      fileBlames.set(file, blameFile(file, repoRoot))
    }
  }

  // ── 3. Evaluate signals for every flag occurrence ──
  const staleFlags: StaleFlag[] = []

  for (const [flagName, occurrences] of flags) {
    // Low-usage + test-only are per-flag-name (not per-occurrence).
    const lowUsageSignal = checkLowUsageSignal(flagName, occurrences)
    const testOnlySignal = checkTestOnlyReferencesSignal(flagName, occurrences)

    // Pre-check: is this flag marked permanent by ANY platform? The
    // `platform-permanent` cross-reference signal is a CONTROL marker,
    // not a stale signal — it tells us to suppress age + low-usage
    // (those are false positives on kill-switches / operational config).
    // The marker itself never reaches the user-facing signals array.
    const platformSigs = options.platformSignals?.get(flagName)
    const isPermanent = platformSigs?.some((ps) => ps.type === 'platform-permanent') ?? false

    for (const flag of occurrences) {
      const signals: StalenessSignal[] = []
      let age: string | undefined

      // Age signal (git blame) — skipped for permanent flags.
      if (!shallow && !isPermanent) {
        const blame = fileBlames.get(flag.filePath)
        const authorTime = blame?.get(flag.lineNumber)
        const ageResult = checkAgeSignal(authorTime, thresholdDays)
        if (ageResult) {
          signals.push(ageResult.signal)
          age = ageResult.age
        } else if (authorTime !== undefined) {
          age = formatAge(authorTime)
        }
      } else if (!shallow && isPermanent) {
        // Still compute the human-readable age for display, even though
        // we suppress the staleness signal. Operators looking at the
        // output for a permanent flag still benefit from knowing how old
        // it is; we just don't yell about it.
        const blame = fileBlames.get(flag.filePath)
        const authorTime = blame?.get(flag.lineNumber)
        if (authorTime !== undefined) {
          age = formatAge(authorTime)
        }
      }

      // Low-usage signal — skipped for permanent flags.
      if (lowUsageSignal && !isPermanent) {
        signals.push(lowUsageSignal)
      }

      // Test-only references signal. Unlike low-usage, this DOES make
      // a flag stale on its own — production code that's referenced
      // only from test files is genuinely dead from the runtime's
      // perspective. Suppressed for permanent flags (a kill switch
      // intentionally exercised only by tests is a valid setup).
      if (testOnlySignal && !isPermanent) {
        signals.push(testOnlySignal)
      }

      // Hardcoded signal (v2 placeholder — always null for regex v1)
      // checkHardcodedSignal returns null unconditionally; kept for structural symmetry
      // with the other signal detectors. No branch emitted here.

      // Platform signals (from provider API cross-reference).
      // `platform-permanent` is dropped at this seam — it was a control
      // signal, not a user-facing one. `missing-in-platform` and
      // `archived-in-platform` still fire even for permanent flags
      // because those represent platform-state-vs-code mismatches the
      // user genuinely needs to know about.
      if (platformSigs) {
        for (const ps of platformSigs) {
          if (ps.type === 'platform-permanent') continue
          signals.push({
            type: ps.type,
            severity: ps.severity,
            description: ps.description,
          })
        }
      }

      // A flag is stale only if it has at least one PRIMARY signal —
      // anything other than `low-usage`. The single-file/low-usage
      // signal is contributing context, not a stale verdict on its own:
      // plenty of legitimate flags ARE single-file (small isolated
      // features, kill switches, A/B toggles for one screen) and
      // surfacing them as stale floods the output with false positives.
      // When a flag IS stale for another reason, low-usage stays in
      // the signals list because "this is single-file → small cleanup
      // scope" is useful diagnostic for the reviewer.
      // `low-usage` and `coverage-gap-vs-platform` are non-stale-implying
      // signals — `low-usage` is a contributing signal (only stale when paired
      // with another), and `coverage-gap-vs-platform` is purely a detector-
      // quality diagnostic (doesn't make a flag stale; informational only).
      // A flag with only these signals should not appear in staleFlags.
      const hasPrimarySignal = signals.some(
        (s) => s.type !== 'low-usage' && s.type !== 'coverage-gap-vs-platform',
      )
      if (hasPrimarySignal) {
        const stale: StaleFlag = {
          name: flag.name,
          filePath: flag.filePath,
          lineNumber: flag.lineNumber,
          language: flag.language,
          provider: flag.provider ?? 'unknown',
          signals,
          age,
        }
        // Propagate the detection confidence only when it's non-default,
        // matching the FeatureFlag emission contract (absent = 'high').
        if (flag.confidence && flag.confidence !== 'high') {
          stale.confidence = flag.confidence
        }

        // Attach platform-side metadata when available. Each field is
        // optional so the StaleFlag shape stays stable for code-only
        // scans (no platforms configured) and JSON consumers that
        // never expected these fields aren't broken by their presence
        // since they're absent unless explicitly populated.
        const meta = options.platformMetadata?.get(flagName)
        if (meta) {
          if (meta.tags && meta.tags.length > 0) stale.tags = meta.tags
          if (meta.maintainer) stale.maintainer = meta.maintainer
          if (meta.status) stale.platformStatus = meta.status
          if (meta.variations && meta.variations.length > 0) stale.variations = meta.variations
          if (meta.codeReferences !== undefined) stale.codeReferences = meta.codeReferences
        }

        if (options.platformEnvironments) {
          const envData = options.platformEnvironments.get(flagName)
          if (envData && envData.size > 0) {
            stale.environments = envData
          }
        }

        staleFlags.push(stale)
      }
    }
  }

  return staleFlags
}
