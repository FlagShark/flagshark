import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

/**
 * Regression test for the bundler-shape bug that took down production scanning
 * for a week. parser-cache.ts calls `createRequire(import.meta.url)`. When
 * esbuild bundles ESM->CJS it stubs `import.meta` to `{}` so `import.meta.url`
 * is undefined, `createRequire(undefined)` throws on every detection call, and
 * PolyglotAnalyzer's try/catch buries the throws behind a `filesWithErrors`
 * counter -- looking identical to "this codebase has no flags."
 *
 * This test bundles parser-cache.ts with the SAME esbuild settings the SaaS
 * Lambda and the GitHub Action use (`format: 'cjs'`, `platform: 'node'`,
 * grammars marked external), then loads the bundle and exercises `getParser`
 * WITHOUT setting `FLAGSHARK_WASM_DIR`. If anyone ever re-introduces a
 * hard dependency on `import.meta.url`, this test fails immediately instead
 * of waiting for production to silently degrade.
 */

const here = dirname(fileURLToPath(import.meta.url))
const parserCacheSrc = resolve(here, '..', '..', 'src', 'detection', 'tree-sitter', 'parser-cache.ts')
// Place the bundle output inside packages/core so node_modules walk-up finds
// tree-sitter-typescript et al via core's installed deps. Bun's flat layout
// means the grammars are NOT reachable from arbitrary tmpdir() paths.
const bundleDir = resolve(here, '.tmp-cjs-bundle')
const bundlePath = join(bundleDir, 'parser-cache.cjs')

let savedWasmDir: string | undefined

beforeAll(async () => {
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(bundleDir, { recursive: true })

  // Small ESM entry that re-exports getParser. Bundling parser-cache.ts
  // directly works too, but entry-via-re-export mirrors how real consumers
  // (Lambda handlers, Action entry points) reach into the module graph.
  const entryPath = join(bundleDir, 'entry.mjs')
  writeFileSync(
    entryPath,
    `export { getParser } from '${parserCacheSrc.replace(/\\/g, '/')}'\n`,
  )

  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    // Match the production externals: grammars resolved at runtime, not inlined.
    external: [
      'web-tree-sitter',
      'tree-sitter-typescript',
      'tree-sitter-javascript',
      'tree-sitter-go',
      'tree-sitter-python',
    ],
    // Force the bug shape: with format=cjs esbuild stubs import.meta to {} so
    // import.meta.url is undefined. Without our pickModuleUrl __filename
    // fallback, the bundled code throws on every detection call.
    logLevel: 'silent',
  })

  // CRITICAL: do not set FLAGSHARK_WASM_DIR. The env-var escape hatch
  // bypasses createRequire entirely -- if it were set, this test would pass
  // even with the bug present. Stash and clear so a polluted dev shell
  // doesn't mask a regression.
  savedWasmDir = process.env.FLAGSHARK_WASM_DIR
  delete process.env.FLAGSHARK_WASM_DIR
})

afterAll(() => {
  if (savedWasmDir !== undefined) {
    process.env.FLAGSHARK_WASM_DIR = savedWasmDir
  }
  rmSync(bundleDir, { recursive: true, force: true })
})

describe('parser-cache — ESM->CJS bundle regression', () => {
  it('the bundled CJS shape has the esbuild import.meta stub we are guarding against', () => {
    // Sanity check. If this stops matching, esbuild's output shape changed and
    // the test is no longer exercising what it claims. Update the regex AND
    // re-verify the createRequire path before assuming the bug is gone.
    const require_ = createRequire(import.meta.url)
    const bundleSource = require_('node:fs').readFileSync(bundlePath, 'utf8')
    expect(bundleSource).toMatch(/import_meta\s*=\s*\{\}/)
  })

  it('bundled CJS can resolve grammars without FLAGSHARK_WASM_DIR', async () => {
    // Use a fresh createRequire anchored at the bundle so its own internal
    // require() calls resolve relative to the bundle's directory.
    const require_ = createRequire(bundlePath)
    const bundle = require_(bundlePath) as { getParser: (lang: string) => Promise<unknown> }
    const parser = await bundle.getParser('typescript')
    expect(parser).toBeDefined()
  })
})

// Catches future `import.meta.url` regressions anywhere in the public API
// surface, not just parser-cache. If someone adds a `createRequire(import.meta.url)`
// to detector loading, the registry, scan-repo, etc., this test will fail when
// the bundled CJS tries to exercise that code path.
describe('@flagshark/core public entry — ESM->CJS bundle regression', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const entryBundleDir = resolve(here, '.tmp-entry-bundle')
  const entryBundlePath = join(entryBundleDir, 'core.cjs')
  let entryBundle: {
    createDefaultRegistry: () => unknown
    PolyglotAnalyzer: new (registry: unknown, logger: unknown) => {
      analyzeFiles: (files: Map<string, string>) => Promise<{ totalFlags: Map<string, unknown[]> }>
    }
  }

  beforeAll(async () => {
    rmSync(entryBundleDir, { recursive: true, force: true })
    mkdirSync(entryBundleDir, { recursive: true })
    const publicEntry = resolve(here, '..', '..', 'src', 'index.ts')
    await esbuild.build({
      entryPoints: [publicEntry],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: entryBundlePath,
      // Match the SaaS Lambda configuration: only the WASM-loading packages
      // are external (resolved at runtime), everything else bundles inline.
      // This is the exact bundling shape that took down production.
      external: [
        'web-tree-sitter',
        'tree-sitter-typescript',
        'tree-sitter-javascript',
        'tree-sitter-go',
        'tree-sitter-python',
      ],
      logLevel: 'silent',
    })
    const require_ = createRequire(entryBundlePath)
    entryBundle = require_(entryBundlePath) as typeof entryBundle
  })

  afterAll(() => {
    rmSync(entryBundleDir, { recursive: true, force: true })
  })

  it('bundled public entry exposes createDefaultRegistry and PolyglotAnalyzer', () => {
    expect(typeof entryBundle.createDefaultRegistry).toBe('function')
    expect(typeof entryBundle.PolyglotAnalyzer).toBe('function')
  })

  it('bundled public entry detects a TypeScript flag without FLAGSHARK_WASM_DIR', async () => {
    // Capture warn logs -- if grammar resolution fails, the upstream auto-log
    // helper surfaces a sample, which is the smoking gun we want to see if
    // this test ever regresses.
    const warns: unknown[] = []
    const captureLogger = {
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => warns.push(args),
      error: () => {},
    }
    const registry = entryBundle.createDefaultRegistry()
    const analyzer = new entryBundle.PolyglotAnalyzer(registry, captureLogger)
    const source =
      "import { init, LDClient } from '@launchdarkly/js-client-sdk'\n" +
      "const client = init('sdk-key')\n" +
      "const showBanner = client.variation('show-banner', false)\n" +
      "const enableChat = client.boolVariation('enable-chat', true)\n"
    const result = await analyzer.analyzeFiles(new Map([['app.ts', source]]))
    expect(warns).toEqual([])
    expect(result.totalFlags.size).toBeGreaterThanOrEqual(1)
    expect(Array.from(result.totalFlags.keys())).toContain('show-banner')
  })
})
