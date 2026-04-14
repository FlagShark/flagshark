import { execFileSync, execSync } from 'child_process'

import { type FeatureFlag } from './detection/feature-flag.js'

// ── Public interfaces ──────────────────────────────────────────────

export interface StalenessSignal {
  type: 'age' | 'hardcoded' | 'low-usage'
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
}

export interface StalenessOptions {
  /** Flag lines older than this are considered stale. Default: 6. */
  thresholdMonths: number
  /** Absolute path to the git repository root. */
  repoRoot: string
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
  thresholdMonths: number,
): { signal: StalenessSignal; age: string } | null {
  if (authorTime === undefined) {
    return null
  }

  const thresholdMs = thresholdMonths * 30.44 * 24 * 60 * 60 * 1000
  const ageMs = Date.now() - authorTime * 1000

  if (ageMs < thresholdMs) {
    return null
  }

  const age = formatAge(authorTime)
  return {
    signal: {
      type: 'age' as const,
      description: `Flag reference last modified ${age} (threshold: ${thresholdMonths} months)`,
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
    description: `Flag "${flagName}" only appears in 1 file — may have been fully rolled out`,
  }
}

/**
 * Hardcoded signal — placeholder for tree-sitter v2.
 * Always returns null (no signal) for the regex v1 implementation.
 */
function checkHardcodedSignal(_flag: FeatureFlag): StalenessSignal | null {
  return null
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
  const { thresholdMonths = 6, repoRoot } = options

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
    // Low-usage is per-flag-name (not per-occurrence).
    const lowUsageSignal = checkLowUsageSignal(flagName, occurrences)

    for (const flag of occurrences) {
      const signals: StalenessSignal[] = []
      let age: string | undefined

      // Age signal (git blame)
      if (!shallow) {
        const blame = fileBlames.get(flag.filePath)
        const authorTime = blame?.get(flag.lineNumber)
        const ageResult = checkAgeSignal(authorTime, thresholdMonths)
        if (ageResult) {
          signals.push(ageResult.signal)
          age = ageResult.age
        } else if (authorTime !== undefined) {
          age = formatAge(authorTime)
        }
      }

      // Low-usage signal
      if (lowUsageSignal) {
        signals.push(lowUsageSignal)
      }

      // Hardcoded signal (v2 placeholder)
      const hardcoded = checkHardcodedSignal(flag)
      if (hardcoded) {
        signals.push(hardcoded)
      }

      // Only include flags that have at least one signal.
      if (signals.length > 0) {
        staleFlags.push({
          name: flag.name,
          filePath: flag.filePath,
          lineNumber: flag.lineNumber,
          language: flag.language,
          provider: flag.provider ?? 'unknown',
          signals,
          age,
        })
      }
    }
  }

  return staleFlags
}
