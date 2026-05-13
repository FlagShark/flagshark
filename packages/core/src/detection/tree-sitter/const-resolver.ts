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
    if (child.type !== 'lexical_declaration') continue
    if (child.children[0]?.type !== 'const') continue

    for (const decl of child.namedChildren) {
      // namedChildren of a const lexical_declaration are always variable_declarator nodes.
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
