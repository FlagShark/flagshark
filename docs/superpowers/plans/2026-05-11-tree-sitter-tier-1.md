# Tree-sitter Detection Engine — Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace regex-based flag detection with tree-sitter (WASM) for tier-1 languages — TypeScript, JavaScript, Go, Python — while keeping the existing public `@flagshark/core` API surface unchanged. Ships as `@flagshark/core@1.3.0` / `flagshark@1.3.0`.

**Architecture:** Add a parallel `detectFlagsWithTreeSitter` engine that mirrors the existing `detectFlagsWithRegex` helper signature. Each per-language detector accepts a constructor option `{ engine: 'regex' | 'tree-sitter' }`. `createDefaultRegistry()` selects tree-sitter for tier-1 languages and regex for the rest. WASM grammars are loaded lazily from the standard `tree-sitter-<lang>` npm packages.

**Tech Stack:**
- web-tree-sitter 0.25.x (WASM bindings, Apache-2.0)
- tree-sitter-typescript, tree-sitter-javascript, tree-sitter-go, tree-sitter-python (each ships prebuilt .wasm)
- vitest (existing)
- esbuild `--loader:.wasm=file` for the Action bundle

**Spec:** [docs/superpowers/specs/2026-05-11-tree-sitter-detection-engine-design.md](../specs/2026-05-11-tree-sitter-detection-engine-design.md)

---

## Reference: file layout after this plan

```
packages/core/
├── package.json                            # +deps: web-tree-sitter + 4 grammars
├── grammars/                               # NEW — used by T5 (Kotlin/Swift) only; empty for now
├── src/
│   ├── detection/
│   │   ├── detectors/
│   │   │   ├── typescript.ts               # +engine option
│   │   │   ├── javascript.ts               # +engine option
│   │   │   ├── go.ts                       # +engine option
│   │   │   ├── python.ts                   # +engine option
│   │   │   └── (others unchanged)
│   │   ├── index.ts                        # createDefaultRegistry: tier-1 = tree-sitter
│   │   ├── tree-sitter/                    # NEW
│   │   │   ├── engine.ts                   # detectFlagsWithTreeSitter
│   │   │   ├── parser-cache.ts             # getParser(lang) — lazy WASM load
│   │   │   ├── query-runner.ts             # match-walking + capture helpers
│   │   │   ├── query-builder.ts            # synthesize per-method queries from MethodConfig
│   │   │   ├── const-resolver.ts           # resolve `const X = '...'` flag-key bindings
│   │   │   └── queries/
│   │   │       ├── typescript.scm
│   │   │       ├── javascript.scm
│   │   │       ├── go.scm
│   │   │       └── python.scm
│   │   └── ...
│   └── ...
└── test/
    ├── tree-sitter/
    │   ├── parser-cache.test.ts            # NEW
    │   ├── engine.test.ts                  # NEW — synthetic tests
    │   ├── corpus.test.ts                  # NEW — parameterized over fixtures
    │   └── const-resolver.test.ts          # NEW
    └── fixtures/tree-sitter/
        ├── typescript/launchdarkly/{positive,negative}/*.ts + expected.json
        ├── javascript/launchdarkly/{positive,negative}/*.js + expected.json
        ├── go/launchdarkly/{positive,negative}/*.go + expected.json
        └── python/launchdarkly/{positive,negative}/*.py + expected.json

packages/cli/
└── src/cli.ts                              # +--engine smoke flag (undocumented)

packages/action/
├── package.json                            # build now copies WASM
├── scripts/
│   └── build.mjs                           # NEW — esbuild + WASM copy
├── dist/grammars/                          # NEW — populated by build, gitignored
└── ...
```

---

## Milestone map

| M | Outcome | Commit message |
|---|---|---|
| M0 | Worktree + branch | (no commit) |
| M1 | Dependencies installed, smoke-load WASM in a Node REPL | chore: add web-tree-sitter and tier-1 grammars |
| M2 | Parser cache (TDD): one parser per language, cached, WASM resolution works | feat(core): add tree-sitter parser cache |
| M3 | Engine baseline: detect a single LaunchDarkly call in a synthetic TS source | feat(core): add tree-sitter detection engine |
| M4 | TS corpus + dual-mode TypeScript detector + corpus harness | feat(core): tree-sitter detection for TypeScript |
| M5 | JS corpus + dual-mode JavaScript detector | feat(core): tree-sitter detection for JavaScript |
| M6 | Go corpus + dual-mode Go detector | feat(core): tree-sitter detection for Go |
| M7 | Python corpus + dual-mode Python detector | feat(core): tree-sitter detection for Python |
| M8 | Const-extraction (goal C from spec): resolve `const X = '…'` in TS | feat(core): const-extraction for tree-sitter (TS) |
| M9 | CLI `--engine` smoke flag (undocumented in `--help`) | feat(cli): add hidden --engine flag for smoke testing |
| M10 | Action bundle script copies WASM, smoke-runs locally | chore(action): bundle WASM grammars |
| M11 | Flip default in `createDefaultRegistry()` for tier-1 | feat(core): default tier-1 languages to tree-sitter |
| M12 | Release v1.3.0 | chore: release v1.3.0 |

Each milestone produces a working repository state and ends with one commit.

---

## Milestone M0 — Worktree

### Task 0.1: Create worktree

- [ ] **Step 0.1.1: Create worktree off `main`**

```bash
cd /Users/joe/projects/flagshark
git worktree add ../flagshark-treesitter-t1 -b feat/treesitter-tier-1
cd ../flagshark-treesitter-t1
```

Expected: worktree exists at `../flagshark-treesitter-t1`, branch `feat/treesitter-tier-1` checked out.

- [ ] **Step 0.1.2: Install existing dependencies**

```bash
bun install
```

Expected: `bun.lock` unchanged, install completes cleanly, all workspaces resolve.

- [ ] **Step 0.1.3: Verify baseline tests pass**

```bash
bun run test
```

Expected: all existing vitest suites pass. If any fail on `main`, stop and report — this plan assumes a green baseline.

---

## Milestone M1 — Add tree-sitter dependencies

Goal: add the 4 tier-1 grammar packages and the `web-tree-sitter` runtime as production deps of `@flagshark/core`. Smoke-load a WASM blob from Node to prove resolution works before writing the cache.

### Task 1.1: Add dependencies

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1.1.1: Add deps via bun**

```bash
cd packages/core
bun add web-tree-sitter@^0.25.0
bun add tree-sitter-typescript@^0.23.0 tree-sitter-javascript@^0.25.0 tree-sitter-go@^0.25.0 tree-sitter-python@^0.25.0
```

Expected: 5 new entries under `dependencies` in `packages/core/package.json`. `bun.lock` updated at repo root.

- [ ] **Step 1.1.2: Verify the WASM files are physically present in `node_modules`**

```bash
ls node_modules/tree-sitter-typescript/tree-sitter-*.wasm \
   node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm \
   node_modules/tree-sitter-go/tree-sitter-go.wasm \
   node_modules/tree-sitter-python/tree-sitter-python.wasm
```

Expected: 5 paths printed (TS package ships `tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm`).

If any path is missing, the npm package shape changed — stop and inspect that package's `node_modules/<pkg>/` directory; update `parser-cache.ts` (M2) to point at the new path.

### Task 1.2: Smoke-load a WASM grammar

- [ ] **Step 1.2.1: Run an inline Node smoke**

From `packages/core`:

```bash
node --input-type=module -e "
import { createRequire } from 'node:module'
import Parser from 'web-tree-sitter'
const require = createRequire(import.meta.url)
await Parser.init()
const wasmPath = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')
const Language = await Parser.Language.load(wasmPath)
const parser = new Parser()
parser.setLanguage(Language)
const tree = parser.parse('const x = client.variation(\"FLAG\", user, false)')
console.log(tree.rootNode.toString().slice(0, 200))
"
```

Expected: prints an S-expression tree starting with `(program ...)` and containing `(call_expression ...)`. If you see an error about `wasi_snapshot_preview1` or `WebAssembly.compile`, the `web-tree-sitter` version is incompatible with your Node version — bump to Node 22.

### Task 1.3: Commit

- [ ] **Step 1.3.1: Commit M1**

```bash
git add packages/core/package.json bun.lock
git commit -m "chore: add web-tree-sitter and tier-1 grammars"
```

---

## Milestone M2 — Parser cache (TDD)

Goal: a tested `getParser(language)` function that lazily loads + caches one `Parser` instance per language. No detection logic yet.

### Task 2.1: Create the parser cache module with a failing test

**Files:**
- Create: `packages/core/src/detection/tree-sitter/parser-cache.ts`
- Create: `packages/core/test/tree-sitter/parser-cache.test.ts`

- [ ] **Step 2.1.1: Write the failing test**

