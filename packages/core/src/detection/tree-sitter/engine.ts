import { deduplicateFlags, isValidFlagKey } from '../helpers.js'
import { getImportPattern } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, MethodConfig } from '../interface.js'

import { getParser } from './parser-cache.js'
import { getQuery, iterateCalls, getArgument, extractStringLiteral } from './query-runner.js'
import { resolveConstStringTS } from './const-resolver.js'

/**
 * Detect feature flags via tree-sitter. Mirrors detectFlagsWithRegex's contract.
 *
 * Import-gating: skip provider scans for files that don't contain the import pattern
 * as a substring. Cheap text check before parsing — saves AST work on most files.
 * Custom providers (no importPattern) always scan.
 */
export async function detectFlagsWithTreeSitter(
  filename: string,
  content: string,
  language: Language,
  providers: FeatureFlagProvider[],
): Promise<FeatureFlag[]> {
  const activeProviders = providers.filter((p) => {
    if (!p.enabled) return false
    if (p.methods.length === 0) return false
    const importPat = getImportPattern(p)
    if (!importPat) return true
    return content.includes(importPat)
  })

  if (activeProviders.length === 0) return []

  const methodLookup = new Map<string, Array<{ provider: FeatureFlagProvider; method: MethodConfig }>>()
  for (const provider of activeProviders) {
    for (const method of provider.methods) {
      if (method.flagKeyIndex < 0) continue
      const list = methodLookup.get(method.name) ?? []
      list.push({ provider, method })
      methodLookup.set(method.name, list)
    }
  }

  if (methodLookup.size === 0) return []

  const parser = await getParser(language)
  // parser.parse() always returns a tree for valid content; non-null assert is safe.
  const tree = parser.parse(content)!

  const query = await getQuery(language)

  const flags: FeatureFlag[] = []

  for (const { callNode, methodName, argsNode } of iterateCalls(tree, query)) {
    const matches = methodLookup.get(methodName)
    if (!matches) continue

    for (const { provider, method } of matches) {
      const arg = getArgument(argsNode, method.flagKeyIndex)
      if (!arg) continue

      let flagKey = extractStringLiteral(arg)

      // Goal C: const-extraction for TypeScript/JavaScript
      if (flagKey === null && (language === 'typescript' || language === 'javascript')) {
        flagKey = resolveConstStringTS(arg, tree.rootNode)
      }

      if (!flagKey || !isValidFlagKey(flagKey)) continue

      flags.push({
        name: flagKey,
        filePath: filename,
        lineNumber: callNode.startPosition.row + 1,
        language,
        provider: getImportPattern(provider) || provider.name,
      })
    }
  }

  return deduplicateFlags(flags)
}
