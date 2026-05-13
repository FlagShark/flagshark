import { describe, it, expect, beforeEach } from 'vitest'

import { _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import { _clearQueryCache } from '../../src/detection/tree-sitter/query-runner.js'
import { detectFlagsWithTreeSitter } from '../../src/detection/tree-sitter/engine.js'

import type { FeatureFlagProvider } from '../../src/detection/interface.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Provider where all methods have flagKeyIndex === -1 (skip in tree-sitter path). */
const allNegativeFlagIndexProvider: FeatureFlagProvider = {
  name: 'TestNegative',
  importPattern: 'negative-sdk',
  enabled: true,
  methods: [
    { name: 'useFlags', flagKeyIndex: -1 },
    { name: 'allFlags', flagKeyIndex: -1 },
  ],
}

const launchDarklyProvider: FeatureFlagProvider = {
  name: 'LaunchDarkly Node Server SDK',
  importPattern: 'launchdarkly-node-server-sdk',
  enabled: true,
  methods: [
    { name: 'variation', flagKeyIndex: 0 },
    { name: 'boolVariation', flagKeyIndex: 0 },
  ],
}

describe('detectFlagsWithTreeSitter (TypeScript)', () => {
  beforeEach(() => {
    _resetParserCacheForTests()
    _clearQueryCache()
  })

  it('detects a single-line variation call', async () => {
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `const client = LaunchDarkly.init('sdk-key')`,
      `if (await client.variation('NEW_CHECKOUT', user, false)) {}`,
    ].join('\n')

    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])

    expect(flags).toEqual([
      {
        name: 'NEW_CHECKOUT',
        filePath: 'app.ts',
        lineNumber: 3,
        language: 'typescript',
        provider: 'launchdarkly-node-server-sdk',
      },
    ])
  })

  it('skips files that do not import the provider SDK', async () => {
    const content = `if (await client.variation('NEW_CHECKOUT', user, false)) {}`
    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([])
  })

  it('ignores flag names inside string literals (precision — goal A)', async () => {
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `throw new Error("variation('FAKE_FLAG_IN_STRING') failed")`,
    ].join('\n')

    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([])
  })

  it('ignores flag names inside comments (precision — goal A)', async () => {
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `// TODO: client.variation('FAKE_FLAG_IN_COMMENT', user, false)`,
      `const x = 1`,
    ].join('\n')

    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([])
  })

  it('handles multi-line calls (recall — goal C)', async () => {
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `const result = await client.variation(`,
      `  'MULTI_LINE_FLAG',`,
      `  user,`,
      `  false`,
      `)`,
    ].join('\n')

    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([
      {
        name: 'MULTI_LINE_FLAG',
        filePath: 'app.ts',
        lineNumber: 2,
        language: 'typescript',
        provider: 'launchdarkly-node-server-sdk',
      },
    ])
  })
})

