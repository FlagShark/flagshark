# Output Formats — Markdown + CSV + SARIF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `markdown`, `csv`, and `sarif` output formats to FlagShark. Refactor the GitHub Action's hand-rolled markdown template to use the shared formatter. Add an `output-format` Action input and a `sarif:` Action input that writes a [SARIF v2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) file consumable by GitHub Code Scanning. Ships as `v1.4.0`.

**Architecture:** Move format-specific output code into `@flagshark/core/output/` — one file per format, pure functions of `ScanRepoResult → string`. Both CLI and Action import from there. A `selectFormatter(name)` dispatcher returns the right formatter. The CLI gains `--format <name>` (with `--json` retained as a deprecated alias) and `--output <path>`. The Action gains `output-format: markdown | none` (default markdown) and `sarif: <path>` (off by default).

**Tech Stack:**
- Pure TypeScript + vitest (no new runtime dependencies)
- SARIF JSON schema v2.1.0
- RFC 4180 CSV

**Spec:** [docs/superpowers/specs/2026-05-11-output-and-customizability-design.md](../specs/2026-05-11-output-and-customizability-design.md) §§3, 5.3, 5.4, 5.5, 9, 11 (P3 + P4).

---

## Reference: file layout after this plan

```
packages/core/
├── src/
│   ├── output/                             # NEW
│   │   ├── index.ts                        # re-exports + selectFormatter
│   │   ├── text.ts                         # formatText (moved from CLI)
│   │   ├── json.ts                         # formatJson (moved from CLI)
│   │   ├── markdown.ts                     # NEW — formatMarkdown
│   │   ├── csv.ts                          # NEW — formatCsv
│   │   ├── sarif.ts                        # NEW — formatSarif
│   │   └── shared.ts                       # NEW — helpers (uniqueStaleCount, healthEmoji, level mapping)
│   └── index.ts                            # re-export output module
└── test/
    └── output/
        ├── text.test.ts                    # moved from packages/cli/test/formatter.test.ts
        ├── json.test.ts                    # NEW (split out from formatter.test.ts)
        ├── markdown.test.ts                # NEW
        ├── csv.test.ts                     # NEW
        ├── sarif.test.ts                   # NEW
        └── select.test.ts                  # NEW — dispatcher tests

packages/cli/
├── src/
│   ├── cli.ts                              # --format <name> + --output <file>
│   └── formatter.ts                        # thin shim — re-exports from @flagshark/core/output (kept for back-compat)
└── test/
    └── formatter.test.ts                   # DELETED — replaced by core/test/output/text.test.ts

packages/action/
├── action.yml                              # +output-format, +sarif inputs
└── src/
    └── index.ts                            # uses formatMarkdown from core; optional SARIF write via formatSarif
```

---

## Milestone map

| M | Outcome | Commit message |
|---|---|---|
| M0 | Worktree + branch | (no commit) |
| M1 | Move text+json formatters into core/output; CLI imports from core. Zero behavior change. | refactor(core): move output formatters into @flagshark/core |
| M2 | Markdown formatter (TDD) | feat(core): add markdown output formatter |
| M3 | CSV formatter (TDD) | feat(core): add CSV output formatter |
| M4 | SARIF formatter (TDD) | feat(core): add SARIF v2.1.0 output formatter |
| M5 | `selectFormatter` dispatcher (TDD) | feat(core): add selectFormatter dispatcher |
| M6 | CLI `--format` + `--output` flags (keep `--json` as alias) | feat(cli): add --format and --output flags |
| M7 | Action refactor — use markdown formatter, add `output-format` input | feat(action): use shared markdown formatter, add output-format input |
| M8 | Action `sarif:` input — writes SARIF file | feat(action): add sarif input for GitHub Code Scanning |
| M9 | PR (pause for user before push) | (PR opened) |

---

## Milestone M0 — Worktree

### Task 0.1: Create worktree

- [ ] **Step 0.1.1: Create worktree off main**

```bash
cd /Users/joe/projects/flagshark
git worktree add ../flagshark-output-formats -b feat/output-formats main
cd ../flagshark-output-formats
bun install
bun run test
```

Expected: bun install completes; baseline tests pass (98 core + 6 CLI = 104).

---

## Milestone M1 — Move text + json into `@flagshark/core/output/`

Goal: relocate the existing text and json formatters into core, with no behavior changes. CLI imports from core. The CLI's `formatter.ts` becomes a thin re-export shim so existing imports keep working.

### Task 1.1: Create `packages/core/src/output/text.ts`

**Files:**
- Create: `packages/core/src/output/text.ts`
- Reference: existing `packages/cli/src/formatter.ts:1-151`

- [ ] **Step 1.1.1: Copy `formatText` + helpers from CLI's formatter.ts**

Create `packages/core/src/output/text.ts` with the contents:

```ts
/**
 * Human-readable text output for FlagShark scan results.
 */

import type { ScanRepoResult, StaleFlag } from '../scan-repo.js'

export interface TextFormatOptions {
  verbose: boolean
  /** Max stale flags to show before truncating. Default: 10. Ignored if verbose. */
  maxDisplay: number
}

/** Pad a string to a fixed width, truncating with ellipsis if necessary. */
function pad(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + '…'
  }
  return str.padEnd(width)
}

function buildTable(flags: StaleFlag[]): string {
  const cols = { flag: 16, file: 22, added: 13, signal: 28 }

  const hBorder = (left: string, mid: string, right: string) =>
    `${left}${'─'.repeat(cols.flag + 2)}${mid}${'─'.repeat(cols.file + 2)}${mid}${'─'.repeat(cols.added + 2)}${mid}${'─'.repeat(cols.signal + 2)}${right}`

  const lines: string[] = []
  lines.push(hBorder('┌', '┬', '┐'))
  lines.push(
    `│ ${pad('Flag', cols.flag)} │ ${pad('File', cols.file)} │ ${pad('Added', cols.added)} │ ${pad('Signal', cols.signal)} │`,
  )
  lines.push(hBorder('├', '┼', '┤'))

  for (const sf of flags) {
    const fileRef = `${sf.filePath}:${sf.lineNumber}`
    const signalText = sf.signals
      .map((s) => {
        if (s.type === 'age') return 'Age > threshold'
        if (s.type === 'low-usage') return 'Single file'
        return s.description
      })
      .join(', ')
    lines.push(
      `│ ${pad(sf.name, cols.flag)} │ ${pad(fileRef, cols.file)} │ ${pad(sf.age ?? 'unknown', cols.added)} │ ${pad(signalText, cols.signal)} │`,
    )
  }

  lines.push(hBorder('└', '┴', '┘'))
  return lines.join('\n')
}

export function formatText(result: ScanRepoResult, options: TextFormatOptions): string {
  const lines: string[] = []

  lines.push(`\u{1F988} FlagShark`)
  lines.push('')

  const langCount = Object.keys(result.languageBreakdown).length
  lines.push(`Scanned ${result.filesScanned} files across ${langCount} language${langCount === 1 ? '' : 's'}`)
  if (result.excludedCount && result.excludedCount > 0) {
    lines.push(`(${result.excludedCount} excluded via .flagsharkignore + excludes)`)
  }

  if (result.totalFlags === 0) {
    lines.push('No feature flags detected.')
    lines.push('')
    lines.push('Supported providers: LaunchDarkly, Unleash, Flipt, Split.io, PostHog, and more.')
    lines.push('Run flagshark scan --help for configuration options.')
    return lines.join('\n')
  }

  if (result.detectedProviders.length > 0) {
    lines.push(`Detected providers: ${result.detectedProviders.join(', ')}`)
  }

  const uniqueStaleNames = new Set(result.staleFlags.map((f) => f.name))
  const staleCount = uniqueStaleNames.size
  lines.push(`Found ${result.totalFlags} feature flags, ${staleCount} stale`)

  if (staleCount > 0) {
    lines.push('')
    lines.push('Stale flags:')
    const displayCount = options.verbose ? staleCount : Math.min(staleCount, options.maxDisplay)
    const displayFlags = result.staleFlags.slice(0, displayCount)
    lines.push(buildTable(displayFlags))
    const remaining = staleCount - displayCount
    if (remaining > 0) {
      lines.push('')
      lines.push(`... and ${remaining} more (use --verbose to see all)`)
    }
  }

  lines.push('')
  if (staleCount === 0) {
    lines.push(`Flag Health Score: ${result.healthScore}/100 ✓ All flags look healthy!`)
  } else {
    lines.push(
      `Flag Health Score: ${result.healthScore}/100 (${staleCount}/${result.totalFlags} flags are stale)`,
    )
    lines.push('')
    lines.push('Automate cleanup → https://flagshark.com')
    lines.push('Open source CLI  → https://github.com/FlagShark/flagshark')
  }

  if (result.excludedPaths && result.excludedPaths.length > 0) {
    lines.push('')
    lines.push(`Excluded files (${result.excludedPaths.length}):`)
    for (const p of result.excludedPaths) {
      lines.push(`  ${p}`)
    }
  }

  return lines.join('\n')
}
```

