import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, it, expect } from 'vitest'

import {
  buildImportGraph,
  extractImports,
  isTsJsFile,
  loadTsconfigAliases,
  resolveAliasedImport,
  resolveImportPath,
} from '../../src/detection/import-graph.js'

// ── extractImports ─────────────────────────────────────────────────────────

describe('extractImports', () => {
  it('extracts plain ESM imports', () => {
    const src = `import 'foo'\nimport { a } from 'bar'\nimport * as x from "baz"`
    expect(extractImports(src)).toEqual(['foo', 'bar', 'baz'])
  })

  it('extracts type-only imports', () => {
    const src = `import type { A } from './types'\nimport type * as t from 'foo'`
    expect(extractImports(src)).toEqual(['./types', 'foo'])
  })

  it('extracts default + named combos', () => {
    const src = `import x, { a, b } from 'foo'`
    expect(extractImports(src)).toEqual(['foo'])
  })

  it('extracts CJS requires', () => {
    const src = `const x = require('foo')\nrequire('bar')`
    expect(extractImports(src)).toEqual(['foo', 'bar'])
  })

  it('extracts dynamic imports', () => {
    const src = `const x = await import('foo')\nawait import('./local')`
    expect(extractImports(src)).toEqual(['foo', './local'])
  })

  it('deduplicates specifiers across patterns', () => {
    const src = `import 'foo'\nrequire('foo')\nawait import('foo')`
    expect(extractImports(src)).toEqual(['foo'])
  })

  it('does not match require/import on a member expression', () => {
    // foo.require('bar') and foo.import('bar') are user code, not Node CJS / dynamic ESM.
    const src = `foo.require('bar')\nobj.import('baz')`
    expect(extractImports(src)).toEqual([])
  })

  it('returns empty for files with no imports', () => {
    expect(extractImports('const x = 1\nfunction foo() {}')).toEqual([])
  })

  it('handles import statement with mixed whitespace', () => {
    const src = `\t  import   { a }   from   'foo'`
    expect(extractImports(src)).toEqual(['foo'])
  })

  it('resets regex lastIndex between calls (stateful-RegExp regression)', () => {
    const src = `import 'a'\nimport 'b'`
    expect(extractImports(src)).toEqual(['a', 'b'])
    // Call again — should not be affected by the previous run's lastIndex.
    expect(extractImports(src)).toEqual(['a', 'b'])
  })
})

// ── resolveImportPath ──────────────────────────────────────────────────────

describe('resolveImportPath', () => {
  it('returns null for bare specifiers', () => {
    const files = new Set(['/repo/foo.ts'])
    expect(resolveImportPath('/repo/a.ts', 'foo', files)).toBeNull()
    expect(resolveImportPath('/repo/a.ts', '@scope/pkg', files)).toBeNull()
  })

  it('resolves exact relative paths', () => {
    const files = new Set(['/repo/foo.ts', '/repo/b.ts'])
    expect(resolveImportPath('/repo/b.ts', './foo.ts', files)).toBe('/repo/foo.ts')
  })

  it('resolves relative paths with extension fallback', () => {
    const files = new Set(['/repo/foo.ts'])
    expect(resolveImportPath('/repo/b.ts', './foo', files)).toBe('/repo/foo.ts')
  })

  it('prefers .ts over .js when both exist (TS resolution priority)', () => {
    const files = new Set(['/repo/foo.ts', '/repo/foo.js'])
    expect(resolveImportPath('/repo/b.ts', './foo', files)).toBe('/repo/foo.ts')
  })

  it('resolves to /index.ts when target is a directory', () => {
    const files = new Set(['/repo/foo/index.ts'])
    expect(resolveImportPath('/repo/b.ts', './foo', files)).toBe('/repo/foo/index.ts')
  })

  it('resolves .js specifiers to .ts files (verbatimModuleSyntax / NodeNext)', () => {
    const files = new Set(['/repo/foo.ts'])
    expect(resolveImportPath('/repo/b.ts', './foo.js', files)).toBe('/repo/foo.ts')
  })

  it('resolves .jsx specifiers to .tsx files', () => {
    const files = new Set(['/repo/Button.tsx'])
    expect(resolveImportPath('/repo/App.tsx', './Button.jsx', files)).toBe('/repo/Button.tsx')
  })

  it('falls through to the SECOND extension replacement when the first does not exist', () => {
    // For `.js` the replacement list is `['.ts', '.tsx']`. When only the
    // `.tsx` source exists (no `.ts`), resolution must walk past the first
    // candidate and pick the second. Coverage gate for the second loop
    // iteration in resolveImportPath's emittedToSourceExt block.
    const files = new Set(['/repo/foo.tsx'])
    expect(resolveImportPath('/repo/b.ts', './foo.js', files)).toBe('/repo/foo.tsx')
  })

  it('returns null when no extension swap candidate exists', () => {
    // `.cjs` import with no matching `.cts` / `.cjs` file in the set —
    // walks the whole replacement list and returns null.
    const files = new Set(['/repo/other.ts'])
    expect(resolveImportPath('/repo/b.ts', './missing.cjs', files)).toBeNull()
  })

  it('handles parent-directory relative paths', () => {
    const files = new Set(['/repo/src/utils/foo.ts'])
    expect(resolveImportPath('/repo/src/components/A.ts', '../utils/foo', files)).toBe(
      '/repo/src/utils/foo.ts',
    )
  })

  it('returns null when no candidate exists in fileSet', () => {
    const files = new Set(['/repo/foo.ts'])
    expect(resolveImportPath('/repo/b.ts', './missing', files)).toBeNull()
  })
})

