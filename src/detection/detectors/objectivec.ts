/**
 * Objective-C language feature flag detector.
 * Ported from Go: internal/languages/objc/detector.go
 */

import { detectFlagsWithRegex, isValidFlagKey, deduplicateFlags } from '../helpers.js'
import { Languages } from '../interface.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class ObjectiveCDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultObjCProviders()
  }

  language(): Language {
    return Languages.ObjectiveC
  }

  fileExtensions(): string[] {
    return ['.m', '.mm', '.h']
  }

  supportsFile(filename: string): boolean {
    const lower = filename.toLowerCase()
    return lower.endsWith('.m') || lower.endsWith('.mm') || lower.endsWith('.h')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    // Run standard regex detection
    const flags = detectFlagsWithRegex(filename, content, this.language(), this.providers)
    // Filter out invalid flag keys (URLs, paths, etc.) -- extra validation for Obj-C
    const validFlags = flags.filter((f) => isValidFlagKey(f.name))
    return deduplicateFlags(validFlags)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}

export function defaultObjCProviders(): FeatureFlagProvider[] {
  return [
    {
      name: 'LaunchDarkly iOS SDK (Objective-C)',
      importPattern: 'LaunchDarkly/LDClient.h',
      description: 'LaunchDarkly iOS SDK for Objective-C',
      enabled: true,
      methods: [
        {
          name: 'boolVariation',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] boolVariation:@"flag-key" defaultValue:NO]'],
        },
        {
          name: 'boolVariationForKey',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] boolVariationForKey:@"flag-key" defaultValue:NO]'],
        },
        {
          name: 'stringVariation',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] stringVariation:@"flag-key" defaultValue:@""]'],
        },
        {
          name: 'stringVariationForKey',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] stringVariationForKey:@"flag-key" defaultValue:@""]'],
        },
        {
          name: 'numberVariation',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] numberVariation:@"flag-key" defaultValue:@0]'],
        },
        {
          name: 'numberVariationForKey',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] numberVariationForKey:@"flag-key" defaultValue:@0]'],
        },
        {
          name: 'jsonVariation',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] jsonVariation:@"flag-key" defaultValue:nil]'],
        },
        {
          name: 'jsonVariationForKey',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] jsonVariationForKey:@"flag-key" defaultValue:nil]'],
        },
        {
          name: 'variationDetail',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] variationDetail:@"flag-key" defaultValue:NO]'],
        },
        {
          name: 'variationDetailForKey',
          flagKeyIndex: 0,
          examples: ['[[LDClient get] variationDetailForKey:@"flag-key" defaultValue:NO]'],
        },
      ],
    },
    {
      name: 'Unleash iOS SDK (Objective-C)',
      importPattern: 'UnleashProxyClientSwift',
      description: 'Unleash iOS SDK for Objective-C',
      enabled: true,
      methods: [
        { name: 'isEnabled', flagKeyIndex: 0, examples: ['[unleash isEnabled:@"feature-toggle"]'] },
        {
          name: 'getVariant',
          flagKeyIndex: 0,
          examples: ['[unleash getVariant:@"feature-toggle"]'],
        },
      ],
    },
    {
      name: 'Split.io iOS SDK (Objective-C)',
      importPattern: 'Split/Split.h',
      description: 'Split.io iOS SDK for Objective-C',
      enabled: true,
      methods: [
        {
          name: 'getTreatment',
          flagKeyIndex: 0,
          examples: ['[splitClient getTreatment:@"split-name"]'],
        },
        {
          name: 'getTreatmentWithConfig',
          flagKeyIndex: 0,
          examples: ['[splitClient getTreatmentWithConfig:@"split-name"]'],
        },
        {
          name: 'getTreatments',
          flagKeyIndex: 0,
          examples: ['[splitClient getTreatments:@[@"split-1", @"split-2"]]'],
        },
      ],
    },
    {
      name: 'Optimizely iOS SDK (Objective-C)',
      importPattern: 'Optimizely/Optimizely.h',
      description: 'Optimizely Feature Experimentation iOS SDK for Objective-C',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['[optimizely isFeatureEnabled:@"feature-key" userId:userId attributes:nil]'],
        },
        {
          name: 'getFeatureVariable',
          flagKeyIndex: 0,
          examples: [
            '[optimizely getFeatureVariable:@"feature-key" variableKey:@"var" userId:userId]',
          ],
        },
        { name: 'decide', flagKeyIndex: 0, examples: ['[user decide:@"flag-key" options:nil]'] },
      ],
    },
    {
      name: 'Flagsmith iOS SDK (Objective-C)',
      importPattern: 'FlagsmithClient',
      description: 'Flagsmith iOS SDK for Objective-C',
      enabled: true,
      methods: [
        {
          name: 'hasFeatureFlag',
          flagKeyIndex: 0,
          examples: ['[[Flagsmith shared] hasFeatureFlag:@"feature-name"]'],
        },
        {
          name: 'hasFeatureFlagWithID',
          flagKeyIndex: 0,
          examples: ['[[Flagsmith shared] hasFeatureFlagWithID:@"feature-name"]'],
        },
        {
          name: 'getValueForFeature',
          flagKeyIndex: 0,
          examples: ['[[Flagsmith shared] getValueForFeature:@"feature-name"]'],
        },
      ],
    },
    {
      name: 'ConfigCat iOS SDK (Objective-C)',
      importPattern: 'ConfigCat/ConfigCat.h',
      description: 'ConfigCat iOS SDK for Objective-C',
      enabled: true,
      methods: [
        {
          name: 'getValue',
          flagKeyIndex: 0,
          examples: ['[configCatClient getValue:@"flag-key" defaultValue:@NO]'],
        },
        {
          name: 'getValueForKey',
          flagKeyIndex: 0,
          examples: ['[configCatClient getValueForKey:@"flag-key" defaultValue:@NO]'],
        },
      ],
    },
    {
      name: 'PostHog iOS SDK (Objective-C)',
      importPattern: 'PostHog/PostHog.h',
      description: 'PostHog iOS SDK for Objective-C',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['[[PHGPostHog sharedInstance] isFeatureEnabled:@"flag-key"]'],
        },
        {
          name: 'getFeatureFlag',
          flagKeyIndex: 0,
          examples: ['[[PHGPostHog sharedInstance] getFeatureFlag:@"flag-key"]'],
        },
        {
          name: 'getFeatureFlagPayload',
          flagKeyIndex: 0,
          examples: ['[[PHGPostHog sharedInstance] getFeatureFlagPayload:@"flag-key"]'],
        },
      ],
    },
    {
      name: 'Custom Feature Flags (Objective-C)',
      description: 'Common custom Objective-C feature flag patterns',
      enabled: true,
      methods: [
        {
          name: 'isFeatureEnabled',
          flagKeyIndex: 0,
          examples: ['[featureFlags isFeatureEnabled:@"feature-name"]'],
        },
        {
          name: 'checkFeature',
          flagKeyIndex: 0,
          examples: ['[featureFlags checkFeature:@"feature-name"]'],
        },
        {
          name: 'hasFeature',
          flagKeyIndex: 0,
          examples: ['[featureFlags hasFeature:@"feature-name"]'],
        },
        {
          name: 'featureEnabled',
          flagKeyIndex: 0,
          examples: ['[flags featureEnabled:@"feature-name"]'],
        },
      ],
    },
  ]
}