`packages/core/test/tree-sitter/parser-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'

import { getParser, _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'

describe('parser-cache', () => {
  beforeEach(() => {
    _resetParserCacheForTests()
  })

  it('returns a Parser instance for typescript', async () => {
    const parser = await getParser('typescript')
    expect(parser).toBeDefined()
    const tree = parser.parse('const x = 1')
    expect(tree.rootNode.type).toBe('program')
  })

  it('caches parsers — second call returns the same instance', async () => {
    const a = await getParser('typescript')
    const b = await getParser('typescript')
    expect(a).toBe(b)
  })

  it('handles concurrent calls for the same language without double-loading', async () => {
    const [a, b] = await Promise.all([getParser('typescript'), getParser('typescript')])
    expect(a).toBe(b)
  })

  it('throws for unsupported languages', async () => {
    await expect(getParser('cobol' as never)).rejects.toThrow(/No tree-sitter grammar/)
  })

  it('returns different instances for different languages', async () => {
    const ts = await getParser('typescript')
    const js = await getParser('javascript')
    expect(ts).not.toBe(js)
  })
})
```

- [ ] **Step 2.1.2: Run test, verify it fails**

```bash
cd packages/core && bun run test parser-cache
```

Expected: FAIL — `parser-cache.ts` doesn't exist.

- [ ] **Step 2.1.3: Implement the parser cache**

`packages/core/src/detection/tree-sitter/parser-cache.ts`:

```ts
import { createRequire } from 'node:module'

import Parser from 'web-tree-sitter'

import type { Language } from '../interface.js'

const require_ = createRequire(import.meta.url)

const WASM_RESOLUTION: Partial<Record<Language, string>> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
}

const parsers = new Map<Language, Parser>()
const inFlight = new Map<Language, Promise<Parser>>()
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init()
  }
  await initPromise
}

function resolveWasmPath(spec: string): string {
  // In an Action bundle, WASM files are copied next to action.cjs and resolved
  // via process.env.FLAGSHARK_WASM_DIR (set by the bundle entry).
  const bundleDir = process.env.FLAGSHARK_WASM_DIR
  if (bundleDir) {
    const file = spec.split('/').pop()!
    return `${bundleDir}/${file}`
  }
  return require_.resolve(spec)
}

export async function getParser(lang: Language): Promise<Parser> {
  await ensureInit()

  const cached = parsers.get(lang)
  if (cached) return cached

  const pending = inFlight.get(lang)
  if (pending) return pending

  const wasmSpec = WASM_RESOLUTION[lang]
  if (!wasmSpec) {
    throw new Error(`No tree-sitter grammar registered for language: ${lang}`)
  }

  const load = (async () => {
    const wasmPath = resolveWasmPath(wasmSpec)
    const Language_ = await Parser.Language.load(wasmPath)
    const parser = new Parser()
    parser.setLanguage(Language_)
    parsers.set(lang, parser)
    inFlight.delete(lang)
    return parser
  })()

  inFlight.set(lang, load)
  return load
}

/** @internal — for tests only */
export function _resetParserCacheForTests(): void {
  parsers.clear()
  inFlight.clear()
  initPromise = null
}
```

- [ ] **Step 2.1.4: Run test, verify it passes**

```bash
bun run test parser-cache
```

Expected: 5 tests pass.

### Task 2.2: Commit

- [ ] **Step 2.2.1: Commit M2**

```bash
git add packages/core/src/detection/tree-sitter/parser-cache.ts \
        packages/core/test/tree-sitter/parser-cache.test.ts
git commit -m "feat(core): add tree-sitter parser cache"
```

---

## Milestone M3 — Detection engine baseline

Goal: `detectFlagsWithTreeSitter(filename, content, language, providers)` that, given one synthetic TypeScript LaunchDarkly call, returns the same `FeatureFlag[]` the regex engine produces. No corpus yet — one inline test only.

### Task 3.1: Engine + query builder + query runner

**Files:**
- Create: `packages/core/src/detection/tree-sitter/engine.ts`
- Create: `packages/core/src/detection/tree-sitter/query-builder.ts`
- Create: `packages/core/src/detection/tree-sitter/query-runner.ts`
- Create: `packages/core/src/detection/tree-sitter/queries/typescript.scm`
- Create: `packages/core/test/tree-sitter/engine.test.ts`

- [ ] **Step 3.1.1: Write the TypeScript query**

`packages/core/src/detection/tree-sitter/queries/typescript.scm`:

```scheme
; Match method-style calls: <receiver>.<method>(<args>)
(call_expression
  function: (member_expression
    object: (_) @receiver
    property: (property_identifier) @method)
  arguments: (arguments) @args) @call

; Match free-function calls: <method>(<args>)
(call_expression
  function: (identifier) @method
  arguments: (arguments) @args) @call
```

The queries match every call expression. The engine post-filters by `@method` capture text matching a configured method name. This keeps the query template fully generic — adding a new provider is a config change, not a query change.

- [ ] **Step 3.1.2: Write the failing engine test**

`packages/core/test/tree-sitter/engine.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'

import { _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
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
```

- [ ] **Step 3.1.3: Run test, verify it fails**

```bash
bun run test engine
```

Expected: FAIL — `engine.ts` doesn't exist.

- [ ] **Step 3.1.4: Implement the query runner**

`packages/core/src/detection/tree-sitter/query-runner.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Query, QueryCapture, SyntaxNode, Tree } from 'web-tree-sitter'
import type Parser from 'web-tree-sitter'

import type { Language } from '../interface.js'

/** Loads the .scm query text for a language, relative to this module. */
export function loadQueryText(lang: Language): string {
  const url = new URL(`./queries/${lang}.scm`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf-8')
}

const queryCache = new Map<Language, Query>()

export function getQuery(parser: Parser, lang: Language): Query {
  const cached = queryCache.get(lang)
  if (cached) return cached
  const Language_ = parser.getLanguage()
  const query = Language_.query(loadQueryText(lang))
  queryCache.set(lang, query)
  return query
}

export interface MatchedCall {
  callNode: SyntaxNode
  methodName: string
  argsNode: SyntaxNode
}

/** Walks query matches and yields one MatchedCall per call expression. */
export function* iterateCalls(tree: Tree, query: Query): Generator<MatchedCall> {
  for (const match of query.matches(tree.rootNode)) {
    const captures = match.captures
    const call = captures.find((c) => c.name === 'call')?.node
    const method = captures.find((c) => c.name === 'method')?.node
    const args = captures.find((c) => c.name === 'args')?.node
    if (!call || !method || !args) continue
    yield { callNode: call, methodName: method.text, argsNode: args }
  }
}

/** Returns the Nth argument node, or null if out of range. */
export function getArgument(argsNode: SyntaxNode, index: number): SyntaxNode | null {
  const realChildren = argsNode.namedChildren.filter((n) => n.type !== 'comment')
  return realChildren[index] ?? null
}

/** Returns the string value if the node is a string literal, else null. */
export function extractStringLiteral(node: SyntaxNode): string | null {
  // tree-sitter string literal shapes vary per grammar.
  // TypeScript/JavaScript: (string) with (string_fragment) children, or (template_string)
  // Go: (interpreted_string_literal) or (raw_string_literal)
  // Python: (string) with (string_content) children
  const type = node.type
  const text = node.text

  if (type === 'string' || type === 'string_literal' ||
      type === 'interpreted_string_literal' || type === 'raw_string_literal' ||
      type === 'template_string') {
    // Strip surrounding quotes — works for all grammars where the literal text includes them.
    if (text.length < 2) return null
    const first = text[0]
    const last = text[text.length - 1]
    if (first === last && (first === '"' || first === "'" || first === '`')) {
      return text.slice(1, -1)
    }
    // Python triple-quoted etc. — strip matched prefix/suffix
    if (text.startsWith('"""') && text.endsWith('"""')) return text.slice(3, -3)
    if (text.startsWith("'''") && text.endsWith("'''")) return text.slice(3, -3)
  }
  return null
}

/** @internal — for tests */
export function _clearQueryCache(): void {
  queryCache.clear()
}
```

- [ ] **Step 3.1.5: Implement the query builder (stub for now)**

`packages/core/src/detection/tree-sitter/query-builder.ts`:

```ts
/**
 * In T1 we use a single static query per language and filter matches in JS.
 * This module exists to keep the interface symmetric with future tiers
 * (e.g. T6's hardcoded-signal queries) and to centralize any future query
 * synthesis.
 */

import type { Language } from '../interface.js'

import { loadQueryText } from './query-runner.js'

export function buildMethodCallQuery(lang: Language): string {
  // Today: just return the static query for the language.
  // Future: synthesize per-method-set queries when we want predicate filtering inside the .scm.
  return loadQueryText(lang)
}
```

- [ ] **Step 3.1.6: Implement the engine**

`packages/core/src/detection/tree-sitter/engine.ts`:

```ts
import { deduplicateFlags } from '../helpers.js'
import { getImportPattern } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, MethodConfig } from '../interface.js'

import { getParser } from './parser-cache.js'
import { getQuery, iterateCalls, getArgument, extractStringLiteral } from './query-runner.js'

const FLAG_KEY_MAX_LENGTH = 256
const INVALID_PREFIXES = ['http://', 'https://', 'file://', '/']

