/**
 * Detection module barrel export.
 * Re-exports registry, interfaces, and provides factory for a fully-loaded registry.
 */

import { CPPDetector } from './detectors/cpp.js'
import { CSharpDetector } from './detectors/csharp.js'
import { GoDetector } from './detectors/go.js'
import { JavaDetector } from './detectors/java.js'
import { JavaScriptDetector } from './detectors/javascript.js'
import { KotlinDetector } from './detectors/kotlin.js'
import { ObjectiveCDetector } from './detectors/objectivec.js'
import { PHPDetector } from './detectors/php.js'
import { PythonDetector } from './detectors/python.js'
import { RubyDetector } from './detectors/ruby.js'
import { RustDetector } from './detectors/rust.js'
import { SwiftDetector } from './detectors/swift.js'
import { TypeScriptDetector } from './detectors/typescript.js'
import { LanguageRegistry } from './registry.js'

// Core types
export type { FeatureFlag } from './feature-flag.js'
export type {
  Language,
  LanguageDetector,
  FeatureFlagProvider,
  MethodConfig,
  DetectionResult,
} from './interface.js'
export { Languages, getImportPattern } from './interface.js'

// Registry
export { LanguageRegistry, getDefaultRegistry, resetDefaultRegistry } from './registry.js'

// Polyglot analyzer
export { PolyglotAnalyzer, compareResults } from './polyglot-analyzer.js'
export type {
  FlagDetector,
  LanguageRegistry as PolyglotLanguageRegistry,
  FileAnalysisStatus,
  FileAnalysisResult,
  RepositoryAnalysisResult,
  AnalysisProgressCallback,
  FlagOccurrence,
  OccurrenceChange,
  ComparisonResult,
  Language as PolyglotLanguage,
} from './polyglot-analyzer.js'

// All 13 detectors
export {
  GoDetector,
  TypeScriptDetector,
  JavaScriptDetector,
  PythonDetector,
  JavaDetector,
  KotlinDetector,
  SwiftDetector,
  RubyDetector,
  CSharpDetector,
  PHPDetector,
  RustDetector,
  CPPDetector,
  ObjectiveCDetector,
} from './detectors/index.js'

// Helpers
export {
  detectFlagsWithRegex,
  deduplicateFlags,
  extractStringArgument,
  splitArguments,
  buildMethodCallPattern,
  escapeRegExp,
  isValidFlagKey,
  mergeProviders,
  extractMethodNames,
  getDefaultKeyIndex,
} from './helpers.js'

// Config adapter
export {
  convertConfigProviders,
  languageToConfigLanguage,
  loadProvidersForLanguage,
} from './config-adapter.js'

/**
 * Creates a LanguageRegistry pre-loaded with all 13 language detectors.
 * Tier-1 languages (TypeScript, JavaScript, Go, Python) use tree-sitter by default.
 * Non-tier-1 detectors use regex (the per-detector default).
 */
export function createDefaultRegistry(): LanguageRegistry {
  const registry = new LanguageRegistry()
  registry.register(new TypeScriptDetector({ engine: 'tree-sitter' }))
  registry.register(new JavaScriptDetector({ engine: 'tree-sitter' }))
  registry.register(new GoDetector({ engine: 'tree-sitter' }))
  registry.register(new PythonDetector({ engine: 'tree-sitter' }))
  // Non-tier-1 stay regex (default):
  registry.register(new JavaDetector())
  registry.register(new KotlinDetector())
  registry.register(new SwiftDetector())
  registry.register(new RubyDetector())
  registry.register(new CSharpDetector())
  registry.register(new PHPDetector())
  registry.register(new RustDetector())
  registry.register(new CPPDetector())
  registry.register(new ObjectiveCDetector())
  return registry
}

import type { DetectorEngine } from './detectors/typescript.js'

/**
 * Build a registry where every tier-1 detector uses the given engine.
 * Used by the CLI's --engine flag and by the cross-engine smoke test.
 *
 * Other (non-tier-1) detectors always use regex regardless of this setting.
 */
export function createRegistryWithEngine(engine: DetectorEngine): LanguageRegistry {
  const registry = new LanguageRegistry()
  registry.register(new TypeScriptDetector({ engine }))
  registry.register(new JavaScriptDetector({ engine }))
  registry.register(new GoDetector({ engine }))
  registry.register(new PythonDetector({ engine }))
  // Non-tier-1 detectors stay regex:
  registry.register(new JavaDetector())
  registry.register(new KotlinDetector())
  registry.register(new SwiftDetector())
  registry.register(new RubyDetector())
  registry.register(new CSharpDetector())
  registry.register(new PHPDetector())
  registry.register(new RustDetector())
  registry.register(new CPPDetector())
  registry.register(new ObjectiveCDetector())
  return registry
}
