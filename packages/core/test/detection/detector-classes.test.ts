import { describe, it, expect } from 'vitest'

import { KotlinDetector } from '../../src/detection/detectors/kotlin.js'
import { SwiftDetector } from '../../src/detection/detectors/swift.js'
import { RubyDetector } from '../../src/detection/detectors/ruby.js'
import { PHPDetector } from '../../src/detection/detectors/php.js'
import { CPPDetector } from '../../src/detection/detectors/cpp.js'
import { ObjectiveCDetector } from '../../src/detection/detectors/objectivec.js'
import { TypeScriptDetector } from '../../src/detection/detectors/typescript.js'
import { JavaScriptDetector } from '../../src/detection/detectors/javascript.js'
import { PythonDetector } from '../../src/detection/detectors/python.js'
import { JavaDetector } from '../../src/detection/detectors/java.js'

import type { FeatureFlagProvider } from '../../src/detection/interface.js'

const ALL_DETECTORS = [
  { name: 'Kotlin', cls: KotlinDetector },
  { name: 'Swift', cls: SwiftDetector },
  { name: 'Ruby', cls: RubyDetector },
  { name: 'CPP', cls: CPPDetector },
  { name: 'ObjectiveC', cls: ObjectiveCDetector },
] as const

const CUSTOM: FeatureFlagProvider[] = [
  {
    name: 'CustomTest',
    importPattern: 'custom-test',
    description: 'test provider',
    enabled: true,
    methods: [{ name: 'check', flagKeyIndex: 0, examples: ['check("x")'] }],
  },
]

describe('detector classes', () => {
  for (const { name, cls } of ALL_DETECTORS) {
    describe(name, () => {
      it('default constructor uses default providers', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        expect(d.getProviders().length).toBeGreaterThan(0)
      })

      it('custom providers replace defaults', () => {
        const d = new (cls as new (p?: FeatureFlagProvider[]) => InstanceType<typeof cls>)(CUSTOM)
        expect(d.getProviders()).toEqual(CUSTOM)
      })

      it('language() returns expected non-empty string', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        expect(typeof d.language()).toBe('string')
        expect(d.language().length).toBeGreaterThan(0)
      })

      it('fileExtensions() returns non-empty array', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        const exts = d.fileExtensions()
        expect(Array.isArray(exts)).toBe(true)
        expect(exts.length).toBeGreaterThan(0)
      })

      it('supportsFile matches at least one of its extensions', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        const ext = d.fileExtensions()[0]
        expect(d.supportsFile(`test${ext}`)).toBe(true)
      })

      it('supportsFile rejects unrelated extension', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        expect(d.supportsFile('test.unknownext')).toBe(false)
      })

      it('detectFlags returns empty array for empty content', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        const ext = d.fileExtensions()[0]
        expect(d.detectFlags(`test${ext}`, '')).toEqual([])
      })
    })
  }
})

describe('CPPDetector — supportsFile with no extension (dotIdx === -1 branch)', () => {
  it('rejects a filename with no extension', () => {
    const d = new CPPDetector()
    expect(d.supportsFile('Makefile')).toBe(false)
  })
})

describe('PHPDetector — supportsFile with no extension (dotIdx === -1 branch)', () => {
  it('rejects a filename with no extension', () => {
    const d = new PHPDetector()
    expect(d.supportsFile('Makefile')).toBe(false)
  })
})

describe('TypeScriptDetector — supportsFile with no extension (dotIdx === -1 branch)', () => {
  it('rejects a filename with no extension', () => {
    const d = new TypeScriptDetector()
    expect(d.supportsFile('Makefile')).toBe(false)
  })
})

describe('JavaScriptDetector — supportsFile with no extension (dotIdx === -1 branch)', () => {
  it('rejects a filename with no extension', () => {
    const d = new JavaScriptDetector()
    expect(d.supportsFile('Makefile')).toBe(false)
  })
})

describe('PythonDetector — supportsFile with no extension (dotIdx === -1 branch)', () => {
  it('rejects a filename with no extension', () => {
    const d = new PythonDetector()
    expect(d.supportsFile('requirements')).toBe(false)
  })
})

describe('RubyDetector special file types', () => {
  it('supports Rakefile (no extension)', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('Rakefile')).toBe(true)
  })

  it('supports Gemfile (no extension)', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('Gemfile')).toBe(true)
  })

  it('supports .gemspec', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('lib/foo.gemspec')).toBe(true)
  })

  it('supports .rake', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('tasks/foo.rake')).toBe(true)
  })

  it('rejects file with no extension and non-special name', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('README')).toBe(false)
  })

  it('supports Rakefile with a directory path prefix (slashIdx !== -1 branch)', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('tasks/Rakefile')).toBe(true)
  })

  it('supports Gemfile with a directory path prefix', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('config/Gemfile')).toBe(true)
  })
})

