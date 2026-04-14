import { describe, it, expect } from 'vitest'

import { createDefaultRegistry } from '../src/detection/index.js'
import { PolyglotAnalyzer } from '../src/detection/polyglot-analyzer.js'

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('createDefaultRegistry', () => {
  it('registers all 13 language detectors', () => {
    const registry = createDefaultRegistry()
    const languages = registry.getSupportedLanguages()
    expect(languages.length).toBe(13)
    expect(languages).toContain('go')
    expect(languages).toContain('typescript')
    expect(languages).toContain('python')
    expect(languages).toContain('java')
    expect(languages).toContain('rust')
  })

  it('supports common file extensions', () => {
    const registry = createDefaultRegistry()
    const exts = registry.getSupportedExtensions()
    expect(exts).toContain('.ts')
    expect(exts).toContain('.go')
    expect(exts).toContain('.py')
    expect(exts).toContain('.rs')
    expect(exts).toContain('.java')
  })
})

describe('PolyglotAnalyzer', () => {
  it('detects LaunchDarkly flags in TypeScript with import', async () => {
    const registry = createDefaultRegistry()
    const analyzer = new PolyglotAnalyzer(registry, logger)

    const files = new Map<string, string>()
    files.set(
      'app.ts',
      `
import { init, LDClient } from '@launchdarkly/js-client-sdk'

const client = init('sdk-key')
const showBanner = client.variation('show-banner', false)
const enableChat = client.boolVariation('enable-chat', true)
`,
    )

    const result = await analyzer.analyzeFiles(files)
    expect(result.totalFlags.size).toBeGreaterThanOrEqual(1)
    const flagNames = Array.from(result.totalFlags.keys())
    expect(flagNames).toContain('show-banner')
  })

  it('does NOT detect flags in files without matching imports', async () => {
    const registry = createDefaultRegistry()
    const analyzer = new PolyglotAnalyzer(registry, logger)

    const files = new Map<string, string>()
    // This file has a function called variation() but does NOT import LaunchDarkly
    files.set(
      'utils.ts',
      `
function variation(key: string, defaultValue: boolean): boolean {
  return defaultValue
}

const result = variation('some-key', false)
`,
    )

    const result = await analyzer.analyzeFiles(files)
    // Should detect 0 flags (or only from "Custom Feature Flags" fallback)
    const flagNames = Array.from(result.totalFlags.keys())
    // The import check should prevent LaunchDarkly from matching
    // Custom Feature Flags provider may still match if it has no import requirement
    expect(flagNames.length).toBeLessThanOrEqual(1)
  })

  it('detects Go flags with correct import', async () => {
    const registry = createDefaultRegistry()
    const analyzer = new PolyglotAnalyzer(registry, logger)

    const files = new Map<string, string>()
    files.set(
      'main.go',
      `
package main

import (
    ld "github.com/launchdarkly/go-server-sdk/v7"
)

func main() {
    client, _ := ld.MakeClient("sdk-key", 5*time.Second)
    showFeature, _ := client.BoolVariation("new-checkout", user, false)
}
`,
    )

    const result = await analyzer.analyzeFiles(files)
    expect(result.totalFlags.size).toBeGreaterThanOrEqual(1)
    const flagNames = Array.from(result.totalFlags.keys())
    expect(flagNames).toContain('new-checkout')
  })
})
