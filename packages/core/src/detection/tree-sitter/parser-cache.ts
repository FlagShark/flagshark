import { createRequire } from 'node:module'

import { Language as TreeSitterLanguage, Parser } from 'web-tree-sitter'

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
