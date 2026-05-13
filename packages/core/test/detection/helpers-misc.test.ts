import { describe, it, expect } from 'vitest'

import {
  buildMethodCallPattern,
  deduplicateFlags,
  detectFlagsWithRegex,
  escapeRegExp,
  extractMethodNames,
  getDefaultKeyIndex,
  isValidFlagKey,
  mergeProviders,
  splitArguments,
} from '../../src/detection/helpers.js'

import type { FeatureFlag } from '../../src/detection/feature-flag.js'
import type { FeatureFlagProvider } from '../../src/detection/interface.js'

describe('extractMethodNames', () => {
  it('returns names from a method list', () => {
    expect(
      extractMethodNames([
        { name: 'variation', flagKeyIndex: 0 },
        { name: 'isEnabled', flagKeyIndex: 0 },
      ]),
    ).toEqual(['variation', 'isEnabled'])
  })

  it('returns empty array for empty input', () => {
    expect(extractMethodNames([])).toEqual([])
  })
})

describe('getDefaultKeyIndex', () => {
  it('returns flagKeyIndex of first method', () => {
    expect(
      getDefaultKeyIndex([
        { name: 'a', flagKeyIndex: 2 },
        { name: 'b', flagKeyIndex: 5 },
      ]),
    ).toBe(2)
  })

  it('returns 0 when methods array is empty', () => {
    expect(getDefaultKeyIndex([])).toBe(0)
  })
})

describe('deduplicateFlags', () => {
  it('removes duplicates by filePath:name:lineNumber', () => {
    const flags: FeatureFlag[] = [
      { name: 'a', filePath: 'f.ts', lineNumber: 1, language: 'typescript' },
      { name: 'a', filePath: 'f.ts', lineNumber: 1, language: 'typescript' },
      { name: 'a', filePath: 'f.ts', lineNumber: 2, language: 'typescript' },
    ]
    expect(deduplicateFlags(flags)).toHaveLength(2)
  })

  it('preserves order and keeps first occurrence', () => {
    const flags: FeatureFlag[] = [
      { name: 'a', filePath: 'f.ts', lineNumber: 1, language: 'typescript', provider: 'first' },
      { name: 'a', filePath: 'f.ts', lineNumber: 1, language: 'typescript', provider: 'second' },
    ]
    const out = deduplicateFlags(flags)
    expect(out).toHaveLength(1)
    expect(out[0].provider).toBe('first')
  })
})

describe('splitArguments', () => {
  it('splits flat args', () => {
    expect(splitArguments('"a", b, 3')).toEqual(['"a"', ' b', ' 3'])
  })

  it('respects nested parens', () => {
    expect(splitArguments('foo(1, 2), bar')).toEqual(['foo(1, 2)', ' bar'])
  })

  it('respects nested brackets and braces', () => {
    expect(splitArguments('[1, 2], {a: 3}')).toEqual(['[1, 2]', ' {a: 3}'])
  })

  it('respects string literals', () => {
    expect(splitArguments('"a, b", c')).toEqual(['"a, b"', ' c'])
  })

  it('handles escaped quote inside string', () => {
    expect(splitArguments('"a\\"b", c')).toEqual(['"a\\"b"', ' c'])
  })

  it('skips block comments', () => {
    // The block-comment branch skips the comment body entirely.
    expect(splitArguments('a /* , skip */, b')).toEqual(['a ', ' b'])
  })

  it('handles unterminated block comment gracefully', () => {
    // No closing */, so the comment-skip branch is not taken
    expect(splitArguments('a /* x, b')).toEqual(['a /* x', ' b'])
  })

  it('handles single quotes', () => {
    expect(splitArguments("'a, b', c")).toEqual(["'a, b'", ' c'])
  })

  it('handles backticks', () => {
    expect(splitArguments('`a, b`, c')).toEqual(['`a, b`', ' c'])
  })

  it('returns empty list for empty input', () => {
    expect(splitArguments('')).toEqual([])
  })
})

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c?')).toBe('a\\.b\\*c\\?')
  })

  it('leaves plain identifiers untouched', () => {
    expect(escapeRegExp('foo')).toBe('foo')
  })
})

describe('buildMethodCallPattern', () => {
  it('returns a never-match regex when methodNames is empty', () => {
    const re = buildMethodCallPattern([])
    expect(re.test('anything')).toBe(false)
  })

  it('matches simple method calls', () => {
    const re = buildMethodCallPattern(['variation'])
    // Pattern needs a non-word char or start-of-string before the receiver.
    expect(re.test(' client.variation(')).toBe(true)
  })

  it('handles alternation between names', () => {
    const re = buildMethodCallPattern(['foo', 'bar'])
    expect(re.test(' x.foo(')).toBe(true)
    // Reset lastIndex because /g is sticky-ish across .test calls.
    re.lastIndex = 0
    expect(re.test(' y.bar(')).toBe(true)
  })
})

