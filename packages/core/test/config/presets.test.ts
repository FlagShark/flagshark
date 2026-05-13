import { describe, it, expect } from 'vitest'

import { PRESETS, expandPresets } from '../../src/config/presets.js'

describe('PRESETS', () => {
  it('has the six documented preset names', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(
      ['examples', 'fixtures', 'generated', 'snapshots', 'stories', 'test-files'],
    )
  })

  it('test-files includes common JS/TS patterns', () => {
    const patterns = PRESETS['test-files']
    expect(patterns).toContain('**/*.test.ts')
    expect(patterns).toContain('**/*.spec.tsx')
    expect(patterns).toContain('**/__tests__/**')
  })

  it('test-files includes patterns from non-JS languages', () => {
    const patterns = PRESETS['test-files']
    expect(patterns).toContain('**/*_test.go')
    expect(patterns).toContain('**/test_*.py')
    expect(patterns).toContain('**/*Test.java')
    expect(patterns).toContain('**/*_spec.rb')
  })

  it('snapshots covers jest and ava conventions', () => {
    expect(PRESETS['snapshots']).toContain('**/*.snap')
    expect(PRESETS['snapshots']).toContain('**/__snapshots__/**')
  })
})

describe('expandPresets', () => {
  it('returns empty array for empty input', () => {
    expect(expandPresets([])).toEqual([])
  })

  it('returns the union of named presets in order', () => {
    const result = expandPresets(['snapshots', 'examples'])
    expect(result).toContain('**/*.snap')
    expect(result).toContain('examples/**')
  })

  it('deduplicates patterns across overlapping presets', () => {
    // If two presets shared a pattern, it should appear once.
    // (Today none of our presets overlap, but the contract holds.)
    const result = expandPresets(['test-files', 'test-files'])
    const set = new Set(result)
    expect(set.size).toBe(result.length)
  })

  it('skips unknown preset names gracefully (line 62 — defensive guard)', () => {
    // Passing an unknown name via type cast exercises the `if (!patterns) continue` branch.
    const result = expandPresets(['unknown-preset' as never])
    expect(result).toEqual([])
  })
})
