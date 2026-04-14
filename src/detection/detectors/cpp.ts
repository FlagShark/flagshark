/**
 * C/C++ language feature flag detector.
 * Ported from Go: internal/languages/cpp/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class CPPDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultCPPProviders()
  }

  language(): Language {
    return Languages.CPP
  }

  fileExtensions(): string[] {
    return ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h', '.c']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'h', 'c'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultCPPProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly C++ SDK',
      importPattern: 'launchdarkly',
      description: 'LaunchDarkly C/C++ Server SDK',
      enabled: true,
      methods: [
        {
          name: 'BoolVariation',
          flagKeyIndex: 1,
          examples: ['client->BoolVariation(context, "flag-key", false)'],
        },
        {
          name: 'StringVariation',
          flagKeyIndex: 1,
          examples: ['client->StringVariation(context, "flag-key", "default")'],
        },
        {
          name: 'IntVariation',
          flagKeyIndex: 1,
          examples: ['client->IntVariation(context, "flag-key", 0)'],
        },
        {
          name: 'DoubleVariation',
          flagKeyIndex: 1,
          examples: ['client->DoubleVariation(context, "flag-key", 0.0)'],
        },
      ],
    },
    {
      name: 'Unleash C++ SDK',
      importPattern: 'unleash',
      description: 'Unleash C++ Client SDK',
      enabled: true,
      methods: [
        { name: 'isEnabled', flagKeyIndex: 0, examples: ['client->isEnabled("feature-toggle")'] },
        { name: 'getVariant', flagKeyIndex: 0, examples: ['client->getVariant("feature-toggle")'] },
      ],
    },
    {
      name: 'ConfigCat C++ SDK',
      importPattern: 'configcat',
      description: 'ConfigCat C++ SDK',
      enabled: true,
      methods: [
        { name: 'getValue', flagKeyIndex: 0, examples: ['client->getValue("flag-key", false)'] },
      ],
    },
    {
      name: 'GrowthBook C++ SDK',
      importPattern: 'growthbook',
      description: 'GrowthBook C++ SDK',
      enabled: true,
      methods: [
        { name: 'isOn', flagKeyIndex: 0, examples: ['gb->isOn("feature-key")'] },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['gb->getFeatureValue("feature-key", fallbackValue)'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom C/C++ feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")'],
        },
        {
          name: 'is_feature_enabled',
          flagKeyIndex: 0,
          examples: ['is_feature_enabled("feature-name")'],
        },
        { name: 'checkFeature', flagKeyIndex: 0, examples: ['checkFeature("feature-name")'] },
        { name: 'hasFeature', flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] },
      ],
    },
  ]
}
