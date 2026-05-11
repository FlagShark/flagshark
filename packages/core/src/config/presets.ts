import type { PresetName } from './schema.js'

/**
 * Built-in exclude presets. Each preset expands to a list of gitignore-style
 * glob patterns that match common conventions for that category.
 *
 * Test-files patterns are derived from the private flag-shark monorepo's
 * `packages/shared/lib/test-files.ts` `isTestFile()` helper — credit there.
 */
export const PRESETS: Readonly<Record<PresetName, readonly string[]>> = Object.freeze({
  'test-files': Object.freeze([
    // JavaScript / TypeScript
    '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
    '**/*.test.mjs', '**/*.test.cjs',
    '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
    // Go
    '**/*_test.go',
    // Python
    '**/*_test.py', '**/test_*.py',
    // Java / Kotlin
    '**/*Test.java', '**/*Tests.java', '**/*Test.kt', '**/*Tests.kt',
    // Swift
    '**/*Tests.swift',
    // Ruby
    '**/*_spec.rb', '**/spec/**/*.rb',
    // C# / .NET
    '**/*Test.cs', '**/*Tests.cs',
    // PHP
    '**/*Test.php',
    // Rust
    '**/tests/**',
    // Directories that always indicate tests
    '**/__tests__/**', '**/test/**',
  ]),
  'snapshots': Object.freeze([
    '**/*.snap',
    '**/__snapshots__/**',
  ]),
  'examples': Object.freeze([
    'examples/**', 'example/**',
    'demo/**', 'demos/**',
  ]),
  'stories': Object.freeze([
    '**/*.stories.ts', '**/*.stories.tsx',
    '**/*.stories.js', '**/*.stories.jsx',
    '**/*.story.ts', '**/*.story.tsx',
  ]),
  'fixtures': Object.freeze([
    '**/__fixtures__/**', '**/fixtures/**',
  ]),
  'generated': Object.freeze([
    '**/*.generated.ts', '**/*.generated.js',
    '**/*.gen.go', '**/generated/**',
  ]),
})

export function expandPresets(names: readonly PresetName[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const patterns = PRESETS[name]
    if (!patterns) continue
    for (const pattern of patterns) {
      if (!seen.has(pattern)) {
        seen.add(pattern)
        out.push(pattern)
      }
    }
  }
  return out
}
