/**
 * Rust language feature flag detector.
 * Ported from Go: internal/languages/rust/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class RustDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultRustProviders()
  }

  language(): Language {
    return Languages.Rust
  }

  fileExtensions(): string[] {
    return ['.rs']
  }

  supportsFile(filename: string): boolean {
    return filename.toLowerCase().endsWith('.rs')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultRustProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly Rust SDK',
      importPattern: 'launchdarkly_server_sdk',
      description: 'LaunchDarkly Rust Server SDK',
      enabled: true,
      methods: [
        {
          name: 'bool_variation',
          flagKeyIndex: 1,
          examples: ['client.bool_variation(&context, "flag-key", false)'],
        },
        {
          name: 'string_variation',
          flagKeyIndex: 1,
          examples: ['client.string_variation(&context, "flag-key", "default".to_string())'],
        },
        {
          name: 'int_variation',
          flagKeyIndex: 1,
          examples: ['client.int_variation(&context, "flag-key", 0)'],
        },
        {
          name: 'float_variation',
          flagKeyIndex: 1,
          examples: ['client.float_variation(&context, "flag-key", 0.0)'],
        },
      ],
    },
    {
      name: 'Unleash Rust SDK',
      importPattern: 'unleash_api_client',
      description: 'Unleash Rust SDK',
      enabled: true,
      methods: [
        {
          name: 'is_enabled',
          flagKeyIndex: 0,
          examples: ['client.is_enabled("feature-toggle", None, false)'],
        },
        {
          name: 'get_variant',
          flagKeyIndex: 0,
          examples: ['client.get_variant("feature-toggle", None)'],
        },
      ],
    },
    {
      name: 'Flagsmith Rust SDK',
      importPattern: 'flagsmith',
      description: 'Flagsmith Rust SDK',
      enabled: true,
      methods: [
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['flags.is_feature_enabled("feature-name")'],
        },
        {
          name: 'get_feature_value',
          flagKeyIndex: 0,
          examples: ['flags.get_feature_value("feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat Rust SDK',
      importPattern: 'configcat',
      description: 'ConfigCat Rust SDK',
      enabled: true,
      methods: [
        {
          name: 'get_value',
          flagKeyIndex: 0,
          examples: ['client.get_value("flag-key", false, None).await'],
        },
      ],
    },
    {
      name: 'GrowthBook Rust SDK',
      importPattern: 'growthbook',
      description: 'GrowthBook Rust SDK',
      enabled: true,
      methods: [
        { name: 'is_on', flagKeyIndex: 0, examples: ['gb.is_on("feature-key")'] },
        {
          name: 'get_feature_value',
          flagKeyIndex: 0,
          examples: ['gb.get_feature_value("feature-key", fallback_value)'],
        },
      ],
    },
    {
      name: 'Eppo Rust SDK',
      importPattern: 'eppo',
      description: 'Eppo Rust SDK',
      enabled: true,
      methods: [
        {
          name: 'get_boolean_assignment',
          flagKeyIndex: 0,
          examples: [
            'eppo_client.get_boolean_assignment("flag-key", &subject_key, &subject_attributes, default_value)',
          ],
        },
        {
          name: 'get_string_assignment',
          flagKeyIndex: 0,
          examples: [
            'eppo_client.get_string_assignment("flag-key", &subject_key, &subject_attributes, default_value)',
          ],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom Rust feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['is_feature_enabled("feature-name")'],
        },
        { name: 'feature_enabled', flagKeyIndex: 0, examples: ['feature_enabled("feature-name")'] },
        { name: 'has_feature', flagKeyIndex: 0, examples: ['has_feature("feature-name")'] },
      ],
    },
  ]
}