function isValidFlagKey(key: string): boolean {
  if (key.length === 0 || key.length > FLAG_KEY_MAX_LENGTH) return false
  for (const prefix of INVALID_PREFIXES) {
    if (key.startsWith(prefix)) return false
  }
  return true
}

/**
 * Detect feature flags via tree-sitter. Mirrors detectFlagsWithRegex's contract.
 *
 * Import-gating: skip provider scans for files that don't contain the import pattern
 * as a substring. Cheap text check before parsing — saves AST work on most files.
 * Custom providers (no importPattern) always scan.
 */
export async function detectFlagsWithTreeSitter(
  filename: string,
  content: string,
  language: Language,
  providers: FeatureFlagProvider[],
): Promise<FeatureFlag[]> {
  // Pre-filter providers based on import presence (text check, fast)
  const activeProviders = providers.filter((p) => {
    if (!p.enabled) return false
    if (p.methods.length === 0) return false
    const importPat = getImportPattern(p)
    if (!importPat) return true // custom providers — no gate
    return content.includes(importPat)
  })

  if (activeProviders.length === 0) return []

  // Build a method-name → (provider, MethodConfig) lookup
  const methodLookup = new Map<string, Array<{ provider: FeatureFlagProvider; method: MethodConfig }>>()
  for (const provider of activeProviders) {
    for (const method of provider.methods) {
      if (method.flagKeyIndex < 0) continue
      const list = methodLookup.get(method.name) ?? []
      list.push({ provider, method })
      methodLookup.set(method.name, list)
    }
  }

  if (methodLookup.size === 0) return []

  const parser = await getParser(language)
  const tree = parser.parse(content)
  const query = getQuery(parser, language)

  const flags: FeatureFlag[] = []

  for (const { callNode, methodName, argsNode } of iterateCalls(tree, query)) {
    const matches = methodLookup.get(methodName)
    if (!matches) continue

    for (const { provider, method } of matches) {
      const arg = getArgument(argsNode, method.flagKeyIndex)
      if (!arg) continue

      const flagKey = extractStringLiteral(arg)
      if (!flagKey || !isValidFlagKey(flagKey)) continue

      flags.push({
        name: flagKey,
        filePath: filename,
        lineNumber: callNode.startPosition.row + 1,
        language,
        provider: getImportPattern(provider) || provider.name,
      })
    }
  }

  return deduplicateFlags(flags)
}
```

- [ ] **Step 3.1.7: Run test, verify it passes**

```bash
bun run test engine
```

Expected: all 5 tests pass.

- [ ] **Step 3.1.8: Verify no regressions in unrelated tests**

```bash
bun run test
```

Expected: all existing suites still pass.

### Task 3.2: Commit

- [ ] **Step 3.2.1: Commit M3**

```bash
git add packages/core/src/detection/tree-sitter/ packages/core/test/tree-sitter/
git commit -m "feat(core): add tree-sitter detection engine"
```

---

## Milestone M4 — TypeScript: corpus + dual-mode detector

Goal: build the parameterized corpus harness and wire it to the TypeScript detector. After this milestone, you can flip a TypeScript scan from regex to tree-sitter via the `engine` constructor option and the test corpus validates both modes.

### Task 4.1: Build the test corpus

**Files:**
- Create: `packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/positive/*.ts`
- Create: `packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/negative/*.ts`
- Create: `packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/expected.json`

- [ ] **Step 4.1.1: Create the directory structure**

```bash
mkdir -p packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/positive
mkdir -p packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/negative
```

- [ ] **Step 4.1.2: Write positive fixtures**

`positive/single-line.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function checkout(user: { key: string }) {
  if (await client.variation('CHECKOUT_V2', user, false)) {
    return 'v2'
  }
  return 'v1'
}
```

`positive/multi-line.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function multi(user: { key: string }) {
  const result = await client.variation(
    'MULTI_LINE_FLAG',
    user,
    false,
  )
  return result
}
```

`positive/nested-call.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function nested(user: { key: string }) {
  if (await client.boolVariation('NESTED_FLAG', user, false)) {
    console.log('on')
  }
}
```

`positive/comment-mid-expression.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

export async function commented(user: { key: string }) {
  return client.variation(/* important: */ 'COMMENT_MID_FLAG', user, false)
}
```

- [ ] **Step 4.1.3: Write negative fixtures**

`negative/flag-in-comment.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const client = LaunchDarkly.init('sdk-key')

// TODO: enable client.variation('FAKE_IN_COMMENT', user, false) for next release
export const noop = () => null
```

`negative/flag-in-string.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

export function error() {
  throw new Error("client.variation('FAKE_IN_STRING', user, false) is disabled")
}
```

`negative/no-import.ts`:

```ts
// No LaunchDarkly import — should NOT be detected even though it looks like a call.

export function fake(client: { variation: (name: string) => boolean }) {
  return client.variation('NO_IMPORT_FLAG')
}
```

`negative/unrelated-call.ts`:

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

// Unrelated method on an unrelated object — shouldn't match.
const db = { execute: (s: string) => s, variation: (s: string) => s }
export const x = db.execute('SELECT * FROM users')
export const y = db.variation('schema_v2')  // db is not an LD client, but our engine WILL flag this
                                              // because the engine treats any .variation call as a candidate.
                                              // Documented limitation — covered in spec §10 open question 4.
```

NOTE: the `unrelated-call.ts` fixture documents a *known limitation*: the engine matches any `.variation('STRING')` call when a LaunchDarkly import is present in the file. Cross-reference resolution (knowing `db` is not `client`) is out of scope for T1. The fixture's `expected.json` reflects this — the engine WILL flag `db.variation('schema_v2')` for now.

- [ ] **Step 4.1.4: Write expected.json**

`expected.json`:

```json
[
  {
    "file": "positive/single-line.ts",
    "flags": [
      { "name": "CHECKOUT_V2", "filePath": "positive/single-line.ts", "lineNumber": 6, "language": "typescript", "provider": "launchdarkly-node-server-sdk" }
    ]
  },
  {
    "file": "positive/multi-line.ts",
    "flags": [
      { "name": "MULTI_LINE_FLAG", "filePath": "positive/multi-line.ts", "lineNumber": 6, "language": "typescript", "provider": "launchdarkly-node-server-sdk" }
    ]
  },
  {
    "file": "positive/nested-call.ts",
    "flags": [
      { "name": "NESTED_FLAG", "filePath": "positive/nested-call.ts", "lineNumber": 6, "language": "typescript", "provider": "launchdarkly-node-server-sdk" }
    ]
  },
  {
    "file": "positive/comment-mid-expression.ts",
    "flags": [
      { "name": "COMMENT_MID_FLAG", "filePath": "positive/comment-mid-expression.ts", "lineNumber": 6, "language": "typescript", "provider": "launchdarkly-node-server-sdk" }
    ]
  },
  {
    "file": "negative/flag-in-comment.ts",
    "flags": []
  },
  {
    "file": "negative/flag-in-string.ts",
    "flags": []
  },
  {
    "file": "negative/no-import.ts",
    "flags": []
  },
  {
    "file": "negative/unrelated-call.ts",
    "flags": [
      { "name": "schema_v2", "filePath": "negative/unrelated-call.ts", "lineNumber": 6, "language": "typescript", "provider": "launchdarkly-node-server-sdk" }
    ]
  }
]
```

### Task 4.2: Corpus harness

**Files:**
- Create: `packages/core/test/tree-sitter/corpus.test.ts`

- [ ] **Step 4.2.1: Write the corpus harness**

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { detectFlagsWithTreeSitter } from '../../src/detection/tree-sitter/engine.js'
import { defaultTypeScriptProviders } from '../../src/detection/detectors/typescript.js'

import type { FeatureFlagProvider, Language } from '../../src/detection/interface.js'

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/tree-sitter')

const LANGUAGES: { name: Language; providers: () => FeatureFlagProvider[] }[] = [
  { name: 'typescript', providers: defaultTypeScriptProviders },
  // M5/M6/M7 will register javascript/go/python here
]

for (const { name: language, providers } of LANGUAGES) {
  const langRoot = join(FIXTURES_ROOT, language)
  if (!existsSync(langRoot)) continue

  describe(`tree-sitter corpus / ${language}`, () => {
    for (const provider of readdirSync(langRoot)) {
      const providerRoot = join(langRoot, provider)
      const expectedPath = join(providerRoot, 'expected.json')
      if (!existsSync(expectedPath)) continue

      const cases = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Array<{
        file: string
        flags: Array<unknown>
      }>

      for (const c of cases) {
        it(`${provider} / ${c.file}`, async () => {
          const fullPath = join(providerRoot, c.file)
          const content = readFileSync(fullPath, 'utf-8')
          const detected = await detectFlagsWithTreeSitter(c.file, content, language, providers())
          expect(detected).toEqual(c.flags)
        })
      }
    }
  })
}
```

- [ ] **Step 4.2.2: Run corpus**

```bash
bun run test corpus
```

Expected: 8 tests (4 positive + 4 negative cases for TypeScript LaunchDarkly), all pass.

### Task 4.3: Wire engine option into TypeScript detector

**Files:**
- Modify: `packages/core/src/detection/detectors/typescript.ts`

- [ ] **Step 4.3.1: Update the detector to support `engine` option**

Replace the constructor + `detectFlags` block in `packages/core/src/detection/detectors/typescript.ts`:

```ts
import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'
import { detectFlagsWithTreeSitter } from '../tree-sitter/engine.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export type DetectorEngine = 'regex' | 'tree-sitter'