Note: I removed the hardcoded `const VERSION = '1.2.0'` constant — the version belongs to the CLI, not the formatter library. The header now reads `🦈 FlagShark` (no version). The CLI can prepend `v${VERSION}` if it wants.

### Task 1.2: Create `packages/core/src/output/json.ts`

**Files:**
- Create: `packages/core/src/output/json.ts`

- [ ] **Step 1.2.1: Copy `formatJson` from CLI's formatter.ts (lines 153-193)**

```ts
/**
 * JSON output for FlagShark scan results.
 *
 * This is the STABLE OUTPUT API — downstream tooling (the Action, custom CI
 * scripts, the hosted SaaS) can rely on the shape produced here.
 */

import type { ScanRepoResult } from '../scan-repo.js'

export interface JsonFormatOptions {
  /** Library version to embed in the output (`version` field). */
  version: string
}

export function formatJson(result: ScanRepoResult, options: JsonFormatOptions): string {
  const languages: Record<string, number> = { ...result.languageBreakdown }

  const flags = result.staleFlags.map((sf) => ({
    name: sf.name,
    file: sf.filePath,
    line: sf.lineNumber,
    language: sf.language,
    provider: sf.provider,
    stale: true,
    signals: sf.signals.map((s) => ({ type: s.type, description: s.description })),
    age: sf.age ?? null,
  }))

  const output = {
    version: options.version,
    totalFlags: result.totalFlags,
    staleFlags: new Set(result.staleFlags.map((f) => f.name)).size,
    healthScore: result.healthScore,
    detectedProviders: result.detectedProviders,
    languages,
    flags,
    excludedPaths: result.excludedPaths,
    scanDuration: result.scanDuration,
    links: {
      dashboard: 'https://flagshark.com',
      cli: 'https://github.com/FlagShark/flagshark',
      npm: 'https://www.npmjs.com/package/flagshark',
    },
  }

  return JSON.stringify(output, null, 2)
}
```

Note: `version` is now an option, not a hardcoded constant — the CLI passes its own version in.

### Task 1.3: Create `packages/core/src/output/index.ts`

**Files:**
- Create: `packages/core/src/output/index.ts`

- [ ] **Step 1.3.1: Write the public API**

```ts
export { formatText, type TextFormatOptions } from './text.js'
export { formatJson, type JsonFormatOptions } from './json.js'
```

### Task 1.4: Re-export from `packages/core/src/index.ts`

- [ ] **Step 1.4.1: Append the re-export**

In `packages/core/src/index.ts`, add at the end:

```ts
// Output formatters
export * from './output/index.js'
```

### Task 1.5: Move + refactor tests

**Files:**
- Create: `packages/core/test/output/text.test.ts` (migrated from `packages/cli/test/formatter.test.ts`)
- Delete: `packages/cli/test/formatter.test.ts`

- [ ] **Step 1.5.1: Read existing tests**

```bash
cat /Users/joe/projects/flagshark-output-formats/packages/cli/test/formatter.test.ts
```

- [ ] **Step 1.5.2: Move into core, update imports**

Create `packages/core/test/output/text.test.ts` with the same test cases but imports from `../../src/output/text.js` and `../../src/output/json.js` instead of the CLI's formatter file. Adjust any references to the removed `version` field — for `formatJson` tests, pass `version: 'test'` explicitly.

Run:
```bash
cd packages/core && bun run test text
```

Expected: tests pass.

- [ ] **Step 1.5.3: Delete the old CLI test file**

```bash
rm /Users/joe/projects/flagshark-output-formats/packages/cli/test/formatter.test.ts
```

### Task 1.6: Update the CLI to import from core

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/formatter.ts` (becomes a thin shim)

- [ ] **Step 1.6.1: Make `packages/cli/src/formatter.ts` a re-export shim**

Replace its contents with:

```ts
/**
 * @deprecated — formatters moved into @flagshark/core/output. Import from
 * `@flagshark/core` directly. This shim exists for one minor release and will
 * be removed in v2.0.
 */
export { formatText, formatJson } from '@flagshark/core'
export type { TextFormatOptions, JsonFormatOptions } from '@flagshark/core'
```

- [ ] **Step 1.6.2: Update `packages/cli/src/cli.ts` to import directly from core and pass version**

Find the existing import:

```ts
import { formatText, formatJson } from './formatter.js'
```

Replace with:

```ts
import { formatText, formatJson } from '@flagshark/core'
```

Find the `formatJson(result)` call and pass `version: VERSION` (the `VERSION` constant should already be in scope at line ~14 of cli.ts):

```ts
const output = args.json ? formatJson(result, { version: VERSION }) : formatText(result, {
  verbose: args.verbose,
  maxDisplay: 10,
})
```

Adjust `formatText` invocation similarly — it now takes `{ verbose, maxDisplay }` (drops the old `json` boolean).

- [ ] **Step 1.6.3: Rebuild core**

```bash
cd /Users/joe/projects/flagshark-output-formats
bun run --filter '@flagshark/core' build
```

- [ ] **Step 1.6.4: Run full suite**

```bash
bun run test
bun run typecheck
```

Expected: all tests pass. The previous CLI formatter test count (6) is now in core; total tests in core grew by 6 (98 → 104). Total CLI tests dropped by 6 (6 → 0).

If `formatJson` tests assumed the version was hardcoded to `1.2.0` or whatever, update them to assert the version passed in explicitly.

### Task 1.7: Commit

- [ ] **Step 1.7.1: Commit M1**

```bash
git add packages/core/src/output/ packages/core/src/index.ts packages/core/test/output/ \
        packages/cli/src/cli.ts packages/cli/src/formatter.ts \
        packages/cli/test/formatter.test.ts  # deletion
