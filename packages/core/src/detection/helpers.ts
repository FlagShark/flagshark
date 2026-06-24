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

  let arg = args[paramIndex].trim()

  // Strip leading argument label (e.g. `forKey: ` / `flagKey: ` / `key: `) before
  // matching the quoted value. Applies to Swift external argument labels and
  // PHP 8 / Ruby keyword-arg call sites. Kotlin uses `=` for named args and is
  // not affected.
  const labelMatch = arg.match(/^\w+\s*:\s*(.+)$/)
  if (labelMatch) {
    arg = labelMatch[1].trim()
  }

  // Match quoted strings: "value", 'value', or `value`
  const match = arg.match(/^["'`](.*)["'`]$/)
  return match ? match[1] : null
}

/**
 * Splits a comma-separated argument list, respecting nested parentheses,
 * brackets, braces, string literals, and block comments (/* ... *\/).
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

    // Skip block comments /* ... */
    if (ch === '/' && argsStr[i + 1] === '*') {
      const end = argsStr.indexOf('*/', i + 2)
      if (end !== -1) {
        i = end + 1
        continue
      }
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

    // Import gate: skip this provider if the file doesn't import its SDK,
    // UNLESS it carries a runtime-symbol that flags the SDK as present even
    // without a static import. Providers with no importPattern (the legacy
    // "Custom Feature Flags" catch-all) always run.
    //
    // Detected via runtimeSymbols are tagged below with `confidence: 'medium'`
    // so downstream consumers can route them through review rather than
    // auto-merge. See B2 design doc + the provider docstring for the
    // false-positive trade-off.
    let detectionConfidence: 'high' | 'medium' = 'high'
    if (importPat) {
      // The import gate passes if EITHER the primary pattern OR any
      // declared alias is present in the file. SDKs republished under a
      // scoped name (e.g. `@launchdarkly/react-client-sdk`) rely on the
      // alias list so the legacy unscoped form
      // (`launchdarkly-react-client-sdk`) still triggers detection.
      const importPatterns = [importPat, ...(provider.importAliases ?? [])]
      const hasImport = importPatterns.some(
        (pat) => content.includes(pat) || lines.some((line) => line.includes(pat)),
      )
      if (!hasImport) {
        // Check whether the file matches any runtime-symbol pattern.
        const runtimeHit = (provider.runtimeSymbols ?? []).some((sym) =>
          content.includes(sym),
        )
        if (!runtimeHit) {
          continue
        }
        // Gate passed via runtime symbol — downgrade confidence so the
        // flag's downstream treatment reflects the weaker signal.
        detectionConfidence = 'medium'
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
          // The regex consumes a leading non-word character (typically a
          // space, but a `(` for calls inside `if (client.Method(...))`),
          // so `match.index` can be one char before the receiver. Anchor
          // the walk at the method's own `(` -- the LAST char of the match
          // -- so `getCallExpression` doesn't mistake a wrapping paren for
          // the call's opening paren. Without this, every C# (and other
          // regex-language) call inside `if (...)` returned the entire
          // wrapped expression as arg 0 and the flag-key extraction failed.
          const callStart = match.index + match[0].length - 1
          const restOfContent = getCallExpression(lines, lineIdx, callStart)
          /* v8 ignore next 3 -- defensive; getCallExpression only returns null when no '(' is ever found, which the matching regex guarantees */
          if (!restOfContent) {
            continue
          }

          const flagKey = extractStringArgument(restOfContent, method.flagKeyIndex)
          if (flagKey && isValidFlagKey(flagKey)) {
            const flag: FeatureFlag = {
              name: flagKey,
              filePath: filename,
              lineNumber: lineIdx + 1,
              language,
              provider: importPat || providerName,
            }
            // Only emit `confidence` when it's a non-default value. The
            // FeatureFlag type documents `confidence` as optional with
            // "absent = high", so omitting it for the common case keeps
            // existing JSON consumers + test fixtures stable.
            if (detectionConfidence !== 'high') flag.confidence = detectionConfidence
            flags.push(flag)
          }
        }
      }
    }

    // useFlagsHook: providers like the LaunchDarkly React SDK don't pass
    // flag keys as call-site arguments. Instead, calling `useFlags()` returns
    // an object whose keys ARE the flag names; consumers either destructure
    // them or index into them. The positional-arg pipeline above can't see
    // this shape. When a provider declares `useFlagsHook`, run a second pass
    // that extracts destructured property names from `... = <hook>()` sites
    // and emits each as a detected flag.
    if (provider.useFlagsHook) {
      const hookFlags = detectDestructuredHookFlags(
        filename,
        content,
        language,
        importPat || providerName,
        provider.useFlagsHook,
        detectionConfidence,
      )
      flags.push(...hookFlags)
    }
  }

  return deduplicateFlags(flags)
}

