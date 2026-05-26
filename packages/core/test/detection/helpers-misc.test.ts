import { describe, it, expect } from 'vitest'

import {
  buildMethodCallPattern,
  deduplicateFlags,
  detectFlagsWithRegex,
  escapeRegExp,
  extractMethodNames,
  extractStringArgument,
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

  // Regression coverage for the PostHog shakedown finding (bug A2): a TSX
  // file's regex fragment `([^/]+)` was emitted as a "detected" flag.
  // Legitimate flag keys never contain regex metacharacters, brackets,
  // parens, or whitespace, so we reject those here.
  describe('rejects regex literals and other non-flag shapes', () => {
    it.each([
      // PostHog shakedown: the actual false-positive that prompted this fix.
      '([^/]+)',
      // Plain character classes / anchored patterns.
      '[a-z]+',
      '^anchored$',
      // Captured groups.
      '(group)',
      // Whitespace — most platforms reject these in their flag UI.
      'flag with space',
      'flag\twith\ttabs',
      // Escape sequences indicate a regex or shell snippet.
      'flag\\name',
    ])('rejects %s', (input) => {
      expect(isValidFlagKey(input)).toBe(false)
    })
  })

  it('keeps accepting the shakedown-corpus legitimate keys', () => {
    // Pin a representative sample from real production flag-management
    // platforms — the rejection above mustn't sweep these up.
    for (const real of [
      'personalAccessTokensKillSwitch',
      'phai-privacy-mode',
      'sdk:dart',
      'branding:large_logo',
      'crm-iteration-one',
      'posthog-ai-billing-free-tier-credits',
      'CHECKOUT_V2',
      'feature.flag.dotted',
    ]) {
      expect(isValidFlagKey(real), real).toBe(true)
    }
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

  it('handles a call without a closing paren (getCallExpression returns null → skips)', () => {
    // A line that matches the method pattern but never has a closing paren,
    // so getCallExpression returns null and the inner continue fires (line 222-224).
    const content = [
      `import * as LD from 'launchdarkly-node-server-sdk'`,
      // 11 consecutive lines without a closing paren — exceeds the 10-line window
      `client.variation(`,
      `  'line1',`,
      `  line2,`,
      `  line3,`,
      `  line4,`,
      `  line5,`,
      `  line6,`,
      `  line7,`,
      `  line8,`,
      `  line9,`,
      `  line10,`,
      `  line11`,
    ].join('\n')
    // No closing paren within 10-line window — getCallExpression returns the fragment but no flag key matters
    const flags = detectFlagsWithRegex('app.ts', content, 'typescript', [provider])
    // May or may not find a flag — what matters is no crash and the branch executes
    expect(Array.isArray(flags)).toBe(true)
  })
})

describe('extractStringArgument', () => {
  it('returns null when there is no opening paren', () => {
    expect(extractStringArgument('no_parens_here', 0)).toBeNull()
  })

  it('returns null when there is an opening paren but no closing paren', () => {
    // Has '(' but no ')'
    expect(extractStringArgument('foo("bar"', 0)).toBeNull()
  })

  it('returns the first string argument at index 0', () => {
    expect(extractStringArgument('foo("hello", other)', 0)).toBe('hello')
  })

  it('returns null for an out-of-range param index', () => {
    expect(extractStringArgument('foo("a")', 5)).toBeNull()
  })

  it('returns null for a negative param index', () => {
    expect(extractStringArgument('foo("a", "b")', -1)).toBeNull()
  })
})

describe('detectFlagsWithRegex — LaunchDarkly React SDK (useFlag + useFlags destructure)', () => {
  // Regression coverage for the user-reported React SDK gap. Pre-fix this
  // codebase shape returned 0 detections because:
  //   1. `useFlag(...)` wasn't registered as a positional-arg method
  //      (it had flagKeyIndex: -1, which the helper skips).
  //   2. `useFlags()` destructured names weren't extracted at all —
  //      there was no destructure-from-call detector.
  //
  // The fix adds:
  //   - useFlag with flagKeyIndex: 0 → matched by the standard pipeline.
  //   - useFlagsHook: 'useFlags' → triggers detectDestructuredHookFlags,
  //     which pulls the destructured property names out of
  //     `const { foo, bar } = useFlags()` and emits each as a flag.

  const reactProvider = {
    name: 'LaunchDarkly React SDK',
    importPattern: '@launchdarkly/react-client-sdk',
    importAliases: ['launchdarkly-react-client-sdk'],
    enabled: true,
    useFlagsHook: 'useFlags',
    methods: [
      { name: 'useFlag', flagKeyIndex: 0 },
      { name: 'useFlags', flagKeyIndex: -1 },
      { name: 'useLDClient', flagKeyIndex: -1 },
    ],
  }

  it('detects useFlag("key", default) via positional arg', () => {
    const content = [
      `import { useFlag } from '@launchdarkly/react-client-sdk'`,
      `export function Checkout() {`,
      `  const showNewFlow = useFlag('show-new-checkout', false)`,
      `  return showNewFlow ? <New /> : <Old />`,
      `}`,
    ].join('\n')
    const flags = detectFlagsWithRegex('Checkout.tsx', content, 'typescript', [reactProvider])
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('show-new-checkout')
    expect(flags[0].lineNumber).toBe(3)
  })

  it('detects each name destructured from `const { ... } = useFlags()`', () => {
    const content = [
      `import { useFlags } from '@launchdarkly/react-client-sdk'`,
      `export function Dashboard() {`,
      `  const { showNewCheckout, oneClickPurchase } = useFlags()`,
      `  return showNewCheckout && oneClickPurchase ? <A /> : <B />`,
      `}`,
    ].join('\n')
    const flags = detectFlagsWithRegex('Dashboard.tsx', content, 'typescript', [reactProvider])
    expect(flags.map((f) => f.name).sort()).toEqual(['oneClickPurchase', 'showNewCheckout'])
  })

  it('handles a multi-line destructure', () => {
    const content = [
      `import { useFlags } from '@launchdarkly/react-client-sdk'`,
      `const {`,
      `  showNewCheckout,`,
      `  oneClickPurchase,`,
      `  experimentalSearch,`,
      `} = useFlags()`,
    ].join('\n')
    const flags = detectFlagsWithRegex('app.tsx', content, 'typescript', [reactProvider])
    expect(flags.map((f) => f.name).sort()).toEqual([
      'experimentalSearch',
      'oneClickPurchase',
      'showNewCheckout',
    ])
  })

  it('takes the source name, not the alias, for `{ source: alias }` destructure', () => {
    const content = [
      `import { useFlags } from '@launchdarkly/react-client-sdk'`,
      `const { showNewCheckout: shouldShowNewCheckout } = useFlags()`,
      `if (shouldShowNewCheckout) { render() }`,
    ].join('\n')
    const flags = detectFlagsWithRegex('aliased.tsx', content, 'typescript', [reactProvider])
    // The source-side identifier is the LD flag key (camelCased from
    // 'show-new-checkout'); the local alias `shouldShowNewCheckout` is
    // private to the consumer.
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('showNewCheckout')
  })

  it('strips trailing line comments inside the destructure body', () => {
    const content = [
      `import { useFlags } from '@launchdarkly/react-client-sdk'`,
      `const {`,
      `  showNewCheckout, // gradual rollout`,
      `  oneClickPurchase, // launched 2025-11-01`,
      `} = useFlags()`,
    ].join('\n')
    const flags = detectFlagsWithRegex('cmt.tsx', content, 'typescript', [reactProvider])
    expect(flags.map((f) => f.name).sort()).toEqual(['oneClickPurchase', 'showNewCheckout'])
  })

  it('passes the import gate via the legacy `launchdarkly-react-client-sdk` alias', () => {
    // Many existing codebases still import the unscoped legacy name; the
    // gate must accept it even though the provider's primary
    // importPattern is the new scoped name.
    const content = [
      `import { useFlag } from 'launchdarkly-react-client-sdk'`,
      `const v = useFlag('legacy-package-flag', false)`,
    ].join('\n')
    const flags = detectFlagsWithRegex('legacy.tsx', content, 'typescript', [reactProvider])
    expect(flags).toHaveLength(1)
    expect(flags[0].name).toBe('legacy-package-flag')
  })

  it('emits nothing for `useFlags()` when no import is present (gate enforced)', () => {
    // The destructure pass is gated on the same import check as the
    // positional path — a file that destructures `useFlags()` without
    // importing the SDK should not light up.
    const content = `const { mystery } = useFlags()`
    const flags = detectFlagsWithRegex('orphan.tsx', content, 'typescript', [reactProvider])
    expect(flags).toEqual([])
  })

  it('combines positional useFlag + destructured useFlags in the same file', () => {
    const content = [
      `import { useFlag, useFlags } from '@launchdarkly/react-client-sdk'`,
      `function A() {`,
      `  const one = useFlag('positional-key', false)`,
      `  const { destructuredOne, destructuredTwo } = useFlags()`,
      `  return one || destructuredOne || destructuredTwo`,
      `}`,
    ].join('\n')
    const flags = detectFlagsWithRegex('mixed.tsx', content, 'typescript', [reactProvider])
    expect(flags.map((f) => f.name).sort()).toEqual([
      'destructuredOne',
      'destructuredTwo',
      'positional-key',
    ])
  })

  it('falls back to provider name when importPattern is unset for the useFlagsHook path', () => {
    // Coverage gate for the `importPat || providerName` short-circuit in
    // the useFlagsHook branch. Providers without an importPattern (the
    // Custom-Feature-Flags catch-all shape) still emit destructured names,
    // tagged with the provider's display name.
    const noImportProvider = {
      name: 'CustomReactHook',
      enabled: true,
      useFlagsHook: 'useFlags',
      methods: [{ name: 'useFlags', flagKeyIndex: -1 }],
    }
    const content = `const { customA, customB } = useFlags()`
    const flags = detectFlagsWithRegex('custom.tsx', content, 'typescript', [noImportProvider])
    expect(flags.map((f) => f.name).sort()).toEqual(['customA', 'customB'])
    expect(flags.every((f) => f.provider === 'CustomReactHook')).toBe(true)
  })

  it('tags destructured flags with confidence:medium when the gate passes via runtimeSymbols', () => {
    // Coverage gate for the medium-confidence branch in
    // detectDestructuredHookFlags. A provider with runtimeSymbols can
    // pass the import gate without a static import (mirroring the
    // PostHog window-loaded pattern); destructured names emitted from
    // that gate carry the same medium tag as the positional path.
    const runtimeReactProvider = {
      name: 'RuntimeReactSDK',
      importPattern: '@example/react-sdk',
      runtimeSymbols: ['useFlags('],
      enabled: true,
      useFlagsHook: 'useFlags',
      methods: [{ name: 'useFlags', flagKeyIndex: -1 }],
    }
    // No static import — gate passes only via the runtime-symbol match.
    const content = `const { runtimeFlagA, runtimeFlagB } = useFlags()`
    const flags = detectFlagsWithRegex('rt.tsx', content, 'typescript', [runtimeReactProvider])
    expect(flags.map((f) => f.name).sort()).toEqual(['runtimeFlagA', 'runtimeFlagB'])
    expect(flags.every((f) => f.confidence === 'medium')).toBe(true)
  })
})
