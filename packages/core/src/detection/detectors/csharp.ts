/**
 * C# language feature flag detector.
 * Ported from Go: internal/languages/csharp/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class CSharpDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultCSharpProviders()
  }

  language(): Language {
    return Languages.CSharp
  }

  fileExtensions(): string[] {
    return ['.cs', '.csx']
  }

  supportsFile(filename: string): boolean {
    const lower = filename.toLowerCase()
    return lower.endsWith('.cs') || lower.endsWith('.csx')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultCSharpProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly .NET SDK',
      importPattern: 'LaunchDarkly.Sdk',
      description: 'LaunchDarkly .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'BoolVariation',
          flagKeyIndex: 0,
          examples: ['client.BoolVariation("flag-key", context, false)'],
        },
        {
          name: 'StringVariation',
          flagKeyIndex: 0,
          examples: ['client.StringVariation("flag-key", context, "default")'],
        },
        {
          name: 'IntVariation',
          flagKeyIndex: 0,
          examples: ['client.IntVariation("flag-key", context, 0)'],
        },
        {
          name: 'DoubleVariation',
          flagKeyIndex: 0,
          examples: ['client.DoubleVariation("flag-key", context, 0.0)'],
        },
      ],
    },
    {
      name: 'Unleash .NET SDK',
      importPattern: 'Unleash',
      description: 'Unleash .NET SDK',
      enabled: true,
      methods: [
        { name: 'IsEnabled', flagKeyIndex: 0, examples: ['unleash.IsEnabled("feature-toggle")'] },
        { name: 'GetVariant', flagKeyIndex: 0, examples: ['unleash.GetVariant("feature-toggle")'] },
      ],
    },
    {
      name: 'Split.io .NET SDK',
      importPattern: 'Splitio.Services.Client',
      description: 'Split.io .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'GetTreatment',
          flagKeyIndex: 1,
          examples: ['client.GetTreatment(key, "split-name")'],
        },
        {
          name: 'GetTreatments',
          flagKeyIndex: 1,
          examples: ['client.GetTreatments(key, new List<string>{"split1", "split2"})'],
        },
      ],
    },
    {
      name: 'Optimizely .NET SDK',
      importPattern: 'OptimizelySDK',
      description: 'Optimizely Feature Experimentation .NET SDK',
      enabled: true,
      methods: [
        { name: 'Decide', flagKeyIndex: 0, examples: ['user.Decide("flag-key", options)'] },
        {
          name: 'IsFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['optimizely.IsFeatureEnabled("feature-key", userId)'],
        },
      ],
    },
    {
      name: 'Flagsmith .NET SDK',
      importPattern: 'Flagsmith',
      description: 'Flagsmith .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'HasFeatureFlag',
          flagKeyIndex: 0,
          examples: ['flags.HasFeatureFlag("feature-name")'],
        },
        {
          name: 'GetFeatureValue',
          flagKeyIndex: 0,
          examples: ['flags.GetFeatureValue("feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat .NET SDK',
      importPattern: 'ConfigCat.Client',
      description: 'ConfigCat .NET SDK',
      enabled: true,
      methods: [
        { name: 'GetValue', flagKeyIndex: 0, examples: ['client.GetValue("flag-key", false)'] },
        {
          name: 'GetValueAsync',
          flagKeyIndex: 0,
          examples: ['await client.GetValueAsync("flag-key", false)'],
        },
      ],
    },
    {
      name: 'Statsig .NET SDK',
      importPattern: 'Statsig',
      description: 'Statsig .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'CheckGate',
          flagKeyIndex: 1,
          examples: ['StatsigServer.CheckGate(user, "gate-name")'],
        },
        {
          name: 'GetExperiment',
          flagKeyIndex: 1,
          examples: ['StatsigServer.GetExperiment(user, "experiment-name")'],
        },
        {
          name: 'GetConfig',
          flagKeyIndex: 1,
          examples: ['StatsigServer.GetConfig(user, "config-name")'],
        },
      ],
    },
    {
      name: 'GrowthBook .NET SDK',
      importPattern: 'GrowthBook',
      description: 'GrowthBook .NET SDK',
      enabled: true,
      methods: [
        { name: 'IsOn', flagKeyIndex: 0, examples: ['gb.IsOn("feature-key")'] },
        {
          name: 'GetFeatureValue',
          flagKeyIndex: 0,
          examples: ['gb.GetFeatureValue<string>("feature-key", fallbackValue)'],
        },
      ],
    },
    {
      name: 'DevCycle .NET SDK',
      importPattern: 'DevCycle.SDK.Server',
      description: 'DevCycle .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'VariableValue',
          flagKeyIndex: 1,
          examples: ['client.VariableValue(user, "variable-key", defaultValue)'],
        },
        {
          name: 'Variable',
          flagKeyIndex: 1,
          examples: ['client.Variable(user, "variable-key", defaultValue)'],
        },
      ],
    },
    {
      name: 'Eppo .NET SDK',
      importPattern: 'Eppo',
      description: 'Eppo .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'GetBooleanAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.GetBooleanAssignment("flag-key", subjectKey, defaultValue)'],
        },
        {
          name: 'GetStringAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.GetStringAssignment("flag-key", subjectKey, defaultValue)'],
        },
      ],
    },
    {
      name: 'PostHog .NET SDK',
      importPattern: 'PostHog',
      description: 'PostHog .NET SDK',
      enabled: true,
      methods: [
        {
          name: 'IsFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['posthog.IsFeatureEnabled("flag-key", distinctId)'],
        },
        {
          name: 'GetFeatureFlag',
          flagKeyIndex: 0,
          examples: ['posthog.GetFeatureFlag("flag-key", distinctId)'],
        },
      ],
    },
    {
      name: 'Microsoft Feature Management',
      importPattern: 'Microsoft.FeatureManagement',
      description: 'Microsoft Feature Management for .NET',
      enabled: true,
      methods: [
        {
          name: 'IsEnabledAsync',
          flagKeyIndex: 0,
          examples: ['await featureManager.IsEnabledAsync("feature-name")'],
        },
        {
          name: 'IsEnabled',
          flagKeyIndex: 0,
          examples: ['featureManager.IsEnabled("feature-name")'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom C# feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'IsFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['IsFeatureEnabled("feature-name")'],
        },
        { name: 'CheckFeature', flagKeyIndex: 0, examples: ['CheckFeature("feature-name")'] },
        { name: 'HasFeature', flagKeyIndex: 0, examples: ['HasFeature("feature-name")'] },
      ],
    },
  ]
}