git commit -m "refactor(core): move output formatters into @flagshark/core

- formatText + formatJson now live in @flagshark/core/output
- CLI's formatter.ts is a thin deprecated re-export shim
- formatJson takes an explicit { version } option (was hardcoded)
- Tests migrated from packages/cli/test/formatter.test.ts to
  packages/core/test/output/text.test.ts"
```

---

## Milestone M2 — Markdown formatter (TDD)

### Task 2.1: Define the markdown formatter shape

**Files:**
- Create: `packages/core/src/output/markdown.ts`
- Create: `packages/core/src/output/shared.ts`
- Create: `packages/core/test/output/markdown.test.ts`

- [ ] **Step 2.1.1: Write `shared.ts` helpers (TDD-free — pure helpers)**

`packages/core/src/output/shared.ts`:

```ts
import type { StaleFlag } from '../staleness.js'

/** Returns the count of unique stale flag names (de-duped across occurrences). */
export function uniqueStaleCount(stale: StaleFlag[]): number {
  return new Set(stale.map((f) => f.name)).size
}

/** Map health score to an emoji used in markdown + SARIF + Action summary. */
export function healthEmoji(score: number): string {
  if (score >= 90) return '🟢'
  if (score >= 70) return '🟡'
  if (score >= 40) return '🟠'
  return '🔴'
}

/**
 * SARIF severity level mapping based on number of staleness signals on a flag.
 *   1 signal  → 'note'
 *   2 signals → 'warning'
 *   3+ signals → 'error'
 */
export function sarifLevel(signalCount: number): 'note' | 'warning' | 'error' {
  if (signalCount >= 3) return 'error'
  if (signalCount === 2) return 'warning'
  return 'note'
}
```

- [ ] **Step 2.1.2: Write the failing markdown test**

`packages/core/test/output/markdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { formatMarkdown } from '../../src/output/markdown.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeResult(overrides: Partial<ScanRepoResult> = {}): ScanRepoResult {
  return {
    totalFlags: 0,
    filesScanned: 0,
    staleFlags: [],
    detectedProviders: [],
    languageBreakdown: {},
    healthScore: 100,
    scanDuration: 0,
    ...overrides,
  } as ScanRepoResult
}

describe('formatMarkdown', () => {
  it('emits the "all healthy" header when no stale flags', () => {
    const md = formatMarkdown(makeResult({ totalFlags: 5, filesScanned: 12 }), {
      scanMode: 'full',
    })
    expect(md).toContain('## 🦈 FlagShark — All flags healthy')
    expect(md).toContain('🟢 **Health Score: 100/100**')
  })

  it('emits the stale-count header when stale flags exist', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 10,
        filesScanned: 50,
        healthScore: 70,
        staleFlags: [
          {
            name: 'CHECKOUT_V2',
            filePath: 'src/checkout.ts',
            lineNumber: 47,
            language: 'typescript',
            provider: 'launchdarkly',
            signals: [{ type: 'age', description: 'Flag reference last modified 14 months ago' }],
            age: '14 months ago',
          },
        ],
      }),
      { scanMode: 'changed' },
    )
    expect(md).toContain('## 🦈 FlagShark — 1 stale flag found')
    expect(md).toContain('🟡 **Health Score: 70/100**')
    expect(md).toContain('| `CHECKOUT_V2` |')
    expect(md).toContain('14 months ago')
  })

  it('pluralizes the header for multiple stale flags', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 10,
        healthScore: 50,
        staleFlags: [
          { name: 'A', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly', signals: [{ type: 'age', description: 'old' }], age: '12 months ago' },
          { name: 'B', filePath: 'b.ts', lineNumber: 2, language: 'typescript', provider: 'launchdarkly', signals: [{ type: 'age', description: 'old' }], age: '12 months ago' },
        ],
      }),
      { scanMode: 'full' },
    )
    expect(md).toContain('2 stale flags found')
    expect(md).toContain('🟠 **Health Score: 50/100**')
  })

  it('emits a stats table with the standard metrics', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 23,
        filesScanned: 156,
        healthScore: 70,
        scanDuration: 2300,
        detectedProviders: ['launchdarkly', 'unleash'],
        languageBreakdown: { typescript: 100, go: 56 },
      }),
      { scanMode: 'full' },
    )
    expect(md).toContain('| Flags detected | 23 |')
    expect(md).toContain('| Stale flags | 0 |')
    expect(md).toContain('| Scan time | 2300ms |')
    expect(md).toContain('typescript (100)')
    expect(md).toContain('launchdarkly, unleash')
  })

  it('applies linkPrefix when provided (Action use case)', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 1,
        healthScore: 60,
        staleFlags: [{
          name: 'X', filePath: 'src/x.ts', lineNumber: 5, language: 'typescript',
          provider: 'launchdarkly', signals: [{ type: 'age', description: 'old' }], age: '12 months ago',
        }],
      }),
      { scanMode: 'changed', linkPrefix: 'https://github.com/owner/repo/blob/abc123/' },
    )
    expect(md).toContain('https://github.com/owner/repo/blob/abc123/src/x.ts#L5')
  })

  it('includes the comment marker when commentMarker option is set', () => {
    const md = formatMarkdown(makeResult({ totalFlags: 0, filesScanned: 1 }), {
      scanMode: 'full',
      commentMarker: '<!-- flagshark-action -->',
    })
    expect(md.startsWith('<!-- flagshark-action -->\n')).toBe(true)
  })

  it('truncates after 20 flags with "... and N more" note', () => {
    const staleFlags = Array.from({ length: 25 }, (_, i) => ({
      name: `FLAG_${i}`,
      filePath: `src/file${i}.ts`,
      lineNumber: i + 1,
      language: 'typescript',
      provider: 'launchdarkly',
      signals: [{ type: 'age' as const, description: 'old' }],
      age: '12 months ago',
    }))
    const md = formatMarkdown(makeResult({ totalFlags: 25, staleFlags }), { scanMode: 'full' })
    expect(md).toContain('FLAG_19')
    expect(md).not.toContain('FLAG_20')
    expect(md).toContain('and 5 more')
  })

  it('includes the footer with links', () => {
    const md = formatMarkdown(makeResult({ totalFlags: 1, filesScanned: 1 }), { scanMode: 'full' })
    expect(md).toContain('https://github.com/FlagShark/flagshark')
    expect(md).toContain('https://flagshark.com')
  })
})
```

- [ ] **Step 2.1.3: Run, confirm fail**

```bash
cd packages/core && bun run test markdown
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 2.1.4: Implement `markdown.ts`**

`packages/core/src/output/markdown.ts`:

```ts
/**
 * Markdown output for FlagShark scan results.
 *
 * Used in two places:
 *   1. CLI: `flagshark scan --format markdown > REPORT.md`
 *   2. GitHub Action: PR comment body
 *
 * The Action passes `linkPrefix` so file paths render as absolute GitHub URLs;
 * the CLI omits the prefix and uses relative paths.
 */

import type { ScanRepoResult, StaleFlag } from '../scan-repo.js'

import { uniqueStaleCount, healthEmoji } from './shared.js'

export interface MarkdownFormatOptions {
  /** 'full' or 'changed' — drives the "scan mode" label in the stats table. */
  scanMode: 'full' | 'changed'
  /** Prefix for file links (e.g. `https://github.com/owner/repo/blob/<sha>/`). When set, file paths become absolute URLs. */
  linkPrefix?: string
  /** HTML comment to prepend (used by the Action to find + update its own comment). */
  commentMarker?: string
  /** Cap on rendered stale flags before "...and N more". Default: 20. */
  maxStaleFlags?: number
}