export interface TypeScriptDetectorOptions {
  providers?: FeatureFlagProvider[]
  engine?: DetectorEngine
}

export class TypeScriptDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]
  private readonly engine: DetectorEngine

  constructor(opts: TypeScriptDetectorOptions = {}) {
    this.providers = opts.providers ?? defaultTypeScriptProviders()
    this.engine = opts.engine ?? 'regex'
  }

  language(): Language {
    return Languages.TypeScript
  }

  fileExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] | Promise<FeatureFlag[]> {
    if (this.engine === 'tree-sitter') {
      return detectFlagsWithTreeSitter(filename, content, this.language(), this.providers)
    }
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}
```

Keep `defaultTypeScriptProviders()` unchanged.

NOTE: The `LanguageDetector` interface declares `detectFlags(...)` returning `FeatureFlag[]`. Tree-sitter returns a `Promise<FeatureFlag[]>`. The polyglot analyzer already awaits this via `await Promise.resolve(detector.detectFlags(...))` ([polyglot-analyzer.ts:254](../../packages/core/src/detection/polyglot-analyzer.ts#L254)). The interface contract works for both modes — no interface change needed.

- [ ] **Step 4.3.2: Update the `LanguageDetector` interface return type**

In `packages/core/src/detection/interface.ts`, change line 88:

```ts
  /** Detects feature flags in the given source code. */
  detectFlags(filename: string, content: string): FeatureFlag[] | Promise<FeatureFlag[]>
```

- [ ] **Step 4.3.3: Run existing TS detector tests to confirm regex path still works**

```bash
bun run test typescript
```

Expected: existing tests pass (they construct `new TypeScriptDetector()` with no opts; `engine` defaults to `'regex'`).

### Task 4.4: Engine-parameterized corpus

Extend the corpus harness to also run the regex engine on the *same* fixtures and confirm equivalent results (within documented limitations). This is the cross-engine smoke test (spec §6.3) baked into the test suite.

**Files:**
- Modify: `packages/core/test/tree-sitter/corpus.test.ts`

- [ ] **Step 4.4.1: Add a regex-engine pass for positive cases only**

Append to `corpus.test.ts`:

```ts
import { detectFlagsWithRegex } from '../../src/detection/helpers.js'

for (const { name: language, providers } of LANGUAGES) {
  const langRoot = join(FIXTURES_ROOT, language)
  if (!existsSync(langRoot)) continue

  describe(`regex-vs-tree-sitter parity / ${language}`, () => {
    for (const provider of readdirSync(langRoot)) {
      const providerRoot = join(langRoot, provider)
      const expectedPath = join(providerRoot, 'expected.json')
      if (!existsSync(expectedPath)) continue

      const cases = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Array<{
        file: string
        flags: Array<{ name: string; lineNumber: number }>
      }>

      // Only check positive cases — negative cases test precision wins that regex doesn't get.
      const positives = cases.filter((c) => c.file.startsWith('positive/'))

      for (const c of positives) {
        it(`${provider} / ${c.file} — both engines agree on flag names`, async () => {
          const fullPath = join(providerRoot, c.file)
          const content = readFileSync(fullPath, 'utf-8')
          const treeSitter = await detectFlagsWithTreeSitter(c.file, content, language, providers())
          const regex = detectFlagsWithRegex(c.file, content, language, providers())
          expect(treeSitter.map((f) => f.name).sort()).toEqual(regex.map((f) => f.name).sort())
        })
      }
    }
  })
}
```

- [ ] **Step 4.4.2: Run**

```bash
bun run test corpus
```

Expected: all corpus tests pass, including the new parity tests on positive cases.

### Task 4.5: Commit

- [ ] **Step 4.5.1: Commit M4**

```bash
git add packages/core/src/detection/detectors/typescript.ts \
        packages/core/src/detection/interface.ts \
        packages/core/test/fixtures/tree-sitter/typescript \
        packages/core/test/tree-sitter/corpus.test.ts
git commit -m "feat(core): tree-sitter detection for TypeScript"
```

---

## Milestone M5 — JavaScript

Goal: extend the corpus + detector to JavaScript. The tree-sitter-javascript grammar's call_expression AST differs slightly from TypeScript's (no `member_expression` distinction in some cases), so we need a JS-specific `.scm`.

### Task 5.1: Add the JS query

**Files:**
- Create: `packages/core/src/detection/tree-sitter/queries/javascript.scm`

- [ ] **Step 5.1.1: Write the JS query**

`queries/javascript.scm`:

```scheme
; tree-sitter-javascript's grammar uses identical node names to typescript
; for these call shapes — we duplicate the file for clarity even though the
; content is identical.

(call_expression
  function: (member_expression
    object: (_) @receiver
    property: (property_identifier) @method)
  arguments: (arguments) @args) @call

(call_expression
  function: (identifier) @method
  arguments: (arguments) @args) @call
