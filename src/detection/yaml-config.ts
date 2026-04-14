/**
 * YAML Config -- .flagshark.yml config file parsing with Zod validation.
 * Ported from Go: internal/config/flagconfig.go + internal/processor/yaml_config_integration.go
 */

import { z } from 'zod'

// -- Zod schemas --

export const SupportedLanguageSchema = z.enum([
  'go',
  'typescript',
  'javascript',
  'python',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'csharp',
  'php',
  'rust',
  'cpp',
  'objc',
  'all',
])

export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>

export const ValidReturnTypes = ['boolean', 'string', 'integer', 'float', 'json'] as const

export const MethodConfigSchema = z.object({
  name: z.string().min(1, 'name is required'),
  flag_key_index: z.number().int().min(-1).default(0),
  context_index: z.number().int().optional().default(0),
  min_params: z.number().int().nonnegative().optional().default(0),
  examples: z.array(z.string()).optional().default([]),
  return_type: z
    .enum(['', ...ValidReturnTypes])
    .optional()
    .default(''),
  default_value_index: z.number().int().nonnegative().optional().default(0),
})

export type MethodConfig = z.infer<typeof MethodConfigSchema>

export const FeatureFlagProviderSchema = z.object({
  name: z.string().min(1, 'name is required'),
  languages: z.array(SupportedLanguageSchema).optional().default([]),
  import_pattern: z.string().default(''),
  methods: z.array(MethodConfigSchema).min(1, 'at least one method must be configured'),
  import_aliases: z.array(z.string()).optional().default([]),
  description: z.string().optional().default(''),
  enabled: z.boolean().default(true),
})

export type FeatureFlagProvider = z.infer<typeof FeatureFlagProviderSchema>

export const GlobalConfigSchema = z.object({
  enable_fallback_detection: z.boolean().default(false),
  strict_import_matching: z.boolean().default(false),
  custom_patterns: z.array(z.string()).optional().default([]),
})

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>

export const FeatureFlagConfigSchema = z.object({
  version: z.string().min(1, 'version is required'),
  providers: z.array(FeatureFlagProviderSchema).min(1, 'at least one provider must be configured'),
  global_settings: GlobalConfigSchema.optional().default({
    enable_fallback_detection: false,
    strict_import_matching: false,
    custom_patterns: [],
  }),
})

export type FeatureFlagConfig = z.infer<typeof FeatureFlagConfigSchema>

// -- Tree-sitter adapter types (matches Go's adapter.go) --

export interface TreeSitterFeatureFlagConfig {
  packagePath: string
  interfaceName: string
  methodNames: string[]
  keyParameterIndex: number
}

// -- Functions --

/**
 * Parses and validates a raw YAML config object (already parsed from YAML string).
 * Returns a validated FeatureFlagConfig or throws a ZodError.
 */
export function parseConfig(raw: unknown): FeatureFlagConfig {
  return FeatureFlagConfigSchema.parse(raw)
}

/**
 * Safely parses a raw config object, returning success/error result.
 */
export function safeParseConfig(raw: unknown) {
  return FeatureFlagConfigSchema.safeParse(raw)
}

/** Returns the effective return type for a method, defaulting to "boolean". */
export function getMethodReturnType(method: MethodConfig): string {
  return method.return_type || 'boolean'
}

/** Returns the effective default value index (-1 when unset). */
export function getMethodDefaultValueIndex(method: MethodConfig): number {
  if ((method.default_value_index ?? 0) === 0 && !method.return_type) {
    return -1
  }
  return method.default_value_index ?? 0
}

/** Checks if a provider applies to a given language. */
export function providerAppliesToLanguage(
  provider: FeatureFlagProvider,
  lang: SupportedLanguage,
): boolean {
  if (provider.languages.length === 0) {
    return true
  }
  return provider.languages.includes('all') || provider.languages.includes(lang)
}

/** Returns only the enabled providers from a config. */
export function getEnabledProviders(config: FeatureFlagConfig): FeatureFlagProvider[] {
  return config.providers.filter((p) => p.enabled)
}