const DEFAULT_MAX_STALE = 20

export function formatMarkdown(result: ScanRepoResult, options: MarkdownFormatOptions): string {
  const staleCount = uniqueStaleCount(result.staleFlags)
  const emoji = healthEmoji(result.healthScore)
  const modeLabel = options.scanMode === 'full' ? 'Full repo scan' : 'Changed files only'
  const maxStale = options.maxStaleFlags ?? DEFAULT_MAX_STALE

  const langList = Object.entries(result.languageBreakdown)
    .map(([l, c]) => `${l} (${c})`)
    .join(', ')
  const providerList = result.detectedProviders.length > 0
    ? result.detectedProviders.slice(0, 5).join(', ') +
      (result.detectedProviders.length > 5 ? ` +${result.detectedProviders.length - 5} more` : '')
    : 'none detected'

  let body = ''
  if (options.commentMarker) {
    body += `${options.commentMarker}\n`
  }

  // Header
  if (staleCount === 0) {
    body += `## 🦈 FlagShark — All flags healthy\n\n`
  } else {
    body += `## 🦈 FlagShark — ${staleCount} stale flag${staleCount !== 1 ? 's' : ''} found\n\n`
  }

  // Health badge
  body += `${emoji} **Health Score: ${result.healthScore}/100**\n\n`

  // Stats table
  body += `| Metric | Value |\n`
  body += `|--------|-------|\n`
  body += `| Flags detected | ${result.totalFlags} |\n`
  body += `| Stale flags | ${staleCount} |\n`
  body += `| Languages | ${langList || 'none'} |\n`
  body += `| Providers | ${providerList} |\n`
  body += `| Scan mode | ${modeLabel} |\n`
  body += `| Scan time | ${result.scanDuration}ms |\n\n`

  // Stale flags table
  if (staleCount > 0) {
    body += `<details${staleCount <= 5 ? ' open' : ''}>\n`
    body += `<summary><strong>Stale flags (${staleCount})</strong></summary>\n\n`
    body += '| Flag | File | Age | Why it looks stale |\n'
    body += '|------|------|-----|--------------------|\n'

    const displayFlags = result.staleFlags.slice(0, maxStale)
    for (const flag of displayFlags) {
      body += `| ${formatRow(flag, options.linkPrefix)} |\n`
    }

    if (result.staleFlags.length > maxStale) {
      body += `\n*... and ${result.staleFlags.length - maxStale} more. Run \`npx flagshark scan --verbose\` locally for the full list.*\n`
    }
    body += '\n</details>\n\n'
  }

  // Footer
  body += '---\n'
  body += `*[FlagShark](https://github.com/FlagShark/flagshark) finds stale feature flags before they cause incidents*\n\n`
  body += `[Automate flag cleanup](https://flagshark.com) · `
  body += `[Install CLI](https://www.npmjs.com/package/flagshark) · `
  body += `[Open source](https://github.com/FlagShark/flagshark)\n`

  return body
}

function formatRow(flag: StaleFlag, linkPrefix?: string): string {
  const signals = flag.signals.map((s) => s.description).join(', ')
  const shortPath = flag.filePath.replace(/^\.\//, '')
  const fileCell = linkPrefix
    ? `[${shortPath}:${flag.lineNumber}](${linkPrefix}${shortPath}#L${flag.lineNumber})`
    : `\`${shortPath}:${flag.lineNumber}\``
  return `\`${flag.name}\` | ${fileCell} | ${flag.age || 'unknown'} | ${signals}`
}
```

- [ ] **Step 2.1.5: Re-export from `packages/core/src/output/index.ts`**

Append:

```ts
export { formatMarkdown, type MarkdownFormatOptions } from './markdown.js'
```

- [ ] **Step 2.1.6: Run, confirm pass**

```bash
cd packages/core && bun run test markdown
```

Expected: 8 tests pass.

- [ ] **Step 2.1.7: Run full suite, typecheck**

```bash
bun run test
bun run typecheck
```

### Task 2.2: Commit

- [ ] **Step 2.2.1: Commit M2**

```bash
git add packages/core/src/output/markdown.ts \
        packages/core/src/output/shared.ts \
        packages/core/src/output/index.ts \
        packages/core/test/output/markdown.test.ts
git commit -m "feat(core): add markdown output formatter

Used by --format markdown in the CLI and the GitHub Action's PR
comment (replacing the hand-rolled markdown template). Supports
linkPrefix for Action-context absolute file links, and commentMarker
for the Action's update-in-place workflow."
```

---

## Milestone M3 — CSV formatter (TDD)

### Task 3.1: TDD CSV

**Files:**
- Create: `packages/core/src/output/csv.ts`
- Create: `packages/core/test/output/csv.test.ts`

- [ ] **Step 3.1.1: Failing test**

`packages/core/test/output/csv.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { formatCsv } from '../../src/output/csv.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeResult(overrides: Partial<ScanRepoResult> = {}): ScanRepoResult {
  return {
    totalFlags: 0,
    filesScanned: 0,
    staleFlags: [],
    detectedProviders: [],
    languageBreakdown: {},
    healthScore: 100,
    scanDuration: 0,
    ...overrides,
  } as ScanRepoResult
}

describe('formatCsv', () => {
  it('emits only the header row when no stale flags', () => {
    expect(formatCsv(makeResult())).toBe(
      'flag,file,line,language,provider,signals,age\n',
    )
  })

  it('emits one row per stale flag', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [
          {
            name: 'CHECKOUT_V2',
            filePath: 'src/checkout.ts',
            lineNumber: 47,
            language: 'typescript',
            provider: 'launchdarkly',
            signals: [{ type: 'age', description: 'Flag reference last modified 14 months ago' }],
            age: '14 months ago',
          },
        ],
      }),
    )
    const lines = csv.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('flag,file,line,language,provider,signals,age')
    expect(lines[1]).toBe('"CHECKOUT_V2","src/checkout.ts",47,"typescript","launchdarkly","age","14 months ago"')
  })

  it('joins multiple signals with semicolons', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'unleash',
          signals: [
            { type: 'age', description: 'old' },
            { type: 'low-usage', description: 'single file' },
          ],
          age: '12 months ago',
        }],
      }),
    )
    expect(csv).toContain('"age; low-usage"')
  })

  it('escapes double quotes by doubling (RFC 4180)', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'FLAG"WITH"QUOTES',
          filePath: 'src/"weird".ts',
          lineNumber: 1,
          language: 'typescript',
          provider: 'launchdarkly',
          signals: [{ type: 'age', description: 'old' }],
          age: '12 months ago',
        }],
      }),
    )
    expect(csv).toContain('"FLAG""WITH""QUOTES"')
    expect(csv).toContain('"src/""weird"".ts"')
  })

  it('handles missing age as empty string', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [{ type: 'age', description: 'old' }],
          // age omitted
        }],
      }),
    )
    expect(csv).toMatch(/,""\n$/)
  })

  it('does not include empty trailing newline beyond the data', () => {
    const csv = formatCsv(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [{ type: 'age', description: 'old' }],
          age: '12 months ago',
        }],
      }),
    )
    // Should end with a single \n after the data row.
    expect(csv.endsWith('"12 months ago"\n')).toBe(true)
  })
})
```

- [ ] **Step 3.1.2: Run, fail**

```bash
cd packages/core && bun run test csv
```

- [ ] **Step 3.1.3: Implement**

`packages/core/src/output/csv.ts`:

```ts
/**
 * RFC 4180-compliant CSV output. One row per stale flag.
 *
 * Header columns: flag, file, line, language, provider, signals, age
 * Multi-value `signals` are joined with `; ` inside a single quoted cell.
 */

