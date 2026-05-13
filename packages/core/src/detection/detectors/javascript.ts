/**
 * JavaScript language feature flag detector.
 * In the Go codebase, TypeScript and JavaScript share the same detector.
 * This provides a JavaScript-specific detector that re-uses the TypeScript providers
 * but reports the language as "javascript".
 */

import { detectFlagsWithRegex } from '../helpers.js'
import { Languages } from '../interface.js'
import { detectFlagsWithTreeSitter } from '../tree-sitter/engine.js'

import { defaultTypeScriptProviders } from './typescript.js'

import type { FeatureFlag } from '../feature-flag.js'
import type { DetectorEngine, FeatureFlagProvider, Language, LanguageDetector } from '../interface.js'

export type { DetectorEngine }

export interface JavaScriptDetectorOptions {
  providers?: FeatureFlagProvider[]
  engine?: DetectorEngine
}

export class JavaScriptDetector implements LanguageDetector {
  private readonly providers: FeatureFlagProvider[]
  private readonly engine: DetectorEngine

  constructor(opts: JavaScriptDetectorOptions = {}) {
    this.providers = opts.providers ?? defaultTypeScriptProviders()
    this.engine = opts.engine ?? 'regex'
  }

  language(): Language {
    return Languages.JavaScript
  }

  fileExtensions(): string[] {
    return ['.js', '.jsx', '.mjs', '.cjs']
  }

  supportsFile(filename: string): boolean {
    const lower = filename.toLowerCase()
    const dotIdx = lower.lastIndexOf('.')
    if (dotIdx === -1) return false
    const ext = lower.slice(dotIdx + 1)
    return ['js', 'jsx', 'mjs', 'cjs'].includes(ext)
  }

  detectFlags(filename: string, content: string): FeatureFlag[] | Promise<FeatureFlag[]> {
    if (this.engine === 'tree-sitter') {
      return detectFlagsWithTreeSitter(filename, content, this.language(), this.providers)
    }
    return detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }

  getProviders(): FeatureFlagProvider[] {
    return this.providers
  }
}
