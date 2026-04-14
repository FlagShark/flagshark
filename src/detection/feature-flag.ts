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
}