import type { ScanRepoResult } from '../scan-repo.js'

const HEADER = 'flag,file,line,language,provider,signals,age'

/** RFC 4180 cell escape: wrap in quotes; double any internal quotes. */
function csvCell(value: string | number | undefined): string {
  const s = value == null ? '' : String(value)
  return `"${s.replace(/"/g, '""')}"`
}

export function formatCsv(result: ScanRepoResult): string {
  const lines: string[] = [HEADER]

  for (const flag of result.staleFlags) {
    const signals = flag.signals.map((s) => s.type).join('; ')
    lines.push(
      [
        csvCell(flag.name),
        csvCell(flag.filePath),
        String(flag.lineNumber),
        csvCell(flag.language),
        csvCell(flag.provider),
        csvCell(signals),
        csvCell(flag.age),
      ].join(','),
    )
  }

  return lines.join('\n') + '\n'
}
```

- [ ] **Step 3.1.4: Export**

Append to `packages/core/src/output/index.ts`:

```ts
export { formatCsv } from './csv.js'
```

- [ ] **Step 3.1.5: Run, pass**

```bash
bun run test csv
```

Expected: 6 tests pass.

### Task 3.2: Commit

```bash
git add packages/core/src/output/csv.ts packages/core/src/output/index.ts \
        packages/core/test/output/csv.test.ts
git commit -m "feat(core): add CSV output formatter"
```

---

## Milestone M4 — SARIF formatter (TDD)

### Task 4.1: TDD SARIF

**Files:**
- Create: `packages/core/src/output/sarif.ts`
- Create: `packages/core/test/output/sarif.test.ts`

- [ ] **Step 4.1.1: Failing test**

`packages/core/test/output/sarif.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { formatSarif } from '../../src/output/sarif.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

function makeResult(overrides: Partial<ScanRepoResult> = {}): ScanRepoResult {
  return {
    totalFlags: 0,
    filesScanned: 0,
    staleFlags: [],
    detectedProviders: [],
    languageBreakdown: {},
    healthScore: 100,
    scanDuration: 0,
    ...overrides,
  } as ScanRepoResult
}

describe('formatSarif', () => {
  it('emits a valid SARIF v2.1.0 envelope', () => {
    const sarif = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json')
    expect(sarif.version).toBe('2.1.0')
    expect(Array.isArray(sarif.runs)).toBe(true)
    expect(sarif.runs).toHaveLength(1)
  })

  it('includes the tool driver metadata with the passed version', () => {
    const sarif = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    expect(sarif.runs[0].tool.driver.name).toBe('FlagShark')
    expect(sarif.runs[0].tool.driver.version).toBe('1.4.0')
    expect(sarif.runs[0].tool.driver.informationUri).toBe('https://github.com/FlagShark/flagshark')
  })

  it('declares the three rules: stale-age, stale-low-usage, stale-hardcoded', () => {
    const sarif = JSON.parse(formatSarif(makeResult(), { version: '1.4.0' }))
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id).sort()
    expect(ruleIds).toEqual(['stale-age', 'stale-hardcoded', 'stale-low-usage'])
  })

  it('emits one result per stale flag', () => {
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [
          {
            name: 'CHECKOUT_V2',
            filePath: 'src/checkout.ts',
            lineNumber: 47,
            language: 'typescript',
            provider: 'launchdarkly',
            signals: [{ type: 'age', description: 'Flag reference last modified 14 months ago' }],
            age: '14 months ago',
          },
        ],
      }),
      { version: '1.4.0' },
    ))
    const results = sarif.runs[0].results
    expect(results).toHaveLength(1)
    expect(results[0].ruleId).toBe('stale-age')
    expect(results[0].level).toBe('note')
    expect(results[0].message.text).toContain('CHECKOUT_V2')
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/checkout.ts')
    expect(results[0].locations[0].physicalLocation.region.startLine).toBe(47)
    expect(results[0].properties.flag).toBe('CHECKOUT_V2')
    expect(results[0].properties.provider).toBe('launchdarkly')
  })

  it('maps signal count to severity: 1 signal = note, 2 = warning, 3+ = error', () => {
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [
          {
            name: 'ONE', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
            signals: [{ type: 'age', description: 'old' }], age: '12 months ago',
          },
          {
            name: 'TWO', filePath: 'b.ts', lineNumber: 2, language: 'typescript', provider: 'launchdarkly',
            signals: [
              { type: 'age', description: 'old' },
              { type: 'low-usage', description: 'single' },
            ],
            age: '12 months ago',
          },
        ],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results.find((r: { properties: { flag: string } }) => r.properties.flag === 'ONE').level).toBe('note')
    expect(sarif.runs[0].results.find((r: { properties: { flag: string } }) => r.properties.flag === 'TWO').level).toBe('warning')
  })

  it('picks rule id from the first signal (deterministic)', () => {
    const sarif = JSON.parse(formatSarif(
      makeResult({
        staleFlags: [{
          name: 'X', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly',
          signals: [
            { type: 'low-usage', description: 'single' },
            { type: 'age', description: 'old' },
          ],
          age: '12 months ago',
        }],
      }),
      { version: '1.4.0' },
    ))
    expect(sarif.runs[0].results[0].ruleId).toBe('stale-low-usage')
  })
})
```

- [ ] **Step 4.1.2: Run, fail**

```bash
cd packages/core && bun run test sarif
```

- [ ] **Step 4.1.3: Implement**

`packages/core/src/output/sarif.ts`:

```ts
/**
 * SARIF v2.1.0 output for FlagShark scan results.
 *
 * Consumable directly by `github/codeql-action/upload-sarif` so stale flags
 * appear in the repo's Security → Code Scanning tab — same UX as CodeQL,
 * ESLint with SARIF output, etc.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import type { ScanRepoResult, StaleFlag } from '../scan-repo.js'

import { sarifLevel } from './shared.js'

export interface SarifFormatOptions {
  /** Tool driver version (the FlagShark release version). */
  version: string
}

interface SarifResult {
  ruleId: string
  level: 'note' | 'warning' | 'error'
  message: { text: string }
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string }
      region: { startLine: number }
    }
  }>
  properties: Record<string, string | number | undefined>
}

