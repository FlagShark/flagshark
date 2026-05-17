import { describe, it, expect, beforeEach } from 'vitest'

import { getParser, _resetParserCacheForTests } from '../../src/detection/tree-sitter/parser-cache.js'
import {
  resolveConstStringGo,
  resolveConstStringTS,
} from '../../src/detection/tree-sitter/const-resolver.js'

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

  it('returns null when the const value is not a string literal (e.g. numeric)', async () => {
    // `const FLAG = 42` — name matches but value is a number literal, not a string.
    // This exercises the branch where literal === null and we continue the inner loop (line 29).
    const source = `const FLAG = 42\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })

  it('returns null when node is not an identifier', async () => {
    // Pass a string-literal node directly — type will be 'string', not 'identifier'
    const source = `client.variation('DIRECT_STRING', user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const stringArg = args.namedChildren[0]!
    // stringArg is a 'string' node, not an 'identifier' — should return null immediately
    expect(resolveConstStringTS(stringArg, tree!.rootNode)).toBeNull()
  })

  it('skips destructured const declarations (no simple name field — line 24)', async () => {
    // `const { a } = obj` creates a variable_declarator where childForFieldName('name')
    // returns an object_pattern, not a simple identifier. The valueNode may be present
    // but nameNode.text !== flagName, so we continue without finding a match.
    const source = `const { a } = obj\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    // FLAG is not a const string binding (it's from a destructure), so returns null
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })

  it('skips const declarations without a value (!valueNode branch)', async () => {
    // `const FLAG: string` (no initializer) — tree-sitter parses this as a
    // variable_declarator with a name field but no value field.
    // This triggers the `!valueNode` branch on line 22 of const-resolver.ts.
    const source = `const FLAG: string\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    // No initializer → valueNode is null → cannot resolve → returns null
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })

  it('handles file with only non-lexical-declaration top-level nodes (line 16)', async () => {
    // No const declarations — loop iterates but all children fail the type check
    const source = `function foo() { return 1 }\nclient.variation(MISSING, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const calls = tree!.rootNode.descendantsOfType('call_expression')
    // Find the outer client.variation call (not the inner return)
    const call = calls.find((c) => c?.text.startsWith('client.variation'))!
    expect(call).not.toBeUndefined()
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })

  it('handles const with let keyword (line 17 — not "const" keyword)', async () => {
    // `let FLAG = 'value'` is a lexical_declaration but with 'let' keyword, not 'const'
    // This covers the `child.children[0]?.type !== 'const'` branch on line 17
    const source = `let FLAG = 'my-flag'\nclient.variation(FLAG, user, false)`
    const parser = await getParser('typescript')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.childForFieldName('arguments')!
    const flagArg = args.namedChildren[0]!
    // `let` declaration → not resolved (line 17 branch)
    expect(resolveConstStringTS(flagArg, tree!.rootNode)).toBeNull()
  })
})

// Mirror of the TS suite for Go. Added in the 1.5 detection-quality sweep
// after `examples/go/launchdarkly_example.go:120` silently lost its
// const-extracted flag (`BoolVariation(newDashboardFlag, ...)`).
describe('const-resolver / go', () => {
  beforeEach(() => _resetParserCacheForTests())

  // Helper -- finds the call_expression's args[0] in a small Go snippet.
  async function firstCallArg(source: string) {
    const parser = await getParser('go')
    const tree = parser.parse(source)
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.namedChildren.find((c) => c && c.type === 'argument_list')!
    const flagArg = args.namedChildren[0]!
    return { tree: tree!, flagArg }
  }

  it('resolves a top-level `const FLAG = "X"` reference (untyped)', async () => {
    const { tree, flagArg } = await firstCallArg(
      `package main
const newDashboardFlag = "go-new-dashboard-layout"
func main() { client.BoolVariation(newDashboardFlag, ctx, false) }`,
    )
    expect(resolveConstStringGo(flagArg, tree.rootNode)).toBe('go-new-dashboard-layout')
  })

  it('resolves a typed `const FLAG string = "X"` reference', async () => {
    const { tree, flagArg } = await firstCallArg(
      `package main
const typedFlag string = "typed-flag-key"
func main() { client.BoolVariation(typedFlag, ctx, false) }`,
    )
    expect(resolveConstStringGo(flagArg, tree.rootNode)).toBe('typed-flag-key')
  })

  it('resolves grouped `const ( A = "x"; B = "y" )` references', async () => {
    const { tree, flagArg } = await firstCallArg(
      `package main
const (
  AnotherFlag = "another-flag-key"
  groupedFlag = "grouped-flag-key"
)
func main() { client.BoolVariation(groupedFlag, ctx, false) }`,
    )
    expect(resolveConstStringGo(flagArg, tree.rootNode)).toBe('grouped-flag-key')
  })

  it('returns null when the identifier is undefined in the file', async () => {
    const { tree, flagArg } = await firstCallArg(
      `package main
func main() { client.BoolVariation(undefinedConst, ctx, false) }`,
    )
    expect(resolveConstStringGo(flagArg, tree.rootNode)).toBeNull()
  })

  it('returns null when the const value is a non-string literal (numeric)', async () => {
    const { tree, flagArg } = await firstCallArg(
      `package main
const FlagNumber = 42
func main() { client.BoolVariation(FlagNumber, ctx, false) }`,
    )
    expect(resolveConstStringGo(flagArg, tree.rootNode)).toBeNull()
  })

  it('returns null when node is not an identifier (e.g. direct string literal)', async () => {
    const parser = await getParser('go')
    const tree = parser.parse(
      `package main
func main() { client.BoolVariation("DIRECT_STRING", ctx, false) }`,
    )
    expect(tree).not.toBeNull()
    const call = tree!.rootNode.descendantsOfType('call_expression')[0]!
    const args = call.namedChildren.find((c) => c && c.type === 'argument_list')!
    const flagArg = args.namedChildren[0]!
    expect(flagArg.type).not.toBe('identifier')
    expect(resolveConstStringGo(flagArg, tree!.rootNode)).toBeNull()
  })

  it('returns null when the binding is a `var` declaration, not `const`', async () => {
    // Go `var X = "y"` is a separate top-level node type from const_declaration
    // and must not be picked up as a const binding.
    const { tree, flagArg } = await firstCallArg(
      `package main
var someFlag = "var-flag-key"
func main() { client.BoolVariation(someFlag, ctx, false) }`,
    )
    expect(resolveConstStringGo(flagArg, tree.rootNode)).toBeNull()
  })
})