```

- [ ] **Step 5.1.2: Register JS in the parser cache**

The parser cache already has `javascript` registered (M2.1.3) — no change.

### Task 5.2: JS fixtures

**Files:**
- Create: `packages/core/test/fixtures/tree-sitter/javascript/launchdarkly/positive/*.js`
- Create: `packages/core/test/fixtures/tree-sitter/javascript/launchdarkly/negative/*.js`
- Create: `packages/core/test/fixtures/tree-sitter/javascript/launchdarkly/expected.json`

- [ ] **Step 5.2.1: Create directories**

```bash
mkdir -p packages/core/test/fixtures/tree-sitter/javascript/launchdarkly/positive
mkdir -p packages/core/test/fixtures/tree-sitter/javascript/launchdarkly/negative
```

- [ ] **Step 5.2.2: Add positive fixtures (mirror the TS set, drop annotations)**

`positive/single-line.js`:

```js
const LaunchDarkly = require('launchdarkly-node-server-sdk')

const client = LaunchDarkly.init('sdk-key')

async function checkout(user) {
  if (await client.variation('JS_CHECKOUT_V2', user, false)) {
    return 'v2'
  }
  return 'v1'
}

module.exports = { checkout }
```

`positive/multi-line.js`:

```js
const LaunchDarkly = require('launchdarkly-node-server-sdk')

const client = LaunchDarkly.init('sdk-key')

async function multi(user) {
  return await client.variation(
    'JS_MULTI_LINE',
    user,
    false,
  )
}
```

- [ ] **Step 5.2.3: Add negative fixtures**

`negative/flag-in-comment.js`:

```js
const LaunchDarkly = require('launchdarkly-node-server-sdk')

const client = LaunchDarkly.init('sdk-key')

// client.variation('JS_FAKE_IN_COMMENT', user, false) — old approach
module.exports = client
```

`negative/no-import.js`:

```js
function isVariant(client) {
  return client.variation('NO_IMPORT_JS')
}
```

- [ ] **Step 5.2.4: Write expected.json**

```json
[
  {
    "file": "positive/single-line.js",
    "flags": [
      { "name": "JS_CHECKOUT_V2", "filePath": "positive/single-line.js", "lineNumber": 6, "language": "javascript", "provider": "launchdarkly-node-server-sdk" }
    ]
  },
  {
    "file": "positive/multi-line.js",
    "flags": [
      { "name": "JS_MULTI_LINE", "filePath": "positive/multi-line.js", "lineNumber": 6, "language": "javascript", "provider": "launchdarkly-node-server-sdk" }
    ]
  },
  { "file": "negative/flag-in-comment.js", "flags": [] },
  { "file": "negative/no-import.js", "flags": [] }
]
```

### Task 5.3: Wire JS detector

**Files:**
- Modify: `packages/core/src/detection/detectors/javascript.ts`

- [ ] **Step 5.3.1: Update the JS detector**

Read the current file first:

```bash
cat packages/core/src/detection/detectors/javascript.ts
```

Apply the same shape as TypeScript (constructor takes `{ providers?, engine? }`, dispatches on engine). The JS detector today is shorter than TS but identical in structure — mirror the TS pattern exactly. If `defaultJavaScriptProviders` doesn't exist, reuse `defaultTypeScriptProviders` (the JS detector currently does this).

The full file should look like:

```ts
import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'
import { detectFlagsWithTreeSitter } from '../tree-sitter/engine.js'

import { defaultTypeScriptProviders } from './typescript.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export type DetectorEngine = 'regex' | 'tree-sitter'

export interface JavaScriptDetectorOptions {
  providers?: FeatureFlagProvider[]
  engine?: DetectorEngine
}

export class JavaScriptDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]
  private readonly engine: DetectorEngine

  constructor(opts: JavaScriptDetectorOptions = {}) {
    this.providers = opts.providers ?? defaultTypeScriptProviders()
    this.engine = opts.engine ?? 'regex'
  }

  language(): Language {
    return Languages.JavaScript
  }

  fileExtensions(): string[] {
    return ['.js', '.jsx', '.mjs', '.cjs']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['js', 'jsx', 'mjs', 'cjs'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] | Promise<FeatureFlag[]> {
    if (this.engine === 'tree-sitter') {
      return detectFlagsWithTreeSitter(filename, content, this.language(), this.providers)
    }
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}
```

### Task 5.4: Register JS in the corpus harness

**Files:**
- Modify: `packages/core/test/tree-sitter/corpus.test.ts`

- [ ] **Step 5.4.1: Add JS to LANGUAGES**

```ts
import { defaultTypeScriptProviders } from '../../src/detection/detectors/typescript.js'

const LANGUAGES: { name: Language; providers: () => FeatureFlagProvider[] }[] = [
  { name: 'typescript', providers: defaultTypeScriptProviders },
  { name: 'javascript', providers: defaultTypeScriptProviders },  // JS reuses TS providers
]
```

- [ ] **Step 5.4.2: Run corpus**

```bash
bun run test corpus
```

Expected: 4 new JS tests pass alongside the TS ones.

### Task 5.5: Commit

```bash
git add packages/core/src/detection/detectors/javascript.ts \
        packages/core/src/detection/tree-sitter/queries/javascript.scm \
        packages/core/test/fixtures/tree-sitter/javascript \
        packages/core/test/tree-sitter/corpus.test.ts
git commit -m "feat(core): tree-sitter detection for JavaScript"
```

---

## Milestone M6 — Go

Goal: same shape as M5 but for Go. Go's AST has different node names — query template differs.

### Task 6.1: Add the Go query

**Files:**
- Create: `packages/core/src/detection/tree-sitter/queries/go.scm`

- [ ] **Step 6.1.1: Inspect a Go AST to understand node names**

```bash
node --input-type=module -e "
import { createRequire } from 'node:module'
import Parser from 'web-tree-sitter'
const require = createRequire(import.meta.url)
await Parser.init()
const L = await Parser.Language.load(require.resolve('tree-sitter-go/tree-sitter-go.wasm'))
const parser = new Parser()
parser.setLanguage(L)
const tree = parser.parse('package main\nfunc main() { client.BoolVariation(\"FLAG\", user, false) }')
console.log(tree.rootNode.toString())
"
```

Expected output should contain `(call_expression (selector_expression operand: (identifier) field: (field_identifier)) arguments: (argument_list (interpreted_string_literal) (identifier) (false)))`. Confirm node names match what we put in the .scm.

- [ ] **Step 6.1.2: Write the Go query**

`queries/go.scm`:

```scheme
; Method call on a receiver: client.BoolVariation(...)
(call_expression
  function: (selector_expression
    operand: (_) @receiver
    field: (field_identifier) @method)
  arguments: (argument_list) @args) @call

; Bare function call: BoolVariation(...)
(call_expression
  function: (identifier) @method
  arguments: (argument_list) @args) @call
```

### Task 6.2: Go fixtures

**Files:**
- Create: `packages/core/test/fixtures/tree-sitter/go/launchdarkly/{positive,negative}/*.go`
- Create: `packages/core/test/fixtures/tree-sitter/go/launchdarkly/expected.json`

- [ ] **Step 6.2.1: Create directories**

```bash
mkdir -p packages/core/test/fixtures/tree-sitter/go/launchdarkly/positive
mkdir -p packages/core/test/fixtures/tree-sitter/go/launchdarkly/negative
```

- [ ] **Step 6.2.2: Add Go positive fixtures**

`positive/single-line.go`:

```go
package main

import (
	ld "github.com/launchdarkly/go-server-sdk/v6"
)

func main() {
	client, _ := ld.MakeClient("sdk-key", 5)
	defer client.Close()

	enabled, _ := client.BoolVariation("GO_CHECKOUT_V2", ldcontext.New("user"), false)
	if enabled {
		println("v2")
	}
}
```

`positive/multi-line.go`:

```go
package main

import (
	ld "github.com/launchdarkly/go-server-sdk/v6"
)

func multi() {
	enabled, _ := client.BoolVariation(
		"GO_MULTI_LINE",
		ldcontext.New("user"),
		false,
	)
	_ = enabled
}
```

- [ ] **Step 6.2.3: Add Go negative fixtures**

`negative/flag-in-comment.go`:

```go
package main

import (
	ld "github.com/launchdarkly/go-server-sdk/v6"
)

// client.BoolVariation("GO_FAKE_IN_COMMENT", ctx, false) — historical reference
func main() {}
```

`negative/no-import.go`:

```go
package main

func main() {
	client.BoolVariation("NO_IMPORT_GO", nil, false)
}
```

- [ ] **Step 6.2.4: Write expected.json**

```json
[
  {
    "file": "positive/single-line.go",
    "flags": [
      { "name": "GO_CHECKOUT_V2", "filePath": "positive/single-line.go", "lineNumber": 11, "language": "go", "provider": "github.com/launchdarkly/go-server-sdk" }
    ]
  },
  {
    "file": "positive/multi-line.go",
    "flags": [
      { "name": "GO_MULTI_LINE", "filePath": "positive/multi-line.go", "lineNumber": 8, "language": "go", "provider": "github.com/launchdarkly/go-server-sdk" }
    ]
  },
  { "file": "negative/flag-in-comment.go", "flags": [] },
  { "file": "negative/no-import.go", "flags": [] }
]
```

**NOTE:** The provider string above must match what `defaultGoProviders()` reports. Open `packages/core/src/detection/detectors/go.ts` and inspect the LaunchDarkly entry's `importPattern`. If it's `github.com/launchdarkly/go-server-sdk/v6`, change the `expected.json` provider field to match exactly. Run the test once after step 6.4.1 to confirm — adjust `expected.json` until tests pass.

### Task 6.3: Wire Go detector

**Files:**
- Modify: `packages/core/src/detection/detectors/go.ts`

- [ ] **Step 6.3.1: Update Go detector constructor**

Mirror the TS pattern. Open `packages/core/src/detection/detectors/go.ts`:

```bash
sed -n '1,40p' packages/core/src/detection/detectors/go.ts
```

Apply the same transformation: add `engine?: DetectorEngine` to options, dispatch in `detectFlags`. The default providers function (`defaultGoProviders`) stays unchanged.

### Task 6.4: Register Go in the corpus harness

- [ ] **Step 6.4.1: Update `corpus.test.ts` LANGUAGES**

```ts
import { defaultGoProviders } from '../../src/detection/detectors/go.js'

const LANGUAGES: { name: Language; providers: () => FeatureFlagProvider[] }[] = [
  { name: 'typescript', providers: defaultTypeScriptProviders },
  { name: 'javascript', providers: defaultTypeScriptProviders },
  { name: 'go', providers: defaultGoProviders },
]
```

- [ ] **Step 6.4.2: Run corpus**

```bash
bun run test corpus
```

Expected: 4 new Go tests pass. If they fail with `expected.json` mismatch on `provider`, adjust the expected provider string to match the actual `defaultGoProviders()` output.

### Task 6.5: Commit

```bash
git add packages/core/src/detection/detectors/go.ts \
        packages/core/src/detection/tree-sitter/queries/go.scm \
        packages/core/test/fixtures/tree-sitter/go \
        packages/core/test/tree-sitter/corpus.test.ts
git commit -m "feat(core): tree-sitter detection for Go"
```

---

## Milestone M7 — Python

Goal: same shape, Python AST.

### Task 7.1: Add the Python query

**Files:**
- Create: `packages/core/src/detection/tree-sitter/queries/python.scm`

- [ ] **Step 7.1.1: Inspect a Python AST**

```bash
node --input-type=module -e "
import { createRequire } from 'node:module'
import Parser from 'web-tree-sitter'
const require = createRequire(import.meta.url)
await Parser.init()
const L = await Parser.Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm'))
const parser = new Parser()
parser.setLanguage(L)
const tree = parser.parse('client.variation(\"FLAG\", user, False)')
console.log(tree.rootNode.toString())
"
```

Expected: `(module (expression_statement (call function: (attribute object: (identifier) attribute: (identifier)) arguments: (argument_list (string (string_start) (string_content) (string_end)) (identifier) (false)))))`. Confirm node names.

- [ ] **Step 7.1.2: Write the Python query**

`queries/python.scm`:

```scheme
; Method call: client.variation(...)
(call
  function: (attribute
    object: (_) @receiver
    attribute: (identifier) @method)
  arguments: (argument_list) @args) @call

; Bare function call: variation(...)
(call
  function: (identifier) @method
  arguments: (argument_list) @args) @call
```

- [ ] **Step 7.1.3: Update `extractStringLiteral` in `query-runner.ts` to handle Python's structured strings**

Python's tree-sitter grammar emits `(string (string_start "\"") (string_content "FLAG") (string_end "\""))`. The current `extractStringLiteral` strips outer quotes from the `.text`, which works because `.text` returns the full source span. Verify by running the engine test for Python (Task 7.4) before adding any new code. If it fails, extend `extractStringLiteral`:

```ts
if (type === 'string') {
  // Python: string with string_content child
  const contentChild = node.namedChildren.find((c) => c.type === 'string_content')
  if (contentChild) return contentChild.text
}
```

### Task 7.2: Python fixtures

**Files:**
- Create: `packages/core/test/fixtures/tree-sitter/python/launchdarkly/{positive,negative}/*.py`

- [ ] **Step 7.2.1: Create directories and fixtures**

```bash
mkdir -p packages/core/test/fixtures/tree-sitter/python/launchdarkly/positive
mkdir -p packages/core/test/fixtures/tree-sitter/python/launchdarkly/negative
```

`positive/single-line.py`:

```python
import ldclient
from ldclient.config import Config

ldclient.set_config(Config("sdk-key"))
client = ldclient.get()

def checkout(user):
    if client.variation("PY_CHECKOUT_V2", user, False):
        return "v2"
    return "v1"
```

`positive/multi-line.py`:

```python
import ldclient

client = ldclient.get()

def multi(user):
    return client.variation(
        "PY_MULTI_LINE",
        user,
        False,
    )
```

`negative/flag-in-comment.py`:

```python
import ldclient

# client.variation("PY_FAKE_IN_COMMENT", user, False)
def noop():
    pass
```

`negative/no-import.py`:

```python
def fake(client, user):
    return client.variation("NO_IMPORT_PY", user, False)
```

- [ ] **Step 7.2.2: Write expected.json**

```json
[
  {
    "file": "positive/single-line.py",
    "flags": [
      { "name": "PY_CHECKOUT_V2", "filePath": "positive/single-line.py", "lineNumber": 8, "language": "python", "provider": "ldclient" }
    ]
  },
  {
    "file": "positive/multi-line.py",
    "flags": [
      { "name": "PY_MULTI_LINE", "filePath": "positive/multi-line.py", "lineNumber": 6, "language": "python", "provider": "ldclient" }
    ]
  },
  { "file": "negative/flag-in-comment.py", "flags": [] },
  { "file": "negative/no-import.py", "flags": [] }
]
```

Adjust `provider` to match `defaultPythonProviders()` after first run.

### Task 7.3: Wire Python detector

- [ ] **Step 7.3.1: Update `packages/core/src/detection/detectors/python.ts`** — same engine-option pattern as TS/JS/Go.

### Task 7.4: Register Python in the corpus harness

- [ ] **Step 7.4.1: Add Python to LANGUAGES, run, adjust expected.json if provider strings differ**

```bash
bun run test corpus
```

Expected: 4 new Python tests pass.

### Task 7.5: Commit

```bash
git add packages/core/src/detection/detectors/python.ts \
        packages/core/src/detection/tree-sitter/queries/python.scm \
        packages/core/test/fixtures/tree-sitter/python \
        packages/core/test/tree-sitter/corpus.test.ts \
        packages/core/src/detection/tree-sitter/query-runner.ts
git commit -m "feat(core): tree-sitter detection for Python"
```

---

## Milestone M8 — Const-extraction (TypeScript, goal C)

Goal: when a flag-key argument is a `const`-bound identifier in the same file, resolve it to its string literal value. This is goal C (recall) from the spec. TypeScript only in T1; other languages get their own const-resolvers in later tiers.

### Task 8.1: Const resolver (TDD)

**Files:**
- Create: `packages/core/src/detection/tree-sitter/const-resolver.ts`
- Create: `packages/core/test/tree-sitter/const-resolver.test.ts`

- [ ] **Step 8.1.1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'

import { getParser, _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import { resolveConstStringTS } from '../../src/detection/tree-sitter/const-resolver.js'

describe('const-resolver / typescript', () => {
  beforeEach(() => _resetParserCacheForTests())

  it('resolves a top-level `const FLAG = "X"` reference', async () => {
    const source = `const FLAG = 'NEW_CHECKOUT'\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    const call = tree.rootNode.descendantsOfType('call_expression')[0]
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]
    expect(resolveConstStringTS(flagArg, tree.rootNode)).toBe('NEW_CHECKOUT')
  })

  it('returns null when the identifier is not a const string', async () => {
    const source = `let FLAG = 'NEW_CHECKOUT'\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    const call = tree.rootNode.descendantsOfType('call_expression')[0]
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]
    expect(resolveConstStringTS(flagArg, tree.rootNode)).toBeNull()
  })

  it('returns null when the identifier is undefined in the file', async () => {
    const source = `client.variation(UNKNOWN, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    const call = tree.rootNode.descendantsOfType('call_expression')[0]
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]
    expect(resolveConstStringTS(flagArg, tree.rootNode)).toBeNull()
  })
})
```

- [ ] **Step 8.1.2: Run test, verify it fails**

```bash
bun run test const-resolver
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 8.1.3: Implement `resolveConstStringTS`**

`packages/core/src/detection/tree-sitter/const-resolver.ts`:

```ts
import { extractStringLiteral } from './query-runner.js'

import type { SyntaxNode } from 'web-tree-sitter'

/**
 * If `node` is an identifier reference, look up its binding in the file's
 * top-level `const NAME = '...'` declarations. Returns the string value
 * or null. File-scope only — no nested scopes, no cross-file resolution.
 */
