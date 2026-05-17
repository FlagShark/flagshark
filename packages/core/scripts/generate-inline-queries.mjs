#!/usr/bin/env node
/**
 * Generates `src/detection/tree-sitter/queries-inline.ts` from the `.scm` files
 * in `src/detection/tree-sitter/queries/`. Inlining is preferable to runtime
 * `readFileSync(import.meta.url-relative)` because the latter silently breaks
 * the moment a consumer bundles ESM->CJS (esbuild stubs `import.meta` to `{}`).
 *
 * The four query files total ~1.4KB and never need to vary per-environment, so
 * shipping them as JS string constants gives every consumer reliable detection
 * with zero filesystem dependence and zero environment variables.
 *
 * Re-run any time the `.scm` files change. Wired into the package's `build`
 * script via `prebuild`; safe to invoke directly with `bun run generate:queries`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const queriesDir = resolve(here, '..', 'src', 'detection', 'tree-sitter', 'queries')
const outFile = resolve(here, '..', 'src', 'detection', 'tree-sitter', 'queries-inline.ts')

const files = readdirSync(queriesDir)
  .filter((name) => name.endsWith('.scm'))
  .sort()

if (files.length === 0) {
  console.error('No .scm files found in', queriesDir)
  process.exit(1)
}

const langs = files.map((name) => name.replace(/\.scm$/, ''))

const body = files
  .map((file) => {
    const lang = file.replace(/\.scm$/, '')
    const text = readFileSync(join(queriesDir, file), 'utf-8')
    // Use a tagged-template-friendly string literal. JSON.stringify gives us
    // a valid JS string with all escapes correct, including newlines.
    return `  ${JSON.stringify(lang)}: ${JSON.stringify(text)},`
  })
  .join('\n')

const generated = `/**
 * GENERATED FILE -- do not edit by hand.
 *
 * Source: src/detection/tree-sitter/queries/*.scm
 * Regenerate: \`bun run generate:queries\` (also runs as part of \`bun run build\`).
 *
 * Inlining queries removes the runtime filesystem dependency that broke under
 * ESM->CJS bundling (see retrospective in parser-cache.ts).
 */

import type { Language } from '../interface.js'

export const INLINE_QUERIES: Partial<Record<Language, string>> = {
${body}
}

export const INLINE_QUERY_LANGUAGES: Language[] = ${JSON.stringify(langs)}
`

writeFileSync(outFile, generated)
console.log(`Wrote ${files.length} queries into ${outFile}`)