// ── isTsJsFile ─────────────────────────────────────────────────────────────

describe('isTsJsFile', () => {
  it.each([
    ['/a/b.ts', true],
    ['/a/b.tsx', true],
    ['/a/b.js', true],
    ['/a/b.jsx', true],
    ['/a/b.mjs', true],
    ['/a/b.cjs', true],
    ['/a/b.mts', true],
    ['/a/b.cts', true],
    ['/a/b.py', false],
    ['/a/b.go', false],
    ['/a/B.TS', true], // case-insensitive
    ['/a/no-ext', false],
  ])('isTsJsFile(%s) -> %s', (path, expected) => {
    expect(isTsJsFile(path)).toBe(expected)
  })
})

// ── buildImportGraph ───────────────────────────────────────────────────────

const tsJsHelper = { isTsJs: isTsJsFile }

describe('buildImportGraph', () => {
  it('marks a file that directly imports an SDK', () => {
    const files = new Map([
      ['/r/a.ts', `import { foo } from 'unleash-client'`],
      ['/r/b.ts', `console.log('unrelated')`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/a.ts')).toEqual(new Set(['unleash-client']))
    expect(transitiveSdks.has('/r/b.ts')).toBe(false)
  })

  it('marks a one-hop wrapper consumer', () => {
    const files = new Map([
      ['/r/sdk.ts', `import 'unleash-client'\nexport const isOn = (k: string) => true`],
      ['/r/use.ts', `import { isOn } from './sdk'\nisOn('x')`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/sdk.ts')).toEqual(new Set(['unleash-client']))
    expect(transitiveSdks.get('/r/use.ts')).toEqual(new Set(['unleash-client']))
  })

  it('propagates through multi-hop chains', () => {
    // a -> b -> c -> sdk
    const files = new Map([
      ['/r/sdk.ts', `import 'posthog-js'`],
      ['/r/c.ts', `import './sdk'`],
      ['/r/b.ts', `import './c'`],
      ['/r/a.ts', `import './b'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['posthog-js'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/a.ts')).toEqual(new Set(['posthog-js']))
    expect(transitiveSdks.get('/r/b.ts')).toEqual(new Set(['posthog-js']))
    expect(transitiveSdks.get('/r/c.ts')).toEqual(new Set(['posthog-js']))
  })

  it('terminates on cyclic imports', () => {
    // a <-> b, neither imports the SDK
    const files = new Map([
      ['/r/a.ts', `import './b'`],
      ['/r/b.ts', `import './a'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.size).toBe(0) // no SDK reach
  })

  it('handles cycles that include the seed', () => {
    // a -> b -> sdk, plus b -> a (cycle), plus a -> sdk-helper -> sdk
    const files = new Map([
      ['/r/sdk.ts', `import 'unleash-client'`],
      ['/r/a.ts', `import './b'\nimport './h'`],
      ['/r/b.ts', `import './sdk'\nimport './a'`],
      ['/r/h.ts', `import './sdk'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/sdk.ts')).toEqual(new Set(['unleash-client']))
    expect(transitiveSdks.get('/r/a.ts')).toEqual(new Set(['unleash-client']))
    expect(transitiveSdks.get('/r/b.ts')).toEqual(new Set(['unleash-client']))
    expect(transitiveSdks.get('/r/h.ts')).toEqual(new Set(['unleash-client']))
  })

  it('unions multiple SDKs across paths', () => {
    // a -> b (unleash), a -> c (posthog-js)
    const files = new Map([
      ['/r/b.ts', `import 'unleash-client'`],
      ['/r/c.ts', `import 'posthog-js'`],
      ['/r/a.ts', `import './b'\nimport './c'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client', 'posthog-js'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/a.ts')).toEqual(new Set(['unleash-client', 'posthog-js']))
  })

  it('matches subpath SDK imports (sdk/lib/foo)', () => {
    const files = new Map([
      ['/r/a.ts', `import { x } from 'launchdarkly-node-server-sdk/lib/strategy'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['launchdarkly-node-server-sdk'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/a.ts')).toEqual(new Set(['launchdarkly-node-server-sdk']))
  })

  it('does NOT mark a file whose SDK substring appears in an unrelated place', () => {
    // The SDK string "unleash-client" appears in a comment, not an import.
    // We only look at import specifiers, so this file should not be in scope.
    const files = new Map([
      ['/r/a.ts', `// TODO: try unleash-client one day\nconst x = 1`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.has('/r/a.ts')).toBe(false)
  })

  it('skips non-TS/JS files', () => {
    const files = new Map([
      ['/r/a.py', `import unleash-client`],
      ['/r/b.go', `import "unleash-client"`],
    ])
    const { transitiveSdks, stats } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.size).toBe(0)
    expect(stats.filesWalked).toBe(0)
  })

  it('reports honest stats', () => {
    const files = new Map([
      ['/r/sdk.ts', `import 'unleash-client'`],
      ['/r/use.ts', `import './sdk'`],
      ['/r/dead.ts', `import './nonexistent'`],
      ['/r/lone.ts', `const x = 1`],
    ])
    const { stats } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      ...tsJsHelper,
    })
    expect(stats.filesWalked).toBe(4)
    expect(stats.seedFiles).toBe(1) // only sdk.ts
    expect(stats.inScopeFiles).toBe(2) // sdk.ts + use.ts
    expect(stats.edgesResolved).toBe(1) // use.ts -> sdk.ts
    expect(stats.edgesUnresolved).toBe(1) // dead.ts -> nonexistent
  })

  it('preserves separate SDK sets when wrappers reach different SDKs', () => {
    // Two independent subtrees — make sure SDK A's reach doesn't leak to SDK B's tree.
    const files = new Map([
      ['/r/a-sdk.ts', `import 'unleash-client'`],
      ['/r/a-use.ts', `import './a-sdk'`],
      ['/r/b-sdk.ts', `import 'posthog-js'`],
      ['/r/b-use.ts', `import './b-sdk'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client', 'posthog-js'],
      ...tsJsHelper,
    })
    expect(transitiveSdks.get('/r/a-use.ts')).toEqual(new Set(['unleash-client']))
    expect(transitiveSdks.get('/r/b-use.ts')).toEqual(new Set(['posthog-js']))
  })
})

// ── Path alias resolution (B1 — tsconfig.json compilerOptions.paths) ────────
//
// Real-world TS monorepos route imports through alias prefixes like `@/foo`
// → `src/foo`. Pre-fix this was a documented recall gap; wrapper detection
// stopped at every aliased boundary. These tests pin the new contract.

describe('loadTsconfigAliases', () => {
  let tmpRoot: string
  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  function setup(tsconfigContent: string): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'flagshark-tsconfig-test-'))
    writeFileSync(join(tmpRoot, 'tsconfig.json'), tsconfigContent, 'utf-8')
    return tmpRoot
  }

  it('returns null when no tsconfig.json exists', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'flagshark-tsconfig-test-'))
    expect(loadTsconfigAliases(tmpRoot)).toBeNull()
  })

  it('returns null when tsconfig has no compilerOptions.paths', () => {
    const root = setup(`{
      "compilerOptions": { "target": "ES2022" }
    }`)
    expect(loadTsconfigAliases(root)).toBeNull()
  })

  it('loads a typical @/* alias', () => {
    const root = setup(`{
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["src/*"] }
      }
    }`)
    const aliases = loadTsconfigAliases(root)
    expect(aliases).not.toBeNull()
    expect(aliases!.paths.get('@/*')).toEqual(['src/*'])
    expect(aliases!.baseUrl).toBe(root)
  })

  it('strips JSONC line and block comments before parsing', () => {
    // tsconfig.json is JSONC — JSON.parse rejects comments; we strip them.
    const root = setup(`{
      // top-level line comment
      "compilerOptions": {
        /* block comment */
        "baseUrl": ".",
        "paths": {
          "@/*": ["src/*"] // trailing line comment
        }
      }
    }`)
    expect(loadTsconfigAliases(root)?.paths.get('@/*')).toEqual(['src/*'])
  })

  it('does not strip comment syntax that appears inside string values', () => {
    // The stripper tracks "inside-string" state to avoid mangling values
    // like URLs. Pin that contract.
    const root = setup(`{
      "compilerOptions": {
        "paths": {
          "@http/*": ["http://example.com/*"]
        }
      }
    }`)
    // The value should arrive verbatim, with the // intact.
    expect(loadTsconfigAliases(root)?.paths.get('@http/*')).toEqual([
      'http://example.com/*',
    ])
  })

  it('walks upward to find the nearest tsconfig.json', () => {
    const root = setup(`{
      "compilerOptions": { "paths": { "@/*": ["src/*"] } }
    }`)
    const nestedDir = join(root, 'packages', 'foo')
    mkdirSync(nestedDir, { recursive: true })
    // No tsconfig in nestedDir; loader walks up to root.
    expect(loadTsconfigAliases(nestedDir)?.paths.get('@/*')).toEqual(['src/*'])
  })

  it('returns null when tsconfig.json is malformed JSON', () => {
    // JSONC stripper handles comments; everything else must still be valid
    // JSON. A truly broken file (unclosed string, dangling comma in array)
    // should yield null rather than throwing into the caller.
    const root = setup(`{ "compilerOptions": { "paths": { "@/*": ["src/*",`)
    expect(loadTsconfigAliases(root)).toBeNull()
  })

  it('returns null when tsconfig.json cannot be read', () => {
    // Coverage gate for the fs.readFileSync error path. Setting up a path
    // where the "tsconfig.json" is actually a directory makes fs throw EISDIR.
    tmpRoot = mkdtempSync(join(tmpdir(), 'flagshark-tsconfig-test-'))
    mkdirSync(join(tmpRoot, 'tsconfig.json'))
    expect(loadTsconfigAliases(tmpRoot)).toBeNull()
  })

  it('preserves escaped characters inside string values when stripping comments', () => {
    // The JSONC stripper steps over `\X` escape sequences when inside a
    // string so that an escaped quote `\"` doesn't accidentally toggle the
    // in-string flag. Pin that contract — without it `\"//\"` inside a
    // value would terminate the string and the stripper would treat the
    // remainder as a line comment.
    const root = setup(`{
      "compilerOptions": {
        "paths": {
          "@msg/*": ["src/quoted-\\"path\\"/*"]
        }
      }
    }`)
    expect(loadTsconfigAliases(root)?.paths.get('@msg/*')).toEqual([
      'src/quoted-"path"/*',
    ])
  })
})

describe('resolveAliasedImport', () => {
  // Aliases pointing at "src/*" with baseUrl /repo.
  const aliases = {
    baseUrl: '/repo',
    paths: new Map([
      ['@/*', ['src/*']],
      ['@lib/*', ['src/lib/*', 'vendor/lib/*']],
      ['@exact', ['src/exact-target.ts']],
    ]),
  }

  it('resolves a typical @/* alias to its concrete file', () => {
    const fileSet = new Set(['/repo/src/feature.ts'])
    expect(resolveAliasedImport('@/feature', aliases, fileSet)).toBe('/repo/src/feature.ts')
  })

  it('falls through targets in order until one resolves', () => {
    // src/lib/foo doesn't exist; vendor/lib/foo does.
    const fileSet = new Set(['/repo/vendor/lib/foo.ts'])
    expect(resolveAliasedImport('@lib/foo', aliases, fileSet)).toBe('/repo/vendor/lib/foo.ts')
  })

  it('resolves an exact (non-wildcard) alias', () => {
    const fileSet = new Set(['/repo/src/exact-target.ts'])
    expect(resolveAliasedImport('@exact', aliases, fileSet)).toBe('/repo/src/exact-target.ts')
  })

  it('returns null when exact alias matches but target file is absent from the set', () => {
    // Coverage gate for the exact-match branch falling through the for-loop
    // without finding a real file. The wildcard variant has its own test;
    // this one nails the non-wildcard symmetry.
    expect(resolveAliasedImport('@exact', aliases, new Set())).toBeNull()
  })

  it('skips wildcard-alias targets that are not themselves wildcards', () => {
    // A wildcard alias like `@foo/*` whose target list contains a
    // non-wildcard entry must skip that target and continue trying the
    // remaining ones. Real tsconfigs occasionally mix the two shapes;
    // we should tolerate them rather than producing a misleading match.
    const mixed = {
      baseUrl: '/repo',
      paths: new Map([['@foo/*', ['src/single.ts', 'src/foo/*']]]),
    }
    const fileSet = new Set(['/repo/src/foo/bar.ts'])
    // 'src/single.ts' is skipped (doesn't end with /*); 'src/foo/*' matches.
    expect(resolveAliasedImport('@foo/bar', mixed, fileSet)).toBe('/repo/src/foo/bar.ts')
  })

  it('matches a wildcard-alias key on its bare prefix (`@` for `@/*`)', () => {
    // The wildcard branch supports both `@/foo` (prefix + rest) and `@`
    // alone (specifier === dotPrefix). Coverage gate for the second
    // disjunct of `!specifier.startsWith(prefix) && specifier !== dotPrefix`.
    const wildcardOnly = {
      baseUrl: '/repo',
      paths: new Map([['@/*', ['src/*']]]),
    }
    // Specifier is just `@` (the bare prefix). With `rest === ''`, the
    // resolution lands at `<baseUrl>/<targetPrefix>` (i.e. /repo/src),
    // which only resolves via /index.<ext> fallback inside tryResolveExisting.
    const fileSet = new Set(['/repo/src/index.ts'])
    expect(resolveAliasedImport('@', wildcardOnly, fileSet)).toBe('/repo/src/index.ts')
  })

  it('returns null for bare specifiers that do not match any alias', () => {
    expect(resolveAliasedImport('lodash', aliases, new Set())).toBeNull()
    expect(resolveAliasedImport('react/jsx-runtime', aliases, new Set())).toBeNull()
  })

  it('returns null when alias matches but target file does not exist', () => {
    expect(resolveAliasedImport('@/missing', aliases, new Set())).toBeNull()
  })

  it('honors extension fallback (alias points at extension-less path)', () => {
    const fileSet = new Set(['/repo/src/api.tsx'])
    expect(resolveAliasedImport('@/api', aliases, fileSet)).toBe('/repo/src/api.tsx')
  })

  it('honors /index.* fallback for directory imports through an alias', () => {
    const fileSet = new Set(['/repo/src/utils/index.ts'])
    expect(resolveAliasedImport('@/utils', aliases, fileSet)).toBe('/repo/src/utils/index.ts')
  })
})

describe('buildImportGraph — with path aliases (B1 wrapper-recall fix)', () => {
  it('follows an aliased import through to the SDK', () => {
    // The pattern this fixes: consumer file uses `@/lib/flags`, which the
    // alias resolves to `src/lib/flags.ts`, which itself does
    // `import 'unleash-client'`. Pre-fix the consumer was invisible to
    // wrapper detection because resolveImportPath returned null on `@/`.
    const files = new Map([
      ['/repo/src/lib/flags.ts', `import 'unleash-client'`],
      ['/repo/src/feature.ts', `import { foo } from '@/lib/flags'\nfoo()`],
    ])
    const aliases = {
      baseUrl: '/repo',
      paths: new Map([['@/*', ['src/*']]]),
    }
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      isTsJs: isTsJsFile,
      aliases,
    })
    expect(transitiveSdks.get('/repo/src/feature.ts')).toEqual(new Set(['unleash-client']))
  })

  it('still works on relative imports when no aliases are passed', () => {
    // Regression guard — making the path optional must not break the
    // existing non-aliased path. Same fixture, no aliases.
    const files = new Map([
      ['/r/sdk.ts', `import 'unleash-client'`],
      ['/r/use.ts', `import { isOn } from './sdk'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      isTsJs: isTsJsFile,
    })
    expect(transitiveSdks.get('/r/use.ts')).toEqual(new Set(['unleash-client']))
  })

  it('does not count unmatched bare specifiers as unresolved edges', () => {
    // Pre-fix, every `import 'lodash'` would inflate edgesUnresolved
    // because the resolver was called on it. Verify the stat stays clean.
    const files = new Map([
      ['/r/a.ts', `import 'lodash'\nimport './b'`],
      ['/r/b.ts', `console.log('x')`],
    ])
    const { stats } = buildImportGraph(files, {
      seedSdkPatterns: ['unleash-client'],
      isTsJs: isTsJsFile,
      aliases: { baseUrl: '/r', paths: new Map([['@/*', ['src/*']]]) },
    })
    // lodash is bare-and-unaliased; should NOT count as unresolved.
    // ./b is relative and resolves; counts as resolved.
    expect(stats.edgesResolved).toBe(1)
    expect(stats.edgesUnresolved).toBe(0)
  })
})

// ── Python import extraction + resolution (B4) ──────────────────────────────
//
// Mirrors the TS/JS section above for Python wrapper codebases. Real-world
// scenario: a PostHog Python wrapper that consumer files import via dotted
// module paths, where the wrapper itself does `import posthog`. Pre-fix the
// graph was TS/JS-only and these consumers were invisible.

import {
  extractPythonImports,
  isPythonFile,
  isScannedSourceFile,
  resolvePythonImport,
} from '../../src/detection/import-graph.js'

describe('extractPythonImports', () => {
  it('extracts simple `import X` statements', () => {
    const src = 'import os\nimport sys\nimport posthog'
    expect(extractPythonImports(src)).toEqual(['os', 'sys', 'posthog'])
  })

  it('extracts `import X as Y` (returns module path, not alias)', () => {
    const src = 'import numpy as np\nimport posthog as ph'
    // The graph cares about the module path; the local alias is a naming
    // detail that doesn't affect SDK seed matching.
    expect(extractPythonImports(src)).toEqual(['numpy', 'posthog'])
  })

  it('extracts `from X import Y`', () => {
    const src = 'from posthog.client import Client\nfrom os.path import join'
    expect(extractPythonImports(src)).toEqual(['posthog.client', 'os.path'])
  })

  it('extracts relative imports with leading dots', () => {
    const src = `from . import utils
from .helpers import featureFlag
from ..lib import client
from ...common import metrics`
    expect(extractPythonImports(src)).toEqual([
      '.',
      '.helpers',
      '..lib',
      '...common',
    ])
  })

  it('splits multi-import on commas', () => {
    const src = 'import a, b, c'
    expect(extractPythonImports(src)).toEqual(['a', 'b', 'c'])
  })

  it('matches indented imports too (recall over conditional-import filtering)', () => {
    // Initial design considered skipping indented (conditional) imports to
    // avoid `try: import X except ImportError: import Y` fallback noise.
    // But the recall hit outweighs the noise: indented conditional imports
    // are genuinely how some flag SDKs are pulled in (test gating,
    // env-specific fallbacks). Match them and let SDK seed comparison
    // filter to relevance.
    const src = `if condition:
    import optional_module
import unconditional`
    expect(extractPythonImports(src)).toEqual(['optional_module', 'unconditional'])
  })

  it('returns empty for files with no Python imports', () => {
    expect(extractPythonImports('def main():\n    return 1\n')).toEqual([])
  })

  it('deduplicates module paths seen multiple times', () => {
    // `from X import Y` captures the MODULE path X, not X.Y -- because the
    // graph cares about which modules a file reaches, not which names it
    // imports. `import os` + `from os import path` both yield 'os'.
    const src = 'import os\nfrom os import path\nimport os'
    expect(extractPythonImports(src)).toEqual(['os'])
  })

  it('keeps distinct dotted module paths separate', () => {
    // `from posthog.client import X` captures `posthog.client`. Distinct
    // from plain `posthog`. The graph's seed matcher handles the dotted
    // prefix relationship at match time.
    const src = 'from posthog import Client\nfrom posthog.client import X'
    expect(extractPythonImports(src)).toEqual(['posthog', 'posthog.client'])
  })
})

describe('resolvePythonImport', () => {
  it('returns null for absolute (non-dotted) imports', () => {
    // Absolute Python imports reference installed packages, not files in
    // the repo. SDK seed matching handles those upstream; the resolver
    // returns null here so they don't count as edges.
    expect(resolvePythonImport('/repo/a.py', 'posthog', new Set())).toBeNull()
    expect(resolvePythonImport('/repo/a.py', 'posthog.client', new Set())).toBeNull()
  })

  it('resolves `from . import x` to same-package __init__.py', () => {
    // `from . import x` lands at the package's __init__.py with the name
    // `x` imported FROM it -- so the file we follow is the __init__.
    const files = new Set(['/repo/pkg/__init__.py'])
    expect(resolvePythonImport('/repo/pkg/consumer.py', '.', files)).toBe(
      '/repo/pkg/__init__.py',
    )
  })

  it('returns null for `from . import x` when no __init__.py exists', () => {
    // Coverage gate for the `rest.length === 0 && !fileSet.has(candidate)`
    // branch — a single-dot import with no package marker file.
    expect(resolvePythonImport('/repo/pkg/consumer.py', '.', new Set())).toBeNull()
  })

  it('resolves `from .utils import x` to sibling module', () => {
    const files = new Set(['/repo/pkg/utils.py'])
    expect(resolvePythonImport('/repo/pkg/consumer.py', '.utils', files)).toBe(
      '/repo/pkg/utils.py',
    )
  })

  it('resolves `from ..lib import x` walking up a level', () => {
    const files = new Set(['/repo/lib.py'])
    expect(resolvePythonImport('/repo/pkg/consumer.py', '..lib', files)).toBe(
      '/repo/lib.py',
    )
  })

  it('resolves package imports via __init__.py fallback', () => {
    // `from .feature_flags import is_enabled` where feature_flags is a
    // package (directory with __init__.py), not a single module file.
    const files = new Set(['/repo/pkg/feature_flags/__init__.py'])
    expect(
      resolvePythonImport('/repo/pkg/consumer.py', '.feature_flags', files),
    ).toBe('/repo/pkg/feature_flags/__init__.py')
  })

  it('returns null when the dotted path leads nowhere in the file set', () => {
    expect(
      resolvePythonImport('/repo/pkg/consumer.py', '.missing', new Set()),
    ).toBeNull()
  })
})

describe('isPythonFile / isScannedSourceFile', () => {
  it.each([
    ['/a/b.py', true],
    ['/a/b.pyx', true],
    ['/a/b.pyi', true],
    ['/a/B.PY', true],
    ['/a/b.ts', false],
    ['/a/b.go', false],
  ])('isPythonFile(%s) -> %s', (p, expected) => {
    expect(isPythonFile(p)).toBe(expected)
  })

  it('isScannedSourceFile covers both TS/JS and Python', () => {
    expect(isScannedSourceFile('/a/b.ts')).toBe(true)
    expect(isScannedSourceFile('/a/b.py')).toBe(true)
    expect(isScannedSourceFile('/a/b.go')).toBe(false)
  })
})

describe('buildImportGraph — Python wrapper detection (B4)', () => {
  it('marks a Python file that directly imports an SDK', () => {
    const files = new Map([
      ['/r/use.py', 'import posthog\nposthog.identify("user")'],
      ['/r/other.py', 'print("unrelated")'],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['posthog'],
      isTsJs: isScannedSourceFile,
    })
    expect(transitiveSdks.get('/r/use.py')).toEqual(new Set(['posthog']))
    expect(transitiveSdks.has('/r/other.py')).toBe(false)
  })

  it('matches dotted submodule imports as the parent seed', () => {
    // `from posthog.client import Client` should hit the `posthog` seed.
    const files = new Map([
      ['/r/use.py', 'from posthog.client import Client'],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['posthog'],
      isTsJs: isScannedSourceFile,
    })
    expect(transitiveSdks.get('/r/use.py')).toEqual(new Set(['posthog']))
  })

  it('follows a one-hop Python wrapper to the SDK', () => {
    // The B4 motivating pattern: a wrapper file imports the SDK, and a
    // consumer file imports the wrapper via relative-dotted notation.
    const files = new Map([
      ['/r/pkg/__init__.py', ''],
      ['/r/pkg/wrapper.py', 'import posthog\ndef is_on(flag): return True'],
      ['/r/pkg/consumer.py', 'from .wrapper import is_on\nis_on("flag-x")'],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['posthog'],
      isTsJs: isScannedSourceFile,
    })
    expect(transitiveSdks.get('/r/pkg/wrapper.py')).toEqual(new Set(['posthog']))
    expect(transitiveSdks.get('/r/pkg/consumer.py')).toEqual(new Set(['posthog']))
  })

  it('does NOT cross language boundaries (TS file does not reach Python wrapper)', () => {
    // A .ts file `import './wrapper'` where wrapper.py imports the SDK
    // should not produce a cross-language edge. Languages have different
    // import semantics; mixing them would create false positives.
    const files = new Map([
      ['/r/wrapper.py', 'import posthog'],
      ['/r/use.ts', `import { isOn } from './wrapper'`],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['posthog'],
      isTsJs: isScannedSourceFile,
    })
    // wrapper.py is in scope as a direct SDK importer; use.ts is NOT
    // because its './wrapper' import can't follow into a .py file.
    expect(transitiveSdks.get('/r/wrapper.py')).toEqual(new Set(['posthog']))
    expect(transitiveSdks.has('/r/use.ts')).toBe(false)
  })

  it('handles deep Python relative imports (..)', () => {
    const files = new Map([
      ['/r/pkg/sdk_wrap.py', 'import ldclient'],
      ['/r/pkg/sub/__init__.py', ''],
      ['/r/pkg/sub/consumer.py', 'from ..sdk_wrap import flag_value'],
    ])
    const { transitiveSdks } = buildImportGraph(files, {
      seedSdkPatterns: ['ldclient'],
      isTsJs: isScannedSourceFile,
    })
    expect(transitiveSdks.get('/r/pkg/sub/consumer.py')).toEqual(new Set(['ldclient']))
  })

  it('counts Python relative imports that point to missing files as unresolved edges', () => {
    // Coverage gate for the `else { edgesUnresolved++ }` branch in the
    // Python resolver. A `from .nope import x` whose target file is not
    // present in the scan set must surface in stats so operators can see
    // when the wrapper graph has dead ends.
    const files = new Map([
      ['/r/pkg/__init__.py', ''],
      ['/r/pkg/consumer.py', 'from .nope import is_on'],
    ])
    const { stats } = buildImportGraph(files, {
      seedSdkPatterns: ['posthog'],
      isTsJs: isScannedSourceFile,
    })
    // consumer.py points at a missing sibling; counted as 1 unresolved edge.
    expect(stats.edgesUnresolved).toBeGreaterThanOrEqual(1)
  })
})