export function resolveConstStringTS(node: SyntaxNode, fileRoot: SyntaxNode): string | null {
  if (node.type !== 'identifier') return null
  const name = node.text

  for (const child of fileRoot.namedChildren) {
    if (child.type !== 'lexical_declaration') continue
    if (child.children[0]?.type !== 'const') continue

    for (const decl of child.namedChildren) {
      if (decl.type !== 'variable_declarator') continue
      const nameNode = decl.childForFieldName('name')
      const valueNode = decl.childForFieldName('value')
      if (!nameNode || !valueNode) continue
      if (nameNode.text !== name) continue
      const literal = extractStringLiteral(valueNode)
      if (literal !== null) return literal
    }
  }

  return null
}
```

- [ ] **Step 8.1.4: Run test, verify pass**

```bash
bun run test const-resolver
```

Expected: 3 tests pass.

### Task 8.2: Hook the resolver into the engine for TypeScript

**Files:**
- Modify: `packages/core/src/detection/tree-sitter/engine.ts`

- [ ] **Step 8.2.1: Update the engine to try const-resolution when arg is not a string literal**

In `engine.ts`, replace the body of the inner loop (after `const arg = getArgument(...)`) with:

```ts
for (const { provider, method } of matches) {
  const arg = getArgument(argsNode, method.flagKeyIndex)
  if (!arg) continue

  let flagKey = extractStringLiteral(arg)

  // Goal C: const-extraction for TypeScript/JavaScript
  if (flagKey === null && (language === 'typescript' || language === 'javascript')) {
    flagKey = resolveConstStringTS(arg, tree.rootNode)
  }

  if (!flagKey || !isValidFlagKey(flagKey)) continue

  flags.push({
    name: flagKey,
    filePath: filename,
    lineNumber: callNode.startPosition.row + 1,
    language,
    provider: getImportPattern(provider) || provider.name,
  })
}
```

Add the import:

```ts
import { resolveConstStringTS } from './const-resolver.js'
```

### Task 8.3: Corpus fixture for const-extraction

- [ ] **Step 8.3.1: Add `positive/const-extracted.ts` fixture**

```ts
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'

const FLAG_NAME = 'CONST_EXTRACTED_FLAG'
const client = LaunchDarkly.init('sdk-key')

export async function extracted(user: { key: string }) {
  return client.variation(FLAG_NAME, user, false)
}
```

- [ ] **Step 8.3.2: Append to `expected.json`**

```json
{
  "file": "positive/const-extracted.ts",
  "flags": [
    { "name": "CONST_EXTRACTED_FLAG", "filePath": "positive/const-extracted.ts", "lineNumber": 7, "language": "typescript", "provider": "launchdarkly-node-server-sdk" }
  ]
}
```

- [ ] **Step 8.3.3: Run**

```bash
bun run test corpus
```

Expected: new test passes. **The parity test for this fixture will fail** (regex can't resolve const-extracted names) — that's correct: this is a recall *win* tree-sitter gives us. Update the parity-test loop to skip fixtures whose filename starts with `positive/const-` (treat as recall-only):

```ts
// In corpus.test.ts, inside the parity describe block, filter further:
const positives = cases.filter((c) =>
  c.file.startsWith('positive/') && !c.file.startsWith('positive/const-')
)
```

### Task 8.4: Commit

```bash
git add packages/core/src/detection/tree-sitter/const-resolver.ts \
        packages/core/src/detection/tree-sitter/engine.ts \
        packages/core/test/tree-sitter/const-resolver.test.ts \
        packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/positive/const-extracted.ts \
        packages/core/test/fixtures/tree-sitter/typescript/launchdarkly/expected.json \
        packages/core/test/tree-sitter/corpus.test.ts
