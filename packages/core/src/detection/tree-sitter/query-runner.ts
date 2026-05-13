import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Query } from 'web-tree-sitter'
import type { Node, Tree } from 'web-tree-sitter'

import type { Language } from '../interface.js'
import { getParser } from './parser-cache.js'

/** Loads the .scm query text for a language, relative to this module. */
export function loadQueryText(lang: Language): string {
  // In an Action bundle context, queries are vendored alongside the WASM grammars.
  // FLAGSHARK_QUERIES_DIR (set by the action entry) points at dist/queries/.
  const queriesDir = process.env.FLAGSHARK_QUERIES_DIR
  if (queriesDir) {
    return readFileSync(`${queriesDir}/${lang}.scm`, 'utf-8')
  }
  const url = new URL(`./queries/${lang}.scm`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf-8')
}

const queryCache = new Map<Language, Query>()
const inFlightQueries = new Map<Language, Promise<Query>>()

export async function getQuery(lang: Language): Promise<Query> {
  const cached = queryCache.get(lang)
  if (cached) return cached

  const pending = inFlightQueries.get(lang)
  if (pending) return pending

  const load = (async () => {
    const parser = await getParser(lang)
    // parser.language is always set after getParser succeeds (setLanguage called in parser-cache.ts)
    const query = new Query(parser.language!, loadQueryText(lang))
    queryCache.set(lang, query)
    inFlightQueries.delete(lang)
    return query
  })()

  inFlightQueries.set(lang, load)
  return load
}

export interface MatchedCall {
  callNode: Node
  methodName: string
  argsNode: Node
}

/** Walks query matches and yields one MatchedCall per call expression. */
export function* iterateCalls(tree: Tree, query: Query): Generator<MatchedCall> {
  for (const match of query.matches(tree.rootNode)) {
    const captures = match.captures
    const call = captures.find((c) => c.name === 'call')?.node
    const method = captures.find((c) => c.name === 'method')?.node
    const args = captures.find((c) => c.name === 'args')?.node
    // All current .scm queries include @call, @method, @args in every pattern.
    // Defensive: skip matches that are somehow missing a capture.
    if (!call || !method || !args) continue  // only fires if a query pattern is added without all captures
    yield { callNode: call, methodName: method.text, argsNode: args }
  }
}

/** Returns the Nth argument node, or null if out of range. */
export function getArgument(argsNode: Node, index: number): Node | null {
  const realChildren = (argsNode.namedChildren.filter((n) => n !== null && n.type !== 'comment')) as Node[]
  return realChildren[index] ?? null
}

/** Returns the string value if the node is a string literal, else null. */
export function extractStringLiteral(node: Node): string | null {
  const type = node.type
  const text = node.text

  if (
    type === 'string' ||
    type === 'string_literal' ||
    type === 'interpreted_string_literal' ||
    type === 'raw_string_literal' ||
    type === 'template_string'
  ) {
    if (text.length < 2) return null
    const first = text[0]
    const last = text[text.length - 1]
    if (first === last && (first === '"' || first === "'" || first === '`')) {
      return text.slice(1, -1)
    }
    /* v8 ignore next 2 -- Python triple-quoted flag literals; no fixture today but real engine behavior */
    if (text.startsWith('"""') && text.endsWith('"""')) return text.slice(3, -3)
    if (text.startsWith("'''") && text.endsWith("'''")) return text.slice(3, -3)
  }
  return null
}

/** @internal — for tests */
export function _clearQueryCache(): void {
  queryCache.clear()
  inFlightQueries.clear()
}