/** Returns enabled providers for a specific language. */
export function getProvidersForLanguage(
  config: FeatureFlagConfig,
  lang: SupportedLanguage,
): FeatureFlagProvider[] {
  return config.providers.filter((p) => p.enabled && providerAppliesToLanguage(p, lang))
}

/** Converts a FeatureFlagConfig to tree-sitter configs. */
export function toTreeSitterConfigs(config: FeatureFlagConfig): TreeSitterFeatureFlagConfig[] {
  const configs: TreeSitterFeatureFlagConfig[] = []

  for (const provider of getEnabledProviders(config)) {
    for (const method of provider.methods) {
      if (method.flag_key_index < 0) {
        continue
      }

      configs.push({
        packagePath: provider.import_pattern,
        interfaceName: provider.name,
        methodNames: [method.name],
        keyParameterIndex: method.flag_key_index,
      })
    }
  }

  return configs
}

/** Converts config to tree-sitter configs for a specific language. */
export function toTreeSitterConfigsForLanguage(
  config: FeatureFlagConfig,
  lang: SupportedLanguage,
): TreeSitterFeatureFlagConfig[] {
  const configs: TreeSitterFeatureFlagConfig[] = []

  for (const provider of getProvidersForLanguage(config, lang)) {
    for (const method of provider.methods) {
      if (method.flag_key_index < 0) {
        continue
      }

      configs.push({
        packagePath: provider.import_pattern,
        interfaceName: provider.name,
        methodNames: [method.name],
        keyParameterIndex: method.flag_key_index,
      })
    }
  }

  return configs
}

/** Merges new providers into an existing config (mutates). */
export function mergeProviders(
  config: FeatureFlagConfig,
  newProviders: FeatureFlagProvider[],
): void {
  const existing = new Map<string, number>()
  for (let i = 0; i < config.providers.length; i++) {
    existing.set(config.providers[i].import_pattern, i)
  }

  for (const newProvider of newProviders) {
    const idx = existing.get(newProvider.import_pattern)
    if (idx !== undefined) {
      config.providers[idx] = newProvider
    } else {
      config.providers.push(newProvider)
    }
  }
}

/**
 * Lints a config for potential misconfigurations.
 * Returns non-fatal warnings (unlike parse which throws on errors).
 */
export function lintConfig(config: FeatureFlagConfig): string[] {
  const warnings: string[] = []

  const nonBooleanHints: Record<string, string> = {
    string: 'string',
    int: 'integer',
    float: 'float',
    double: 'float',
    json: 'json',
    variant: 'string',
    value: 'string',
    payload: 'json',
    config: 'json',
  }

  for (const provider of config.providers) {
    if (!provider.enabled) {
      continue
    }
    for (const method of provider.methods) {
      if (method.flag_key_index < 0) {
        continue
      }
      if (method.return_type) {
        continue
      }

      const nameLower = method.name.toLowerCase()

      // Skip clearly boolean methods
      if (
        nameLower.includes('enabled') ||
        nameLower.includes('isbool') ||
        nameLower.startsWith('is_') ||
        (nameLower.startsWith('is') &&
          method.name.length > 2 &&
          method.name[2] >= 'A' &&
          method.name[2] <= 'Z')
      ) {
        continue
      }

      for (const [hint, expectedType] of Object.entries(nonBooleanHints)) {
        if (nameLower.includes(hint)) {
          warnings.push(
            `${provider.name}: method "${method.name}" may return ${expectedType} but has no return_type set (defaults to boolean)`,
          )
          break
        }
      }
    }
  }

  return warnings
}

/**
 * Known config file locations to search for auto-detection.
 */
export const CONFIG_FILE_LOCATIONS = [
  '.flagshark.yaml',
  '.flagshark.yml',
  'flagshark.yaml',
  'flagshark.yml',
  '.github/flagshark.yaml',
  '.github/flagshark.yml',
  'config/flagshark.yaml',
  'config/flagshark.yml',
  '.config/flagshark.yaml',
  '.config/flagshark.yml',
] as const