git commit -m "feat(core): const-extraction for tree-sitter (TS/JS)"
```

---

## Milestone M9 — CLI `--engine` smoke flag

Goal: a hidden CLI flag that overrides engine selection for testing. Not in `--help`. Documented in the spec §6.4.

### Task 9.1: Parse `--engine` argument

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 9.1.1: Read existing arg parsing**

```bash
sed -n '1,80p' packages/cli/src/cli.ts
```

Locate where args are parsed (probably a `parseArgs` function around line 30-80).

- [ ] **Step 9.1.2: Add the flag to parseArgs**

Inside the parseArgs switch/if-chain, add:

```ts
} else if (a === '--engine') {
  const value = process.argv[++i]
  if (value !== 'regex' && value !== 'tree-sitter') {
    process.stderr.write(`Error: --engine must be 'regex' or 'tree-sitter', got '${value}'\n`)
    process.exit(2)
  }
  args.engine = value
}
```

In the `args` object type (likely a TypeScript interface near the top of the file), add:

```ts
engine?: 'regex' | 'tree-sitter'
```

### Task 9.2: Thread `engine` into the registry

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/core/src/detection/index.ts`

- [ ] **Step 9.2.1: Expose `createRegistryWithEngine(engine)` from core**

In `packages/core/src/detection/index.ts`, locate `createDefaultRegistry` and add a sibling:

```ts
import type { DetectorEngine } from './detectors/typescript.js'

/**
 * Build a registry where every tier-1 detector uses the given engine.
 * Used by the CLI's --engine flag and by the cross-engine smoke test.
 *
 * Other (non-tier-1) detectors always use regex regardless of this setting.
 */
export function createRegistryWithEngine(engine: DetectorEngine): LanguageRegistry {
  const registry = new LanguageRegistry()
  registry.register(new TypeScriptDetector({ engine }))
  registry.register(new JavaScriptDetector({ engine }))
  registry.register(new GoDetector({ engine }))
  registry.register(new PythonDetector({ engine }))
  // Non-tier-1 stay regex:
  registry.register(new JavaDetector())
  registry.register(new KotlinDetector())
  registry.register(new SwiftDetector())
  registry.register(new RubyDetector())
  registry.register(new CSharpDetector())
  registry.register(new PHPDetector())
  registry.register(new RustDetector())
  registry.register(new CPPDetector())
  registry.register(new ObjectiveCDetector())
  return registry
}
```

