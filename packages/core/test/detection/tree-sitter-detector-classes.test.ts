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
import { JavaDetector } from '../../src/detection/detectors/java.js'
import { CSharpDetector } from '../../src/detection/detectors/csharp.js'
import { PHPDetector } from '../../src/detection/detectors/php.js'
import { RustDetector } from '../../src/detection/detectors/rust.js'
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

  // LaunchDarkly React SDK: tree-sitter's positional-arg query can't see
  // `const { x, y } = useFlags()` directly because the flag keys aren't
  // call arguments. The engine falls through to detectDestructuredHookFlags
  // for any provider that declares `useFlagsHook`. These tests pin that
  // the tree-sitter path emits the same flag set as the regex path.
  describe('LaunchDarkly React SDK destructure (useFlagsHook fallback)', () => {
    it('detects names destructured from useFlags() via the tree-sitter path', async () => {
      const d = new TypeScriptDetector({ engine: 'tree-sitter' })
      const content = [
        `import { useFlags } from '@launchdarkly/react-client-sdk'`,
        `export function Dashboard() {`,
        `  const { showNewCheckout, oneClickPurchase } = useFlags()`,
        `  return showNewCheckout && oneClickPurchase`,
        `}`,
      ].join('\n')
      const flags = await d.detectFlags('Dashboard.tsx', content)
      const names = flags.map((f) => f.name).sort()
      expect(names).toContain('showNewCheckout')
      expect(names).toContain('oneClickPurchase')
    })

    it('also detects useFlag("key") positional sites via tree-sitter', async () => {
      const d = new TypeScriptDetector({ engine: 'tree-sitter' })
      const content = [
        `import { useFlag } from '@launchdarkly/react-client-sdk'`,
        `const v = useFlag('show-checkout-banner', false)`,
      ].join('\n')
      const flags = await d.detectFlags('banner.tsx', content)
      expect(flags.some((f) => f.name === 'show-checkout-banner')).toBe(true)
    })

    it('uses provider.name as the source label when importPattern is unset', async () => {
      // A custom-shaped provider with useFlagsHook but no importPattern
      // (the catch-all custom provider shape). Tree-sitter still picks
      // up destructured names; the emitted `provider` field falls back
      // to the display name.
      const customHook = {
        name: 'CustomTreeSitterHook',
        enabled: true,
        useFlagsHook: 'useFlags',
        methods: [{ name: 'useFlags', flagKeyIndex: -1 }],
      }
      const d = new TypeScriptDetector({ engine: 'tree-sitter', providers: [customHook] })
      const content = `const { tsHookFlagA, tsHookFlagB } = useFlags()`
      const flags = await d.detectFlags('hook.ts', content)
      const names = flags.map((f) => f.name).sort()
      expect(names).toEqual(['tsHookFlagA', 'tsHookFlagB'])
      expect(flags.every((f) => f.provider === 'CustomTreeSitterHook')).toBe(true)
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

// ────────────────────────────────────────────────────────────────────────────
// JavaDetector
// ────────────────────────────────────────────────────────────────────────────

describe('JavaDetector class', () => {
  it('default constructor uses default providers', () => {
    const d = new JavaDetector()
    expect(d.getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    const d = new JavaDetector({ providers: CUSTOM })
    expect(d.getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "java"', () => {
    expect(new JavaDetector().language()).toBe('java')
  })

  it('fileExtensions() returns [".java"]', () => {
    expect(new JavaDetector().fileExtensions()).toEqual(['.java'])
  })

  it('supportsFile matches .java', () => {
    expect(new JavaDetector().supportsFile('App.java')).toBe(true)
  })

  it('supportsFile rejects .kt', () => {
    expect(new JavaDetector().supportsFile('App.kt')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    const d = new JavaDetector({ engine: 'regex' })
    expect(d.detectFlags('App.java', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    const d = new JavaDetector({ engine: 'tree-sitter' })
    const result = await d.detectFlags('App.java', '')
    expect(result).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a LaunchDarkly Java flag', async () => {
    const d = new JavaDetector({ engine: 'tree-sitter' })
    const content = [
      `import com.launchdarkly.sdk.server.LDClient;`,
      `public class App {`,
      `  void run(LDClient client) {`,
      `    client.boolVariation("JAVA_FLAG", context, false);`,
      `  }`,
      `}`,
    ].join('\n')
    const flags = await d.detectFlags('App.java', content)
    expect(flags.some((f) => f.name === 'JAVA_FLAG')).toBe(true)
  })

  it('detectFlags (tree-sitter engine) ignores a flag in a comment', async () => {
    const d = new JavaDetector({ engine: 'tree-sitter' })
    const content = [
      `import com.launchdarkly.sdk.server.LDClient;`,
      `public class App {`,
      `  // client.boolVariation("COMMENTED_FLAG", context, false)`,
      `  void run() {}`,
      `}`,
    ].join('\n')
    const flags = await d.detectFlags('App.java', content)
    expect(flags.some((f) => f.name === 'COMMENTED_FLAG')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// CSharpDetector
// ────────────────────────────────────────────────────────────────────────────

describe('CSharpDetector class', () => {
  it('default constructor uses default providers', () => {
    expect(new CSharpDetector().getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    expect(new CSharpDetector({ providers: CUSTOM }).getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "csharp"', () => {
    expect(new CSharpDetector().language()).toBe('csharp')
  })

  it('supportsFile matches .cs, rejects .php', () => {
    expect(new CSharpDetector().supportsFile('App.cs')).toBe(true)
    expect(new CSharpDetector().supportsFile('app.php')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    expect(new CSharpDetector({ engine: 'regex' }).detectFlags('App.cs', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    expect(await new CSharpDetector({ engine: 'tree-sitter' }).detectFlags('App.cs', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a LaunchDarkly .NET flag', async () => {
    const content = [
      `using LaunchDarkly.Sdk.Server;`,
      `class App {`,
      `  void Run(LdClient client, Context ctx) {`,
      `    var x = client.BoolVariation("CS_FLAG", ctx, false);`,
      `  }`,
      `}`,
    ].join('\n')
    const flags = await new CSharpDetector({ engine: 'tree-sitter' }).detectFlags('App.cs', content)
    expect(flags.some((f) => f.name === 'CS_FLAG')).toBe(true)
  })

  it('detectFlags (tree-sitter engine) ignores a flag in a comment', async () => {
    const content = [
      `using LaunchDarkly.Sdk.Server;`,
      `class App {`,
      `  // client.BoolVariation("CS_COMMENTED", ctx, false)`,
      `  void Run() {}`,
      `}`,
    ].join('\n')
    const flags = await new CSharpDetector({ engine: 'tree-sitter' }).detectFlags('App.cs', content)
    expect(flags.some((f) => f.name === 'CS_COMMENTED')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// PHPDetector
// ────────────────────────────────────────────────────────────────────────────

describe('PHPDetector class', () => {
  it('default constructor uses default providers', () => {
    expect(new PHPDetector().getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    expect(new PHPDetector({ providers: CUSTOM }).getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "php"', () => {
    expect(new PHPDetector().language()).toBe('php')
  })

  it('supportsFile matches .php, rejects .cs', () => {
    expect(new PHPDetector().supportsFile('app.php')).toBe(true)
    expect(new PHPDetector().supportsFile('App.cs')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    expect(new PHPDetector({ engine: 'regex' }).detectFlags('app.php', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    expect(await new PHPDetector({ engine: 'tree-sitter' }).detectFlags('app.php', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a LaunchDarkly PHP flag', async () => {
    const content = [
      `<?php`,
      `use LaunchDarkly\\LDClient;`,
      `$enabled = $client->variation("PHP_FLAG", $ctx, false);`,
    ].join('\n')
    const flags = await new PHPDetector({ engine: 'tree-sitter' }).detectFlags('app.php', content)
    expect(flags.some((f) => f.name === 'PHP_FLAG')).toBe(true)
  })

  it('detectFlags (tree-sitter engine) ignores a flag in a comment', async () => {
    const content = [
      `<?php`,
      `use LaunchDarkly\\LDClient;`,
      `// $client->variation("PHP_COMMENTED", $ctx, false)`,
      `$x = 1;`,
    ].join('\n')
    const flags = await new PHPDetector({ engine: 'tree-sitter' }).detectFlags('app.php', content)
    expect(flags.some((f) => f.name === 'PHP_COMMENTED')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// RustDetector
// ────────────────────────────────────────────────────────────────────────────

describe('RustDetector class', () => {
  it('default constructor uses default providers', () => {
    expect(new RustDetector().getProviders().length).toBeGreaterThan(0)
  })

  it('custom providers replace defaults', () => {
    expect(new RustDetector({ providers: CUSTOM }).getProviders()).toEqual(CUSTOM)
  })

  it('language() returns "rust"', () => {
    expect(new RustDetector().language()).toBe('rust')
  })

  it('supportsFile matches .rs, rejects .rb', () => {
    expect(new RustDetector().supportsFile('main.rs')).toBe(true)
    expect(new RustDetector().supportsFile('main.rb')).toBe(false)
  })

  it('detectFlags (regex engine) returns empty for empty content', () => {
    expect(new RustDetector({ engine: 'regex' }).detectFlags('main.rs', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) returns empty for empty content', async () => {
    expect(await new RustDetector({ engine: 'tree-sitter' }).detectFlags('main.rs', '')).toEqual([])
  })

  it('detectFlags (tree-sitter engine) detects a LaunchDarkly Rust flag', async () => {
    const content = [
      `use launchdarkly_server_sdk::Client;`,
      `fn run(client: &Client, ctx: &Context) {`,
      `    let x = client.bool_variation(&ctx, "RUST_FLAG", false);`,
      `}`,
    ].join('\n')
    const flags = await new RustDetector({ engine: 'tree-sitter' }).detectFlags('main.rs', content)
    expect(flags.some((f) => f.name === 'RUST_FLAG')).toBe(true)
  })

  it('detectFlags (tree-sitter engine) ignores a flag in a comment', async () => {
    const content = [
      `use launchdarkly_server_sdk::Client;`,
      `// client.bool_variation(&ctx, "RUST_COMMENTED", false)`,
      `fn run() {}`,
    ].join('\n')
    const flags = await new RustDetector({ engine: 'tree-sitter' }).detectFlags('main.rs', content)
    expect(flags.some((f) => f.name === 'RUST_COMMENTED')).toBe(false)
  })
})
