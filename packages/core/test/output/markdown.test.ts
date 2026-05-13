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

  it('normalizes linkPrefix that does not end with /', () => {
    const md = formatMarkdown(
      makeResult({
        totalFlags: 1,
        healthScore: 60,
        staleFlags: [{
          name: 'X', filePath: 'src/x.ts', lineNumber: 5, language: 'typescript',
          provider: 'launchdarkly', signals: [{ type: 'age', description: 'old' }], age: '12 months ago',
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
          signals: [{ type: 'age', description: 'old' }],
          // no age field
        }],
      }),
      { scanMode: 'full' },
    )
    expect(md).toContain('unknown')
  })
})
