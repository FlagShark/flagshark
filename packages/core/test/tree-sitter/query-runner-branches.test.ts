/**
 * Branch coverage for query-runner.ts lines 16-17:
 * The FLAGSHARK_QUERIES_DIR env var code path (loadQueryText bundle path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import { _clearQueryCache, loadQueryText } from '../../src/detection/tree-sitter/query-runner.js'

// Path to the actual .scm queries directory (same place the module reads from by default)
const queriesDir = dirname(fileURLToPath(new URL('../../src/detection/tree-sitter/queries/typescript.scm', import.meta.url)))

describe('loadQueryText — FLAGSHARK_QUERIES_DIR branch (lines 16-17)', () => {
  let origQueriesDir: string | undefined

  beforeEach(() => {
    origQueriesDir = process.env.FLAGSHARK_QUERIES_DIR
    _resetParserCacheForTests()
    _clearQueryCache()
  })

  afterEach(() => {
    if (origQueriesDir === undefined) {
      delete process.env.FLAGSHARK_QUERIES_DIR
    } else {
      process.env.FLAGSHARK_QUERIES_DIR = origQueriesDir
    }
    _resetParserCacheForTests()
    _clearQueryCache()
  })

  it('reads the query file via FLAGSHARK_QUERIES_DIR when set', () => {
    process.env.FLAGSHARK_QUERIES_DIR = queriesDir
    const text = loadQueryText('typescript')
    expect(typeof text).toBe('string')
    expect(text.length).toBeGreaterThan(0)
  })

  it('reads the same content as the default path', () => {
    // Default path (no env var)
    const defaultText = loadQueryText('typescript')

    // Bundle path via env var
    process.env.FLAGSHARK_QUERIES_DIR = queriesDir
    const bundleText = loadQueryText('typescript')

    expect(bundleText).toBe(defaultText)
  })
})

describe('loadQueryText — unknown language', () => {
  it('throws an actionable error when no inlined query exists for the language', () => {
    // Tier-2 languages (java, ruby, etc.) use regex detection and have no .scm
    // query, but if a caller mistakenly asks for one we want a clear error
    // pointing them at the registry, not a cryptic `undefined.length` crash.
    expect(() => loadQueryText('cobol' as never)).toThrow(/no inlined query/)
    expect(() => loadQueryText('cobol' as never)).toThrow(/createDefaultRegistry/)
  })
})
