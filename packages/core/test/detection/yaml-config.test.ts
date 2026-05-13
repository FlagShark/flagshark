import { describe, it, expect } from 'vitest'

import {
  CONFIG_FILE_LOCATIONS,
  getEnabledProviders,
  getMethodDefaultValueIndex,
  getMethodReturnType,
  getProvidersForLanguage,
  lintConfig,
  mergeProviders,
  parseConfig,
  providerAppliesToLanguage,
  safeParseConfig,
  toTreeSitterConfigs,
  toTreeSitterConfigsForLanguage,
} from '../../src/detection/yaml-config.js'

import type { FeatureFlagConfig, FeatureFlagProvider } from '../../src/detection/yaml-config.js'

function makeProvider(overrides: Partial<FeatureFlagProvider> = {}): FeatureFlagProvider {
  return {
    name: 'LD',
    languages: [],
    import_pattern: 'launchdarkly',
    methods: [
      {
        name: 'variation',
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
    ...overrides,
  }
}

function makeConfig(overrides: Partial<FeatureFlagConfig> = {}): FeatureFlagConfig {
  return {
    version: '1',
    providers: [makeProvider()],
    global_settings: {
      enable_fallback_detection: false,
      strict_import_matching: false,
      custom_patterns: [],
    },
    ...overrides,
  }
}

describe('parseConfig / safeParseConfig', () => {
  it('parseConfig validates a minimal valid input', () => {
    const out = parseConfig({
      version: '1',
      providers: [
        {
          name: 'LD',
          import_pattern: 'launchdarkly',
          methods: [{ name: 'variation' }],
        },
      ],
    })
    expect(out.version).toBe('1')
    expect(out.providers).toHaveLength(1)
  })

  it('parseConfig throws on missing required field', () => {
    expect(() => parseConfig({ providers: [] })).toThrow()
  })

  it('safeParseConfig returns success on valid input', () => {
    const out = safeParseConfig({
      version: '1',
      providers: [{ name: 'LD', methods: [{ name: 'v' }] }],
    })
    expect(out.success).toBe(true)
  })

  it('safeParseConfig returns failure on invalid input', () => {
    const out = safeParseConfig({ providers: [] })
    expect(out.success).toBe(false)
  })
})

describe('getMethodReturnType', () => {
  it('returns "boolean" when no return_type is set', () => {
    expect(
      getMethodReturnType({
        name: 'v',
        flag_key_index: 0,
        context_index: 0,
        min_params: 0,
        examples: [],
        return_type: '',
        default_value_index: 0,
      }),
    ).toBe('boolean')
  })

  it('returns the explicit return_type', () => {
    expect(
      getMethodReturnType({
        name: 'v',
        flag_key_index: 0,
        context_index: 0,
        min_params: 0,
        examples: [],
        return_type: 'string',
        default_value_index: 0,
      }),
    ).toBe('string')
  })
})

describe('getMethodDefaultValueIndex', () => {
  it('returns -1 when default_value_index is 0 AND return_type is empty', () => {
    expect(
      getMethodDefaultValueIndex({
        name: 'v',
        flag_key_index: 0,
        context_index: 0,
        min_params: 0,
        examples: [],
        return_type: '',
        default_value_index: 0,
      }),
    ).toBe(-1)
  })

  it('returns the explicit index when set', () => {
    expect(
      getMethodDefaultValueIndex({
        name: 'v',
        flag_key_index: 0,
        context_index: 0,
        min_params: 0,
        examples: [],
        return_type: '',
        default_value_index: 2,
      }),
    ).toBe(2)
  })

  it('returns 0 when return_type is set and default_value_index is 0', () => {
    expect(
      getMethodDefaultValueIndex({
        name: 'v',
        flag_key_index: 0,
        context_index: 0,
        min_params: 0,
        examples: [],
        return_type: 'boolean',
        default_value_index: 0,
      }),
    ).toBe(0)
  })
})

describe('providerAppliesToLanguage', () => {
  it('applies when languages is empty (default = all)', () => {
    expect(providerAppliesToLanguage(makeProvider({ languages: [] }), 'typescript')).toBe(true)
  })

  it('applies when languages contains the target', () => {
    expect(providerAppliesToLanguage(makeProvider({ languages: ['typescript'] }), 'typescript')).toBe(true)
  })

  it('applies when languages contains "all"', () => {
    expect(providerAppliesToLanguage(makeProvider({ languages: ['all'] }), 'go')).toBe(true)
  })

  it('does not apply when languages excludes target', () => {
    expect(providerAppliesToLanguage(makeProvider({ languages: ['python'] }), 'go')).toBe(false)
  })
})

describe('getEnabledProviders / getProvidersForLanguage', () => {
  it('filters out disabled providers', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({ name: 'on', enabled: true }),
        makeProvider({ name: 'off', enabled: false }),
      ],
    })
    expect(getEnabledProviders(cfg).map((p) => p.name)).toEqual(['on'])
  })

  it('filters by language as well as enabled', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({ name: 'ts-only', languages: ['typescript'] }),
        makeProvider({ name: 'go-only', languages: ['go'] }),
        makeProvider({ name: 'disabled', enabled: false, languages: ['typescript'] }),
      ],
    })
    expect(getProvidersForLanguage(cfg, 'typescript').map((p) => p.name)).toEqual(['ts-only'])
  })
})