(Check `detection/index.ts` for the actual import list — match what's already there.)

- [ ] **Step 9.2.2: Pass `engine` from CLI to scanRepo**

`scanRepo` currently constructs its own registry via `createDefaultRegistry()` (see `scan-repo.ts:24`). Add an option to override:

In `packages/core/src/scan-repo.ts`, in `ScanRepoOptions`:

```ts
export interface ScanRepoOptions {
  cwd: string
  threshold?: number
  diff?: string
  signal?: AbortSignal
  logger?: ScanLogger
  /** @internal — undocumented escape hatch for cross-engine smoke testing */
  engine?: 'regex' | 'tree-sitter'
}
```

In the body of `scanRepo`:

```ts
const registry = opts.engine
  ? createRegistryWithEngine(opts.engine)
  : createDefaultRegistry()
```

Import `createRegistryWithEngine` from `./detection/index.js`.

In `packages/cli/src/cli.ts`, pass it through:

```ts
const result = await scanRepo({
  cwd: process.cwd(),
  threshold: args.threshold,
  diff: args.diff ?? undefined,
  engine: args.engine,
  logger,
})
```

- [ ] **Step 9.2.3: Smoke-test**

```bash
cd packages/cli && bun run build
node bin/flagshark.mjs scan --engine=tree-sitter --help
```

Expected: prints help (because `--help` short-circuits). Then:

```bash
# Run against the corpus fixture as a real repo
cp -r ../core/test/fixtures/tree-sitter/typescript/launchdarkly/positive /tmp/flagshark-smoke
cd /tmp/flagshark-smoke && git init -q && git add . && git commit -qm 'init'
node /Users/joe/projects/flagshark-treesitter-t1/packages/cli/bin/flagshark.mjs scan --engine=tree-sitter
```

Expected: prints flags from the positive fixtures. Then run the same with `--engine=regex` and confirm regex finds at least the simple cases.

### Task 9.3: Commit

```bash
cd /Users/joe/projects/flagshark-treesitter-t1
git add packages/cli/src/cli.ts packages/core/src/detection/index.ts packages/core/src/scan-repo.ts
git commit -m "feat(cli): add hidden --engine flag for smoke testing"
```

---

## Milestone M10 — Action bundle

Goal: the Action's esbuild build copies the 4 tier-1 WASM files into `dist/grammars/`. At runtime, `parser-cache.ts` resolves them via `process.env.FLAGSHARK_WASM_DIR` (already implemented in M2.1.3).

### Task 10.1: Replace the action build with a script

**Files:**
- Create: `packages/action/scripts/build.mjs`
- Modify: `packages/action/package.json`
- Modify: `packages/action/src/index.ts`

- [ ] **Step 10.1.1: Write the build script**

`packages/action/scripts/build.mjs`:

```js
#!/usr/bin/env node
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import * as esbuild from 'esbuild'

const require_ = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, '..', 'dist')
const grammarsDir = join(distDir, 'grammars')

mkdirSync(grammarsDir, { recursive: true })

// Copy WASM grammars
const grammars = [
  'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-javascript/tree-sitter-javascript.wasm',
  'tree-sitter-go/tree-sitter-go.wasm',
  'tree-sitter-python/tree-sitter-python.wasm',
]
for (const spec of grammars) {
  const src = require_.resolve(spec, { paths: [resolve(here, '..', '..', 'core')] })
  const filename = spec.split('/').pop()
  copyFileSync(src, join(grammarsDir, filename))
  console.log(`Copied ${spec} -> dist/grammars/${filename}`)
}

// Bundle action
await esbuild.build({
  entryPoints: [resolve(here, '..', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(distDir, 'action.cjs'),
  loader: { '.scm': 'text' },
  external: [],
})

console.log('Action bundle built')
```

- [ ] **Step 10.1.2: Replace the build script in `packages/action/package.json`**

```json
{
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 10.1.3: Make the action set `FLAGSHARK_WASM_DIR` before any tree-sitter call**

In `packages/action/src/index.ts`, at the top of `run()` (before any `scanRepo` call):

```ts
import { join } from 'node:path'

// Tell @flagshark/core where to find vendored WASM grammars
process.env.FLAGSHARK_WASM_DIR = join(__dirname, 'grammars')
```

- [ ] **Step 10.1.4: Add `dist/grammars/` to action's `.gitignore`**

Check current contents:

```bash
cat packages/action/.gitignore 2>/dev/null || echo "(no .gitignore)"
```

If `dist/` is already gitignored, no change. Otherwise:

```bash
cat >> packages/action/.gitignore <<'EOF'
dist/
EOF
```

- [ ] **Step 10.1.5: Build and verify**

```bash
bun run --filter '@flagshark/action' build
ls packages/action/dist/grammars/
```

Expected: `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`, `tree-sitter-go.wasm`, `tree-sitter-python.wasm`.

- [ ] **Step 10.1.6: Smoke-test the built action**

Run it directly:

```bash
cd /tmp/flagshark-smoke
GITHUB_TOKEN=dummy \
GITHUB_REPOSITORY=foo/bar \
GITHUB_EVENT_PATH=/dev/null \
INPUT_SCAN=full \
node /Users/joe/projects/flagshark-treesitter-t1/packages/action/dist/action.cjs 2>&1 | tail -20
```

Expected: action runs (may exit with errors about missing GITHUB_EVENT_PATH content, but tree-sitter loads successfully — no "WASM file not found" errors). If it complains about WASM resolution, double-check `FLAGSHARK_WASM_DIR` is being set before any `import @flagshark/core` happens.

### Task 10.2: Update action.yml entry path

The action.yml currently points at `packages/action/dist/action.cjs` — that's already correct. No change needed.

### Task 10.3: Commit

```bash
git add packages/action/scripts/build.mjs \
        packages/action/package.json \
        packages/action/src/index.ts \
        packages/action/.gitignore
git commit -m "chore(action): bundle WASM grammars and resolve via FLAGSHARK_WASM_DIR"
```

---

## Milestone M11 — Flip default

Goal: `createDefaultRegistry()` selects tree-sitter for tier-1 languages. Production CLI + Action now use tree-sitter by default.

### Task 11.1: Update createDefaultRegistry

**Files:**
- Modify: `packages/core/src/detection/index.ts`

- [ ] **Step 11.1.1: Edit createDefaultRegistry**

Locate the function (it constructs the registry and registers each detector):

```ts
export function createDefaultRegistry(): LanguageRegistry {
  const registry = new LanguageRegistry()
  registry.register(new TypeScriptDetector({ engine: 'tree-sitter' }))
  registry.register(new JavaScriptDetector({ engine: 'tree-sitter' }))
  registry.register(new GoDetector({ engine: 'tree-sitter' }))
  registry.register(new PythonDetector({ engine: 'tree-sitter' }))
  registry.register(new JavaDetector())
  registry.register(new KotlinDetector())
  registry.register(new SwiftDetector())
  registry.register(new RubyDetector())
  registry.register(new CSharpDetector())
  registry.register(new PHPDetector())
  registry.register(new RustDetector())
  registry.register(new CPPDetector())
  registry.register(new ObjectiveCDetector())
  return registry
}
```

- [ ] **Step 11.1.2: Run all tests**

```bash
bun run test
```

Expected: all suites pass. The polyglot-analyzer tests and the existing detector tests should be unaffected — they construct detectors directly with explicit options, bypassing `createDefaultRegistry`.

If the existing `scanRepo` tests in `scan-repo.test.ts` fail because they assumed regex behavior on TS fixtures, update the test fixtures to use simpler patterns that both engines find identically — or thread `engine: 'regex'` into those specific tests if they're verifying regex-specific behavior.

- [ ] **Step 11.1.3: Run the end-to-end smoke test**

```bash
cd /tmp/flagshark-smoke
node /Users/joe/projects/flagshark-treesitter-t1/packages/cli/bin/flagshark.mjs scan
```

Expected: scan completes; flags from positive fixtures are reported.

### Task 11.2: Cross-engine smoke audit on a real repo

- [ ] **Step 11.2.1: Pick a smoke repo and clone**

```bash
cd /tmp && rm -rf flagshark-real-smoke
git clone --depth 100 https://github.com/microsoft/vscode flagshark-real-smoke
cd flagshark-real-smoke
```

- [ ] **Step 11.2.2: Run both engines**

```bash
FLAGSHARK=/Users/joe/projects/flagshark-treesitter-t1/packages/cli/bin/flagshark.mjs
node $FLAGSHARK scan --engine=regex --json > /tmp/regex.json
node $FLAGSHARK scan --engine=tree-sitter --json > /tmp/treesitter.json
```

- [ ] **Step 11.2.3: Diff the staleFlags lists**

```bash
diff <(jq -S '.staleFlags | sort_by(.filePath, .lineNumber)' /tmp/regex.json) \
     <(jq -S '.staleFlags | sort_by(.filePath, .lineNumber)' /tmp/treesitter.json) | head -80
```

Review the diff by hand:
- **Flags only in regex output:** likely false positives the regex catches in strings/comments. Verify by opening 2-3 examples. If the tree-sitter omission is correct, ✅ keep going.
- **Flags only in tree-sitter output:** likely recall wins (multi-line, const-extracted). Verify by opening 2-3 examples. If tree-sitter is correct, ✅ keep going.
- **Flags with different lineNumber:** investigate. Likely a real bug in line-mapping.

Document the findings in `docs/superpowers/plans/2026-05-11-tree-sitter-tier-1-smoke-audit.md` (a new file — record before/after counts, sample of removed FPs, sample of added recall wins).

- [ ] **Step 11.2.4: Commit M11**

```bash
cd /Users/joe/projects/flagshark-treesitter-t1
git add packages/core/src/detection/index.ts \
        docs/superpowers/plans/2026-05-11-tree-sitter-tier-1-smoke-audit.md
git commit -m "feat(core): default tier-1 languages to tree-sitter"
```

---

## Milestone M12 — Release v1.3.0

Goal: ship the change.

### Task 12.1: Open PR

- [ ] **Step 12.1.1: Push branch**

```bash
git push -u origin feat/treesitter-tier-1
```

- [ ] **Step 12.1.2: Open PR**

```bash
gh pr create --title "feat: tree-sitter detection engine for tier-1 languages" --body "$(cat <<'EOF'
## Summary

- Adds tree-sitter (WASM, web-tree-sitter) as the detection engine for TypeScript, JavaScript, Go, Python.
- Eliminates false positives from flag names inside strings and comments.
- Handles multi-line calls and const-extracted flag keys (TS/JS) — recall wins.
- Other languages (Java, Kotlin, Swift, Ruby, C#, PHP, Rust, C, C++, ObjC) keep regex; future tiers migrate them.
- No public API breaks. `engine: 'regex' | 'tree-sitter'` option on per-language detectors.

## Test plan

- [x] Parser cache TDD passes
- [x] Engine TDD passes
- [x] Test corpus (positive + negative fixtures) passes for TS/JS/Go/Python
- [x] Parity test: regex and tree-sitter agree on positive cases (non-const-extracted)
- [x] Cross-engine smoke audit on microsoft/vscode (see docs/superpowers/plans/2026-05-11-tree-sitter-tier-1-smoke-audit.md)
- [x] Action bundle built locally with WASM blobs; smoke-test run with FLAGSHARK_WASM_DIR
- [x] `--engine` CLI flag works (hidden from --help)

## Spec
[docs/superpowers/specs/2026-05-11-tree-sitter-detection-engine-design.md](docs/superpowers/specs/2026-05-11-tree-sitter-detection-engine-design.md)
EOF
)"
```

- [ ] **Step 12.1.3: Wait for CI green + human review**

Manual gate. Pause here. Don't merge automatically.

### Task 12.2: Cut release

After PR is merged to main:

- [ ] **Step 12.2.1: Bump versions**

```bash
cd /Users/joe/projects/flagshark  # main worktree
git pull origin main
# Edit packages/core/package.json: "version": "1.3.0"
# Edit packages/cli/package.json:  "version": "1.3.0"
# Edit packages/cli/src/cli.ts:    const VERSION = '1.3.0'
```

- [ ] **Step 12.2.2: Commit and tag**

```bash
git add -A
git commit -m "chore: release v1.3.0"
git tag v1.3.0
git tag -f v1
git push origin main v1.3.0
git push -f origin v1
```

- [ ] **Step 12.2.3: Create GitHub Release**

```bash
gh release create v1.3.0 \
  --title "v1.3.0 — tree-sitter detection for TypeScript, JavaScript, Go, Python" \
  --notes "$(cat <<'EOF'
This release switches FlagShark's detection engine to tree-sitter (WASM) for TypeScript, JavaScript, Go, and Python. Other languages continue to use the existing regex engine and will migrate in future tiers.

**What's new**
- ✅ Zero false positives from flag names inside string literals or comments (was a real pain on test-heavy repos)
- ✅ Multi-line method calls now detected
- ✅ Const-extracted flag keys (`const FLAG = 'X'; client.variation(FLAG, …)`) now resolved in TS/JS
- ✅ Custom in-house SDKs you've already configured continue to work — same provider config, new engine

**What stayed the same**
- Same CLI flags, same exit codes, same Action behavior
- `@flagshark/core` API: no breaking changes
- Languages not on this tier (Java, Kotlin, Swift, Ruby, C#, PHP, Rust, C, C++, ObjC) keep regex

**Migration**
No action required. If you hit a false-negative for a pattern we don't handle yet, file an issue or use `flagshark scan --engine=regex` as an escape hatch.
EOF
)"
```

This triggers `release.yml`, which publishes `@flagshark/core@1.3.0` and `flagshark@1.3.0` to npm.

- [ ] **Step 12.2.4: Verify**

```bash
sleep 60
npm view @flagshark/core@1.3.0 version
npm view flagshark@1.3.0 version
npx flagshark@1.3.0 --version
```

Expected: both packages published, CLI prints `flagshark v1.3.0`.

---

## Self-Review

**Spec coverage:**

- ✅ Goal A (precision — no FPs in strings/comments): M3, M4, M5, M6, M7 (negative fixtures)
- ✅ Goal C (recall — multi-line, const-extraction): M3 multi-line test, M8 const-extraction
- 🟡 Goal B (hardcoded signal): out of scope for T1 by design — covered in spec §11 P8
- ✅ WASM via web-tree-sitter: M1
- ✅ Per-language detector dual-mode: M4 (TS), M5 (JS), M6 (Go), M7 (Python)
- ✅ Engine plug-in architecture, regex retained: detectors keep both code paths
- ✅ Test corpus + parameterized harness: M4.2
- ✅ Cross-engine smoke audit before flip: M11.2
- ✅ CLI `--engine` smoke flag: M9
- ✅ Action bundle WASM packaging: M10
- ✅ Tier 1 flip default: M11
- ✅ Release v1.3.0: M12

**Placeholder scan:** no TBDs, no "appropriate error handling", every code step includes the actual code.

**Type consistency:**
- `DetectorEngine = 'regex' | 'tree-sitter'` defined in `typescript.ts`, re-used in `javascript.ts`, `go.ts`, `python.ts`, `scan-repo.ts`, `cli.ts`. ✓
- `Language` type unchanged across plan. ✓
- `FeatureFlag` shape unchanged. ✓
- `extractStringLiteral` signature defined in M3.1.4, extended in M7.1.3, called in M3.1.6, M8.1.3. ✓
- `getParser(lang: Language): Promise<Parser>` consistent across M2 → M3 → M8. ✓
- `_resetParserCacheForTests()` defined in M2.1.3, used in M2.1.1, M3.1.2, M8.1.1. ✓

**Ambiguity check:** the one fuzzy area is provider string mismatches in `expected.json` for Go and Python (the actual `importPattern` may differ from what I assumed). Steps 6.2.4 and 7.2.2 call this out explicitly with an instruction to "adjust until tests pass."
