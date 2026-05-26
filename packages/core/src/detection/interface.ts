/**
 * Language detection interfaces and types.
 * Ported from Go: internal/languages/interface.go
 */

import type { FeatureFlag } from './feature-flag.js'

/** Supported programming language identifiers. */
export type Language =
  | 'go'
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'ruby'
  | 'csharp'
  | 'php'
  | 'rust'
  | 'cpp'
  | 'objc'

/** All supported language constants for convenience. */
export const Languages = {
  Go: 'go' as Language,
  TypeScript: 'typescript' as Language,
  JavaScript: 'javascript' as Language,
  Python: 'python' as Language,
  Java: 'java' as Language,
  Kotlin: 'kotlin' as Language,
  Swift: 'swift' as Language,
  Ruby: 'ruby' as Language,
  CSharp: 'csharp' as Language,
  PHP: 'php' as Language,
  Rust: 'rust' as Language,
  CPP: 'cpp' as Language,
  ObjectiveC: 'objc' as Language,
} as const

/** Defines how to detect a specific feature flag method call. */
export interface MethodConfig {
  /** Method name to match (e.g., "BoolVariation", "isEnabled") */
  name: string
  /** Regex pattern override (optional; defaults to method name) */
  pattern?: string
  /** Index of the flag key parameter in the method call (0-based) */
  flagKeyIndex: number
  /** Index of the context parameter (optional) */
  contextIndex?: number
  /** Example usages for documentation */
  examples?: string[]
}

/** Represents a feature flag library/service provider for a language. */
export interface FeatureFlagProvider {
  /** Display name (e.g., "LaunchDarkly Go SDK") */
  name: string
  /** Import/package path for the SDK */
  packagePath?: string
  /** Import pattern to match in source code */
  importPattern?: string
  /**
   * Optional alternative import patterns. Either the primary
   * `importPattern` OR any entry here is enough to pass the import gate.
   * Useful for SDKs published under both a legacy unscoped name and a
   * new scoped name (e.g. `launchdarkly-react-client-sdk` vs.
   * `@launchdarkly/react-client-sdk`).
   */
  importAliases?: string[]
  /** Methods to detect */
  methods: MethodConfig[]
  /** Human-readable description */
  description?: string
  /** Whether detection is enabled for this provider */
  enabled: boolean
  /**
   * Optional list of runtime-global symbol patterns that, when present
   * anywhere in a file's content, count as evidence that the file uses
   * this provider's SDK — even when the SDK is never statically imported.
   *
   * This is the B2 gate-bypass mechanism: codebases that load the SDK via
   * `<script>` snippet or tag manager (PostHog's canonical setup,
   * LaunchDarkly's client snippet) have NO `import 'posthog-js'` to
   * trigger the standard import gate. Without runtimeSymbols those
   * codebases get 0 detections despite hundreds of real callsites. The
   * n8n editor-ui shakedown case is the motivating reproduction.
   *
   * Patterns are matched as substrings (cheap and good enough for the
   * canonical shapes we care about — `window.posthog`, `posthog.isFeatureEnabled(`,
   * `useFeatureFlag(`). False-positive risk is bounded because:
   *   1. The patterns are chosen to be uniquely SDK-shaped (a `(` at the
   *      end means we're inside a call, not a string literal).
   *   2. Detected flags from a runtime-symbol gate carry `confidence:
   *      'medium'` so downstream tooling can route them through review
   *      rather than auto-merging cleanup PRs.
   *
   * Empty / unset = behave exactly as before (import gate only).
   */
  runtimeSymbols?: string[]

  /**
   * Optional bulk-flags hook name (e.g. `useFlags` for the LaunchDarkly
   * React SDK). When set, the detector additionally extracts flag keys
   * from destructured property names on the hook's return value:
   *
   *   const { showNewCheckout, oneClickPurchase } = useFlags()
   *                ^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
   *                each one becomes a detected flag
   *
   * Required because the React SDK does not pass flag keys as call-site
   * arguments — `useFlags()` takes no parameters and returns an object
   * keyed by every flag. Without this hook the entire React-SDK call
   * pattern produces zero detections, even though every site reads a
   * flag. See "React SDK gap" in the changelog for the motivating user
   * report.
   *
   * Note: LaunchDarkly camelCases flag keys by default; detected names
   * arrive in that form unless the consumer opted out via
   * `reactOptions: { useCamelCaseFlagKeys: false }`. Users should turn
   * camelCase off for the cleanest FlagShark experience, or apply a
   * convention mapping in `.flagshark.yml`.
   *
   * Empty / unset = no destructure-based detection.
   */
  useFlagsHook?: string
}

/** Returns the effective import pattern, supporting backward compatibility. */
export function getImportPattern(provider: FeatureFlagProvider): string {
  return provider.importPattern || provider.packagePath || ''
}

/**
 * LanguageDetector defines the interface for language-specific feature flag detection.
 * Each supported language implements this interface.
 */
export interface LanguageDetector {
  /** Returns the language this detector supports. */
  language(): Language

  /** Returns the file extensions this detector handles (e.g., [".go", ".py"]). */
  fileExtensions(): string[]

  /** Detects feature flags in the given source code. */
  detectFlags(filename: string, content: string): FeatureFlag[] | Promise<FeatureFlag[]>

  /** Checks if this detector can handle the given file. */
  supportsFile(filename: string): boolean

  /** Returns the feature flag providers supported by this language. */
  getProviders(): FeatureFlagProvider[]
}

/** Detailed detection result with metadata. */
export interface DetectionResult {
  flags: FeatureFlag[]
  language: Language
  metadata?: Record<string, unknown>
}

/** Which detection engine to use for tier-1 language detectors. */
export type DetectorEngine = 'regex' | 'tree-sitter'
