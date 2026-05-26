/* v8 ignore file -- type-only module; no runtime statements to execute */
/**
 * How sure we are this is really a feature flag callsite.
 *
 *   - **high**: Detected through a strict import-gated SDK match. False
 *     positives are very rare; the SDK package is statically imported and
 *     the call shape matches the provider's declared method exactly. Safe
 *     for auto-merge cleanup PRs.
 *
 *   - **medium**: Detected through a weaker signal — a runtime-symbol
 *     gate bypass (`window.posthog` etc.), an unambiguous-method-name
 *     match without an import, or a user-configured custom detector.
 *     The flag is almost certainly real but the gate is wider. Suggested
 *     handling: surface to humans for review, don't auto-merge.
 *
 *   - **low**: Reserved for the future static-config flag system
 *     detector (B3 auto-discovery slice — not shipped today). Heuristic
 *     match with weaker precision; recommend manual confirmation.
 *
 * Absent / undefined is equivalent to `'high'` so existing consumers
 * that don't read the field keep their current behaviour.
 */
export type FlagConfidence = 'high' | 'medium' | 'low'

/**
 * Represents a detected feature flag in source code.
 */
export interface FeatureFlag {
  /** Flag name/key */
  name: string
  /** File where the flag is found (from diff) */
  filePath: string
  /** Line number in the file (1-based) */
  lineNumber: number
  /** Programming language (e.g., "go", "typescript") */
  language: string
  /** SDK/library provider if detected (e.g., "launchdarkly") */
  provider?: string
  /**
   * Detection-quality tier. See FlagConfidence's docstring for what each
   * value means. Absent = `'high'` (the historical default, preserves
   * behaviour for consumers that haven't been updated yet).
   */
  confidence?: FlagConfidence
}
