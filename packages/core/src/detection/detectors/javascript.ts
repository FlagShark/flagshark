/**
 * JavaScript language feature flag detector.
 * In the Go codebase, TypeScript and JavaScript share the same detector.
 * This provides a JavaScript-specific detector that re-uses the TypeScript providers
 * but reports the language as "javascript".
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'

import { defaultTypeScriptProviders } from './typescript.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export class JavaScriptDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]

  constructor(providers?: FeatureFlagProvider[]) {
    this.providers = providers ?? defaultTypeScriptProviders()
  }

  language(): Language {
    return Languages.JavaScript
  }

  fileExtensions(): string[] {
    return ['.js', '.jsx', '.mjs', '.cjs']
  }

  supportsFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop()
    return ['js', 'jsx', 'mjs', 'cjs'].includes(ext ?? '')
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}
