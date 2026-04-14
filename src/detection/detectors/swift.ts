/**
 * Swift language feature flag detector.
 * Ported from Go: internal/languages/swift/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class SwiftDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultSwiftProviders()
  }

  language(): Language {
    return Languages.Swift
  }

  fileExtensions(): string[] {
    return ['.swift']
  }

  supportsFile(filename: string): boolean {
    return filename.toLowerCase().endsWith('.swift')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultSwiftProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly iOS SDK',
      importPattern: 'LaunchDarkly',
      description: 'LaunchDarkly iOS/macOS/tvOS SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['LDClient.get()!.variation(forKey: "flag-key", defaultValue: false)'],
        },
        {
          name: 'boolVariation',
          flagKeyIndex: 0,
          examples: ['client.boolVariation(forKey: "flag-key", defaultValue: false)'],
        },
        {
          name: 'stringVariation',
          flagKeyIndex: 0,
          examples: ['client.stringVariation(forKey: "flag-key", defaultValue: "")'],
        },
      ],
    },
    {
      name: 'Unleash iOS SDK',
      importPattern: 'UnleashProxyClientSwift',
      description: 'Unleash iOS SDK',
      enabled: true,
      methods: [
        {
          name: 'isEnabled',
          flagKeyIndex: 0,
          examples: ['unleash.isEnabled(name: "feature-toggle")'],
        },
        {
          name: 'getVariant',
          flagKeyIndex: 0,
          examples: ['unleash.getVariant(name: "feature-toggle")'],
        },
      ],
    },
    {
      name: 'Split.io iOS SDK',
      importPattern: 'Split',
      description: 'Split.io iOS SDK',
      enabled: true,
      methods: [
        { name: 'getTreatment', flagKeyIndex: 0, examples: ['client.getTreatment("split-name")'] },
      ],
    },
    {
      name: 'Optimizely iOS SDK',
      importPattern: 'Optimizely',
      description: 'Optimizely Feature Experimentation iOS SDK',
      enabled: true,
      methods: [
        { name: 'decide', flagKeyIndex: 0, examples: ['user.decide(key: "flag-key")'] },
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['optimizely.isFeatureEnabled(featureKey: "feature-key", userId: userId)'],
        },
      ],
    },
    {
      name: 'Flagsmith iOS SDK',
      importPattern: 'FlagsmithClient',
      description: 'Flagsmith iOS SDK',
      enabled: true,
      methods: [
        {
          name: 'hasFeatureFlag',
          flagKeyIndex: 0,
          examples: ['Flagsmith.shared.hasFeatureFlag(withID: "feature-name")'],
        },
        {
          name: 'getValueForFeature',
          flagKeyIndex: 0,
          examples: ['Flagsmith.shared.getValueForFeature(withID: "feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat iOS SDK',
      importPattern: 'ConfigCat',
      description: 'ConfigCat iOS SDK',
      enabled: true,
      methods: [
        {
          name: 'getValue',
          flagKeyIndex: 0,
          examples: ['client.getValue(for: "flag-key", defaultValue: false)'],
        },
      ],
    },
    {
      name: 'Statsig iOS SDK',
      importPattern: 'StatsigOnDeviceEvaluations',
      description: 'Statsig iOS/Swift SDK',
      enabled: true,
      methods: [
        { name: 'checkGate', flagKeyIndex: 0, examples: ['statsig.checkGate("gate-name")'] },
        {
          name: 'getExperiment',
          flagKeyIndex: 0,
          examples: ['statsig.getExperiment("experiment-name")'],
        },
        { name: 'getConfig', flagKeyIndex: 0, examples: ['statsig.getConfig("config-name")'] },
      ],
    },
    {
      name: 'GrowthBook iOS SDK',
      importPattern: 'GrowthBook',
      description: 'GrowthBook iOS/Swift SDK',
      enabled: true,
      methods: [
        { name: 'isOn', flagKeyIndex: 0, examples: ['gb.isOn(feature: "feature-key")'] },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['gb.getFeatureValue(feature: "feature-key", default: JSON("blue"))'],
        },
      ],
    },
    {
      name: 'DevCycle iOS SDK',
      importPattern: 'DevCycle',
      description: 'DevCycle iOS/Swift SDK',
      enabled: true,
      methods: [
        {
          name: 'variableValue',
          flagKeyIndex: 0,
          examples: ['client.variableValue(key: "variable-key", defaultValue: false)'],
        },
        { name: 'variable', flagKeyIndex: 0, examples: ['client.variable(key: "variable-key")'] },
      ],
    },
    {
      name: 'Eppo iOS SDK',
      importPattern: 'EppoClient',
      description: 'Eppo iOS/Swift SDK',
      enabled: true,
      methods: [
        {
          name: 'getBoolAssignment',
          flagKeyIndex: 0,
          examples: [
            'eppoClient.getBoolAssignment(flagKey: "flag-key", subjectKey: subjectKey, defaultValue: false)',
          ],
        },
        {
          name: 'getStringAssignment',
          flagKeyIndex: 0,
          examples: [
            'eppoClient.getStringAssignment(flagKey: "flag-key", subjectKey: subjectKey, defaultValue: "")',
          ],
        },
      ],
    },
    {
      name: 'PostHog iOS SDK',
      importPattern: 'PostHog',
      description: 'PostHog iOS/Swift SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['PostHogSDK.shared.isFeatureEnabled("flag-key")'],
        },
        {
          name: 'getFeatureFlag',
          flagKeyIndex: 0,
          examples: ['PostHogSDK.shared.getFeatureFlag("flag-key")'],
        },
        {
          name: 'getFeatureFlagPayload',
          flagKeyIndex: 0,
          examples: ['PostHogSDK.shared.getFeatureFlagPayload("flag-key")'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom Swift feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")'],
        },
        { name: 'checkFeature', flagKeyIndex: 0, examples: ['checkFeature("feature-name")'] },
        { name: 'hasFeature', flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] },
      ],
    },
  ]
}
