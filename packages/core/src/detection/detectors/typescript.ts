/**
 * TypeScript language feature flag detector.
 * Ported from Go: internal/languages/typescript/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class TypeScriptDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultTypeScriptProviders()
  }

  language(): Language {
    return Languages.TypeScript
  }

  fileExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultTypeScriptProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly JavaScript SDK',
      importPattern: '@launchdarkly/js-client-sdk',
      description: 'LaunchDarkly JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", defaultValue)'],
        },
        {
          name: 'boolVariation',
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", false)'],
        },
      ],
    },
    {
      name: 'LaunchDarkly Node Server SDK',
      importPattern: '@launchdarkly/node-server-sdk',
      description: 'LaunchDarkly Node.js Server SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", context, defaultValue)'],
        },
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
        {
          name: 'jsonVariation',
          flagKeyIndex: 0,
          examples: ['client.jsonVariation("flag-key", context, {})'],
        },
        {
          name: 'variationDetail',
          flagKeyIndex: 0,
          examples: ['client.variationDetail("flag-key", context, defaultValue)'],
        },
      ],
    },
    {
      name: 'LaunchDarkly React SDK',
      importPattern: '@launchdarkly/react-client-sdk',
      description: 'LaunchDarkly React SDK',
      enabled: true,
      methods: [
        { name: 'useFlags', flagKeyIndex: -1, examples: ['const { flagKey } = useFlags()'] },
        { name: 'useLDClient', flagKeyIndex: -1, examples: ['const ldClient = useLDClient()'] },
      ],
    },
    {
      name: 'LaunchDarkly Legacy Node SDK',
      importPattern: 'launchdarkly-node-server-sdk',
      description: 'LaunchDarkly legacy Node.js Server SDK',
      enabled: true,
      methods: [
        {
          name: 'variation',
          flagKeyIndex: 0,
          examples: ['client.variation("flag-key", context, defaultValue)'],
        },
        {
          name: 'boolVariation',
          flagKeyIndex: 0,
          examples: ['client.boolVariation("flag-key", context, false)'],
        },
      ],
    },
    {
      name: 'Unleash JavaScript SDK',
      importPattern: 'unleash-client',
      description: 'Unleash JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        { name: 'isEnabled', flagKeyIndex: 0, examples: ['unleash.isEnabled("feature-toggle")'] },
        { name: 'getVariant', flagKeyIndex: 0, examples: ['unleash.getVariant("feature-toggle")'] },
      ],
    },
    {
      name: 'Split.io JavaScript SDK',
      importPattern: '@splitsoftware/splitio',
      description: 'Split.io JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        {
          name: 'getTreatment',
          flagKeyIndex: 1,
          examples: ['client.getTreatment(key, "split-name")'],
        },
      ],
    },
    {
      name: 'React Feature Flags',
      importPattern: 'react-feature-flags',
      description: 'React feature flags library',
      enabled: true,
      methods: [{ name: 'Flag', flagKeyIndex: 0, examples: ['<Flag name="new-feature">'] }],
    },
    {
      name: 'Optimizely JavaScript SDK',
      importPattern: '@optimizely/optimizely-sdk',
      description: 'Optimizely Feature Experimentation JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        { name: 'decide', flagKeyIndex: 0, examples: ['user.decide("flag-key", options)'] },
        {
          name: 'decideForKeys',
          flagKeyIndex: 0,
          examples: ['user.decideForKeys(["flag-key-1", "flag-key-2"], options)'],
        },
        { name: 'decideAll', flagKeyIndex: 0, examples: ['user.decideAll(options)'] },
      ],
    },
    {
      name: 'Flagsmith JavaScript SDK',
      importPattern: 'flagsmith',
      description: 'Flagsmith JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        { name: 'hasFeature', flagKeyIndex: 0, examples: ['flagsmith.hasFeature("feature-name")'] },
        { name: 'getValue', flagKeyIndex: 0, examples: ['flagsmith.getValue("feature-name")'] },
      ],
    },
    {
      name: 'ConfigCat JavaScript SDK',
      importPattern: 'configcat-js',
      description: 'ConfigCat JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        {
          name: 'getValue',
          flagKeyIndex: 0,
          examples: ['client.getValue("flag-key", defaultValue)'],
        },
        {
          name: 'getValueAsync',
          flagKeyIndex: 0,
          examples: ['await client.getValueAsync("flag-key", defaultValue)'],
        },
      ],
    },
    {
      name: 'Flipt JavaScript SDK',
      importPattern: '@flipt-io/flipt-client-js',
      description: 'Flipt JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        {
          name: 'evaluateBoolean',
          flagKeyIndex: 0,
          examples: ['client.evaluateBoolean("flag-key", entityId, context)'],
        },
        {
          name: 'evaluateVariant',
          flagKeyIndex: 0,
          examples: ['client.evaluateVariant("flag-key", entityId, context)'],
        },
      ],
    },
    {
      name: 'Statsig JavaScript SDK',
      importPattern: 'statsig-js',
      description: 'Statsig JavaScript/TypeScript SDK',
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
      name: 'GrowthBook JavaScript SDK',
      importPattern: '@growthbook/growthbook',
      description: 'GrowthBook JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        { name: 'isOn', flagKeyIndex: 0, examples: ['gb.isOn("feature-key")'] },
        {
          name: 'getFeatureValue',
          flagKeyIndex: 0,
          examples: ['gb.getFeatureValue("feature-key", fallbackValue)'],
        },
        { name: 'evalFeature', flagKeyIndex: 0, examples: ['gb.evalFeature("feature-key")'] },
      ],
    },
    {
      name: 'DevCycle JavaScript SDK',
      importPattern: '@devcycle/js-client-sdk',
      description: 'DevCycle JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        {
          name: 'variableValue',
          flagKeyIndex: 0,
          examples: ['client.variableValue("variable-key", defaultValue)'],
        },
        {
          name: 'variable',
          flagKeyIndex: 0,
          examples: ['client.variable("variable-key", defaultValue)'],
        },
      ],
    },
    {
      name: 'Eppo JavaScript SDK',
      importPattern: '@eppo/js-client-sdk',
      description: 'Eppo JavaScript/TypeScript SDK',
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
          name: 'getNumericAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.getNumericAssignment("flag-key", subjectKey, defaultValue)'],
        },
        {
          name: 'getJSONAssignment',
          flagKeyIndex: 0,
          examples: ['eppoClient.getJSONAssignment("flag-key", subjectKey, defaultValue)'],
        },
      ],
    },
    {
      name: 'PostHog JavaScript SDK',
      importPattern: 'posthog-js',
      description: 'PostHog JavaScript/TypeScript SDK',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['posthog.isFeatureEnabled("flag-key")'],
        },
        {
          name: 'getFeatureFlag',
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlag("flag-key")'],
        },
        {
          name: 'getFeatureFlagPayload',
          flagKeyIndex: 0,
          examples: ['posthog.getFeatureFlagPayload("flag-key")'],
        },
      ],
    },
    {
      name: 'PostHog Node SDK',
      importPattern: 'posthog-node',
      description: 'PostHog Node.js SDK',
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
        { name: 'getAllFlags', flagKeyIndex: -1, examples: ['posthog.getAllFlags(distinctId)'] },
      ],
    },
    {
      name: 'Custom Feature Flags',
      description: 'Common custom feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['isFeatureEnabled("feature-name")'],
        },
        { name: 'featureFlag', flagKeyIndex: 0, examples: ['featureFlag("feature-name")'] },
        { name: 'hasFeature', flagKeyIndex: 0, examples: ['hasFeature("feature-name")'] },
      ],
    },
  ]
}
