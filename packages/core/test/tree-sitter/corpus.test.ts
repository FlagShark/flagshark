import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { detectFlagsWithTreeSitter } from '../../src/detection/tree-sitter/engine.js'
import { defaultTypeScriptProviders } from '../../src/detection/detectors/typescript.js'
import { detectFlagsWithRegex } from '../../src/detection/helpers.js'

import type { FeatureFlagProvider, Language } from '../../src/detection/interface.js'

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/tree-sitter')

const LANGUAGES: { name: Language; providers: () => FeatureFlagProvider[] }[] = [
  { name: 'typescript', providers: defaultTypeScriptProviders },
  { name: 'javascript', providers: defaultTypeScriptProviders },  // JS reuses TS providers
]

for (const { name: language, providers } of LANGUAGES) {
  const langRoot = join(FIXTURES_ROOT, language)
  if (!existsSync(langRoot)) continue

  describe(`tree-sitter corpus / ${language}`, () => {
    for (const provider of readdirSync(langRoot)) {
      const providerRoot = join(langRoot, provider)
      const expectedPath = join(providerRoot, 'expected.json')
      if (!existsSync(expectedPath)) continue

      const cases = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Array<{
        file: string
        flags: Array<unknown>
      }>

      for (const c of cases) {
        it(`${provider} / ${c.file}`, async () => {
          const fullPath = join(providerRoot, c.file)
          const content = readFileSync(fullPath, 'utf-8')
          const detected = await detectFlagsWithTreeSitter(c.file, content, language, providers())
          expect(detected).toEqual(c.flags)
        })
      }
    }
  })
}

for (const { name: language, providers } of LANGUAGES) {
  const langRoot = join(FIXTURES_ROOT, language)
  if (!existsSync(langRoot)) continue

  describe(`regex-vs-tree-sitter parity / ${language}`, () => {
    for (const provider of readdirSync(langRoot)) {
      const providerRoot = join(langRoot, provider)
      const expectedPath = join(providerRoot, 'expected.json')
      if (!existsSync(expectedPath)) continue

      const cases = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Array<{
        file: string
        flags: Array<{ name: string; lineNumber: number }>
      }>

      // Only check positive cases — negative cases test precision wins that regex doesn't get.
      const positives = cases.filter((c) => c.file.startsWith('positive/'))

      for (const c of positives) {
        it(`${provider} / ${c.file} — both engines agree on flag names`, async () => {
          const fullPath = join(providerRoot, c.file)
          const content = readFileSync(fullPath, 'utf-8')
          const treeSitter = await detectFlagsWithTreeSitter(c.file, content, language, providers())
          const regex = detectFlagsWithRegex(c.file, content, language, providers())
          expect(treeSitter.map((f) => f.name).sort()).toEqual(regex.map((f) => f.name).sort())
        })
      }
    }
  })
}
