/**
 * Shared detection helper utilities.
 * Ported from Go: internal/languages/helpers/helpers.go
 */

import { getImportPattern } from './interface.js'

import type { FeatureFlag } from './feature-flag.js'
import type { MethodConfig, FeatureFlagProvider, Language } from './interface.js'

/** Extracts method names from a list of MethodConfig. */
export function extractMethodNames(methods: MethodConfig[]): string[] {
  return methods.map((m) => m.name)
}

/** Returns the flagKeyIndex from the first method, or 0 if empty. */
export function getDefaultKeyIndex(methods: MethodConfig[]): number {
  if (methods.length > 0) {
    return methods[0].flagKeyIndex
  }
  return 0
}

/**
 * Deduplicates feature flags based on filePath + name + lineNumber.
 * Keeps the first occurrence.
 */
export function deduplicateFlags(flags: FeatureFlag[]): FeatureFlag[] {
  const seen = new Set<string>()
  const result: FeatureFlag[] = []

  for (const flag of flags) {
    const key = `${flag.filePath}:${flag.name}:${flag.lineNumber}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(flag)
    }
  }

  return result
}

/**
 * Extracts a string argument from a method call at a given parameter index.
 * Handles both single-quoted and double-quoted strings, and backtick template literals.
 *
 * @param callText - The full method call text (e.g., `client.variation("flag-key", ctx, false)`)
 * @param paramIndex - The 0-based index of the parameter to extract
 * @returns The extracted string value (without quotes), or null if not found
 */
export function extractStringArgument(callText: string, paramIndex: number): string | null {
  // Find the opening parenthesis
  const parenStart = callText.indexOf('(')
  if (parenStart === -1) {
    return null
  }

  const parenEnd = callText.lastIndexOf(')')
  if (parenEnd === -1) {
    return null
  }

  const argsStr = callText.slice(parenStart + 1, parenEnd)
  const args = splitArguments(argsStr)

  if (paramIndex < 0 || paramIndex >= args.length) {
    return null
  }

  const arg = args[paramIndex].trim()

  // Match quoted strings: "value", 'value', or `value`
  const match = arg.match(/^["'`](.*)["'`]$/)
  return match ? match[1] : null
}

/**
 * Splits a comma-separated argument list, respecting nested parentheses,
 * brackets, braces, and string literals.
 */
export function splitArguments(argsStr: string): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  let inString: string | null = null

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i]
    const prev = i > 0 ? argsStr[i - 1] : ''

    if (inString) {
      current += ch
      if (ch === inString && prev !== '\\') {
        inString = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      current += ch
      continue
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      current += ch
      continue
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      current += ch
      continue
    }

    if (ch === ',' && depth === 0) {
      args.push(current)
      current = ''
      continue
    }

    current += ch
  }

  if (current.trim().length > 0) {
    args.push(current)
  }

  return args
}

/**
 * Builds a regex pattern that matches any of the given method names being called.
 * Supports both dot-notation (obj.method) and standalone function calls.
 *
 * @returns A RegExp that captures the full call expression, including the first string argument.
 */
export function buildMethodCallPattern(methodNames: string[]): RegExp {
  if (methodNames.length === 0) {
    return /(?!)/ // Never matches
  }
  const escaped = methodNames.map((n) => escapeRegExp(n))
  const alternation = escaped.join('|')
  // Match: optional_receiver.methodName( ... ) capturing the call
  return new RegExp(`(?:^|[^\\w.])(?:\\w+\\.)?(?:${alternation})\\s*\\(`, 'gm')
}

/** Escapes special regex characters in a string. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Detects feature flags in source code using regex-based pattern matching.
 * This is used by all language detectors as the primary detection mechanism.
 */
