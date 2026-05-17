import { createRequire } from 'node:module'

import { Language as TreeSitterLanguage, Parser } from 'web-tree-sitter'

import { getModuleUrl } from './module-url.js'

import type { Language } from '../interface.js'

// `__filename` is a CJS module-scoped variable injected by Node's CJS wrapper
// (NOT on globalThis). In ESM contexts it doesn't exist at all -- the `typeof`
// guard below makes the reference safe in ESM (V8 returns 'undefined' for
// `typeof <undeclared>` without throwing). Declaring the type here keeps tsc
// happy when compiling ESM source.
declare const __filename: string | undefined

// Lazily created so that bundled environments where neither import.meta.url
// nor __filename is available (edge runtimes, browser bundles) don't crash at
// module initialisation -- we only call createRequire when FLAGSHARK_WASM_DIR
// is NOT set (i.e. normal npm / dev usage and standard Node bundles).
let require_: ReturnType<typeof createRequire> | null = null
function getRequire(): ReturnType<typeof createRequire> {
  if (require_) return require_
  // Native ESM has `import.meta.url`. Native CJS has `__filename` (as a
  // module-scoped local, hence the `typeof` access). esbuild's ESM->CJS
  // output stubs `import.meta` to `{}` but preserves `__filename` -- without
  // that fallback every grammar lookup throws.
  const metaUrl = (import.meta as unknown as Record<string, unknown>).url
  // The truthy branch of this ternary is unreachable under vitest (always
  // ESM, so `__filename` is undeclared and `typeof` returns 'undefined').
  // End-to-end coverage of the CJS-bundle path lives in
  // parser-cache-cjs-bundle.test.ts, which actually bundles the source
  // ESM->CJS and exercises the result.
  /* c8 ignore next */
  const cjsFilename = typeof __filename !== 'undefined' ? __filename : undefined
  require_ = createRequire(getModuleUrl(metaUrl, cjsFilename, noResolutionBase))
  return require_
}

/** @internal Factored out for direct unit testing -- inline `throw` blocks
 * inside `getRequire` are unreachable in any normal vitest context (both
 * `import.meta.url` and `__filename` are always defined). */
export function noResolutionBase(): Error {
  return new Error(
    'parser-cache: cannot resolve tree-sitter grammars. Neither import.meta.url ' +
      'nor __filename is available -- this usually means @flagshark/core is being ' +
      'bundled into a non-Node target. Set the FLAGSHARK_WASM_DIR environment ' +
      'variable to a directory containing tree-sitter-{typescript,javascript,' +
      'go,python}.wasm.',
  )
}

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
  return getRequire().resolve(spec)
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
    const tsLang = await TreeSitterLanguage.load(wasmPath)
    const parser = new Parser()
    parser.setLanguage(tsLang)
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
