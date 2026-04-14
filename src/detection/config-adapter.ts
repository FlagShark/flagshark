/**
 * Adapts YAML config providers to language detector FeatureFlagProvider format.
 * Ported from Go: internal/languages/config_adapter.go
 */

import { mergeProviders } from './helpers.js'
import { getProvidersForLanguage } from './yaml-config.js'

import type { FeatureFlagProvider, Language, MethodConfig } from './interface.js'
import type {
  FeatureFlagConfig,
  FeatureFlagProvider as ConfigProvider,
  MethodConfig as ConfigMethodConfig,
  SupportedLanguage,
} from './yaml-config.js'

/** Converts YAML config providers to language detector FeatureFlagProvider format. */
export function convertConfigProviders(providers: ConfigProvider[]): FeatureFlagProvider[] {
  return providers.map((p) => ({
    name: p.name,
    packagePath: p.import_pattern,
    importPattern: p.import_pattern,
    description: p.description,
    enabled: p.enabled,
    methods: convertConfigMethods(p.methods),
  }))
}

function convertConfigMethods(methods: ConfigMethodConfig[]): MethodConfig[] {
  return methods.map((m) => ({
    name: m.name,
    flagKeyIndex: m.flag_key_index,
    contextIndex: m.context_index,
    examples: m.examples,
  }))
}

/** Maps a Language to a SupportedLanguage config enum value. */
export function languageToConfigLanguage(lang: Language): SupportedLanguage {
  const mapping: Record<Language, SupportedLanguage> = {
    go: 'go',
    typescript: 'typescript',
    javascript: 'javascript',
    python: 'python',
    java: 'java',
    kotlin: 'kotlin',
    swift: 'swift',
    ruby: 'ruby',
    csharp: 'csharp',
    php: 'php',
    rust: 'rust',
    cpp: 'cpp',
    objc: 'objc',
  }
  return mapping[lang] ?? 'all'
}

/**
 * Loads providers for a language from YAML config, merging with defaults.
 * Falls back to defaults if no config is available.
 */
export function loadProvidersForLanguage(
  lang: Language,
  defaultProviders: FeatureFlagProvider[],
  config?: FeatureFlagConfig | null,
): FeatureFlagProvider[] {
  if (!config) {
    return defaultProviders
  }

  const configLang = languageToConfigLanguage(lang)
  const configProviders = getProvidersForLanguage(config, configLang)

  if (configProviders.length === 0) {
    return defaultProviders
  }

  return mergeProviders(defaultProviders, convertConfigProviders(configProviders))
}
