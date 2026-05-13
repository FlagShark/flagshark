import { describe, it, expect } from 'vitest'
import { extractStringArgument } from '../../src/detection/helpers.js'

describe('extractStringArgument', () => {
  it('extracts plain quoted positional arg at index 0', () => {
    expect(extractStringArgument('variation("FLAG", ctx, false)', 0)).toBe('FLAG')
  })

  it('extracts at higher index (Statsig-style key as second arg)', () => {
    expect(extractStringArgument('checkGate(user, "GATE")', 1)).toBe('GATE')
  })

  it('handles single-quoted strings', () => {
    expect(extractStringArgument("variation('FLAG', ctx)", 0)).toBe('FLAG')
  })

  it('handles backtick template literals (no interpolation)', () => {
    expect(extractStringArgument('variation(`FLAG`, ctx)', 0)).toBe('FLAG')
  })

  it('strips Swift external argument label "forKey:" before extracting', () => {
    expect(
      extractStringArgument('boolVariation(forKey: "CHECKOUT_V2", defaultValue: false)', 0),
    ).toBe('CHECKOUT_V2')
  })

  it('strips Swift "flagKey:" label (Eppo SDK style)', () => {
    expect(
      extractStringArgument('getBooleanAssignment(flagKey: "FLAG", subjectKey: id)', 0),
    ).toBe('FLAG')
  })

  it('strips Swift "key:" label (Optimizely / generic)', () => {
    expect(
      extractStringArgument('isFeatureEnabled(key: "FEATURE", userId: id)', 0),
    ).toBe('FEATURE')
  })

  it('returns null when no parens', () => {
    expect(extractStringArgument('not a call', 0)).toBeNull()
  })

  it('returns null when paramIndex is out of range', () => {
    expect(extractStringArgument('call("only")', 5)).toBeNull()
  })

  it('returns null when paramIndex is negative', () => {
    expect(extractStringArgument('call("x")', -1)).toBeNull()
  })

  it('returns null for nested-call positional arg (regression guard)', () => {
    // getKey("X") as a positional arg is NOT a quoted string — should not falsely extract
    expect(extractStringArgument('call(getKey("X"), false)', 0)).toBeNull()
  })

  it('does not strip from object-literal positional arg (regression guard)', () => {
    // {key: "v"} starts with {, not a word char — the label-stripper should not engage
    expect(extractStringArgument('call({key: "v"}, ctx)', 0)).toBeNull()
  })

  it('returns null for identifier-only labeled value (no quotes after strip)', () => {
    expect(extractStringArgument('boolVariation(forKey: flagVar, default: false)', 0)).toBeNull()
  })

  it('handles labeled arg with extra whitespace', () => {
    expect(extractStringArgument('boolVariation(forKey:   "X", default: false)', 0)).toBe('X')
  })

  it('preserves existing positional arg behavior (regression guard)', () => {
    // Kotlin-style positional: `variation("FLAG", ctx, false)`
    expect(extractStringArgument('variation("FLAG", ctx, false)', 0)).toBe('FLAG')
  })
})