describe('OpenFeature detection', () => {
  const cases = [
    {
      lang: 'TypeScript',
      detector: () => new TypeScriptDetector(),
      file: 'app.ts',
      src: `import { OpenFeature } from '@openfeature/server-sdk'\nconst c = OpenFeature.getClient()\nif (await c.getBooleanValue("new-checkout", false)) { go() }\n`,
    },
    {
      lang: 'Python',
      detector: () => new PythonDetector(),
      file: 'app.py',
      src: `from openfeature import api\nc = api.get_client()\nif c.get_boolean_value("new-checkout", False):\n    go()\n`,
    },
    {
      lang: 'Java',
      detector: () => new JavaDetector(),
      file: 'App.java',
      src: `import dev.openfeature.sdk.Client;\nboolean v = client.getBooleanValue("new-checkout", false);\n`,
    },
    {
      lang: 'Kotlin',
      detector: () => new KotlinDetector(),
      file: 'App.kt',
      src: `import dev.openfeature.sdk.Client\nval v = client.getBooleanValue("new-checkout", false)\n`,
    },
  ]

  for (const { lang, detector, file, src } of cases) {
    it(`detects an OpenFeature flag in ${lang}`, async () => {
      const flags = await detector().detectFlags(file, src)
      const flag = flags.find((f) => f.name === 'new-checkout')
      expect(flag, `no new-checkout flag detected in ${lang}`).toBeTruthy()
      // The emitted provider must contain "openfeature" so the cleanup-side
      // slug normaliser routes it to the OpenFeature provider config.
      expect(flag?.provider?.toLowerCase()).toContain('openfeature')
    })
  }
})

describe('Objective-C message-syntax detection', () => {
  // Obj-C uses `[receiver method:@"key" other:val]` message syntax, not the
  // `method(args)` paren-call syntax every other language uses. The shared
  // regex helper keyed off `(`, so these all silently returned zero flags.
  const cases = [
    {
      name: 'LaunchDarkly boolVariation',
      src: `#import <LaunchDarkly/LDClient.h>\n- (void)gate {\n  BOOL show = [[LDClient get] boolVariation:@"new-checkout" defaultValue:NO];\n}\n`,
      key: 'new-checkout',
    },
    {
      name: 'PostHog isFeatureEnabled',
      src: `#import <PostHog/PostHog.h>\nBOOL on = [[PHGPostHog sharedInstance] isFeatureEnabled:@"beta-banner"];\n`,
      key: 'beta-banner',
    },
    {
      name: 'Optimizely with trailing selector args',
      src: `#import <Optimizely/Optimizely.h>\nBOOL e = [optimizely isFeatureEnabled:@"price-test" userId:userId attributes:nil];\n`,
      key: 'price-test',
    },
  ]
  for (const { name, src, key } of cases) {
    it(`detects ${name}`, () => {
      const flags = new ObjectiveCDetector().detectFlags('Legacy.m', src)
      expect(flags.find((f) => f.name === key), `no ${key} flag detected`).toBeTruthy()
    })
  }

  it('does not let a method name match a longer selector it prefixes', () => {
    // `boolVariation` must not also fire inside `boolVariationForKey:`
    const src = `#import <LaunchDarkly/LDClient.h>\nBOOL v = [[LDClient get] boolVariationForKey:@"only-once" defaultValue:NO];\n`
    const flags = new ObjectiveCDetector().detectFlags('Legacy.m', src)
    expect(flags.filter((f) => f.name === 'only-once').length).toBe(1)
  })

  it('requires the SDK import (no false positive without it)', () => {
    const src = `BOOL show = [[LDClient get] boolVariation:@"unimported" defaultValue:NO];\n`
    const flags = new ObjectiveCDetector().detectFlags('Legacy.m', src)
    expect(flags.find((f) => f.name === 'unimported')).toBeFalsy()
  })

  it('skips disabled providers', () => {
    const providers: FeatureFlagProvider[] = [
      {
        name: 'Disabled Obj-C',
        importPattern: 'X/X.h',
        description: '',
        enabled: false,
        methods: [{ name: 'isFeatureEnabled', flagKeyIndex: 0, examples: [] }],
      },
    ]
    const src = `#import <X/X.h>\nBOOL v = [x isFeatureEnabled:@"should-not-detect"];\n`
    const flags = new ObjectiveCDetector(providers).detectFlags('Legacy.m', src)
    expect(flags).toEqual([])
  })

  it('ignores invalid flag keys (e.g. whitespace)', () => {
    const src = `#import <LaunchDarkly/LDClient.h>\nBOOL v = [[LDClient get] boolVariation:@"bad key with spaces" defaultValue:NO];\n`
    const flags = new ObjectiveCDetector().detectFlags('Legacy.m', src)
    expect(flags.find((f) => f.name.includes('bad key'))).toBeFalsy()
  })
})
