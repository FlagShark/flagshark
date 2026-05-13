import ignoreModule from 'ignore'

import { expandPresets } from './presets.js'

import type { FlagsharkConfig } from './schema.js'

/* v8 ignore next -- CJS/ESM interop shim; one branch is always taken depending on bundler */
const ignore = (ignoreModule as unknown as { default?: typeof ignoreModule }).default ?? ignoreModule

export interface EffectiveRules {
  paths: string[]
  files: string[]
  presets: string[]
  presetPatterns: string[]
  ignoreFile: string[]
}

export interface Excluder {
  shouldExclude(path: string): boolean
  effectiveRules: EffectiveRules
}

export interface BuildExcluderInput {
  config: FlagsharkConfig
  ignoreFilePatterns: string[]
}

/**
 * Convert trailing-slash directory patterns (`examples/`) to recursive globs
 * (`examples/**`) so that `!`-negation works downstream.
 *
 * The `ignore@5` package follows the strict gitignore spec: once a parent
 * directory is excluded via a trailing-slash pattern, files inside it cannot
 * be re-included via `!`. Converting to `examples/**` bypasses this restriction
 * by treating the pattern as a glob rather than a directory match.
 *
 * Trade-off: `examples/**` is anchored to the repo root, while gitignore's
 * `examples/` is unanchored (matches `examples/` anywhere in the tree).
 * In practice the scanner's hardcoded SKIP_DIRS already filters node_modules,
 * vendor, etc., so this anchoring change rarely affects real users — but it
 * is a deliberate departure from strict gitignore semantics.
 */
function normalisePattern(p: string): string {
  if (!p.startsWith('!') && p.endsWith('/')) {
    return p + '**'
  }
  return p
}

export function buildExcluder(input: BuildExcluderInput): Excluder {
  const { config, ignoreFilePatterns } = input

  const presetPatterns = expandPresets(config.excludes.presets)

  const allPatterns: string[] = [
    ...config.excludes.paths,
    ...config.excludes.files,
    ...presetPatterns,
    ...ignoreFilePatterns,
  ]

  const matcher = ignore().add(allPatterns.map(normalisePattern))

  return {
    shouldExclude(path: string): boolean {
      if (allPatterns.length === 0) return false
      const normalised = path.startsWith('./') ? path.slice(2) : path
      return matcher.ignores(normalised)
    },
    effectiveRules: {
      paths: [...config.excludes.paths],
      files: [...config.excludes.files],
      presets: [...config.excludes.presets],
      presetPatterns,
      ignoreFile: [...ignoreFilePatterns],
    },
  }
}
