/**
 * Barrel/re-export coverage.
 * These files contain only re-exports; exercising them at the module level
 * ensures v8 counts their statements as covered.
 */
import { describe, it, expect } from 'vitest'

// src/index.ts
import * as rootBarrel from '../src/index.js'

// src/config/index.ts
import * as configBarrel from '../src/config/index.js'

// src/output/index.ts
import * as outputBarrel from '../src/output/index.js'

// src/detection/index.ts (lines 121-137 — createRegistryWithEngine)
import { createDefaultRegistry, createRegistryWithEngine } from '../src/detection/index.js'

describe('root barrel (src/index.ts)', () => {
  it('exports analyzeStaleness', () => {
    expect(typeof rootBarrel.analyzeStaleness).toBe('function')
  })
  it('exports collectFiles', () => {
    expect(typeof rootBarrel.collectFiles).toBe('function')
  })
  it('exports scanRepo', () => {
    expect(typeof rootBarrel.scanRepo).toBe('function')
  })
  it('exports buildDefaultConfig', () => {
    expect(typeof rootBarrel.buildDefaultConfig).toBe('function')
  })
  it('exports formatText', () => {
    expect(typeof rootBarrel.formatText).toBe('function')
  })
  it('exports LanguageRegistry', () => {
    expect(typeof rootBarrel.LanguageRegistry).toBe('function')
  })
  it('exports createDefaultRegistry', () => {
    expect(typeof rootBarrel.createDefaultRegistry).toBe('function')
  })
})

describe('config barrel (src/config/index.ts)', () => {
  it('exports buildDefaultConfig', () => {
    expect(typeof configBarrel.buildDefaultConfig).toBe('function')
  })
  it('exports loadConfigFile', () => {
    expect(typeof configBarrel.loadConfigFile).toBe('function')
  })
  it('exports buildExcluder', () => {
    expect(typeof configBarrel.buildExcluder).toBe('function')
  })
  it('exports expandPresets', () => {
    expect(typeof configBarrel.expandPresets).toBe('function')
  })
  it('exports FlagsharkConfigSchema', () => {
    expect(configBarrel.FlagsharkConfigSchema).toBeDefined()
  })
})

describe('output barrel (src/output/index.ts)', () => {
  it('exports formatText', () => {
    expect(typeof outputBarrel.formatText).toBe('function')
  })
  it('exports formatJson', () => {
    expect(typeof outputBarrel.formatJson).toBe('function')
  })
  it('exports formatMarkdown', () => {
    expect(typeof outputBarrel.formatMarkdown).toBe('function')
  })
  it('exports formatCsv', () => {
    expect(typeof outputBarrel.formatCsv).toBe('function')
  })
  it('exports formatSarif', () => {
    expect(typeof outputBarrel.formatSarif).toBe('function')
  })
  it('exports selectFormatter', () => {
    expect(typeof outputBarrel.selectFormatter).toBe('function')
  })
  it('exports healthEmoji', () => {
    expect(typeof outputBarrel.healthEmoji).toBe('function')
  })
  it('exports uniqueStaleCount', () => {
    expect(typeof outputBarrel.uniqueStaleCount).toBe('function')
  })
  it('exports sarifLevel', () => {
    expect(typeof outputBarrel.sarifLevel).toBe('function')
  })
})

describe('detection/index.ts — createRegistryWithEngine (lines 121-137)', () => {
  it('createDefaultRegistry returns a registry with detectors', () => {
    const reg = createDefaultRegistry()
    expect(reg.getSupportedLanguages().length).toBeGreaterThan(0)
  })

  it('createRegistryWithEngine("regex") returns a registry with detectors', () => {
    const reg = createRegistryWithEngine('regex')
    expect(reg.getSupportedLanguages().length).toBeGreaterThan(0)
  })

  it('createRegistryWithEngine("tree-sitter") returns a registry with detectors', () => {
    const reg = createRegistryWithEngine('tree-sitter')
    expect(reg.getSupportedLanguages().length).toBeGreaterThan(0)
  })

  it('createRegistryWithEngine includes all 13 language detectors', () => {
    const reg = createRegistryWithEngine('regex')
    const langs = reg.getSupportedLanguages()
    expect(langs.length).toBe(13)
  })
})