export function detectFlagsWithRegex(
  filename: string,
  content: string,
  language: Language,
  providers: FeatureFlagProvider[],
): FeatureFlag[] {
  const flags: FeatureFlag[] = []
  const lines = content.split('\n')

  for (const provider of providers) {
    if (!provider.enabled) {
      continue
    }
    if (provider.methods.length === 0) {
      continue
    }

    const providerName = provider.name
    const importPat = getImportPattern(provider)

    // Import check: skip this provider if file doesn't import its SDK.
    // Providers with no importPattern (e.g., "Custom Feature Flags") are kept as fallbacks.
    if (importPat) {
      const hasImport =
        content.includes(importPat) || lines.some((line) => line.includes(importPat))
      if (!hasImport) {
        continue
      }
    }

    for (const method of provider.methods) {
      // Skip methods that return all flags (flagKeyIndex = -1)
      if (method.flagKeyIndex < 0) {
        continue
      }

      const pattern = buildSingleMethodPattern(method.name)

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx]
        let match: RegExpExecArray | null

        while ((match = pattern.exec(line)) !== null) {
          const callStart = match.index
          // Extract the full call from this position
          const restOfContent = getCallExpression(lines, lineIdx, callStart)
          if (!restOfContent) {
            continue
          }

          const flagKey = extractStringArgument(restOfContent, method.flagKeyIndex)
          if (flagKey && isValidFlagKey(flagKey)) {
            flags.push({
              name: flagKey,
              filePath: filename,
              lineNumber: lineIdx + 1,
              language,
              provider: importPat || providerName,
            })
          }
        }
      }
    }
  }

  return deduplicateFlags(flags)
}

/** Builds a regex for a single method name that matches calls. */
function buildSingleMethodPattern(methodName: string): RegExp {
  const escaped = escapeRegExp(methodName)
  return new RegExp(`(?:^|[^\\w])(?:\\w+[.:])?${escaped}\\s*\\(`, 'g')
}

/**
 * Extracts a full call expression starting from a match position,
 * handling multi-line calls by tracking parenthesis depth.
 */
function getCallExpression(lines: string[], startLine: number, startCol: number): string | null {
  let result = lines[startLine].slice(startCol)
  let depth = 0
  let foundOpen = false

  for (let i = 0; i < result.length; i++) {
    if (result[i] === '(') {
      depth++
      foundOpen = true
    } else if (result[i] === ')') {
      depth--
      if (foundOpen && depth === 0) {
        return result.slice(0, i + 1)
      }
    }
  }

  // Multi-line call: continue scanning subsequent lines (up to 10)
  const maxLines = Math.min(startLine + 10, lines.length)
  for (let lineIdx = startLine + 1; lineIdx < maxLines; lineIdx++) {
    const line = lines[lineIdx]
    result += '\n' + line
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '(') {
        depth++
        foundOpen = true
      } else if (line[i] === ')') {
        depth--
        if (foundOpen && depth === 0) {
          return result
        }
      }
    }
  }

  return foundOpen ? result : null
}

/** Checks whether a string looks like a valid feature flag key. */
export function isValidFlagKey(key: string): boolean {
  if (key.length === 0 || key.length > 256) {
    return false
  }

  const invalidPrefixes = ['http://', 'https://', 'file://', '/']
  for (const prefix of invalidPrefixes) {
    if (key.startsWith(prefix)) {
      return false
    }
  }

  return true
}

/**
 * Merges custom providers with defaults.
 * Custom providers override defaults with the same import pattern.
 */
export function mergeProviders(
  defaults: FeatureFlagProvider[],
  custom: FeatureFlagProvider[],
): FeatureFlagProvider[] {
  const result = [...defaults]
  const byPattern = new Map<string, number>()

  for (let i = 0; i < result.length; i++) {
    const pattern = getImportPattern(result[i])
    if (pattern) {
      byPattern.set(pattern, i)
    }
  }

  for (const customProvider of custom) {
    const pattern = getImportPattern(customProvider)
    const idx = byPattern.get(pattern)
    if (idx !== undefined) {
      result[idx] = customProvider
    } else {
      result.push(customProvider)
      byPattern.set(pattern, result.length - 1)
    }
  }

  return result
}