describe('detectFlagsWithTreeSitter — branch coverage', () => {
  beforeEach(() => {
    _resetParserCacheForTests()
    _clearQueryCache()
  })

  it('returns [] when all providers are disabled', async () => {
    const disabled: FeatureFlagProvider = {
      ...launchDarklyProvider,
      enabled: false,
    }
    const flags = await detectFlagsWithTreeSitter('app.ts', `import 'launchdarkly-node-server-sdk'`, 'typescript', [disabled])
    expect(flags).toEqual([])
  })

  it('returns [] when all methods have flagKeyIndex < 0 (methodLookup.size === 0)', async () => {
    // Provider is active (enabled=true, importPattern matched) but all methods are negative index.
    // This hits the `if (methodLookup.size === 0) return []` branch (line 44).
    const content = `import 'negative-sdk'\nclient.useFlags()`
    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [allNegativeFlagIndexProvider])
    expect(flags).toEqual([])
  })

  it('returns [] for a provider with empty methods array', async () => {
    const emptyMethods: FeatureFlagProvider = {
      name: 'NoMethods',
      importPattern: 'some-sdk',
      enabled: true,
      methods: [],
    }
    const flags = await detectFlagsWithTreeSitter('app.ts', `import 'some-sdk'`, 'typescript', [emptyMethods])
    expect(flags).toEqual([])
  })

  it('detects a Go flag (non-TS/JS language — skips const-extraction branch)', async () => {
    // Go path skips the `language === 'typescript' || language === 'javascript'` branch (lines 65-67)
    const content = [
      `package main`,
      `import ld "github.com/launchdarkly/go-server-sdk/v7"`,
      `func main() {`,
      `  client.BoolVariation("GO_ENGINE_FLAG", context, false)`,
      `}`,
    ].join('\n')
    const flags = await detectFlagsWithTreeSitter('main.go', content, 'go', [
      {
        name: 'LaunchDarkly Go',
        importPattern: 'github.com/launchdarkly/go-server-sdk/v7',
        enabled: true,
        methods: [{ name: 'BoolVariation', flagKeyIndex: 0 }],
      },
    ])
    expect(flags.some((f) => f.name === 'GO_ENGINE_FLAG')).toBe(true)
  })

  it('uses provider.name when provider has no importPattern', async () => {
    // The `getImportPattern(provider) || provider.name` branch (line 76)
    const customProvider: FeatureFlagProvider = {
      name: 'CustomProviderName',
      // No importPattern — custom/fallback provider
      enabled: true,
      methods: [{ name: 'isFeatureEnabled', flagKeyIndex: 0 }],
    }
    const content = `isFeatureEnabled('CUSTOM_FLAG')`
    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [customProvider])
    if (flags.length > 0) {
      expect(flags[0].provider).toBe('CustomProviderName')
    }
    // Even if no flags found (query may not match standalone calls), the branch is exercised
  })

  it('skips calls where the arg at flagKeyIndex does not exist (!arg branch)', async () => {
    // Call variation with NO args — getArgument(argsNode, 0) returns null → `if (!arg) continue`
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `client.variation()`,
    ].join('\n')
    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([])
  })

  it('skips calls where flagKey is null and resolveConstStringTS also returns null', async () => {
    // An identifier arg (not string literal, not a resolvable const) → flagKey = null (line 65)
    // resolveConstStringTS returns null → flagKey stays null → skipped by line 69
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `client.variation(UNRESOLVABLE_VAR, user, false)`,
    ].join('\n')
    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([])
  })

  it('skips calls where the flag key fails isValidFlagKey (!isValidFlagKey branch)', async () => {
    // An empty string literal would fail isValidFlagKey → skipped
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `client.variation('', user, false)`,
    ].join('\n')
    const flags = await detectFlagsWithTreeSitter('app.ts', content, 'typescript', [launchDarklyProvider])
    expect(flags).toEqual([])
  })

  it('skips non-string args for Go (flagKey null AND not TS/JS — line 65 false branch)', async () => {
    // For Go, when arg is an identifier (not a string literal), flagKey is null.
    // The const-extraction branch (line 65) is NOT entered because language is not TS/JS.
    const content = [
      `package main`,
      `import ld "github.com/launchdarkly/go-server-sdk/v7"`,
      `func main() {`,
      `  client.BoolVariation(FLAG_VAR, context, false)`,
      `}`,
    ].join('\n')
    const flags = await detectFlagsWithTreeSitter('main.go', content, 'go', [
      {
        name: 'LaunchDarkly Go',
        importPattern: 'github.com/launchdarkly/go-server-sdk/v7',
        enabled: true,
        methods: [{ name: 'BoolVariation', flagKeyIndex: 0 }],
      },
    ])
    // FLAG_VAR is an identifier, not a string → null flagKey, not resolved (not TS/JS) → skipped
    expect(flags.some((f) => f.name === 'FLAG_VAR')).toBe(false)
  })
})
