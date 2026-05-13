import { describe, it, expect } from 'vitest'

import {
  convertConfigProviders,
  languageToConfigLanguage,
  loadProvidersForLanguage,
} from '../../src/detection/config-adapter.js'
import type { FeatureFlagProvider } from '../../src/detection/interface.js'
import type { FeatureFlagConfig } from '../../src/detection/yaml-config.js'

const defaultProviders: FeatureFlagProvider[] = [
  {
    name: 'Default LD',
    importPattern: 'launchdarkly',
    enabled: true,
    methods: [{ name: 'variation', flagKeyIndex: 0 }],
  },
]

describe('convertConfigProviders', () => {
  it('maps snake_case config provider fields to camelCase runtime fields', () => {
    const out = convertConfigProviders([
      {
        name: 'LD',
        languages: ['typescript'],
        import_pattern: 'launchdarkly',
        import_aliases: [],
        description: 'desc',
        enabled: true,
        methods: [
          {
            name: 'variation',
            flag_key_index: 1,
            context_index: 2,
            min_params: 0,
            examples: ['ex'],
            return_type: '',
            default_value_index: 0,
          },
        ],
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('LD')
    expect(out[0].importPattern).toBe('launchdarkly')
    expect(out[0].packagePath).toBe('launchdarkly')
    expect(out[0].methods[0].flagKeyIndex).toBe(1)
    expect(out[0].methods[0].contextIndex).toBe(2)
  })
})

describe('languageToConfigLanguage', () => {
  it('maps each Language to the matching SupportedLanguage', () => {
    expect(languageToConfigLanguage('go')).toBe('go')
    expect(languageToConfigLanguage('typescript')).toBe('typescript')
    expect(languageToConfigLanguage('javascript')).toBe('javascript')
    expect(languageToConfigLanguage('python')).toBe('python')
    expect(languageToConfigLanguage('java')).toBe('java')
    expect(languageToConfigLanguage('kotlin')).toBe('kotlin')
    expect(languageToConfigLanguage('swift')).toBe('swift')
    expect(languageToConfigLanguage('ruby')).toBe('ruby')
    expect(languageToConfigLanguage('csharp')).toBe('csharp')
    expect(languageToConfigLanguage('php')).toBe('php')
    expect(languageToConfigLanguage('rust')).toBe('rust')
    expect(languageToConfigLanguage('cpp')).toBe('cpp')
    expect(languageToConfigLanguage('objc')).toBe('objc')
  })

  it('returns "all" for an unknown language (line 55 — fallback branch)', () => {
    // Casting an unknown language exercises the `?? 'all'` fallback
    expect(languageToConfigLanguage('unknown-lang' as never)).toBe('all')
  })
})

describe('loadProvidersForLanguage', () => {
  it('returns defaults when config is undefined', () => {
    expect(loadProvidersForLanguage('typescript', defaultProviders, undefined)).toEqual(
      defaultProviders,
    )
  })

  it('returns defaults when config is null', () => {
    expect(loadProvidersForLanguage('typescript', defaultProviders, null)).toEqual(defaultProviders)
  })

  it('returns defaults when config has no enabled providers for that language', () => {
    const cfg: FeatureFlagConfig = {
      version: '1',
      providers: [
        {
          name: 'GoOnly',
          languages: ['go'],
          import_pattern: 'go-sdk',
          methods: [
            {
              name: 'Bool',
              flag_key_index: 0,
              context_index: 0,
              min_params: 0,
              examples: [],
              return_type: '',
              default_value_index: 0,
            },
          ],
          import_aliases: [],
          description: '',
          enabled: true,
        },
      ],
      global_settings: {
        enable_fallback_detection: false,
        strict_import_matching: false,
        custom_patterns: [],
      },
    }
    expect(loadProvidersForLanguage('typescript', defaultProviders, cfg)).toEqual(defaultProviders)
  })

  it('merges config providers with defaults when one exists for the language', () => {
    const cfg: FeatureFlagConfig = {
      version: '1',
      providers: [
        {
          name: 'NewOne',
          languages: ['typescript'],
          import_pattern: 'new-sdk',
          methods: [
            {
              name: 'check',
              flag_key_index: 0,
              context_index: 0,
              min_params: 0,
              examples: [],
              return_type: '',
              default_value_index: 0,
            },
          ],
          import_aliases: [],
          description: '',
          enabled: true,
        },
      ],
      global_settings: {
        enable_fallback_detection: false,
        strict_import_matching: false,
        custom_patterns: [],
      },
    }
    const out = loadProvidersForLanguage('typescript', defaultProviders, cfg)
    expect(out.length).toBe(2)
    expect(out.map((p) => p.name).sort()).toEqual(['Default LD', 'NewOne'])
  })
})