const RULES = [
  {
    id: 'stale-age',
    name: 'Stale by age',
    shortDescription: { text: 'Flag reference older than the configured threshold' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  {
    id: 'stale-low-usage',
    name: 'Stale by usage',
    shortDescription: { text: 'Flag appears in only one file across the repo' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  {
    id: 'stale-hardcoded',
    name: 'Stale by hardcoded variation',
    shortDescription: { text: 'Flag call uses a constant default — the flag may be permanently removed upstream' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
] as const

export function formatSarif(result: ScanRepoResult, options: SarifFormatOptions): string {
  const results: SarifResult[] = result.staleFlags.map((flag) => toSarifResult(flag))

  const envelope = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'FlagShark',
            version: options.version,
            informationUri: 'https://github.com/FlagShark/flagshark',
            rules: RULES,
          },
        },
        results,
      },
    ],
  }

  return JSON.stringify(envelope, null, 2)
}

function toSarifResult(flag: StaleFlag): SarifResult {
  const firstSignal = flag.signals[0]
  const ruleId = firstSignal?.type === 'age'
    ? 'stale-age'
    : firstSignal?.type === 'low-usage'
      ? 'stale-low-usage'
      : 'stale-hardcoded'

  return {
    ruleId,
    level: sarifLevel(flag.signals.length),
    message: {
      text: `Flag "${flag.name}" appears stale. ${flag.signals.map((s) => s.description).join('; ')}`,
    },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: flag.filePath.replace(/^\.\//, '') },
        region: { startLine: flag.lineNumber },
      },
    }],
    properties: {
      flag: flag.name,
      provider: flag.provider,
      language: flag.language,
      age: flag.age ?? '',
    },
  }
}
```

- [ ] **Step 4.1.4: Export**

Append to `packages/core/src/output/index.ts`:

```ts
export { formatSarif, type SarifFormatOptions } from './sarif.js'
```

- [ ] **Step 4.1.5: Run, pass**

```bash
bun run test sarif
```

Expected: 6 tests pass.

### Task 4.2: Commit

```bash
git add packages/core/src/output/sarif.ts packages/core/src/output/index.ts \
        packages/core/test/output/sarif.test.ts
git commit -m "feat(core): add SARIF v2.1.0 output formatter

Consumable by github/codeql-action/upload-sarif so stale flags appear
in the repo's Security tab. Level mapping: 1 signal = note,
2 = warning, 3+ = error. Forward-compat for the future hardcoded
signal (T6) which is already in the rule list."
```

---

## Milestone M5 — `selectFormatter` dispatcher (TDD)

### Task 5.1: TDD dispatcher

**Files:**
- Create: `packages/core/src/output/select.ts`
- Create: `packages/core/test/output/select.test.ts`

- [ ] **Step 5.1.1: Failing test**

`packages/core/test/output/select.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { selectFormatter, type FormatName } from '../../src/output/select.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

const empty: ScanRepoResult = {
  totalFlags: 0,
  filesScanned: 0,
  staleFlags: [],
  detectedProviders: [],
  languageBreakdown: {},
  healthScore: 100,
  scanDuration: 0,
} as ScanRepoResult

describe('selectFormatter', () => {
  it.each([
    ['text', /Scanned/],
    ['json', /"totalFlags"/],
    ['markdown', /🦈 FlagShark/],
    ['csv', /^flag,file,line/],
    ['sarif', /"version": "2.1.0"/],
  ] as const)('returns a function for format=%s', (name: FormatName, marker) => {
    const fn = selectFormatter(name)
    const output = fn(empty, { version: '1.4.0', scanMode: 'full' })
    expect(output).toMatch(marker)
  })

  it('throws for unknown format name', () => {
    expect(() => selectFormatter('xml' as FormatName)).toThrow(/Unknown format/)
  })
})
```

- [ ] **Step 5.1.2: Implement**

`packages/core/src/output/select.ts`:

```ts
/**
 * Format-name dispatcher. Returns a unified callable that all formatters
 * conform to, so CLI/Action callers don't switch on format name themselves.
 */

import type { ScanRepoResult } from '../scan-repo.js'

import { formatCsv } from './csv.js'
import { formatJson } from './json.js'
import { formatMarkdown } from './markdown.js'
import { formatSarif } from './sarif.js'
import { formatText } from './text.js'

export type FormatName = 'text' | 'json' | 'markdown' | 'csv' | 'sarif'

export interface UnifiedFormatOptions {
  /** Tool version (used by JSON + SARIF envelopes). */
  version: string
  /** Scan mode label (used by markdown). */
  scanMode: 'full' | 'changed'
  /** Verbose flag (used by text). Default false. */
  verbose?: boolean
  /** Max stale flags rendered in text/markdown. Default: 10 (text), 20 (markdown). */
  maxDisplay?: number
  /** Link prefix for markdown (Action-context absolute URLs). */
  linkPrefix?: string
  /** Comment marker (Action only). */
  commentMarker?: string
}

export type Formatter = (result: ScanRepoResult, options: UnifiedFormatOptions) => string

const TEXT_DEFAULT_MAX = 10
const MARKDOWN_DEFAULT_MAX = 20

export function selectFormatter(name: FormatName): Formatter {
  switch (name) {
    case 'text':
      return (result, opts) => formatText(result, {
        verbose: opts.verbose ?? false,
        maxDisplay: opts.maxDisplay ?? TEXT_DEFAULT_MAX,
      })
    case 'json':
      return (result, opts) => formatJson(result, { version: opts.version })
    case 'markdown':
      return (result, opts) => formatMarkdown(result, {
        scanMode: opts.scanMode,
        linkPrefix: opts.linkPrefix,
        commentMarker: opts.commentMarker,
        maxStaleFlags: opts.maxDisplay ?? MARKDOWN_DEFAULT_MAX,
      })
    case 'csv':
      return (result) => formatCsv(result)
    case 'sarif':
      return (result, opts) => formatSarif(result, { version: opts.version })
    default:
      throw new Error(`Unknown format: ${name as string}`)
  }
}
```

- [ ] **Step 5.1.3: Export**

In `packages/core/src/output/index.ts`:

```ts
export { selectFormatter, type FormatName, type Formatter, type UnifiedFormatOptions } from './select.js'
```

- [ ] **Step 5.1.4: Run, pass**

```bash
bun run test select
```

Expected: 6 tests pass (5 parameterized + 1 unknown-format).

### Task 5.2: Commit

```bash
git add packages/core/src/output/select.ts packages/core/src/output/index.ts \
        packages/core/test/output/select.test.ts
git commit -m "feat(core): add selectFormatter dispatcher

Single entry point for callers that pick format at runtime (CLI flag,
Action input). Unified options shape works for all 5 formatters."
```

---

## Milestone M6 — CLI `--format` and `--output` flags

### Task 6.1: Parse the new flags

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 6.1.1: Read existing arg parsing**

```bash
cd /Users/joe/projects/flagshark-output-formats
sed -n '1,150p' packages/cli/src/cli.ts
```

Locate the arg-parsing block (`parseArgs` or the inline switch).

- [ ] **Step 6.1.2: Add args**

In the args type (probably `CliArgs` interface near the top):

```ts
interface CliArgs {
  // ...existing fields...
  format: 'text' | 'json' | 'markdown' | 'csv' | 'sarif'
  output?: string
}
```

In the initial args literal:

```ts
const args: CliArgs = {
  // ...
  format: 'text',
}
```

In `parseArgs` (or equivalent), add the cases. Support both `--flag value` and `--flag=value`:

```ts
} else if (a === '--format') {
  const v = process.argv[++i]
  if (!['text', 'json', 'markdown', 'csv', 'sarif'].includes(v)) {
    process.stderr.write(`Error: --format must be one of text, json, markdown, csv, sarif; got '${v}'\n`)
    process.exit(2)
  }
  args.format = v as CliArgs['format']
} else if (a === '--output' || a === '-o') {
  args.output = process.argv[++i]
}
```

Also: when `--json` is parsed, set `args.format = 'json'` (for back-compat). Keep both flags working but `--json` is now equivalent to `--format json`.

- [ ] **Step 6.1.3: Update HELP_TEXT**

Append to the existing HELP_TEXT (after the `Configuration:` section if present):

```
Output:
  --format <fmt>           Output format: text | json | markdown | csv | sarif (default: text)
  --output <path> | -o     Write output to this file instead of stdout
  --json                   Shorthand for --format json (deprecated, will be removed in v2)
