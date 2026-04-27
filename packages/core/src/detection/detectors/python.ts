/**
 * Python language feature flag detector.
 * Ported from Go: internal/languages/python/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class PythonDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultPythonProviders()
  }

  language(): Language {
    return Languages.Python
  }

  fileExtensions(): string[] {
    return ['.py', '.pyw', '.pyx', '.pyi']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['py', 'pyw', 'pyx', 'pyi'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultPythonProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly Python SDK',
      importPattern: 'ldclient',
      description: 'LaunchDarkly Python SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", user, default_value)'],
        },
        {
          name: 'bool_variation',
          flagKeyIndex: 0,
          examples: ['client.bool_variation("flag-key", user, False)'],
        },
      ],
    },
    {
      name: 'Unleash Python SDK',
      importPattern: 'UnleashClient',
      description: 'Unleash Python SDK',
      enabled: true,
      methods: [
        { name: 'is_enabled', flagKeyIndex: 0, examples: ['unleash.is_enabled("feature-toggle")'] },
        {
          name: 'get_variant',
          flagKeyIndex: 0,
          examples: ['unleash.get_variant("feature-toggle")'],
        },
      ],
    },
    {
      name: 'Split.io Python SDK',
      importPattern: 'splitio',
      description: 'Split.io Python SDK',
      enabled: true,
      methods: [
        {
          name: 'get_treatment',
          flagKeyIndex: 1,
          examples: ['client.get_treatment(key, "split-name")'],
        },
      ],
    },
    {
      name: 'Flipt Python SDK',
      importPattern: 'flipt',
      description: 'Flipt Python SDK',
      enabled: true,
      methods: [
        {
          name: 'evaluate_boolean',
          flagKeyIndex: 0,
          examples: ['flipt.evaluate_boolean("flag-key", entity_id)'],
        },
        {
          name: 'evaluate_variant',
          flagKeyIndex: 0,
          examples: ['flipt.evaluate_variant("flag-key", entity_id)'],
        },
      ],
    },
    {
      name: 'Django Feature Flags',
      importPattern: 'django_feature_flags',
      description: 'Django feature flags',
      enabled: true,
      methods: [
        { name: 'flag_enabled', flagKeyIndex: 0, examples: ['flag_enabled("feature-name")'] },
        { name: 'flag_disabled', flagKeyIndex: 0, examples: ['flag_disabled("feature-name")'] },
      ],
    },
    {
      name: 'Optimizely Python SDK',
      importPattern: 'optimizely',
      description: 'Optimizely Feature Experimentation Python SDK',
      enabled: true,
      methods: [
        { name: 'decide', flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: 'decide_for_keys',
          flagKeyIndex: 0,
          examples: ['user.decide_for_keys(["flag-key-1", "flag-key-2"], options)'],
        },
        { name: 'decide_all', flagKeyIndex: 0, examples: ['user.decide_all(options)'] },
      ],
    },
    {
      name: 'Flagsmith Python SDK',
      importPattern: 'flagsmith',
      description: 'Flagsmith Python SDK',
      enabled: true,
      methods: [
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['identity_flags.is_feature_enabled("feature-name")'],
        },
        {
          name: 'get_feature_value',
          flagKeyIndex: 0,
          examples: ['identity_flags.get_feature_value("feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat Python SDK',
      importPattern: 'configcatclient',
      description: 'ConfigCat Python SDK',
      enabled: true,
      methods: [
        {
          name: 'get_value',
          flagKeyIndex: 0,
          examples: ['client.get_value("flag-key", default_value)'],
        },
        {
          name: 'get_value_details',
          flagKeyIndex: 0,
          examples: ['client.get_value_details("flag-key", default_value)'],
        },
      ],
    },
    {
      name: 'Statsig Python SDK',
      importPattern: 'statsig',
      description: 'Statsig Python SDK',
      enabled: true,
      methods: [
        {
          name: 'check_gate',
          flagKeyIndex: 1,
          examples: ['statsig.check_gate(user, "gate-name")'],
        },
        {
          name: 'get_experiment',
          flagKeyIndex: 1,
          examples: ['statsig.get_experiment(user, "experiment-name")'],
        },
        {
          name: 'get_config',
          flagKeyIndex: 1,
          examples: ['statsig.get_config(user, "config-name")'],
        },
      ],
    },
    {
      name: 'GrowthBook Python SDK',
      importPattern: 'growthbook',
      description: 'GrowthBook Python SDK',
      enabled: true,
      methods: [
        { name: 'is_on', flagKeyIndex: 0, examples: ['gb.is_on("feature-key")'] },
        {
          name: 'get_feature_value',
          flagKeyIndex: 0,
          examples: ['gb.get_feature_value("feature-key", fallback_value)'],
        },
        { name: 'eval_feature', flagKeyIndex: 0, examples: ['gb.eval_feature("feature-key")'] },
      ],
    },
    {
      name: 'DevCycle Python SDK',
      importPattern: 'devcycle_python_sdk',
      description: 'DevCycle Python SDK',
      enabled: true,
      methods: [
        {
          name: 'variable_value',
          flagKeyIndex: 1,
          examples: ['client.variable_value(user, "variable-key", default_value)'],
        },
        {
          name: 'variable',
          flagKeyIndex: 1,
          examples: ['client.variable(user, "variable-key", default_value)'],
        },
      ],
    },
    {
      name: 'Eppo Python SDK',
      importPattern: 'eppo_client',
      description: 'Eppo Python SDK',
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
        {
          name: 'get_numeric_assignment',
          flagKeyIndex: 0,
          examples: ['eppo_client.get_numeric_assignment("flag-key", subject_key, default_value)'],
        },
        {
          name: 'get_json_assignment',
          flagKeyIndex: 0,
          examples: ['eppo_client.get_json_assignment("flag-key", subject_key, default_value)'],
        },
      ],
    },
    {
      name: 'PostHog Python SDK',
      importPattern: 'posthog',
      description: 'PostHog Python SDK',
      enabled: true,
      methods: [
        {
          name: 'feature_enabled',
          flagKeyIndex: 0,
          examples: ['posthog.feature_enabled("flag-key", distinct_id)'],
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
        {
          name: 'get_all_flags',
          flagKeyIndex: 0,
          examples: ['posthog.get_all_flags(distinct_id)'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom Python feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['is_feature_enabled("feature-name")'],
        },
        { name: 'feature_flag', flagKeyIndex: 0, examples: ['feature_flag("feature-name")'] },
        { name: 'has_feature', flagKeyIndex: 0, examples: ['has_feature("feature-name")'] },
        { name: 'check_feature', flagKeyIndex: 0, examples: ['check_feature("feature-name")'] },
      ],
    },
  ]
}