/**
 * Extracts flag keys from destructured property names on a hook's return
 * value. Handles the LaunchDarkly React SDK pattern (and any future hook
 * with the same shape):
 *
 *   const { showNewCheckout, oneClickPurchase } = useFlags()
 *   let   { feature: aliased } = useFlags()  // takes `feature`, not `aliased`
 *
 * Multi-line destructures are supported (the regex spans newlines). The
 * line number reported is the line where the destructure begins.
 *
 * Identifiers that fail `isValidFlagKey` (numeric literals, reserved
 * words) are dropped — this is the same gate the positional-arg path
 * applies, kept consistent so downstream consumers see one rule.
 */
export function detectDestructuredHookFlags(
  filename: string,
  content: string,
  language: Language,
  provider: string,
  hookName: string,
  confidence: 'high' | 'medium' = 'high',
): FeatureFlag[] {
  const out: FeatureFlag[] = []
  const pattern = new RegExp(
    `(?:const|let|var)\\s*\\{\\s*([\\s\\S]*?)\\}\\s*=\\s*${escapeRegExp(hookName)}\\s*\\(\\s*\\)`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = pattern.exec(content)) !== null) {
    const lineNumber = content.slice(0, m.index).split('\n').length
    const inside = m[1]
    // Strip line comments inside the destructure body before splitting on
    // commas — otherwise a trailing `// note` would taint the last name.
    const cleaned = inside
      .split('\n')
      .map((seg) => seg.replace(/\/\/.*$/, ''))
      .join(' ')
    for (const raw of cleaned.split(',')) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      // `originalName: alias` — the flag key is the SOURCE side (the
      // property on the hook's return value), not the local alias.
      const flagKey = trimmed.split(':')[0].trim()
      if (isValidFlagKey(flagKey)) {
        const flag: FeatureFlag = {
          name: flagKey,
          filePath: filename,
          lineNumber,
          language,
          provider,
        }
        if (confidence !== 'high') flag.confidence = confidence
        out.push(flag)
      }
    }
  }
  return out
}

/**
 * Detects feature flags in Objective-C source.
 *
 * Obj-C uses message-send syntax — `[receiver method:@"key" other:val]` — not
 * the `method(args)` paren-call syntax every other language uses. The shared
 * `detectFlagsWithRegex` keys off `(` (via `buildSingleMethodPattern` and the
 * paren-based arg extraction), so it never matched a single Obj-C call. This
 * pass matches the `method:@"key"` selector form and extracts the key directly.
 *
 * The flag key is always the argument immediately after the method-name label
 * (every Obj-C provider method declares `flagKeyIndex: 0`), so we read the first
 * `@"..."` string right after `method:`. The `\s*:` boundary stops a method
 * name from matching a longer selector it merely prefixes (e.g. `boolVariation`
 * will NOT fire inside `boolVariationForKey:`).
 */
export function detectObjcMessageFlags(
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

    const importPat = getImportPattern(provider)
    // Import gate: a provider with an importPattern only runs when the file
    // imports its SDK. The catch-all custom provider (no importPattern) always
    // runs. Obj-C has no runtime-loaded SDKs, so there's no runtime-symbol
    // fallback here (unlike the JS path in detectFlagsWithRegex).
    if (importPat && !content.includes(importPat)) {
      continue
    }

    for (const method of provider.methods) {
      // `[^\w]`-anchored method label, then `:` then the first quoted string
      // (Obj-C string literals are `@"..."`; the `@` is optional for safety).
      // The `\s*:` boundary stops a method name from matching a longer selector
      // it merely prefixes (e.g. `boolVariation` will NOT fire inside
      // `boolVariationForKey:`).
      const pattern = new RegExp(
        `(?:^|[^\\w])${escapeRegExp(method.name)}\\s*:\\s*@?["']([^"'\\n]+)["']`,
        'g',
      )
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(lines[lineIdx])) !== null) {
          if (isValidFlagKey(match[1])) {
            flags.push({
              name: match[1],
              filePath: filename,
              lineNumber: lineIdx + 1,
              language,
              provider: importPat || provider.name,
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

  /* v8 ignore next -- foundOpen is always true here: the matching regex requires '(' which startCol points to */
  return foundOpen ? result : null
}

/**
 * Characters that legitimate feature flag keys never contain. Real keys
 * across LaunchDarkly, Unleash, PostHog, Statsig, Split.io, and the
 * shakedown corpus are limited to letters, digits, underscores, dashes,
 * dots, and colons. The chars below appear only when we've accidentally
 * latched onto a regex literal, a URL fragment, or a string with parens.
 *
 * Surfaced by the PostHog shakedown: a TSX file contained the regex
 * fragment `([^/]+)` which slipped through `isValidFlagKey` because the
 * legacy check only rejected URL prefixes. The new key now reports as a
 * false positive in flagshark's output — that's the bug this set guards
 * against. See A2 in the shakedown bug inventory.
 */
const INVALID_FLAG_KEY_CHAR = /[()\[\]^$\\\s]/

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

  // Reject keys that look like regex literals, character classes, or contain
  // whitespace — none of these are legitimate shapes for a feature flag key
  // and they consistently indicate we've extracted the wrong string from a
  // method call (e.g. `new RegExp('([^/]+)')` getting matched).
  if (INVALID_FLAG_KEY_CHAR.test(key)) {
    return false
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
