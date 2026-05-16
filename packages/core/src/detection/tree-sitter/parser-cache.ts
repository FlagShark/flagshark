import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { Language as TreeSitterLanguage, Parser } from 'web-tree-sitter'

import type { Language } from '../interface.js'

// Lazily created so that bundled CJS environments (where neither import.meta.url
// nor __filename is available) don't crash at module initialisation — we only
// need require_ when FLAGSHARK_WASM_DIR is NOT set (i.e. normal npm / dev usage).
let require_: ReturnType<typeof createRequire> | null = null
function getRequire(): ReturnType<typeof createRequire> {
  if (require_) return require_
  // Read both potential bases defensively. Native ESM under Node has
  // `import.meta.url`. Native CJS has `__filename`. esbuild's ESM->CJS output
  // stubs `import.meta` to `{}` (so `.url` is undefined) but `__filename`
  // exists -- without that fallback every grammar lookup throws.
  const metaUrl: unknown = (import.meta as unknown as Record<string, unknown>).url
  const cjsFilename: unknown = (globalThis as unknown as Record<string, unknown>).__filename
  require_ = createRequire(
    pickModuleUrl(
      typeof metaUrl === 'string' ? metaUrl : undefined,
      typeof cjsFilename === 'string' ? cjsFilename : undefined,
    ),
  )
  return require_
}

/**
 * @internal Pick a base URL for `createRequire`. Extracted from `getRequire` so
 * the runtime-shape logic is testable without spinning up a real bundler.
 *
 * Order:
 *   1. `metaUrl` -- normal ESM (`import.meta.url`).
 *   2. `pathToFileURL(filename)` -- CJS or ESM->CJS bundles (esbuild stubs
 *      `import.meta` to `{}` but keeps `__filename`).
 *   3. Throw with a `FLAGSHARK_WASM_DIR` pointer for non-Node bundles
 *      (edge runtimes, browsers) where neither base is available.
 */
export function pickModuleUrl(
  metaUrl: string | undefined,
  filename: string | undefined,
): string {
  if (typeof metaUrl === 'string' && metaUrl.length > 0) return metaUrl
  if (typeof filename === 'string' && filename.length > 0) {
    return pathToFileURL(filename).href
  }
  throw new Error(
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
