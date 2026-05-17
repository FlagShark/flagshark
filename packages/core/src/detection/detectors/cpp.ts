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
    const lower = filename.toLowerCase()
    const dotIdx = lower.lastIndexOf('.')
    if (dotIdx === -1) return false
    const ext = lower.slice(dotIdx + 1)
    return ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'h', 'c'].includes(ext)
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
      // Server SDK takes a Context as the first argument, then the flag key:
      //   client->BoolVariation(context, "flag-key", false)
      // Client SDK omits the context (one client = one context), so the flag
      // is at index 0:
      //   client->BoolVariation("flag-key", false)
      // The two have to be separate providers with distinct importPattern
      // values, otherwise a single `flagKeyIndex` would silently extract the
      // wrong arg for whichever SDK didn't match. Pre-split, customers using
      // the Client SDK got the default-value string reported as a flag (a
      // false positive that polluted staleness output).
      name: 'LaunchDarkly C++ Server SDK',
      importPattern: 'launchdarkly/server_side',
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
        {
          name: 'JsonVariation',
          flagKeyIndex: 1,
          examples: ['client->JsonVariation(context, "flag-key", Value::Null())'],
        },
      ],
    },
    {
      name: 'LaunchDarkly C++ Client SDK',
      importPattern: 'launchdarkly/client_side',
      description: 'LaunchDarkly C/C++ Client SDK (single-context)',
      enabled: true,
      methods: [
        {
          name: 'BoolVariation',
          flagKeyIndex: 0,
          examples: ['client->BoolVariation("flag-key", false)'],
        },
        {
          name: 'StringVariation',
          flagKeyIndex: 0,
          examples: ['client->StringVariation("flag-key", "default")'],
        },
        {
          name: 'IntVariation',
          flagKeyIndex: 0,
          examples: ['client->IntVariation("flag-key", 0)'],
        },
        {
          name: 'DoubleVariation',
          flagKeyIndex: 0,
          examples: ['client->DoubleVariation("flag-key", 0.0)'],
        },
        {
          name: 'JsonVariation',
          flagKeyIndex: 0,
          examples: ['client->JsonVariation("flag-key", Value::Null())'],
        },
        {
          name: 'BoolVariationDetail',
          flagKeyIndex: 0,
          examples: ['client->BoolVariationDetail("flag-key", false)'],
        },
        {
          name: 'StringVariationDetail',
          flagKeyIndex: 0,
          examples: ['client->StringVariationDetail("flag-key", "default")'],
        },
        {
          name: 'IntVariationDetail',
          flagKeyIndex: 0,
          examples: ['client->IntVariationDetail("flag-key", 0)'],
        },
        {
          name: 'DoubleVariationDetail',
          flagKeyIndex: 0,
          examples: ['client->DoubleVariationDetail("flag-key", 0.0)'],
        },
        {
          name: 'JsonVariationDetail',
          flagKeyIndex: 0,
          examples: ['client->JsonVariationDetail("flag-key", Value::Null())'],
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
