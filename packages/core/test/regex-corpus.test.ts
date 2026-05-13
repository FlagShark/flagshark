import { describe, it, expect, test } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { detectFlagsWithRegex } from '../src/detection/helpers.js'

import { defaultCPPProviders } from '../src/detection/detectors/cpp.js'
import { defaultCSharpProviders } from '../src/detection/detectors/csharp.js'
import { defaultJavaProviders } from '../src/detection/detectors/java.js'
import { defaultKotlinProviders } from '../src/detection/detectors/kotlin.js'
import { defaultObjCProviders } from '../src/detection/detectors/objectivec.js'
import { defaultPHPProviders } from '../src/detection/detectors/php.js'
import { defaultRubyProviders } from '../src/detection/detectors/ruby.js'
import { defaultRustProviders } from '../src/detection/detectors/rust.js'
import { defaultSwiftProviders } from '../src/detection/detectors/swift.js'

import type { FeatureFlagProvider, Language } from '../src/detection/interface.js'

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/regex')

interface LangSpec {
  dir: string
  language: Language
  providers: () => FeatureFlagProvider[]
}

const LANGUAGES: LangSpec[] = [
  { dir: 'cpp',    language: 'cpp',     providers: defaultCPPProviders },
  { dir: 'csharp', language: 'csharp',  providers: defaultCSharpProviders },
  { dir: 'java',   language: 'java',    providers: defaultJavaProviders },
  { dir: 'kotlin', language: 'kotlin',  providers: defaultKotlinProviders },
  { dir: 'objc',   language: 'objc',    providers: defaultObjCProviders },
  { dir: 'php',    language: 'php',     providers: defaultPHPProviders },
  { dir: 'ruby',   language: 'ruby',    providers: defaultRubyProviders },
  { dir: 'rust',   language: 'rust',    providers: defaultRustProviders },
  { dir: 'swift',  language: 'swift',   providers: defaultSwiftProviders },
]

// Sentinel: keeps vitest happy before any fixture directories exist (Tasks 2.2-2.7).
describe('regex corpus', () => {
  test.todo('fixtures added in Tasks 2.2-2.7')
})

for (const { dir, language, providers } of LANGUAGES) {
  const langRoot = join(FIXTURES_ROOT, dir)
  if (!existsSync(langRoot)) continue

  describe(`regex corpus / ${language}`, () => {
    for (const provider of readdirSync(langRoot)) {
      const providerRoot = join(langRoot, provider)
      const expectedPath = join(providerRoot, 'expected.json')
      if (!existsSync(expectedPath)) continue

      const cases = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Array<{
        file: string
        flags: Array<unknown>
      }>

      for (const c of cases) {
        it(`${provider} / ${c.file}`, () => {
          const fullPath = join(providerRoot, c.file)
          const content = readFileSync(fullPath, 'utf-8')
          const detected = detectFlagsWithRegex(c.file, content, language, providers())
          expect(detected).toEqual(c.flags)
        })
      }
    }
  })
}
