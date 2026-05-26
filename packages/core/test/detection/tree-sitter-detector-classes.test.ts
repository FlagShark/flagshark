/**
 * Class-level tests for the four tree-sitter detectors (TypeScript, JavaScript, Go, Python).
 * Mirrors the pattern from detector-classes.test.ts but covers the async detectFlags path
 * (engine: 'regex') and the tree-sitter engine path.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { TypeScriptDetector } from '../../src/detection/detectors/typescript.js'
import { JavaScriptDetector } from '../../src/detection/detectors/javascript.js'
import { GoDetector } from '../../src/detection/detectors/go.js'
import { PythonDetector } from '../../src/detection/detectors/python.js'
import { _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import { _clearQueryCache } from '../../src/detection/tree-sitter/query-runner.js'

import type { FeatureFlagProvider } from '../../src/detection/interface.js'

const CUSTOM: FeatureFlagProvider[] = [
  {
    name: 'CustomTest',
    importPattern: 'custom-test',
    description: 'test provider',
    enabled: true,
    methods: [{ name: 'check', flagKeyIndex: 0, examples: ['check("x")'] }],
  },
]

beforeEach(() => {
  _resetParserCacheForTests()
  _clearQueryCache()
})

// ────────────────────────────────────────────────────────────────────────────
// TypeScriptDetector
// ────────────────────────────────────────────────────────────────────────────

describe('TypeScriptDetector class', () => {
  it('default constructor uses default providers', () => {
    const d = new TypeScriptDetector()
    expect(d.getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    const d = new TypeScriptDetector({ providers: CUSTOM })
    expect(d.getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "typescript"', () => {
    expect(new TypeScriptDetector().language()).toBe('typescript')
  })

  it('fileExtensions() is non-empty', () => {
    const exts = new TypeScriptDetector().fileExtensions()
    expect(exts.length).toBeGreaterThan(0)
  })

  it('supportsFile matches .ts', () => {
    expect(new TypeScriptDetector().supportsFile('app.ts')).toBe(true)
  })

  it('supportsFile rejects .rb', () => {
    expect(new TypeScriptDetector().supportsFile('app.rb')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    const d = new TypeScriptDetector({ engine: 'regex' })
    expect(d.detectFlags('app.ts', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    const d = new TypeScriptDetector({ engine: 'tree-sitter' })
    const result = await d.detectFlags('app.ts', '')
    expect(result).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a flag', async () => {
    const d = new TypeScriptDetector({ engine: 'tree-sitter' })
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `const client = LaunchDarkly.init('sdk-key')`,
      `client.variation('TS_FLAG', user, false)`,
    ].join('\n')
    const flags = await d.detectFlags('app.ts', content)
    expect(flags.some((f) => f.name === 'TS_FLAG')).toBe(true)
  })

  // B2.A — runtime-loaded SDK detection. PostHog's canonical snippet
  // attaches the SDK to `window.posthog` from a <script> tag; consumer
  // files never `import 'posthog-js'`. Pre-fix this returned 0 detections;
  // post-fix the runtimeSymbols field on the PostHog provider triggers
  // the import-gate bypass and the flag is detected with confidence:'medium'.
  describe('PostHog runtime-loaded SDK (B2.A)', () => {
    const runtimePostHogSource = [
      // No `import 'posthog-js'` — the SDK is loaded by a layout-level
      // <script> tag and attached to the window.
      `function trackFlag(): void {`,
      `  if (window.posthog.isFeatureEnabled('feature-x')) {`,
      `    doX()`,
      `  }`,
      `}`,
    ].join('\n')

    it('regex engine: detects when posthog is loaded via window without import', async () => {
      const d = new TypeScriptDetector({ engine: 'regex' })
      const flags = await d.detectFlags('app.tsx', runtimePostHogSource)
      const match = flags.find((f) => f.name === 'feature-x')
      expect(match, 'PostHog runtime-loaded flag should be detected').toBeDefined()
      expect(match!.confidence, 'runtime-symbol gate should tag as medium').toBe('medium')
    })

    it('tree-sitter engine: same detection + confidence tag', async () => {
      const d = new TypeScriptDetector({ engine: 'tree-sitter' })
      const flags = await d.detectFlags('app.tsx', runtimePostHogSource)
      const match = flags.find((f) => f.name === 'feature-x')
      expect(match).toBeDefined()
      expect(match!.confidence).toBe('medium')
    })

    it('keeps confidence at "high" when posthog is statically imported', async () => {
      const d = new TypeScriptDetector({ engine: 'tree-sitter' })
      const withImport = [
        `import posthog from 'posthog-js'`,
        `if (posthog.isFeatureEnabled('feature-y')) {}`,
      ].join('\n')
      const flags = await d.detectFlags('app.tsx', withImport)
      const match = flags.find((f) => f.name === 'feature-y')
      expect(match).toBeDefined()
      // High confidence omits the field by convention -- the type
      // docstring says "absent = high". Pin both encodings.
      expect(match!.confidence).toBeUndefined()
    })

    it('does NOT match when the runtime-symbol shape is missing', async () => {
      const d = new TypeScriptDetector({ engine: 'tree-sitter' })
      // String contains "posthog" but not as a property/call shape —
      // this would have false-positived without the disciplined symbol
      // patterns (`window.posthog.`, `posthog.isFeatureEnabled(`).
      const irrelevant = `const note = 'remember to set up posthog later'`
      const flags = await d.detectFlags('notes.ts', irrelevant)
      expect(flags).toEqual([])
    })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// JavaScriptDetector
// ────────────────────────────────────────────────────────────────────────────

describe('JavaScriptDetector class', () => {
  it('default constructor uses default providers', () => {
    const d = new JavaScriptDetector()
    expect(d.getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    const d = new JavaScriptDetector({ providers: CUSTOM })
    expect(d.getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "javascript"', () => {
    expect(new JavaScriptDetector().language()).toBe('javascript')
  })

  it('fileExtensions() is non-empty', () => {
    const exts = new JavaScriptDetector().fileExtensions()
    expect(exts.length).toBeGreaterThan(0)
  })

  it('supportsFile matches .js', () => {
    expect(new JavaScriptDetector().supportsFile('app.js')).toBe(true)
  })

  it('supportsFile matches .jsx', () => {
    expect(new JavaScriptDetector().supportsFile('app.jsx')).toBe(true)
  })

  it('supportsFile matches .mjs', () => {
    expect(new JavaScriptDetector().supportsFile('app.mjs')).toBe(true)
  })

  it('supportsFile matches .cjs', () => {
    expect(new JavaScriptDetector().supportsFile('app.cjs')).toBe(true)
  })

  it('supportsFile rejects .go', () => {
    expect(new JavaScriptDetector().supportsFile('app.go')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    const d = new JavaScriptDetector({ engine: 'regex' })
    expect(d.detectFlags('app.js', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    const d = new JavaScriptDetector({ engine: 'tree-sitter' })
    const result = await d.detectFlags('app.js', '')
    expect(result).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a flag', async () => {
    const d = new JavaScriptDetector({ engine: 'tree-sitter' })
    const content = [
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'`,
      `const client = LaunchDarkly.init('sdk-key')`,
      `client.variation('JS_FLAG', user, false)`,
    ].join('\n')
    const flags = await d.detectFlags('app.js', content)
    expect(flags.some((f) => f.name === 'JS_FLAG')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// GoDetector
// ────────────────────────────────────────────────────────────────────────────

describe('GoDetector class', () => {
  it('default constructor uses default providers', () => {
    const d = new GoDetector()
    expect(d.getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    const d = new GoDetector({ providers: CUSTOM })
    expect(d.getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "go"', () => {
    expect(new GoDetector().language()).toBe('go')
  })

  it('fileExtensions() returns [".go"]', () => {
    expect(new GoDetector().fileExtensions()).toEqual(['.go'])
  })

  it('supportsFile matches .go', () => {
    expect(new GoDetector().supportsFile('main.go')).toBe(true)
  })

  it('supportsFile rejects .ts', () => {
    expect(new GoDetector().supportsFile('main.ts')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    const d = new GoDetector({ engine: 'regex' })
    expect(d.detectFlags('main.go', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    const d = new GoDetector({ engine: 'tree-sitter' })
    const result = await d.detectFlags('main.go', '')
    expect(result).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a LaunchDarkly Go flag', async () => {
    const d = new GoDetector({ engine: 'tree-sitter' })
    const content = [
      `package main`,
      `import ld "github.com/launchdarkly/go-server-sdk/v7"`,
      `func main() {`,
      `  client.BoolVariation("GO_FLAG", context, false)`,
      `}`,
    ].join('\n')
    const flags = await d.detectFlags('main.go', content)
    expect(flags.some((f) => f.name === 'GO_FLAG')).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// PythonDetector
// ────────────────────────────────────────────────────────────────────────────

describe('PythonDetector class', () => {
  it('default constructor uses default providers', () => {
    const d = new PythonDetector()
    expect(d.getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    const d = new PythonDetector({ providers: CUSTOM })
    expect(d.getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "python"', () => {
    expect(new PythonDetector().language()).toBe('python')
  })

  it('fileExtensions() includes .py', () => {
    expect(new PythonDetector().fileExtensions()).toContain('.py')
  })

  it('supportsFile matches .py', () => {
    expect(new PythonDetector().supportsFile('app.py')).toBe(true)
  })

  it('supportsFile matches .pyw', () => {
    expect(new PythonDetector().supportsFile('app.pyw')).toBe(true)
  })

  it('supportsFile matches .pyx', () => {
    expect(new PythonDetector().supportsFile('module.pyx')).toBe(true)
  })

  it('supportsFile matches .pyi', () => {
    expect(new PythonDetector().supportsFile('stubs.pyi')).toBe(true)
  })

  it('supportsFile rejects .rb', () => {
    expect(new PythonDetector().supportsFile('app.rb')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    const d = new PythonDetector({ engine: 'regex' })
    expect(d.detectFlags('app.py', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    const d = new PythonDetector({ engine: 'tree-sitter' })
    const result = await d.detectFlags('app.py', '')
    expect(result).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a LaunchDarkly Python flag', async () => {
    const d = new PythonDetector({ engine: 'tree-sitter' })
    const content = [
      `import ldclient`,
      `client = ldclient.get()`,
      `result = client.variation("PY_FLAG", user, False)`,
    ].join('\n')
    const flags = await d.detectFlags('app.py', content)
    expect(flags.some((f) => f.name === 'PY_FLAG')).toBe(true)
  })
})
