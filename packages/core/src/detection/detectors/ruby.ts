/**
 * Ruby language feature flag detector.
 * Ported from Go: internal/languages/ruby/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class RubyDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultRubyProviders()
  }

  language(): Language {
    return Languages.Ruby
  }

  fileExtensions(): string[] {
    return ['.rb', '.rake', '.gemspec']
  }

  supportsFile(filename: string): boolean {
    const lower = filename.toLowerCase()
    const ext = lower.split('.').pop()
    if (['rb', 'rake', 'gemspec'].includes(ext ?? '')) {
      return true
    }
    // Also check for Rakefile, Gemfile, etc.
    const baseName = lower.split('/').pop() ?? ''
    return baseName === 'rakefile' || baseName === 'gemfile'
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultRubyProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly Ruby SDK',
      importPattern: 'launchdarkly-server-sdk',
      description: 'LaunchDarkly Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", context, default_value)'],
        },
        {
          name: 'variation_detail',
          flagKeyIndex: 0,
          examples: ['client.variation_detail("flag-key", context, default_value)'],
        },
      ],
    },
    {
      name: 'Unleash Ruby SDK',
      importPattern: 'unleash',
      description: 'Unleash Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'is_enabled?',
          flagKeyIndex: 0,
          examples: ['UNLEASH.is_enabled?("feature-toggle")'],
        },
        {
          name: 'enabled?',
          flagKeyIndex: 0,
          examples: ['UNLEASH.enabled?("feature-toggle", context)'],
        },
        {
          name: 'get_variant',
          flagKeyIndex: 0,
          examples: ['UNLEASH.get_variant("feature-toggle", context)'],
        },
      ],
    },
    {
      name: 'Split.io Ruby SDK',
      importPattern: 'splitclient-rb',
      description: 'Split.io Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'get_treatment',
          flagKeyIndex: 1,
          examples: ['client.get_treatment(key, "split-name")'],
        },
        {
          name: 'get_treatments',
          flagKeyIndex: 1,
          examples: ['client.get_treatments(key, ["split1", "split2"])'],
        },
      ],
    },
    {
      name: 'Flipper',
      importPattern: 'flipper',
      description: 'Flipper feature flags for Ruby',
      enabled: true,
      methods: [
        { name: 'enabled?', flagKeyIndex: 0, examples: ['Flipper.enabled?(:feature_name)'] },
        { name: 'disabled?', flagKeyIndex: 0, examples: ['Flipper.disabled?(:feature_name)'] },
      ],
    },
    {
      name: 'Optimizely Ruby SDK',
      importPattern: 'optimizely-sdk',
      description: 'Optimizely Feature Experimentation Ruby SDK',
      enabled: true,
      methods: [
        { name: 'decide', flagKeyIndex: 0, examples: ['user.decide("flag-key")'] },
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['optimizely.is_feature_enabled("feature-key", user_id)'],
        },
      ],
    },
    {
      name: 'Flagsmith Ruby SDK',
      importPattern: 'flagsmith',
      description: 'Flagsmith Ruby SDK',
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
      name: 'ConfigCat Ruby SDK',
      importPattern: 'configcat',
      description: 'ConfigCat Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'get_value',
          flagKeyIndex: 0,
          examples: ['client.get_value("flag-key", default_value)'],
        },
      ],
    },
    {
      name: 'Statsig Ruby SDK',
      importPattern: 'statsig',
      description: 'Statsig Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'check_gate',
          flagKeyIndex: 1,
          examples: ['Statsig.check_gate(user, "gate-name")'],
        },
        {
          name: 'get_experiment',
          flagKeyIndex: 1,
          examples: ['Statsig.get_experiment(user, "experiment-name")'],
        },
        {
          name: 'get_config',
          flagKeyIndex: 1,
          examples: ['Statsig.get_config(user, "config-name")'],
        },
      ],
    },
    {
      name: 'GrowthBook Ruby SDK',
      importPattern: 'growthbook',
      description: 'GrowthBook Ruby SDK',
      enabled: true,
      methods: [
        { name: 'on?', flagKeyIndex: 0, examples: ['gb.on?(:feature_key)'] },
        {
          name: 'feature_value',
          flagKeyIndex: 0,
          examples: ['gb.feature_value(:feature_key, fallback_value)'],
        },
      ],
    },
    {
      name: 'DevCycle Ruby SDK',
      importPattern: 'devcycle-ruby-server-sdk',
      description: 'DevCycle Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'variable_value',
          flagKeyIndex: 1,
          examples: ['client.variable_value(user, "variable-key", default_value)'],
        },
        { name: 'variable', flagKeyIndex: 1, examples: ['client.variable(user, "variable-key")'] },
      ],
    },
    {
      name: 'Eppo Ruby SDK',
      importPattern: 'eppo_client',
      description: 'Eppo Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'get_boolean_assignment',
          flagKeyIndex: 0,
          examples: ['eppo_client.get_boolean_assignment("flag-key", subject_key, default_value)'],
        },
        {
          name: 'get_string_assignment',
          flagKeyIndex: 0,
          examples: ['eppo_client.get_string_assignment("flag-key", subject_key, default_value)'],
        },
      ],
    },
    {
      name: 'PostHog Ruby SDK',
      importPattern: 'posthog-ruby',
      description: 'PostHog Ruby SDK',
      enabled: true,
      methods: [
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['posthog.is_feature_enabled("flag-key", distinct_id)'],
        },
        {
          name: 'get_feature_flag',
          flagKeyIndex: 0,
          examples: ['posthog.get_feature_flag("flag-key", distinct_id)'],
        },
        {
          name: 'get_feature_flag_payload',
          flagKeyIndex: 0,
          examples: ['posthog.get_feature_flag_payload("flag-key", distinct_id)'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom Ruby feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'feature_enabled?',
          flagKeyIndex: 0,
          examples: ['feature_enabled?("feature-name")'],
        },
        { name: 'enabled?', flagKeyIndex: 0, examples: ['enabled?("feature-name")'] },
        { name: 'has_feature?', flagKeyIndex: 0, examples: ['has_feature?("feature-name")'] },
      ],
    },
  ]
}
