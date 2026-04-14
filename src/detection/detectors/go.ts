/**
 * Go language feature flag detector.
 * Ported from Go: internal/languages/golang/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class GoDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultGoProviders()
  }

  language(): Language {
    return Languages.Go
  }

  fileExtensions(): string[] {
    return ['.go']
  }

  supportsFile(filename: string): boolean {
    return filename.toLowerCase().endsWith('.go')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultGoProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly Go SDK',
      packagePath: 'github.com/launchdarkly/go-server-sdk/v7',
      description: 'LaunchDarkly feature flag service',
      enabled: true,
      methods: [
        {
          name: 'BoolVariation',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.BoolVariation("flag-key", context, false)'],
        },
        {
          name: 'StringVariation',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.StringVariation("flag-key", context, "default")'],
        },
        {
          name: 'IntVariation',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.IntVariation("flag-key", context, 0)'],
        },
        {
          name: 'Float64Variation',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.Float64Variation("flag-key", context, 0.0)'],
        },
        {
          name: 'JSONVariation',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.JSONVariation("flag-key", context, ldvalue.Null())'],
        },
        {
          name: 'BoolVariationDetail',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.BoolVariationDetail("flag-key", context, false)'],
        },
        {
          name: 'StringVariationDetail',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.StringVariationDetail("flag-key", context, "default")'],
        },
        {
          name: 'IntVariationDetail',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.IntVariationDetail("flag-key", context, 0)'],
        },
        {
          name: 'Float64VariationDetail',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.Float64VariationDetail("flag-key", context, 0.0)'],
        },
        {
          name: 'JSONVariationDetail',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['client.JSONVariationDetail("flag-key", context, ldvalue.Null())'],
        },
      ],
    },
    {
      name: 'ZeroFlag',
      packagePath: 'github.com/aviva-zero/zeroflag',
      description: 'Custom ZeroFlag implementation',
      enabled: true,
      methods: [
        {
          name: 'Bool',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['zeroflag.Bool(ctx, "feature-flag")'],
        },
      ],
    },
    {
      name: 'Unleash',
      packagePath: 'github.com/Unleash/unleash-client-go/v4',
      description: 'Unleash feature toggle service',
      enabled: true,
      methods: [
        { name: 'IsEnabled', flagKeyIndex: 0, examples: ['unleash.IsEnabled("feature-toggle")'] },
        { name: 'GetVariant', flagKeyIndex: 0, examples: ['unleash.GetVariant("feature-toggle")'] },
      ],
    },
    {
      name: 'Flipt',
      packagePath: 'go.flipt.io/flipt/sdk/go',
      description: 'Flipt open-source feature flag solution',
      enabled: true,
      methods: [
        {
          name: 'Boolean',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['flipt.Boolean(ctx, "flag-key", "entity-id", context)'],
        },
      ],
    },
    {
      name: 'Split.io',
      packagePath: 'github.com/splitio/go-client/v6/splitio/client',
      description: 'Split.io feature flag and experimentation platform',
      enabled: true,
      methods: [
        {
          name: 'Treatment',
          flagKeyIndex: 1,
          examples: ['client.Treatment("user-key", "split-name", nil)'],
        },
      ],
    },
    {
      name: 'Optimizely Go SDK',
      packagePath: 'github.com/optimizely/go-sdk/v2',
      description: 'Optimizely Feature Experimentation Go SDK',
      enabled: true,
      methods: [
        {
          name: 'Decide',
          flagKeyIndex: 0,
          contextIndex: 1,
          examples: ['user.Decide("flag-key", options)'],
        },
      ],
    },
    {
      name: 'Flagsmith Go SDK',
      packagePath: 'github.com/Flagsmith/flagsmith-go-client/v2',
      description: 'Flagsmith Go SDK',
      enabled: true,
      methods: [
        {
          name: 'GetIdentityFlags',
          flagKeyIndex: 0,
          examples: ['client.GetIdentityFlags(ctx, "identifier", traits)'],
        },
        {
          name: 'IsFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['flags.IsFeatureEnabled("feature-name")'],
        },
      ],
    },
    {
      name: 'ConfigCat Go SDK',
      packagePath: 'github.com/configcat/go-sdk/v7',
      description: 'ConfigCat Go SDK',
      enabled: true,
      methods: [
        {
          name: 'GetBoolValue',
          flagKeyIndex: 0,
          examples: ['client.GetBoolValue("flag-key", false, user)'],
        },
        {
          name: 'GetStringValue',
          flagKeyIndex: 0,
          examples: ['client.GetStringValue("flag-key", "default", user)'],
        },
        {
          name: 'GetIntValue',
          flagKeyIndex: 0,
          examples: ['client.GetIntValue("flag-key", 0, user)'],
        },
      ],
    },
    {
      name: 'Statsig Go SDK',
      packagePath: 'github.com/statsig-io/go-sdk',
      description: 'Statsig Go SDK',
      enabled: true,
      methods: [
        {
          name: 'CheckGate',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['statsig.CheckGate(user, "gate-name")'],
        },
        {
          name: 'GetExperiment',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['statsig.GetExperiment(user, "experiment-name")'],
        },
        {
          name: 'GetConfig',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['statsig.GetConfig(user, "config-name")'],
        },
      ],
    },
    {
      name: 'GrowthBook Go SDK',
      packagePath: 'github.com/growthbook/growthbook-golang',
      description: 'GrowthBook Go SDK',
      enabled: true,
      methods: [
        { name: 'Feature', flagKeyIndex: 0, examples: ['gb.Feature("feature-key")'] },
        { name: 'EvalFeature', flagKeyIndex: 0, examples: ['gb.EvalFeature("feature-key")'] },
      ],
    },
    {
      name: 'DevCycle Go SDK',
      packagePath: 'github.com/devcyclehq/go-server-sdk',
      description: 'DevCycle Go SDK',
      enabled: true,
      methods: [
        {
          name: 'Variable',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['client.Variable(user, "variable-key", defaultValue)'],
        },
        {
          name: 'VariableValue',
          flagKeyIndex: 1,
          contextIndex: 0,
          examples: ['client.VariableValue(user, "variable-key", defaultValue)'],
        },
      ],
    },
    {
      name: 'Eppo Go SDK',
      packagePath: 'github.com/Eppo-exp/golang-sdk',
      description: 'Eppo Go SDK',
      enabled: true,
      methods: [
        {
          name: 'GetBoolAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.GetBoolAssignment("flag-key", subjectKey, defaultValue)'],
        },
        {
          name: 'GetStringAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.GetStringAssignment("flag-key", subjectKey, defaultValue)'],
        },
        {
          name: 'GetNumericAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.GetNumericAssignment("flag-key", subjectKey, defaultValue)'],
        },
        {
          name: 'GetJSONAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.GetJSONAssignment("flag-key", subjectKey, defaultValue)'],
        },
      ],
    },
    {
      name: 'PostHog Go SDK',
      packagePath: 'github.com/posthog/posthog-go',
      description: 'PostHog Go SDK',
      enabled: true,
      methods: [
        {
          name: 'IsFeatureEnabled',
          flagKeyIndex: 0,
          examples: [
            'client.IsFeatureEnabled(posthog.FeatureFlagPayload{Key: "flag-key", DistinctId: distinctId})',
          ],
        },
        {
          name: 'GetFeatureFlag',
          flagKeyIndex: 0,
          examples: [
            'client.GetFeatureFlag(posthog.FeatureFlagPayload{Key: "flag-key", DistinctId: distinctId})',
          ],
        },
        {
          name: 'GetFeatureFlagPayload',
          flagKeyIndex: 0,
          examples: [
            'client.GetFeatureFlagPayload(posthog.FeatureFlagPayload{Key: "flag-key", DistinctId: distinctId})',
          ],
        },
      ],
    },
  ]
}