```

### Task 6.2: Wire to selectFormatter

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 6.2.1: Replace the existing format-and-write block**

Find the block that calls `formatText` or `formatJson` and replace with:

```ts
import { selectFormatter } from '@flagshark/core'
import { writeFileSync } from 'node:fs'

// ...inside main, after scanRepo returns:

const formatter = selectFormatter(args.format)
const output = formatter(result, {
  version: VERSION,
  scanMode: args.diff ? 'changed' : 'full',
  verbose: args.verbose,
})

if (args.output) {
  writeFileSync(args.output, output)
} else {
  process.stdout.write(output)
  if (!output.endsWith('\n')) {
    process.stdout.write('\n')
  }
}
```

Drop the old `formatText`/`formatJson` direct calls — they go through `selectFormatter` now.

- [ ] **Step 6.2.2: Smoke-test all 5 formats**

```bash
cd /Users/joe/projects/flagshark-output-formats
bun run --filter '@flagshark/core' build
cd packages/cli && bun run build

mkdir -p /tmp/format-smoke/src
cat > /tmp/format-smoke/src/app.ts <<'EOF'
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'
const client = LaunchDarkly.init('sdk-key')
const x = client.variation('SMOKE_FLAG', user, false)
EOF
cd /tmp/format-smoke && git init -q && git add . && git commit -qm 'init'
FS=/Users/joe/projects/flagshark-output-formats/packages/cli/bin/flagshark.mjs

