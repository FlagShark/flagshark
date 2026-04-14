/**
 * PHP language feature flag detector.
 * Ported from Go: internal/languages/php/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class PHPDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultPHPProviders()
  }

  language(): Language {
    return Languages.PHP
  }

  fileExtensions(): string[] {
    return ['.php', '.phtml', '.php3', '.php4', '.php5', '.phps']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['php', 'phtml', 'php3', 'php4', 'php5', 'phps'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultPHPProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly PHP SDK',
      importPattern: 'LaunchDarkly\\',
      description: 'LaunchDarkly PHP SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['$client->variation("flag-key", $context, false)'],
        },
        {
          name: 'boolVariation',
          flagKeyIndex: 0,
          examples: ['$client->boolVariation("flag-key", $context, false)'],
        },
        {
          name: 'stringVariation',
          flagKeyIndex: 0,
          examples: ['$client->stringVariation("flag-key", $context, "default")'],
        },
        {
          name: 'intVariation',
          flagKeyIndex: 0,
          examples: ['$client->intVariation("flag-key", $context, 0)'],
        },
        {
          name: 'floatVariation',
          flagKeyIndex: 0,
          examples: ['$client->floatVariation("flag-key", $context, 0.0)'],
        },
        {
          name: 'jsonVariation',
          flagKeyIndex: 0,
          examples: ['$client->jsonVariation("flag-key", $context, [])'],
        },
      ],
    },
    {
      name: 'Unleash PHP SDK',
      importPattern: 'Unleash\\Client',
      description: 'Unleash PHP SDK',
      enabled: true,
      methods: [
        { name: 'isEnabled', flagKeyIndex: 0, examples: ['$unleash->isEnabled("feature-toggle")'] },
        {
          name: 'getVariant',
          flagKeyIndex: 0,
          examples: ['$unleash->getVariant("feature-toggle")'],
        },
      ],
    },
    {
      name: 'Split.io PHP SDK',
      importPattern: 'SplitIO\\',
      description: 'Split.io PHP SDK',
      enabled: true,
      methods: [
        {
          name: 'getTreatment',
          flagKeyIndex: 1,
          examples: ['$client->getTreatment($key, "split-name")'],
        },
        {
          name: 'getTreatments',
          flagKeyIndex: 1,
          examples: ['$client->getTreatments($key, ["split1", "split2"])'],
        },
      ],
    },
    {
      name: 'Flagsmith PHP SDK',
      importPattern: 'Flagsmith\\',
      description: 'Flagsmith PHP SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['$flags->isFeatureEnabled("feature-name")'],
        },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['$flags->getFeatureValue("feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat PHP SDK',
      importPattern: 'ConfigCat\\',
      description: 'ConfigCat PHP SDK',
      enabled: true,
      methods: [
        { name: 'getValue', flagKeyIndex: 0, examples: ['$client->getValue("flag-key", false)'] },
      ],
    },
    {
      name: 'Statsig PHP SDK',
      importPattern: 'Statsig\\',
      description: 'Statsig PHP SDK',
      enabled: true,
      methods: [
        {
          name: 'checkGate',
          flagKeyIndex: 1,
          examples: ['Statsig::checkGate($user, "gate-name")'],
        },
        {
          name: 'getExperiment',
          flagKeyIndex: 1,
          examples: ['Statsig::getExperiment($user, "experiment-name")'],
        },
        {
          name: 'getConfig',
          flagKeyIndex: 1,
          examples: ['Statsig::getConfig($user, "config-name")'],
        },
      ],
    },
    {
      name: 'GrowthBook PHP SDK',
      importPattern: 'Growthbook\\',
      description: 'GrowthBook PHP SDK',
      enabled: true,
      methods: [
        { name: 'isOn', flagKeyIndex: 0, examples: ['$gb->isOn("feature-key")'] },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['$gb->getFeatureValue("feature-key", $fallbackValue)'],
        },
      ],
    },
    {
      name: 'PostHog PHP SDK',
      importPattern: 'PostHog\\',
      description: 'PostHog PHP SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['PostHog::isFeatureEnabled("flag-key", $distinctId)'],
        },
        {
          name: 'getFeatureFlag',
          flagKeyIndex: 0,
          examples: ['PostHog::getFeatureFlag("flag-key", $distinctId)'],
        },
      ],
    },
    {
      name: 'Laravel Pennant',
      importPattern: 'Laravel\\Pennant',
      description: 'Laravel Pennant feature flags',
      enabled: true,
      methods: [
        { name: 'active', flagKeyIndex: 0, examples: ['Feature::active("feature-name")'] },
        { name: 'inactive', flagKeyIndex: 0, examples: ['Feature::inactive("feature-name")'] },
        { name: 'value', flagKeyIndex: 0, examples: ['Feature::value("feature-name")'] },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom PHP feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")'],
        },
        { name: 'feature_enabled', flagKeyIndex: 0, examples: ['feature_enabled("feature-name")'] },
        { name: 'hasFeature', flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] },
      ],
    },
  ]
}
