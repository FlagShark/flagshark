#!/usr/bin/env node
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import * as esbuild from 'esbuild'

const require_ = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(here, '..', 'dist')
const grammarsDir = join(distDir, 'grammars')
const queriesDir = join(distDir, 'queries')

mkdirSync(grammarsDir, { recursive: true })
mkdirSync(queriesDir, { recursive: true })

// Copy WASM grammars from node_modules (resolved relative to @flagshark/core's location)
const grammars = [
  'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-javascript/tree-sitter-javascript.wasm',
  'tree-sitter-go/tree-sitter-go.wasm',
  'tree-sitter-python/tree-sitter-python.wasm',
]
for (const spec of grammars) {
  const src = require_.resolve(spec, { paths: [resolve(here, '..', '..', 'core')] })
  const filename = spec.split('/').pop()
  copyFileSync(src, join(grammarsDir, filename))
  console.log(`Copied ${spec} -> dist/grammars/${filename}`)
}

// Copy .scm query files from @flagshark/core's source
const queries = ['typescript.scm', 'javascript.scm', 'go.scm', 'python.scm']
const coreQueriesDir = resolve(here, '..', '..', 'core', 'src', 'detection', 'tree-sitter', 'queries')
for (const queryFile of queries) {
  const src = join(coreQueriesDir, queryFile)
  if (!existsSync(src)) {
    console.error(`Query file missing: ${src}`)
    process.exit(1)
  }
  copyFileSync(src, join(queriesDir, queryFile))
  console.log(`Copied ${queryFile} -> dist/queries/${queryFile}`)
}

// Bundle the action
await esbuild.build({
  entryPoints: [resolve(here, '..', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(distDir, 'action.cjs'),
})

console.log('Action bundle built')
