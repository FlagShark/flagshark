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
            signals: [{ type: 'age', severity: 'warning', description: 'Flag reference last modified 14 months ago' }],
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
          { name: 'A', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly', signals: [{ type: 'age', severity: 'warning', description: 'old' }], age: '12 months ago' },
          { name: 'B', filePath: 'b.ts', lineNumber: 2, language: 'typescript', provider: 'launchdarkly', signals: [{ type: 'age', severity: 'warning', description: 'old' }], age: '12 months ago' },
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
          provider: 'launchdarkly', signals: [{ type: 'age', severity: 'warning', description: 'old' }], age: '12 months ago',
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
      signals: [{ type: 'age' as const, severity: 'warning' as const, description: 'old' }],
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

  it('normalizes linkPrefix that does not end with /', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 1,
        healthScore: 60,
        staleFlags: [{
          name: 'X', filePath: 'src/x.ts', lineNumber: 5, language: 'typescript',
          provider: 'launchdarkly', signals: [{ type: 'age', severity: 'warning', description: 'old' }], age: '12 months ago',
        }],
      }),
      { scanMode: 'changed', linkPrefix: 'https://github.com/owner/repo/blob/abc123' },  // NO trailing slash
    )
    expect(md).toContain('https://github.com/owner/repo/blob/abc123/src/x.ts#L5')
  })

  it('shows "+N more" when more than 5 providers (line 41)', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 3,
        filesScanned: 50,
        detectedProviders: ['ld', 'unleash', 'split', 'statsig', 'posthog', 'growthbook'],
      }),
      { scanMode: 'full' },
    )
    expect(md).toContain('+1 more')
  })

  it('shows "unknown" age when flag.age is undefined (line 103)', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 1,
        healthScore: 70,
        staleFlags: [{
          name: 'NO_AGE', filePath: 'src/x.ts', lineNumber: 1, language: 'typescript',
          provider: 'launchdarkly',
          signals: [{ type: 'age', severity: 'warning', description: 'old' }],
          // no age field
        }],
      }),
      { scanMode: 'full' },
    )
    expect(md).toContain('unknown')
  })
})

describe('markdown formatter — severity sections', () => {
  function staleFlag(name: string, type: 'missing-in-platform' | 'archived-in-platform' | 'age', severity: 'error' | 'warning') {
    return {
      name, filePath: 'src/a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk',
      signals: [{ type, severity, description: 'desc' }],
      age: '12 months ago',
    }
  }
  function makeResult(staleFlags: ReturnType<typeof staleFlag>[]) {
    return {
      totalFlags: staleFlags.length, filesScanned: 1, staleFlags,
      detectedProviders: [], languageBreakdown: {},
      healthScore: 50, scanDuration: 1,
    }
  }

  it('renders Production-risk section above Stale section', () => {
    const out = formatMarkdown(makeResult([
      staleFlag('M', 'missing-in-platform', 'error'),
      staleFlag('A', 'age', 'warning'),
    ]), { scanMode: 'full' })
    const errIdx = out.indexOf('Production-risk')
    const staleIdx = out.indexOf('Stale flags')
    expect(errIdx).toBeGreaterThanOrEqual(0)
    expect(staleIdx).toBeGreaterThan(errIdx)
  })

  it('Production-risk section absent when no error-severity flags', () => {
    const out = formatMarkdown(makeResult([staleFlag('A', 'age', 'warning')]), { scanMode: 'full' })
    expect(out).not.toContain('Production-risk')
  })

  it('Production-risk section renders even when no warnings exist', () => {
    const out = formatMarkdown(makeResult([staleFlag('M', 'missing-in-platform', 'error')]), { scanMode: 'full' })
    expect(out).toContain('Production-risk')
  })
})