echo "=== text ==="
node $FS scan | head -10
echo "=== json ==="
node $FS scan --format json | head -10
echo "=== markdown ==="
node $FS scan --format markdown | head -10
echo "=== csv ==="
node $FS scan --format csv
echo "=== sarif ==="
node $FS scan --format sarif | head -10
echo "=== --json alias ==="
node $FS scan --json | head -3
echo "=== --output ==="
node $FS scan --format json --output /tmp/format-smoke-out.json
cat /tmp/format-smoke-out.json | head -3
```

Each should produce sensible output. SARIF should start with `{\n  "$schema": "https://json.schemastore.org/sarif-2.1.0.json"`. CSV should start with the header `flag,file,line,language,provider,signals,age`. Markdown should contain `## 🦈 FlagShark`.

### Task 6.3: Commit

```bash
cd /Users/joe/projects/flagshark-output-formats
git add packages/cli/src/cli.ts
git commit -m "feat(cli): add --format and --output flags

--format: text | json | markdown | csv | sarif (default: text)
--output <path>: write to file instead of stdout
--json: kept as deprecated alias for --format json"
```

---

## Milestone M7 — Action refactor + `output-format` input

Goal: the Action uses the shared markdown formatter (deletes ~60 lines of hand-rolled markdown), and gains an `output-format` input. PR comment behavior is unchanged for users.

### Task 7.1: Refactor postComment to use formatMarkdown

**Files:**
- Modify: `packages/action/src/index.ts`
- Modify: `action.yml`

- [ ] **Step 7.1.1: Read the current postComment**

```bash
sed -n '160,250p' packages/action/src/index.ts
```

It hand-rolls ~60 lines of markdown (header, stats table, stale flags table, footer).

- [ ] **Step 7.1.2: Replace the markdown-building block in postComment with formatMarkdown call**

In `packages/action/src/index.ts`, find the `postComment` function. Replace the entire body that builds `body` (lines roughly 184-234) with:

```ts
import { formatMarkdown } from '@flagshark/core'

// ...inside postComment:

const repoUrl = `https://github.com/${owner}/${repo}`
const headSha = github.context.payload.pull_request!.head.sha
const linkPrefix = `${repoUrl}/blob/${headSha}/`

const body = formatMarkdown(result, {
  scanMode,
  linkPrefix,
  commentMarker: COMMENT_MARKER,
})
```

But `postComment` currently takes `staleFlags`, `totalFlags`, `healthScore`, `scanMode`, `langStats`, `providers`, `scanDuration` as separate arguments. Refactor to take the full `ScanRepoResult` instead:

```ts
async function postComment(
  token: string,
  result: ScanRepoResult,
  scanMode: 'full' | 'changed',
): Promise<void> {
  // ...
  const linkPrefix = `${repoUrl}/blob/${headSha}/`
  const body = formatMarkdown(result, {
    scanMode,
    linkPrefix,
    commentMarker: COMMENT_MARKER,
  })

  // ...existing GitHub API calls to find + update or create the comment
}
```

Update the call site in `run()`:

```ts
await postComment(token, result, scanMode as 'full' | 'changed')
```

Drop the now-unused arguments (`staleFlags`, `totalFlags`, etc.) from the call.

Add the import at the top of the file:

```ts
import { scanRepo, formatMarkdown } from '@flagshark/core'
import type { ScanRepoResult } from '@flagshark/core'
```

- [ ] **Step 7.1.3: Add `output-format` Action input**

Edit `action.yml` (at the repo root). Find the existing `inputs:` block and add:

```yaml
inputs:
  # ... existing inputs ...
  output-format:
    description: 'PR comment format: markdown (default) or none (disable PR comment)'
    required: false
    default: 'markdown'
```

In `packages/action/src/index.ts`, read the input and guard the comment call:

```ts
const outputFormat = core.getInput('output-format') || 'markdown'

// ...

// Post PR comment
if (github.context.payload.pull_request && totalFlags > 0 && outputFormat === 'markdown') {
  const token = process.env.GITHUB_TOKEN || core.getInput('token')
  if (token) {
    await postComment(token, result, scanMode as 'full' | 'changed')
  }
}
```

If `outputFormat === 'none'`, skip the PR comment entirely.

- [ ] **Step 7.1.4: Build and smoke-test the Action bundle**

```bash
cd /Users/joe/projects/flagshark-output-formats
bun run --filter '@flagshark/core' build
bun run --filter '@flagshark/action' build
```

Verify the bundle exists and contains the new formatter code:

```bash
grep -c 'formatMarkdown' packages/action/dist/action.cjs
```

Should be > 0.

- [ ] **Step 7.1.5: Run full test suite**

```bash
bun run test
bun run typecheck
```

### Task 7.2: Commit

```bash
git add packages/action/src/index.ts action.yml packages/action/dist/
git commit -m "feat(action): use shared markdown formatter, add output-format input

The Action's hand-rolled markdown template (~60 lines) is replaced
with formatMarkdown from @flagshark/core. PR comment shape is
unchanged for users.

New input: output-format (markdown | none). 'none' disables the PR
comment entirely — useful when pairing with sarif: to send results
only to GitHub Code Scanning."
```

---

## Milestone M8 — Action `sarif:` input

Goal: when `sarif: <path>` is set on the Action, write a SARIF v2.1.0 file at that path. Users can then chain `github/codeql-action/upload-sarif` to surface stale flags in the Security tab.

### Task 8.1: Wire sarif input + write

**Files:**
- Modify: `packages/action/src/index.ts`
- Modify: `action.yml`

- [ ] **Step 8.1.1: Add the action.yml input**

In `action.yml`, in the `inputs:` block:

```yaml
inputs:
  # ... existing inputs ...
  sarif:
    description: 'Write SARIF v2.1.0 output to this path (default: do not write)'
    required: false
```

- [ ] **Step 8.1.2: Read and write SARIF in the action entry**

In `packages/action/src/index.ts`, add the SARIF write logic after the scan completes:

```ts
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Inside run(), after the scanRepo call and outputs are set:

const sarifPath = core.getInput('sarif')
if (sarifPath) {
  const { formatSarif } = await import('@flagshark/core')
  // Version is the FlagShark Action's version — read from package.json or env.
  // Simplest: hardcode to match the release, or read GITHUB_ACTION_REF.
  const actionVersion = process.env.GITHUB_ACTION_REF || 'unknown'
  const sarifJson = formatSarif(result, { version: actionVersion })
  const absolutePath = resolve(process.cwd(), sarifPath)
  writeFileSync(absolutePath, sarifJson)
  core.info(`Wrote SARIF to ${absolutePath}`)
  core.setOutput('sarif-path', absolutePath)
}
```

Or import `formatSarif` at the top of the file alongside `formatMarkdown` and skip the dynamic import.

- [ ] **Step 8.1.3: Update README docs in the repo**

Edit `README.md` at the repo root. In the "GitHub Action" section, add a subsection after the existing Action example showing SARIF integration:

```markdown
### Upload to GitHub Code Scanning (Security tab)

Set the `sarif:` input and chain `codeql-action/upload-sarif`:

\`\`\`yaml
- uses: FlagShark/flagshark@v1
  with:
    sarif: flagshark.sarif
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: flagshark.sarif
\`\`\`

Stale flags now appear in your repo's **Security → Code Scanning** tab, same UX as CodeQL or ESLint with SARIF output.
```

Also add the new action inputs to the action inputs table:

```markdown
| Input | Default | Description |
|-------|---------|-------------|
| `scan` | `changed` | `changed` (PR files only) or `full` (entire repo) |
| `threshold` | `6` | Staleness threshold in months |
| `fail-threshold` | `0` | Fail the check if health drops below this score (0 = never fail) |
| `output-format` | `markdown` | PR comment format: `markdown` or `none` |
| `sarif` | (unset) | Write SARIF v2.1.0 to this path — pair with `codeql-action/upload-sarif` |
```

- [ ] **Step 8.1.4: Rebuild Action**

```bash
bun run --filter '@flagshark/action' build
```

- [ ] **Step 8.1.5: Smoke-test SARIF generation locally**

```bash
mkdir -p /tmp/sarif-smoke/src
cat > /tmp/sarif-smoke/src/app.ts <<'EOF'
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'
const client = LaunchDarkly.init('sdk-key')
const x = client.variation('SARIF_FLAG', user, false)
EOF
cd /tmp/sarif-smoke && git init -q && git add . && git commit -qm 'init'

FS=/Users/joe/projects/flagshark-output-formats/packages/cli/bin/flagshark.mjs
node $FS scan --format sarif --output /tmp/sarif-smoke.sarif

# Quick syntax check — must be valid JSON with the SARIF schema
cat /tmp/sarif-smoke.sarif | jq '.$schema, .version, .runs[0].tool.driver.name'
```

Expected:
```
"https://json.schemastore.org/sarif-2.1.0.json"
"2.1.0"
"FlagShark"
```

### Task 8.2: Commit

```bash
cd /Users/joe/projects/flagshark-output-formats
git add packages/action/src/index.ts action.yml README.md packages/action/dist/
git commit -m "feat(action): add sarif input for GitHub Code Scanning

When sarif: <path> is set, the Action writes a SARIF v2.1.0 file
that can be uploaded via github/codeql-action/upload-sarif. Stale
flags then appear in the repo's Security → Code Scanning tab."
```

---

## Milestone M9 — PR (pause for user)

### Task 9.1: Push and open PR

- [ ] **Step 9.1.1: Push**

```bash
cd /Users/joe/projects/flagshark-output-formats
git push -u origin feat/output-formats
```

- [ ] **Step 9.1.2: Open PR**

```bash
gh pr create --title "feat: markdown + CSV + SARIF output formats (P3 + P4)" --body "$(cat <<'EOF'
## Summary

Resolves P3 + P4 from the output/customizability spec. Ships as v1.4.0.

- New CLI flags: \`--format text|json|markdown|csv|sarif\`, \`--output <path>\`
- New Action inputs: \`output-format: markdown | none\`, \`sarif: <path>\`
- The Action's hand-rolled PR-comment template (~60 lines) is replaced with the shared markdown formatter
- SARIF v2.1.0 output unlocks GitHub Code Scanning integration (Security tab)

## Test plan

- [x] TDD tests for each formatter (text, json, markdown, csv, sarif, dispatcher)
- [x] CLI smoke test against a fixture repo for all 5 formats + --output + --json alias
- [x] Action bundle rebuilt with formatMarkdown inlined
- [x] SARIF output validates against jsonschema 2.1.0 (manual jq verification)
- [x] Typecheck clean across all packages

## Spec & plan

- [Output spec](docs/superpowers/specs/2026-05-11-output-and-customizability-design.md)
- [This plan](docs/superpowers/plans/2026-05-11-output-formats-markdown-csv-sarif.md)
EOF
)"
```

- [ ] **Step 9.1.3: Wait for CI + human review.** Manual gate.

---

## Self-Review

**Spec coverage:**

- ✅ §3.1 Module layout — formatters under `@flagshark/core/output/` (slightly different from spec's `packages/cli/src/formatter/` — moved to core for shared use; documented in M1.1.1)
- ✅ §5.3 SARIF v2.1.0 — M4
- ✅ §5.4 Markdown formatter (with linkPrefix for Action) — M2
- ✅ §5.5 CSV (RFC 4180) — M3
- ✅ §8 CLI flags `--format`, `--output` — M6 (kept `--json` as alias)
- ✅ §9 Action inputs `output-format`, `sarif:` — M7, M8
- 🟡 §13 Q5 "output-format: none disables PR comment entirely" — implemented in M7 ✓
- 🟡 §13 Q6 "one markdown formatter with linkPrefix option" — implemented in M2 ✓
- 🟡 §13 Q9 "excludes paths vs files split" — already shipped in v1.3.0, not in this plan
- Out of scope: P5 (inline suppression), P6 (per-path rules), P7 (groupBy/sortBy/init/colors), P8 (health weights)

**Placeholder scan:** every code step shows actual code; every command shows expected output. No TBDs.

**Type consistency:**
- `FormatName`, `Formatter`, `UnifiedFormatOptions` defined in M5, used in M6 + M7 + M8.
- `MarkdownFormatOptions.linkPrefix`, `commentMarker`, `maxStaleFlags`, `scanMode` consistent across M2, M5, M7.
- `SarifFormatOptions.version` consistent across M4, M5, M8.
- `JsonFormatOptions.version` consistent across M1.2, M5, M6.

**Ambiguity check:**
- M8 fetches the action version via `GITHUB_ACTION_REF`. This may be `v1` (mutable tag) rather than `v1.4.0` (specific). That's acceptable — the SARIF `version` field is informational. If we want the exact release version, M8 would need to read `package.json` at build time. Leaving as-is for v1.4.0; can refine in a follow-up.
- M6's CSV smoke test prints the full output (small) while text/json/markdown/sarif use `head -10`. Intentional — CSV is short and we want to see the whole structure.
