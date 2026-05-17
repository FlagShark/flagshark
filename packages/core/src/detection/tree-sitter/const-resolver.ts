import { extractStringLiteral } from './query-runner.js'

import type { Node } from 'web-tree-sitter'

/**
 * If `node` is an identifier reference, look up its binding in the file's
 * top-level `const NAME = '...'` declarations. Returns the string value
 * or null. File-scope only — no nested scopes, no cross-file resolution.
 */
export function resolveConstStringTS(node: Node, fileRoot: Node): string | null {
  if (node.type !== 'identifier') return null
  const name = node.text

  for (const child of fileRoot.namedChildren) {
    /* v8 ignore next -- web-tree-sitter types namedChildren as (Node|null)[]; runtime values are non-null */
    if (!child) continue
    if (child.type !== 'lexical_declaration') continue
    if (child.children[0]?.type !== 'const') continue

    for (const decl of child.namedChildren) {
      /* v8 ignore next -- same as above; runtime values are non-null */
      if (!decl) continue
      const nameNode = decl.childForFieldName('name')
      const valueNode = decl.childForFieldName('value')
      if (!nameNode || !valueNode) continue
      if (nameNode.text !== name) continue
      const literal = extractStringLiteral(valueNode)
      if (literal !== null) return literal
    }
  }

  return null
}

/**
 * Go equivalent of `resolveConstStringTS`. Walks file-scope `const_declaration`
 * nodes (both single-form `const X = "..."` and grouped form `const ( ... )`)
 * and returns the string literal bound to `name`, or null if not found.
 *
 * tree-sitter-go does not label const-spec children with field names, so we
 * pick the first identifier (name) and the first expression_list (value) out
 * of `const_spec.children`. The grouped form parses as a single
 * `const_declaration` with multiple `const_spec` children -- iterate them.
 */
export function resolveConstStringGo(node: Node, fileRoot: Node): string | null {
  if (node.type !== 'identifier') return null
  const name = node.text

  for (const child of fileRoot.namedChildren) {
    /* v8 ignore next -- web-tree-sitter types namedChildren as (Node|null)[]; runtime values are non-null */
    if (!child) continue
    if (child.type !== 'const_declaration') continue

    for (const spec of child.namedChildren) {
      /* v8 ignore next -- same as above; runtime values are non-null */
      if (!spec) continue
      /* v8 ignore next -- tree-sitter-go's const_declaration only contains const_spec children; the type guard is defensive */
      if (spec.type !== 'const_spec') continue

      let nameNode: Node | null = null
      let valueNode: Node | null = null
      for (const c of spec.children) {
        /* v8 ignore next -- runtime values are non-null */
        if (!c) continue
        if (!nameNode && c.type === 'identifier') nameNode = c
        else if (!valueNode && c.type === 'expression_list') valueNode = c
      }
      /* v8 ignore next -- a well-formed const_spec always has both an identifier and an expression_list; defensive */
      if (!nameNode || !valueNode) continue
      if (nameNode.text !== name) continue

      // Go's expression_list wraps one or more expressions. For a const
      // spec the value is typically a single literal -- look at the first
      // named child of expression_list (the literal itself).
      const literalNode = valueNode.namedChildren[0]
      /* v8 ignore next -- a const_spec's expression_list is non-empty in any parseable Go; defensive */
      if (!literalNode) continue
      const literal = extractStringLiteral(literalNode)
      if (literal !== null) return literal
    }
  }

  return null
}
