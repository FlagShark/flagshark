import { deduplicateFlags, isValidFlagKey } from '../helpers.js'
import { getImportPattern } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, MethodConfig } from '../interface.js'

import { getParser } from './parser-cache.js'
import { getQuery, iterateCalls, getArgument, extractStringLiteral } from './query-runner.js'
import { resolveConstStringGo, resolveConstStringTS } from './const-resolver.js'

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
  // Each provider gets one of:
  //   - 'high'   — import gate passed (full-confidence SDK detection)
  //   - 'medium' — import gate FAILED but a runtime-symbol matched, so we
  //                still scan the file. The B2 gate-bypass mechanism — see
  //                interface.ts:runtimeSymbols for the trade-off discussion.
  //   - skip     — neither matched.
  // Custom providers (no importPattern) always pass with 'high'; their
  // recall is bounded by the method-name list, not the import gate.
  type ActiveProvider = {
    provider: FeatureFlagProvider
    confidence: 'high' | 'medium'
  }
  const activeProviders: ActiveProvider[] = []
  for (const p of providers) {
    if (!p.enabled) continue
    if (p.methods.length === 0) continue
    const importPat = getImportPattern(p)
    if (!importPat) {
      activeProviders.push({ provider: p, confidence: 'high' })
      continue
    }
    if (content.includes(importPat)) {
      activeProviders.push({ provider: p, confidence: 'high' })
      continue
    }
    const runtimeHit = (p.runtimeSymbols ?? []).some((sym) => content.includes(sym))
    if (runtimeHit) {
      activeProviders.push({ provider: p, confidence: 'medium' })
    }
  }

  if (activeProviders.length === 0) return []

  const methodLookup = new Map<
    string,
    Array<{ provider: FeatureFlagProvider; method: MethodConfig; confidence: 'high' | 'medium' }>
  >()
  for (const { provider, confidence } of activeProviders) {
    for (const method of provider.methods) {
      if (method.flagKeyIndex < 0) continue
      const list = methodLookup.get(method.name) ?? []
      list.push({ provider, method, confidence })
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

    for (const { provider, method, confidence } of matches) {
      const arg = getArgument(argsNode, method.flagKeyIndex)
      if (!arg) continue

      let flagKey = extractStringLiteral(arg)

      // Const-extraction for tier-1 languages where the resolver is wired up.
      // Resolves file-scope `const NAME = "literal"` references when a method
      // call uses the identifier instead of a string literal. Go added in the
      // 1.5 detection-quality sweep -- prior to that, Go consumers like
      // `examples/go/launchdarkly_example.go:120` (BoolVariation(newDashboardFlag, ...))
      // had their const-extracted flag silently dropped.
      if (flagKey === null) {
        if (language === 'typescript' || language === 'javascript') {
          flagKey = resolveConstStringTS(arg, tree.rootNode)
        } else if (language === 'go') {
          flagKey = resolveConstStringGo(arg, tree.rootNode)
        }
      }

      if (!flagKey || !isValidFlagKey(flagKey)) continue

      const flag: FeatureFlag = {
        name: flagKey,
        filePath: filename,
        lineNumber: callNode.startPosition.row + 1,
        language,
        provider: getImportPattern(provider) || provider.name,
      }
      if (confidence !== 'high') flag.confidence = confidence
      flags.push(flag)
    }
  }

  return deduplicateFlags(flags)
}
