/**
 * Java language feature flag detector.
 * Ported from Go: internal/languages/java/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class JavaDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultJavaProviders()
  }

  language(): Language {
    return Languages.Java
  }

  fileExtensions(): string[] {
    return ['.java']
  }

  supportsFile(filename: string): boolean {
    return filename.toLowerCase().endsWith('.java')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultJavaProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly Java SDK',
      importPattern: 'com.launchdarkly.sdk',
      description: 'LaunchDarkly Java SDK',
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
        {
          name: 'doubleVariation',
          flagKeyIndex: 0,
          examples: ['client.doubleVariation("flag-key", context, 0.0)'],
        },
      ],
    },
    {
      name: 'Unleash Java SDK',
      importPattern: 'io.getunleash',
      description: 'Unleash Java SDK',
      enabled: true,
      methods: [
        { name: 'isEnabled', flagKeyIndex: 0, examples: ['unleash.isEnabled("feature-toggle")'] },
        { name: 'getVariant', flagKeyIndex: 0, examples: ['unleash.getVariant("feature-toggle")'] },
      ],
    },
    {
      name: 'Split.io Java SDK',
      importPattern: 'io.split.client',
      description: 'Split.io Java SDK',
      enabled: true,
      methods: [
        {
          name: 'getTreatment',
          flagKeyIndex: 1,
          examples: ['client.getTreatment(key, "split-name")'],
        },
        {
          name: 'getTreatments',
          flagKeyIndex: 1,
          examples: ['client.getTreatments(key, Arrays.asList("split1", "split2"))'],
        },
      ],
    },
    {
      name: 'Flipt Java SDK',
      importPattern: 'io.flipt',
      description: 'Flipt Java SDK',
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
      name: 'Optimizely Java SDK',
      importPattern: 'com.optimizely.ab',
      description: 'Optimizely Feature Experimentation Java SDK',
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
      name: 'Flagsmith Java SDK',
      importPattern: 'com.flagsmith',
      description: 'Flagsmith Java SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['flags.isFeatureEnabled("feature-name")'],
        },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['flags.getFeatureValue("feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat Java SDK',
      importPattern: 'com.configcat',
      description: 'ConfigCat Java SDK',
      enabled: true,
      methods: [
        {
          name: 'getValue',
          flagKeyIndex: 1,
          examples: ['client.getValue(Boolean.class, "flag-key", false)'],
        },
        {
          name: 'getValueDetails',
          flagKeyIndex: 1,
          examples: ['client.getValueDetails(Boolean.class, "flag-key", false)'],
        },
      ],
    },
    {
      name: 'Statsig Java SDK',
      importPattern: 'com.statsig',
      description: 'Statsig Java SDK',
      enabled: true,
      methods: [
        { name: 'checkGate', flagKeyIndex: 1, examples: ['statsig.checkGate(user, "gate-name")'] },
        {
          name: 'getExperiment',
          flagKeyIndex: 1,
          examples: ['statsig.getExperiment(user, "experiment-name")'],
        },
        {
          name: 'getConfig',
          flagKeyIndex: 1,
          examples: ['statsig.getConfig(user, "config-name")'],
        },
      ],
    },
    {
      name: 'GrowthBook Java SDK',
      importPattern: 'growthbook.sdk',
      description: 'GrowthBook Java SDK',
      enabled: true,
      methods: [
        { name: 'isOn', flagKeyIndex: 0, examples: ['gb.isOn("feature-key")'] },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['gb.getFeatureValue("feature-key", defaultValue)'],
        },
        { name: 'evalFeature', flagKeyIndex: 0, examples: ['gb.evalFeature("feature-key")'] },
      ],
    },
    {
      name: 'DevCycle Java SDK',
      importPattern: 'com.devcycle',
      description: 'DevCycle Java SDK',
      enabled: true,
      methods: [
        {
          name: 'variableValue',
          flagKeyIndex: 1,
          examples: ['client.variableValue(user, "variable-key", defaultValue)'],
        },
        { name: 'variable', flagKeyIndex: 1, examples: ['client.variable(user, "variable-key")'] },
      ],
    },
    {
      name: 'Eppo Java SDK',
      importPattern: 'com.eppo',
      description: 'Eppo Java SDK',
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
        {
          name: 'getJSONAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.getJSONAssignment("flag-key", subjectKey, defaultValue)'],
        },
      ],
    },
    {
      name: 'PostHog Java SDK',
      importPattern: 'com.posthog.java',
      description: 'PostHog Java SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['posthog.isFeatureEnabled("flag-key", distinctId)'],
        },
        {
          name: 'getFeatureFlag',
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlag("flag-key", distinctId)'],
        },
        {
          name: 'getFeatureFlagPayload',
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlagPayload("flag-key", distinctId)'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom Java feature flag patterns',
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
