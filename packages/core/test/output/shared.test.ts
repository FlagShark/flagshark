/**
 * Tests for output/shared.ts: healthEmoji, uniqueStaleCount, sarifLevel.
 * Covers lines 13-14 (orange branch of healthEmoji) and sarifLevel for 3+ signals.
 */
import { describe, it, expect } from 'vitest'

import { healthEmoji, uniqueStaleCount, sarifLevel } from '../../src/output/shared.js'
import type { StaleFlag } from '../../src/staleness.js'

describe('healthEmoji', () => {
  it('returns 🟢 for score >= 90', () => {
    expect(healthEmoji(90)).toBe('🟢')
    expect(healthEmoji(100)).toBe('🟢')
  })

  it('returns 🟡 for score >= 70 and < 90', () => {
    expect(healthEmoji(70)).toBe('🟡')
    expect(healthEmoji(89)).toBe('🟡')
  })

  it('returns 🟠 for score >= 40 and < 70 (lines 13-14)', () => {
    expect(healthEmoji(40)).toBe('🟠')
    expect(healthEmoji(69)).toBe('🟠')
  })

  it('returns 🔴 for score < 40', () => {
    expect(healthEmoji(0)).toBe('🔴')
    expect(healthEmoji(39)).toBe('🔴')
  })
})

describe('uniqueStaleCount', () => {
  const flag = (name: string): StaleFlag => ({
    name,
    filePath: 'a.ts',
    lineNumber: 1,
    language: 'typescript',
    provider: 'launchdarkly',
    signals: [{ type: 'age', description: 'old' }],
  })

  it('counts unique names across multiple occurrences', () => {
    expect(uniqueStaleCount([flag('A'), flag('A'), flag('B')])).toBe(2)
  })

  it('returns 0 for empty array', () => {
    expect(uniqueStaleCount([])).toBe(0)
  })
})

describe('sarifLevel', () => {
  it('returns "note" for 1 signal', () => {
    expect(sarifLevel(1)).toBe('note')
  })

  it('returns "warning" for 2 signals', () => {
    expect(sarifLevel(2)).toBe('warning')
  })

  it('returns "error" for 3+ signals', () => {
    expect(sarifLevel(3)).toBe('error')
    expect(sarifLevel(5)).toBe('error')
  })

  it('returns "note" for 0 signals', () => {
    expect(sarifLevel(0)).toBe('note')
  })
})