describe('isValidFlagKey', () => {
  it('returns false for empty string', () => {
    expect(isValidFlagKey('')).toBe(false)
  })

  it('returns false for over-long string', () => {
    expect(isValidFlagKey('a'.repeat(257))).toBe(false)
  })

  it('returns false for http:// URLs', () => {
    expect(isValidFlagKey('http://example.com')).toBe(false)
  })

  it('returns false for https:// URLs', () => {
    expect(isValidFlagKey('https://example.com')).toBe(false)
  })

  it('returns false for file:// URLs', () => {
    expect(isValidFlagKey('file:///etc/passwd')).toBe(false)
  })

  it('returns false for absolute paths', () => {
    expect(isValidFlagKey('/etc/passwd')).toBe(false)
  })

  it('returns true for normal flag names', () => {
    expect(isValidFlagKey('CHECKOUT_V2')).toBe(true)
    expect(isValidFlagKey('feature-flag.key')).toBe(true)
  })
})

describe('mergeProviders', () => {
  const defaults: FeatureFlagProvider[] = [
    {
      name: 'LD',
      importPattern: 'launchdarkly',
      enabled: true,
      methods: [{ name: 'variation', flagKeyIndex: 0 }],
    },
  ]

  it('appends a new provider with a unique import pattern', () => {
    const out = mergeProviders(defaults, [
      {
        name: 'Other',
        importPattern: 'other-sdk',
        enabled: true,
        methods: [{ name: 'check', flagKeyIndex: 0 }],
      },
    ])
    expect(out).toHaveLength(2)
    expect(out.map((p) => p.name).sort()).toEqual(['LD', 'Other'])
  })

  it('overrides defaults when import pattern matches', () => {
    const out = mergeProviders(defaults, [
      {
        name: 'LDCustom',
        importPattern: 'launchdarkly',
        enabled: false,
        methods: [{ name: 'variation', flagKeyIndex: 0 }],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('LDCustom')
    expect(out[0].enabled).toBe(false)
  })

  it('appending two customs with the same import pattern keeps only the last', () => {
    const out = mergeProviders([], [
      {
        name: 'A',
        importPattern: 'shared',
        enabled: true,
        methods: [{ name: 'a', flagKeyIndex: 0 }],
      },
      {
        name: 'B',
        importPattern: 'shared',
        enabled: true,
        methods: [{ name: 'b', flagKeyIndex: 0 }],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('B')
  })

  it('appends a custom provider with no import pattern when defaults are empty', () => {
    // Providers with no importPattern map to empty-string key in the byPattern
    // map; a second empty-key provider would override. This test covers the
    // initial-push branch (idx === undefined for empty pattern).
    const out = mergeProviders([], [
      {
        name: 'Custom1',
        enabled: true,
        methods: [{ name: 'check', flagKeyIndex: 0 }],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Custom1')
  })
})

describe('detectFlagsWithRegex', () => {
  const provider: FeatureFlagProvider = {
    name: 'LD',
    importPattern: 'launchdarkly-node-server-sdk',
    enabled: true,
    methods: [{ name: 'variation', flagKeyIndex: 0 }],
  }

  it('detects a flag in a file that imports the SDK', () => {
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `client.variation('FLAG_KEY', user, false)`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [provider])
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('FLAG_KEY')
  })

  it('skips disabled providers', () => {
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `client.variation('FLAG_KEY', user, false)`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [
      { ...provider, enabled: false },
    ])
    expect(flags).toEqual([])
  })

  it('skips providers with no methods', () => {
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `client.variation('FLAG_KEY', user, false)`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [
      { ...provider, methods: [] },
    ])
    expect(flags).toEqual([])
  })

  it('skips files without the import pattern', () => {
    const content = `client.variation('FLAG_KEY', user, false)`
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [provider])
    expect(flags).toEqual([])
  })

  it('treats provider with no importPattern as a fallback (always scans)', () => {
    const content = `isFeatureEnabled('SOMETHING')`
    const customProvider: FeatureFlagProvider = {
      name: 'Custom',
      enabled: true,
      methods: [{ name: 'isFeatureEnabled', flagKeyIndex: 0 }],
    }
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [customProvider])
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('SOMETHING')
  })

  it('skips methods whose flagKeyIndex is negative (returns-all-flags)', () => {
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `useFlags()`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [
      {
        name: 'LD',
        importPattern: 'launchdarkly-node-server-sdk',
        enabled: true,
        methods: [{ name: 'useFlags', flagKeyIndex: -1 }],
      },
    ])
    expect(flags).toEqual([])
  })

  it('handles a multi-line call', () => {
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `const v = client.variation(`,
      `  'MULTI_FLAG',`,
      `  user,`,
      `  false`,
      `)`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [provider])
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('MULTI_FLAG')
    expect(flags[0].lineNumber).toBe(2)
  })

  it('rejects invalid flag keys (e.g. URLs)', () => {
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      `client.variation('http://bad', user, false)`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [provider])
    expect(flags).toEqual([])
  })
})
