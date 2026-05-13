import { describe, it, expect } from 'vitest'

import { JavaDetector } from '../../src/detection/detectors/java.js'
import { KotlinDetector } from '../../src/detection/detectors/kotlin.js'
import { SwiftDetector } from '../../src/detection/detectors/swift.js'
import { RubyDetector } from '../../src/detection/detectors/ruby.js'
import { CSharpDetector } from '../../src/detection/detectors/csharp.js'
import { PHPDetector } from '../../src/detection/detectors/php.js'
import { RustDetector } from '../../src/detection/detectors/rust.js'
import { CPPDetector } from '../../src/detection/detectors/cpp.js'
import { ObjectiveCDetector } from '../../src/detection/detectors/objectivec.js'

import type { FeatureFlagProvider } from '../../src/detection/interface.js'

const ALL_DETECTORS = [
  { name: 'Java', cls: JavaDetector },
  { name: 'Kotlin', cls: KotlinDetector },
  { name: 'Swift', cls: SwiftDetector },
  { name: 'Ruby', cls: RubyDetector },
  { name: 'CSharp', cls: CSharpDetector },
  { name: 'PHP', cls: PHPDetector },
  { name: 'Rust', cls: RustDetector },
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
})
