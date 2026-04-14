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
  /** Methods to detect */
  methods: MethodConfig[]
  /** Human-readable description */
  description?: string
  /** Whether detection is enabled for this provider */
  enabled: boolean
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
  detectFlags(filename: string, content: string): FeatureFlag[]

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
