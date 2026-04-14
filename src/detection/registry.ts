/**
 * Language detector registry.
 * Ported from Go: internal/languages/registry.go
 *
 * Maps file extensions and language identifiers to their respective detectors.
 */

import type { FeatureFlag } from './feature-flag.js'
import type { Language, LanguageDetector } from './interface.js'

export class LanguageRegistry {
  private detectors = new Map<Language, LanguageDetector>()

  /** Registers a language detector. Throws if a detector for the language is already registered. */
  register(detector: LanguageDetector): void {
    const lang = detector.language()
    if (this.detectors.has(lang)) {
      throw new Error(`detector for language ${lang} already registered`)
    }
    this.detectors.set(lang, detector)
  }

  /** Returns the detector for a specific language, or undefined if not registered. */
  getDetector(lang: Language): LanguageDetector | undefined {
    return this.detectors.get(lang)
  }

  /** Returns the appropriate detector for a file based on its extension. */
  getDetectorForFile(filename: string): LanguageDetector | undefined {
    for (const detector of this.detectors.values()) {
      if (detector.supportsFile(filename)) {
        return detector
      }
    }
    return undefined
  }

  /** Detects feature flags in a file using the appropriate language detector. */
  detectInFile(filename: string, content: string): FeatureFlag[] | null {
    const detector = this.getDetectorForFile(filename)
    if (!detector) {
      return null
    }
    return detector.detectFlags(filename, content)
  }

  /** Returns all registered languages. */
  getSupportedLanguages(): Language[] {
    return Array.from(this.detectors.keys())
  }

  /** Returns all supported file extensions (deduplicated). */
  getSupportedExtensions(): string[] {
    const extensionSet = new Set<string>()
    for (const detector of this.detectors.values()) {
      for (const ext of detector.fileExtensions()) {
        extensionSet.add(ext)
      }
    }
    return Array.from(extensionSet)
  }
}

let defaultRegistry: LanguageRegistry | null = null

/** Returns the global default registry singleton. */
export function getDefaultRegistry(): LanguageRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new LanguageRegistry()
  }
  return defaultRegistry
}

/**
 * Resets the default registry (primarily for testing).
 * @internal
 */
export function resetDefaultRegistry(): void {
  defaultRegistry = null
}
