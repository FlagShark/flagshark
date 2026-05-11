import { describe, it, expect, beforeEach } from 'vitest'

import { getParser, _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import { resolveConstStringTS } from '../../src/detection/tree-sitter/const-resolver.js'

describe('const-resolver / typescript', () => {
  beforeEach(() => _resetParserCacheForTests())

  it('resolves a top-level `const FLAG = "X"` reference', async () => {
    const source = `const FLAG = 'NEW_CHECKOUT'\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBe('NEW_CHECKOUT')
  })

  it('returns null when the identifier is not a const string', async () => {
    const source = `let FLAG = 'NEW_CHECKOUT'\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })

  it('returns null when the identifier is undefined in the file', async () => {
    const source = `client.variation(UNKNOWN, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })
})