describe('formatMarkdown — parseErrorCount surfacing', () => {
  // Coverage gate for markdown.ts:68-76. The GitHub Action PR comment is
  // FlagShark's most visible surface — pre-fix it silently hid the
  // "27% of files skipped" case the feature was originally designed to
  // expose. Two banner shapes: loud (>5% rounded) and quiet (1-5%).
  function baseResult(filesScanned: number, parseErrorCount: number) {
    return {
      totalFlags: 3,
      filesScanned,
      parseErrorCount,
      staleFlags: [],
      detectedProviders: ['LaunchDarkly'],
      languageBreakdown: { typescript: filesScanned },
      healthScore: 100,
      scanDuration: 100,
    }
  }

  it('emits a loud banner when more than 5% of files failed to parse', () => {
    const out = formatMarkdown(baseResult(100, 27), { scanMode: 'full' })
    expect(out).toContain('⚠️')
    expect(out).toContain("**27 of 100 files (27%) couldn't be parsed**")
    expect(out).toContain('results may be incomplete')
  })

  it('emits a quiet banner when 5% or fewer files failed to parse', () => {
    const out = formatMarkdown(baseResult(100, 3), { scanMode: 'full' })
    // Quiet form uses italic underscores, not the ⚠️ siren
    expect(out).not.toContain('⚠️')
    expect(out).toContain("_3 files couldn't be parsed — totals exclude them._")
  })

  it('pluralizes correctly for a single parse failure in quiet form', () => {
    const out = formatMarkdown(baseResult(100, 1), { scanMode: 'full' })
    expect(out).toContain("_1 file couldn't be parsed — totals exclude them._")
  })

  it('omits any parse-error banner when parseErrorCount is 0', () => {
    const out = formatMarkdown(baseResult(100, 0), { scanMode: 'full' })
    expect(out).not.toContain("couldn't be parsed")
  })

  it('omits the banner when filesScanned is 0 (avoids divide-by-zero)', () => {
    const out = formatMarkdown(baseResult(0, 5), { scanMode: 'full' })
    expect(out).not.toContain("couldn't be parsed")
  })

  it('emits a quoted callout per platform that marked flags permanent', () => {
    // Same UX as text output, but markdown — used by the GitHub Action
    // PR comment. The block-quote (`> _..._`) style keeps it visually
    // separate from the stale tables below.
    const out = formatMarkdown(
      {
        ...baseResult(50, 0),
        permanentByPlatform: { LaunchDarkly: ['kill-switch-billing', 'kill-switch-auth'] },
      },
      { scanMode: 'full' },
    )
    expect(out).toContain('2 flags excluded as permanent in LaunchDarkly')
    expect(out).toContain('`kill-switch-billing`')
    expect(out).toContain('`kill-switch-auth`')
  })

  it('singularizes "flag" when only one was excluded (markdown)', () => {
    const out = formatMarkdown(
      {
        ...baseResult(50, 0),
        permanentByPlatform: { LaunchDarkly: ['solo'] },
      },
      { scanMode: 'full' },
    )
    expect(out).toContain('1 flag excluded as permanent in LaunchDarkly')
  })

  it('omits empty-array platforms from the markdown callout', () => {
    const out = formatMarkdown(
      {
        ...baseResult(50, 0),
        permanentByPlatform: { LaunchDarkly: [], Unleash: ['x'] },
      },
      { scanMode: 'full' },
    )
    expect(out).toContain('excluded as permanent in Unleash')
    expect(out).not.toContain('excluded as permanent in LaunchDarkly')
  })

  it('hides the percentage in the loud banner when pct < 1', () => {
    // pct = 0.5 (< 1). The percentage suffix should be empty so we don't
    // emit a misleading "0%" annotation. Coverage gate for the
    // `pct >= 1 ? ` (${rounded}%)` : ''` branch.
    const out = formatMarkdown(baseResult(2000, 8), { scanMode: 'full' })
    expect(out).toContain("couldn't be parsed")
    // rounded=0, banner falls through to the quiet form (rounded <= 5).
    expect(out).not.toContain('(0%)')
  })
})

describe('formatMarkdown — platform-side metadata in rows', () => {
  function staleFlag(opts: {
    tags?: string[]
    maintainer?: string
    platformStatus?: 'new' | 'active' | 'inactive' | 'launched'
  }) {
    return {
      name: 'FLAG_X',
      filePath: 'src/a.ts',
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly',
      signals: [{ type: 'low-usage' as const, severity: 'warning' as const, description: 'old' }],
      age: '12 months ago',
      ...opts,
    }
  }
  function makeResult(staleFlags: ReturnType<typeof staleFlag>[]) {
    return {
      totalFlags: staleFlags.length,
      filesScanned: 1,
      staleFlags,
      detectedProviders: [],
      languageBreakdown: {},
      healthScore: 50,
      scanDuration: 1,
    }
  }

  it('appends tags as backticked tokens after the signal list', () => {
    const out = formatMarkdown(
      makeResult([staleFlag({ tags: ['kill-switch', 'auth'] })]),
      { scanMode: 'full' },
    )
    expect(out).toContain('`kill-switch`')
    expect(out).toContain('`auth`')
  })

  it('prefixes maintainer with @', () => {
    const out = formatMarkdown(
      makeResult([staleFlag({ maintainer: 'Jane Doe <jane@example.com>' })]),
      { scanMode: 'full' },
    )
    expect(out).toContain('@Jane Doe <jane@example.com>')
  })

  it('shows non-active platformStatus inline', () => {
    const out = formatMarkdown(
      makeResult([staleFlag({ platformStatus: 'inactive' })]),
      { scanMode: 'full' },
    )
    expect(out).toContain('status: inactive')
  })

  it('omits the meta segment entirely when nothing is set', () => {
    const out = formatMarkdown(makeResult([staleFlag({})]), { scanMode: 'full' })
    expect(out).not.toContain('<br/>')
  })

  it('suppresses platformStatus when value is "active"', () => {
    const out = formatMarkdown(
      makeResult([staleFlag({ platformStatus: 'active' })]),
      { scanMode: 'full' },
    )
    expect(out).not.toContain('status: active')
  })
})
