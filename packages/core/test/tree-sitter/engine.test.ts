import { describe, it, expect, beforeEach } from 'vitest'

import { _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import { _clearQueryCache } from '../../src/detection/tree-sitter/query-runner.js'
import { detectFlagsWithTreeSitter } from '../../src/detection/tree-sitter/engine.js'

import type { FeatureFlagProvider } from '../../src/detection/interface.js'

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
