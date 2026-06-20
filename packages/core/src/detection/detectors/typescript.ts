/**
 * TypeScript language feature flag detector.
 * Ported from Go: internal/languages/typescript/detector.go
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'
import { detectFlagsWithTreeSitter } from '../tree-sitter/engine.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { DetectorEngine, FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export type { DetectorEngine }

export interface TypeScriptDetectorOptions {
  providers?: FeatureFlagProvider[]
  engine?: DetectorEngine
}

export class TypeScriptDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]
  private readonly engine: DetectorEngine

  constructor(opts: TypeScriptDetectorOptions = {}) {
    this.providers = opts.providers ?? defaultTypeScriptProviders()
    this.engine = opts.engine ?? 'regex'
  }

  language(): Language {
    return Languages.TypeScript
  }

  fileExtensions(): string[] {
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
  }

  supportsFile(filename: string): boolean {
    const lower = filename.toLowerCase()
    const dotIdx = lower.lastIndexOf('.')
    if (dotIdx === -1) return false
    const ext = lower.slice(dotIdx + 1)
    return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)
  }

  detectFlags(filename: string, content: string): FeatureFlag[] | Promise<FeatureFlag[]> {
    if (this.engine === 'tree-sitter') {
      return detectFlagsWithTreeSitter(filename, content, this.language(), this.providers)
    }
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
      // Three accepted package names — LaunchDarkly has shipped the React
      // SDK under three identities:
      //   1. `launchdarkly-react-client-sdk` (legacy unscoped, still in use)
      //   2. `@launchdarkly/react-client-sdk` (scoped rename of #1)
      //   3. `@launchdarkly/react-sdk`        (the current React Web SDK,
      //      v4+, published as a fresh package — NOT a substring of #2,
      //      so the import gate must list it explicitly)
      // All three share `useLDClient`. #1/#2 use `useFlag(key, default)` +
      // `useFlags()` destructure. #3 introduced typed variation hooks
      // (`useBoolVariation`/`useStringVariation`/`useNumberVariation`/
      // `useJsonVariation`) plus their `*Detail` variants, and deprecated
      // `useFlags()` (still works in v4 so we keep detecting it). The
      // method list is the union of all three; the per-method regex only
      // fires on files that actually call that method, so combining is
      // safe — a file importing #1 with only `useFlag(...)` won't surface
      // spurious `useBoolVariation` matches.
      importAliases: ['launchdarkly-react-client-sdk', '@launchdarkly/react-sdk'],
      description: 'LaunchDarkly React SDK',
      enabled: true,
      useFlagsHook: 'useFlags',
      methods: [
        // Old SDK hooks (@launchdarkly/react-client-sdk + legacy unscoped).
        {
          name: 'useFlag',
          flagKeyIndex: 0,
          examples: ["const enabled = useFlag('show-new-checkout', false)"],
        },
        { name: 'useFlags', flagKeyIndex: -1, examples: ['const { flagKey } = useFlags()'] },
        { name: 'useLDClient', flagKeyIndex: -1, examples: ['const ldClient = useLDClient()'] },

        // New React Web SDK (@launchdarkly/react-sdk, v4+) typed variation
        // hooks. Each takes the flag key as the first positional arg.
        {
          name: 'useBoolVariation',
          flagKeyIndex: 0,
          examples: ["const on = useBoolVariation('show-new-feature', false)"],
        },
        {
          name: 'useStringVariation',
          flagKeyIndex: 0,
          examples: ["const theme = useStringVariation('ui-theme', 'light')"],
        },
        {
          name: 'useNumberVariation',
          flagKeyIndex: 0,
          examples: ["const max = useNumberVariation('max-items', 10)"],
        },
        {
          name: 'useJsonVariation',
          flagKeyIndex: 0,
          examples: ["const cfg = useJsonVariation('my-config', {})"],
        },
        // `*Detail` variants return { value, variationIndex, reason }
        // instead of the bare value. Same first-arg shape.
        {
          name: 'useBoolVariationDetail',
          flagKeyIndex: 0,
          examples: ["const { value } = useBoolVariationDetail('flag', false)"],
        },
        {
          name: 'useStringVariationDetail',
          flagKeyIndex: 0,
          examples: ["const { value } = useStringVariationDetail('flag', 'x')"],
        },
        {
          name: 'useNumberVariationDetail',
          flagKeyIndex: 0,
          examples: ["const { value } = useNumberVariationDetail('flag', 0)"],
        },
        {
          name: 'useJsonVariationDetail',
          flagKeyIndex: 0,
          examples: ["const { value } = useJsonVariationDetail('flag', {})"],
        },
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
      name: 'OpenFeature JavaScript SDK',
      importPattern: '@openfeature/server-sdk',
      importAliases: ['@openfeature/web-sdk', '@openfeature/js-sdk', '@openfeature/react-sdk'],
      description: 'OpenFeature vendor-neutral JS/TS SDK',
      enabled: true,
      methods: [
        { name: 'getBooleanValue', flagKeyIndex: 0, examples: ['client.getBooleanValue("flag-key", false)'] },
        { name: 'getStringValue', flagKeyIndex: 0, examples: ['client.getStringValue("flag-key", "default")'] },
        { name: 'getNumberValue', flagKeyIndex: 0, examples: ['client.getNumberValue("flag-key", 0)'] },
        { name: 'getObjectValue', flagKeyIndex: 0, examples: ['client.getObjectValue("flag-key", {})'] },
        { name: 'getBooleanDetails', flagKeyIndex: 0, examples: ['client.getBooleanDetails("flag-key", false)'] },
        { name: 'getStringDetails', flagKeyIndex: 0, examples: ['client.getStringDetails("flag-key", "default")'] },
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
      // Runtime-load symbols (B2). PostHog's canonical snippet attaches
      // the SDK to `window.posthog` from a <script src=".../array.js">,
      // so React/Vue/etc. consumer files never `import 'posthog-js'`
      // directly. Without these symbols flagshark returns 0 on every
      // PostHog frontend (n8n, PostHog's own dashboard, ...). The
      // patterns are property-access shapes (with `.` separators) or
      // call-shaped (with trailing `(`) so they don't match the bare
      // string "posthog" in unrelated comments / docs.
      runtimeSymbols: [
        'window.posthog.',
        'posthog.isFeatureEnabled(',
        'posthog.getFeatureFlag(',
        'posthog.getFeatureFlagPayload(',
      ],
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
