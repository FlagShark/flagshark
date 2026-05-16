import { pathToFileURL } from 'node:url'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { tryGetModuleUrl } from '../../src/detection/tree-sitter/module-url.js'
import {
  getParser,
  _resetParserCacheForTests,
} from '../../src/detection/tree-sitter/parser-cache.js'

describe('parser-cache', () => {
  beforeEach(() => {
    _resetParserCacheForTests()
  })

  it('returns a Parser instance for typescript', async () => {
    const parser = await getParser('typescript')
    expect(parser).toBeDefined()
    const tree = parser.parse('const x = 1')
    expect(tree).not.toBeNull()
    expect(tree!.rootNode.type).toBe('program')
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

describe('parser-cache — FLAGSHARK_WASM_DIR branch (lines 41-43)', () => {
  // This test covers the `if (bundleDir)` branch in resolveWasmPath.
  // We point FLAGSHARK_WASM_DIR to the actual wasm directory so the parser loads correctly.

  let origWasmDir: string | undefined

  beforeEach(() => {
    origWasmDir = process.env.FLAGSHARK_WASM_DIR
    _resetParserCacheForTests()
  })

  afterEach(() => {
    if (origWasmDir === undefined) {
      delete process.env.FLAGSHARK_WASM_DIR
    } else {
      process.env.FLAGSHARK_WASM_DIR = origWasmDir
    }
    _resetParserCacheForTests()
  })

  it('resolves wasm via FLAGSHARK_WASM_DIR when set', async () => {
    // Resolve the actual wasm directory so the test can load it via the env-var code path
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const wasmPath = req.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')
    const { dirname } = await import('node:path')
    process.env.FLAGSHARK_WASM_DIR = dirname(wasmPath)

    // getParser should use the FLAGSHARK_WASM_DIR path to load the grammar
    const parser = await getParser('typescript')
    expect(parser).toBeDefined()
    const tree = parser.parse('const x = 1')
    expect(tree).not.toBeNull()
  })
})

// Regression coverage for the bundler-shape selection logic. The bug we are
// guarding against: when esbuild emits ESM->CJS, `import.meta` is stubbed to
// `{}` so `import.meta.url` is undefined. Without the __filename fallback,
// `createRequire(undefined)` throws on every detection call and PolyglotAnalyzer
// silently buries the errors in its per-file try/catch. This is exactly how a
// week-long production regression went undiagnosed.
describe('module-url — tryGetModuleUrl (bundler-shape selection)', () => {
  it('prefers import.meta.url when it is a usable string', () => {
    expect(tryGetModuleUrl('file:///foo/bar.js', '/var/task/index.js')).toBe('file:///foo/bar.js')
  })

  it('falls back to pathToFileURL(__filename) when import.meta.url is undefined', () => {
    // This is the esbuild ESM->CJS case: import.meta got stubbed to {}.
    const result = tryGetModuleUrl(undefined, '/var/task/index.js')
    expect(result).toBe(pathToFileURL('/var/task/index.js').href)
  })

  it('treats an empty-string meta.url as missing (defensive)', () => {
    const result = tryGetModuleUrl('', '/var/task/index.js')
    expect(result).toBe(pathToFileURL('/var/task/index.js').href)
  })

  it('treats non-string meta.url as missing (defensive against bundler shimming)', () => {
    // Some shims set import.meta.url to a non-string sentinel (e.g. null, {}).
    expect(tryGetModuleUrl(null, '/var/task/index.js')).toBe(
      pathToFileURL('/var/task/index.js').href,
    )
    expect(tryGetModuleUrl({}, '/var/task/index.js')).toBe(
      pathToFileURL('/var/task/index.js').href,
    )
  })

  it('returns undefined when neither base is available', () => {
    expect(tryGetModuleUrl(undefined, undefined)).toBeUndefined()
  })
})