describe('toTreeSitterConfigs / toTreeSitterConfigsForLanguage', () => {
  it('emits one config per non-negative flagKeyIndex method', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          methods: [
            { name: 'good', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
            { name: 'skip', flag_key_index: -1, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(toTreeSitterConfigs(cfg)).toHaveLength(1)
    expect(toTreeSitterConfigs(cfg)[0].methodNames).toEqual(['good'])
  })

  it('toTreeSitterConfigsForLanguage filters by language', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({ name: 'ts', languages: ['typescript'] }),
        makeProvider({ name: 'go', languages: ['go'] }),
      ],
    })
    const out = toTreeSitterConfigsForLanguage(cfg, 'typescript')
    expect(out.map((c) => c.interfaceName)).toEqual(['ts'])
  })

  it('toTreeSitterConfigsForLanguage skips methods with negative flagKeyIndex', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          languages: ['typescript'],
          methods: [
            { name: 'good', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
            { name: 'skip', flag_key_index: -1, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(toTreeSitterConfigsForLanguage(cfg, 'typescript')).toHaveLength(1)
  })
})

describe('mergeProviders (yaml-config)', () => {
  it('appends a new provider whose import_pattern is not in the existing config', () => {
    const cfg = makeConfig()
    mergeProviders(cfg, [makeProvider({ name: 'NEW', import_pattern: 'newpat' })])
    expect(cfg.providers).toHaveLength(2)
  })

  it('replaces an existing provider with matching import_pattern', () => {
    const cfg = makeConfig()
    mergeProviders(cfg, [makeProvider({ name: 'REPLACED', import_pattern: 'launchdarkly' })])
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.providers[0].name).toBe('REPLACED')
  })
})

describe('lintConfig', () => {
  it('returns empty warnings for a clean boolean-style config', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          methods: [
            { name: 'isEnabled', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(lintConfig(cfg)).toEqual([])
  })

  it('warns about methods with hint names but no return_type', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          methods: [
            { name: 'getString', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    const warnings = lintConfig(cfg)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/string/i)
  })

  it('skips disabled providers', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          enabled: false,
          methods: [
            { name: 'getJson', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(lintConfig(cfg)).toEqual([])
  })

  it('skips methods with negative flag_key_index', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          methods: [
            { name: 'getString', flag_key_index: -1, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(lintConfig(cfg)).toEqual([])
  })

  it('skips methods whose return_type is set', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          methods: [
            { name: 'getString', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: 'string', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(lintConfig(cfg)).toEqual([])
  })

  it('skips boolean-style method names (is_*, isFoo, *enabled*, *isbool*)', () => {
    const cfg = makeConfig({
      providers: [
        makeProvider({
          methods: [
            { name: 'is_enabled', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
            { name: 'isFooEnabled', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
            { name: 'getIsBoolValue', flag_key_index: 0, context_index: 0, min_params: 0, examples: [], return_type: '', default_value_index: 0 },
          ],
        }),
      ],
    })
    expect(lintConfig(cfg)).toEqual([])
  })
})

describe('CONFIG_FILE_LOCATIONS', () => {
  it('exposes the documented set of locations', () => {
    expect(CONFIG_FILE_LOCATIONS).toContain('.flagshark.yaml')
    expect(CONFIG_FILE_LOCATIONS).toContain('.flagshark.yml')
  })
})
