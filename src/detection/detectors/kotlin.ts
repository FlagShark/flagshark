/**
 * Kotlin language feature flag detector.
 * Ported from Go: internal/languages/kotlin/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class KotlinDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultKotlinProviders()
  }

  language(): Language {
    return Languages.Kotlin
  }

  fileExtensions(): string[] {
    return ['.kt', '.kts']
  }

  supportsFile(filename: string): boolean {
    const lower = filename.toLowerCase()
    return lower.endsWith('.kt') || lower.endsWith('.kts')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultKotlinProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly Kotlin SDK',
      importPattern: 'com.launchdarkly.sdk',
      description: 'LaunchDarkly Kotlin/Android SDK',
      enabled: true,
      methods: [
        {
          name: 'boolVariation',
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", context, false)'],
        },
        {
          name: 'stringVariation',
          flagKeyIndex: 0,
          examples: ['client.stringVariation("flag-key", context, "default")'],
        },
        {
          name: 'intVariation',
          flagKeyIndex: 0,
          examples: ['client.intVariation("flag-key", context, 0)'],
        },
      ],
    },
    {
      name: 'Unleash Kotlin SDK',
      importPattern: 'io.getunleash',
      description: 'Unleash Kotlin/Android SDK',
      enabled: true,
      methods: [
        { name: 'isEnabled', flagKeyIndex: 0, examples: ['unleash.isEnabled("feature-toggle")'] },
        { name: 'getVariant', flagKeyIndex: 0, examples: ['unleash.getVariant("feature-toggle")'] },
      ],
    },
    {
      name: 'Split.io Kotlin SDK',
      importPattern: 'io.split.android',
      description: 'Split.io Android/Kotlin SDK',
      enabled: true,
      methods: [
        { name: 'getTreatment', flagKeyIndex: 0, examples: ['client.getTreatment("split-name")'] },
      ],
    },
    {
      name: 'Flipt Kotlin SDK',
      importPattern: 'io.flipt',
      description: 'Flipt Kotlin SDK',
      enabled: true,
      methods: [
        {
          name: 'evaluateBoolean',
          flagKeyIndex: 0,
          examples: ['flipt.evaluateBoolean("flag-key", entityId, context)'],
        },
        {
          name: 'evaluateVariant',
          flagKeyIndex: 0,
          examples: ['flipt.evaluateVariant("flag-key", entityId, context)'],
        },
      ],
    },
    {
      name: 'Optimizely Kotlin SDK',
      importPattern: 'com.optimizely.ab',
      description: 'Optimizely Feature Experimentation Kotlin SDK',
      enabled: true,
      methods: [
        { name: 'decide', flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['optimizely.isFeatureEnabled("feature-key", userId)'],
        },
      ],
    },
    {
      name: 'ConfigCat Kotlin SDK',
      importPattern: 'com.configcat',
      description: 'ConfigCat Kotlin/Android SDK',
      enabled: true,
      methods: [
        { name: 'getValue', flagKeyIndex: 0, examples: ['client.getValue("flag-key", false)'] },
      ],
    },
    {
      name: 'Statsig Kotlin SDK',
      importPattern: 'com.statsig',
      description: 'Statsig Kotlin/Android SDK',
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
      name: 'GrowthBook Kotlin SDK',
      importPattern: 'growthbook.sdk',
      description: 'GrowthBook Kotlin/Android SDK',
      enabled: true,
      methods: [
        { name: 'feature', flagKeyIndex: 0, examples: ['gb.feature("feature-key").on'] },
        { name: 'isOn', flagKeyIndex: 0, examples: ['gb.isOn("feature-key")'] },
      ],
    },
    {
      name: 'DevCycle Kotlin SDK',
      importPattern: 'com.devcycle',
      description: 'DevCycle Kotlin/Android SDK',
      enabled: true,
      methods: [
        {
          name: 'variableValue',
          flagKeyIndex: 0,
          examples: ['client.variableValue("variable-key", defaultValue)'],
        },
        { name: 'variable', flagKeyIndex: 0, examples: ['client.variable("variable-key")'] },
      ],
    },
    {
      name: 'Eppo Kotlin SDK',
      importPattern: 'com.eppo',
      description: 'Eppo Kotlin/Android SDK',
      enabled: true,
      methods: [
        {
          name: 'getBooleanAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.getBooleanAssignment("flag-key", subjectKey, defaultValue)'],
        },
        {
          name: 'getStringAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.getStringAssignment("flag-key", subjectKey, defaultValue)'],
        },
      ],
    },
    {
      name: 'PostHog Android SDK',
      importPattern: 'com.posthog.android',
      description: 'PostHog Android/Kotlin SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['PostHog.isFeatureEnabled("flag-key")'],
        },
        {
          name: 'getFeatureFlag',
          flagKeyIndex: 0,
          examples: ['PostHog.getFeatureFlag("flag-key")'],
        },
        {
          name: 'getFeatureFlagPayload',
          flagKeyIndex: 0,
          examples: ['PostHog.getFeatureFlagPayload("flag-key")'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom Kotlin feature flag patterns',
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
