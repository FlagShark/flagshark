import { readFileSync } from 'node:fs'

import { Query } from 'web-tree-sitter'
import type { Node, Tree } from 'web-tree-sitter'

import type { Language } from '../interface.js'
import { getParser } from './parser-cache.js'
import { INLINE_QUERIES } from './queries-inline.js'

/**
 * Loads the .scm query text for a language.
 *
 * Default path returns the inlined query strings shipped with the package.
 * Inlining removes the filesystem dependency that broke under ESM->CJS
 * bundling (the prior implementation called `new URL('./queries/...',
 * import.meta.url)` which silently threw `Invalid URL` once bundlers stubbed
 * `import.meta` to `{}` -- see parser-cache.ts retrospective).
 *
 * `FLAGSHARK_QUERIES_DIR` stays as an escape hatch for consumers who need to
 * override the bundled queries at runtime (custom detection rules, vendored
 * variants). When set, it reads `${dir}/${lang}.scm` and skips the inline
 * lookup entirely.
 */
export function loadQueryText(lang: Language): string {
  const queriesDir = process.env.FLAGSHARK_QUERIES_DIR
  if (queriesDir) {
    return readFileSync(`${queriesDir}/${lang}.scm`, 'utf-8')
  }
  const inline = INLINE_QUERIES[lang]
  if (inline === undefined) {
    throw new Error(
      `query-runner: no inlined query for language "${lang}". This language ` +
        `is not registered as a tier-1 tree-sitter detector. Did you mean to use ` +
        `regex-based detection? See createDefaultRegistry().`,
    )
  }
  return inline
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
  const node = realChildren[index] ?? null
  // C# (argument_list) and PHP (arguments) wrap each call argument in an
  // `argument` node; Go/Java/TS/Python place the expression directly. Unwrap
  // so the caller (extractStringLiteral) sees the literal, not the wrapper.
  if (node && node.type === 'argument') {
    const inner = node.namedChildren.filter((n) => n !== null && n.type !== 'comment') as Node[]
    /* v8 ignore next -- a parsed `argument` always wraps an expression; the empty fallback is defensive */
    return inner[inner.length - 1] ?? null
  }
  return node
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
    type === 'template_string' ||
    type === 'encapsed_string'
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
