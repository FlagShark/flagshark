/**
 * GENERATED FILE -- do not edit by hand.
 *
 * Source: src/detection/tree-sitter/queries/*.scm
 * Regenerate: `bun run generate:queries` (also runs as part of `bun run build`).
 *
 * Inlining queries removes the runtime filesystem dependency that broke under
 * ESM->CJS bundling (see retrospective in parser-cache.ts).
 */

import type { Language } from '../interface.js'

export const INLINE_QUERIES: Partial<Record<Language, string>> = {
  "go": "; Method call on a receiver: client.BoolVariation(...)\n(call_expression\n  function: (selector_expression\n    operand: (_) @receiver\n    field: (field_identifier) @method)\n  arguments: (argument_list) @args) @call\n\n; Bare function call: BoolVariation(...)\n(call_expression\n  function: (identifier) @method\n  arguments: (argument_list) @args) @call\n",
  "javascript": "; tree-sitter-javascript's grammar uses identical node names to typescript\n; for these call shapes — we duplicate the file for clarity even though the\n; content is identical.\n\n(call_expression\n  function: (member_expression\n    object: (_) @receiver\n    property: (property_identifier) @method)\n  arguments: (arguments) @args) @call\n\n(call_expression\n  function: (identifier) @method\n  arguments: (arguments) @args) @call\n",
  "python": "; Method call: client.variation(...)\n(call\n  function: (attribute\n    object: (_) @receiver\n    attribute: (identifier) @method)\n  arguments: (argument_list) @args) @call\n\n; Bare function call: variation(...)\n(call\n  function: (identifier) @method\n  arguments: (argument_list) @args) @call\n",
  "typescript": "; Match method-style calls: <receiver>.<method>(<args>)\n(call_expression\n  function: (member_expression\n    object: (_) @receiver\n    property: (property_identifier) @method)\n  arguments: (arguments) @args) @call\n\n; Match free-function calls: <method>(<args>)\n(call_expression\n  function: (identifier) @method\n  arguments: (arguments) @args) @call\n",
}

export const INLINE_QUERY_LANGUAGES: Language[] = ["go","javascript","python","typescript"]
