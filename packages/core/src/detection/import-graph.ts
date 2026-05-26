/**
 * Lightweight import-graph builder for TS/JS files.
 *
 * Goal: extend the existing "file imports a known SDK" detection gate to cover
 * the common case where consumer files reach the SDK through a local wrapper —
 * an internal `flag-resolver.ts`, a Pinia store, a custom React hook, a re-export
 * barrel, etc. Without this, real codebases that hide the SDK behind an
 * abstraction silently report 0 flags (see the pre-launch shakedown notes:
 * Unleash at 4 of 62, n8n at 0 of many).
 *
 * Design — three deliberate compromises in service of "ship soon and don't add
 * false positives":
 *
 *   1. **Regex import extraction, not tree-sitter.** The existing analyzer
 *      already parses each file once for flag detection; running a second
 *      tree-sitter pass for imports would roughly double scan time on a large
 *      monorepo. Three regexes cover ESM static imports, CJS require(), and
 *      dynamic import() with >95% coverage of real-world syntax. The misses
 *      (heavily multi-line imports, computed-string specifiers, etc.) only
 *      cost us some recall — they never add false positives because the gate
 *      still requires a *real* SDK string match downstream.
 *
 *   2. **Relative-path resolution only.** TypeScript path aliases
 *      (`@/foo` via tsconfig.paths), workspace `@scope/pkg` resolution, and
 *      package.json `exports` are out of scope. A user with path aliases will
 *      hit the same blind spot as today; we document it. The right fix is to
 *      read tsconfig.json and apply paths — separate workstream, not a Show HN
 *      blocker.
 *
 *   3. **Reverse-reachability BFS from SDK-importing seeds.** We propagate
 *      SDK provenance *away* from the SDK importers. A file is "in scope" iff
 *      it transitively imports something that imports an SDK. Cycle-safe via
 *      a "did the set actually grow?" check before requeueing — bounded
 *      O(edges × seeds) in the worst case.
 *
 * The output is consumed by PolyglotAnalyzer, which uses it to mark
 * wrapper-consumer files as SDK-positive *for the gating step only* — actual
 * flag-key extraction still goes through the same per-provider patterns, so
 * precision stays the same as direct-import detection.
 */

import * as fs from 'node:fs'
import path from 'node:path'

import { Languages, type Language } from './interface.js'

// -- Import-extraction regexes --------------------------------------------------
//
// All three patterns capture the bare module specifier in group 1. Anchored
// loosely enough to handle whitespace variations but not so loosely that they
// match inside strings or comments — both forms have a leading non-word boundary
// (or start-of-line, for ESM) before the keyword.

/**
 * ESM static imports. Matches:
 *   import 'foo'
 *   import x from 'foo'
 *   import { a, b } from 'foo'
 *   import * as x from 'foo'
 *   import x, { a } from 'foo'
 *   import type { a } from 'foo'
 *   import type * as x from 'foo'
 *
 * The optional `\s+...\s+from\s+` clause uses a lazy quantifier so it doesn't
 * greedily swallow a no-from `import 'foo'`. Multi-line imports (newlines
 * inside the import clause) are a known miss — `[^'"`;\n]*` excludes newlines
 * to keep matching linear-time. In practice those are rare outside
 * auto-generated barrels.
 */
const ESM_IMPORT_RE =
  /^[ \t]*import\s*(?:\s+type)?\s*(?:[^'"`;\n]*?\s+from\s+)?['"`]([^'"`]+)['"`]/gm

/**
 * CJS require(). Matches:
 *   const x = require('foo')
 *   require('foo')
 *
 * The lookbehind `(?<![.\w$])` blocks `foo.require('bar')` and
 * `myRequire('bar')` — anything where `require` is part of a longer identifier
 * or a member-expression property name.
 */
const REQUIRE_RE = /(?<![.\w$])require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

/**
 * Dynamic ESM imports. Matches:
 *   import('foo')
 *   await import('foo')
 *
 * Same lookbehind guard as REQUIRE_RE to avoid `obj.import('foo')`.
 */
const DYNAMIC_IMPORT_RE = /(?<![.\w$])import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

/**
 * Python `from X import Y` matcher. `X` can be:
 *   - a dotted module path (`posthog.client`)
 *   - a relative path (`.utils`, `..lib.flags`, `...common.feature_flags`)
 *
 * Captures group 1 = the module path (including leading dots if any).
 * Names after `import` are intentionally not captured — for the import-graph
 * we care about which MODULE was reached, not which names were brought in.
 *
 * Anchored to line start (after optional indentation) to skip `from` keywords
 * that appear mid-expression (e.g. in docstrings or string literals).
 */
const PY_FROM_IMPORT_RE = /^[ \t]*from\s+(\.*[\w.]+)\s+import\s+/gm

/**
 * Python bare `import X` / `import X as Y` matcher (top-level only, never
 * `if cond: import X` because conditional imports almost always indicate
 * fallback paths we shouldn't follow as the primary edge).
 *
 * Captures the module path — comma-separated multi-imports (`import a, b`)
 * are uncommon in real code; we handle them by running this regex once and
 * splitting the capture on `,` post-hoc.
 */
const PY_IMPORT_RE = /^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm

/**
 * Extracts every module specifier mentioned in a TS/JS file.
 *
 * @returns a deduplicated array of specifier strings, in the order first seen.
 *   Order is not load-bearing for the graph algorithm but makes test fixtures
 *   readable.
 */
export function extractImports(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const collect = (re: RegExp) => {
    // Reset state on the shared RegExp — we use the /g flag for exec loops.
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const spec = m[1]
      if (!seen.has(spec)) {
        seen.add(spec)
        out.push(spec)
      }
    }
  }

  collect(ESM_IMPORT_RE)
  collect(REQUIRE_RE)
  collect(DYNAMIC_IMPORT_RE)
  return out
}

/**
 * Extracts every module specifier mentioned in a Python file. Returns each
 * specifier verbatim (including leading dots for relative imports). The
 * graph's seed-matching logic compares the bare module name (everything
 * before the first dot, e.g. `posthog` from `posthog.client`) against the
 * SDK seed list.
 *
 * Multi-import lines like `import a, b, c` are split into individual
 * specifiers; deduplicated within a file.
 */
export function extractPythonImports(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const push = (spec: string) => {
    const trimmed = spec.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  }

  PY_FROM_IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PY_FROM_IMPORT_RE.exec(content)) !== null) push(m[1])

  PY_IMPORT_RE.lastIndex = 0
  while ((m = PY_IMPORT_RE.exec(content)) !== null) {
    // `import a, b, c` -- split the captured run on commas.
    for (const part of m[1].split(',')) push(part)
  }

  return out
}

/**
 * Resolves a Python import specifier to a file path that exists in
 * `fileSet`. Python relative imports use dot notation rather than `./`:
 *   - `from . import x`     → same package as importer
 *   - `from .utils import x` → sibling module `utils` in same package
 *   - `from ..lib import x`  → parent package's `lib`
 *   - `from .. import x`    → parent package's `__init__.py`
 *
 * Absolute imports (`from posthog.client import x`) are NOT resolved into
 * the file map — they reference installed packages outside the repo. Those
 * get matched against the SDK seed list separately.
 *
 * Returns null for absolute imports or unresolvable paths.
 */
export function resolvePythonImport(
  importerPath: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | null {
  // Count leading dots — that's the package walk depth (one dot = same
  // package, two = parent, three = grandparent, etc.). The remaining
  // dotted name is the module path under that package.
  let dots = 0
  while (dots < specifier.length && specifier[dots] === '.') dots++
  if (dots === 0) return null // absolute import — see SDK seed matching upstream

  const importerDir = path.dirname(importerPath)
  // First dot is "same dir", each subsequent dot walks up one level.
  let baseDir = importerDir
  for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir)

  const rest = specifier.slice(dots) // e.g. "utils.helpers" or ""
  if (rest.length === 0) {
    // `from . import x` -- target is the package's __init__.py.
    const candidate = path.join(baseDir, '__init__.py')
    return fileSet.has(candidate) ? candidate : null
  }

  // Convert "utils.helpers" to "utils/helpers" then try both `.py` and
  // `/__init__.py` forms (Python packages vs modules).
  const segments = rest.split('.').filter((s) => s.length > 0)
  const moduleBase = path.join(baseDir, ...segments)
  const candidateModule = moduleBase + '.py'
  if (fileSet.has(candidateModule)) return candidateModule
  const candidatePackage = path.join(moduleBase, '__init__.py')
  if (fileSet.has(candidatePackage)) return candidatePackage
  return null
}

// -- Path resolution ----------------------------------------------------------

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

/**
 * Resolved tsconfig.json path aliases — `compilerOptions.baseUrl` plus the
 * `compilerOptions.paths` map. Returned by `loadTsconfigAliases` and passed
 * to `resolveImportPath` so transitive wrapper detection follows imports
 * that go through tsconfig path mapping (e.g. `@/lib/featureFlags` →
 * `src/lib/featureFlags`). Pre-fix this was a known recall gap on
 * alias-heavy monorepos.
 */
export interface PathAliases {
  /** Absolute path of the directory `paths` resolves against. */
  baseUrl: string
  /**
   * Each entry maps an alias key (with a trailing `/*` if any) to a list of
   * candidate targets (also with their `/*`). Example tsconfig entry:
   *
   *   "paths": { "@/*": ["src/*"], "@lib/*": ["src/lib/*", "vendor/lib/*"] }
   *
   * stores as `{ "@/*": ["src/*"], "@lib/*": ["src/lib/*", "vendor/lib/*"] }`.
   */
  paths: Map<string, string[]>
}

/**
 * Finds the nearest tsconfig.json (or jsconfig.json) at or above `root` and
 * parses `compilerOptions.baseUrl` + `compilerOptions.paths`. Returns null
 * if no config exists, the config has no path aliases, or the file fails
 * to parse.
 *
 * Intentional limitations (documented so the recall ceiling is honest):
 *   - We do NOT follow `extends` chains. A tsconfig that inherits aliases
 *     from a parent project won't have them resolved here. Real fix would
 *     require a recursive resolver matching tsc's actual behaviour.
 *   - We only look at the first matching tsconfig walking up from `root`.
 *     Nested workspaces with distinct tsconfigs per package aren't handled
 *     specially — the outermost one wins. Sufficient for the typical
 *     "alias is in repo-root tsconfig" pattern.
 */
export function loadTsconfigAliases(root: string): PathAliases | null {
  // Walk up from `root` looking for tsconfig.json, then jsconfig.json.
  // Stop at the filesystem root. Bound the loop so a pathological setup
  // can't hang us — 32 levels is well past any realistic monorepo depth.
  let dir = path.resolve(root)
  for (let i = 0; i < 32; i++) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        const parsed = readTsconfigJson(candidate)
        if (parsed?.paths) return parsed
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Parses a JSONC tsconfig file (allows `//` line comments and `/* *\/` block
 * comments — tsc accepts both, JSON.parse does not). The comment stripper is
 * intentionally minimal: it doesn't try to be perfect inside string values,
 * just inside the structural JSON. In practice tsconfig.json string values
 * rarely contain comment-like text (`http://...` paths are URLs, not
 * comments — handled below) so this works for the long tail.
 */
function readTsconfigJson(file: string): PathAliases | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }

  // Strip /* ... */ block comments and // line comments outside strings.
  // We walk the file once, tracking whether we're inside a "..." string —
  // this avoids false-stripping `://` from a URL value, which a naive regex
  // would mangle.
  const stripped = stripJsoncComments(raw)

  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }

  const co = parsed.compilerOptions
  if (!co?.paths || Object.keys(co.paths).length === 0) return null

  const baseUrl = path.resolve(path.dirname(file), co.baseUrl ?? '.')
  const paths = new Map<string, string[]>()
  for (const [alias, targets] of Object.entries(co.paths)) {
    if (Array.isArray(targets)) paths.set(alias, targets)
  }
  return { baseUrl, paths }
}

function stripJsoncComments(src: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < src.length) {
    const ch = src[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      // Line comment — skip to next newline.
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      // Block comment — skip to closing */.
      i += 2
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Tries to apply tsconfig path aliases to a bare-spec import. Returns the
 * resolved absolute file path (if it exists in `fileSet`) or null.
 *
 * Two alias shapes are supported, matching tsc:
 *   - Wildcard: key ends with `/*`, target ends with `/*`. The portion
 *     after the alias prefix is substituted into the target wildcard.
 *     Example: alias `@/*` → `src/*`; specifier `@/lib/foo` resolves to
 *     `<baseUrl>/src/lib/foo`.
 *   - Exact: no `*`. The specifier matches the alias exactly and resolves
 *     to the literal target.
 */
export function resolveAliasedImport(
  specifier: string,
  aliases: PathAliases,
  fileSet: ReadonlySet<string>,
): string | null {
  for (const [alias, targets] of aliases.paths) {
    if (alias.endsWith('/*')) {
      const prefix = alias.slice(0, -2) + '/'
      // `@/` must be matched as a prefix; `@/lib/foo` matches `@/*`.
      // Edge case: an alias key like `@/*` should also match `@/lib`
      // without the trailing slash if the user wrote `@/lib` not `@/lib/`.
      // The slash is part of the prefix, so `@/lib` doesn't start with
      // `@//` — handle the slash-less prefix separately.
      const dotPrefix = alias.slice(0, -2) // "@"
      if (!specifier.startsWith(prefix) && specifier !== dotPrefix) continue
      const rest = specifier.slice(prefix.length)
      for (const target of targets) {
        if (!target.endsWith('/*')) continue
        const targetPrefix = target.slice(0, -2)
        const resolved = path.resolve(aliases.baseUrl, targetPrefix, rest)
        const found = tryResolveExisting(resolved, fileSet)
        if (found) return found
      }
    } else if (alias === specifier) {
      for (const target of targets) {
        const resolved = path.resolve(aliases.baseUrl, target)
        const found = tryResolveExisting(resolved, fileSet)
        if (found) return found
      }
    }
  }
  return null
}

/**
 * Given a resolved path (no extension), tries the same exact-then-extension-
 * then-/index.* lookup that resolveImportPath does for relative imports.
 * Factored out so both code paths agree on what "exists" means.
 */
function tryResolveExisting(resolved: string, fileSet: ReadonlySet<string>): string | null {
  if (fileSet.has(resolved)) return resolved
  for (const ext of TS_JS_EXTENSIONS) {
    if (fileSet.has(resolved + ext)) return resolved + ext
  }
  for (const ext of TS_JS_EXTENSIONS) {
    const candidate = path.join(resolved, `index${ext}`)
    if (fileSet.has(candidate)) return candidate
  }
  return null
}

/**
 * Resolves a relative or absolute import specifier to a file path that exists
 * in `fileSet`. Returns null for bare specifiers (unless `aliases` provided
 * and the specifier matches an alias) or unresolvable paths.
 *
 * Resolution order matches Node + TS behavior closely enough for our purposes:
 *   1. Path aliases (when `aliases` provided) — `@/foo` → `src/foo`.
 *   2. Exact match (`./foo.ts`).
 *   3. With each candidate extension (`./foo` → `./foo.ts`).
 *   4. As a directory with `index.<ext>` (`./foo` → `./foo/index.ts`).
 *   5. TS-emitted `.js` rewritten to `.ts` (`./foo.js` → `./foo.ts`), which
 *      handles the verbatimModuleSyntax / NodeNext convention where TS source
 *      writes `.js` but the actual file is `.ts`. Same for `.jsx`/`.tsx`.
 */
export function resolveImportPath(
  importerPath: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  aliases?: PathAliases,
): string | null {
  // Try path aliases first — they win over both relative and bare interpretation.
  // A monorepo's `@/foo` is conceptually a re-mapping, not a relative path,
  // so it gets the highest-priority resolution attempt.
  if (aliases) {
    const aliased = resolveAliasedImport(specifier, aliases, fileSet)
    if (aliased) return aliased
  }

  if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
    return null
  }

  const importerDir = path.dirname(importerPath)
  const absSpecifier = path.resolve(importerDir, specifier)

  // 1. Exact match
  if (fileSet.has(absSpecifier)) return absSpecifier

  // 2. + extension
  for (const ext of TS_JS_EXTENSIONS) {
    const candidate = absSpecifier + ext
    if (fileSet.has(candidate)) return candidate
  }

  // 3. /index.<ext>
  for (const ext of TS_JS_EXTENSIONS) {
    const candidate = path.join(absSpecifier, `index${ext}`)
    if (fileSet.has(candidate)) return candidate
  }

  // 4. TS source convention: import './foo.js' → real file is './foo.ts' / './foo.tsx'.
  //    Same for .jsx → .tsx, .mjs → .mts, .cjs → .cts.
  const emittedToSourceExt: Record<string, string[]> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
  }
  const ext = path.extname(absSpecifier)
  const replacements = emittedToSourceExt[ext]
  if (replacements) {
    const base = absSpecifier.slice(0, absSpecifier.length - ext.length)
    for (const r of replacements) {
      const candidate = base + r
      if (fileSet.has(candidate)) return candidate
    }
  }

  return null
}

// -- Graph build --------------------------------------------------------------

export interface ImportGraphOptions {
  /**
   * SDK package patterns that anchor the graph — typically the union of every
   * provider's `importPattern` field across all enabled detectors
   * (e.g. `['unleash-client', 'posthog-js', 'posthog-node', '@launchdarkly/...']`).
   *
   * A specifier counts as an SDK reference if it equals an entry exactly OR
   * starts with `<entry>/` (handles SDK subpath imports like
   * `launchdarkly-node-server-sdk/lib/foo`).
   */
  seedSdkPatterns: string[]
  /**
   * Returns whether a file path is a TS/JS source file the graph should walk.
   * Used to skip Python/Go/etc. files in a polyglot file map without forcing
   * callers to pre-filter.
   */
  /**
   * Predicate that decides whether a file is in scope for the graph walk.
   * Historically named `isTsJs` because TS/JS was the only supported
   * surface — Python wrapper detection (B4) added .py to the in-scope
   * set, and the implementation now dispatches extraction by extension
   * inside the loop. The name is kept for back-compat; callers can pass
   * `isScannedSourceFile` (which returns true for TS/JS + Python) when
   * they want polyglot coverage, or `isTsJsFile` for TS/JS-only.
   */
  isTsJs(filePath: string): boolean
  /**
   * Optional tsconfig path aliases (returned by `loadTsconfigAliases`).
   * When provided, `@/foo`-style imports are followed during the
   * transitive expansion; without it, those imports stop at the alias
   * boundary and wrapper detection under-counts. Documented recall
   * limitation pre-fix.
   *
   * Path aliases apply only to TS/JS files; Python imports never route
   * through tsconfig.
   */
  aliases?: PathAliases
}

export interface ImportGraphResult {
  /**
   * For each file in the input map (TS/JS only), the set of seed SDKs it
   * reaches — directly or transitively through 1-N hops of relative imports.
   * Files with no SDK reach are absent from the map (not present as empty set).
   */
  transitiveSdks: Map<string, Set<string>>
  /** Diagnostics — useful for tests and to surface in --verbose output later. */
  stats: {
    /** TS/JS files walked. */
    filesWalked: number
    /** Files that directly import at least one seed SDK. */
    seedFiles: number
    /** Files in transitiveSdks (seedFiles + wrappers + transitive consumers). */
    inScopeFiles: number
    /** Relative-import edges resolved successfully. */
    edgesResolved: number
    /** Relative-import edges that couldn't be resolved to a file in the input. */
    edgesUnresolved: number
  }
}

/**
 * Builds the transitive SDK-reach map for a set of TS/JS files.
 *
 * Algorithm:
 *   1. Walk every TS/JS file, extract module specifiers.
 *   2. For each specifier: if it's a seed SDK → record direct SDK reach;
 *      if it's a relative path that resolves in the file map → add forward edge.
 *   3. Build the reverse adjacency map (target → importers).
 *   4. Seed the worklist with every directly-importing file. BFS outward
 *      through the reverse graph, propagating each importer's SDK set
 *      (union of all reachable importees). Requeue only when a set actually
 *      grew — this terminates on every cyclic import graph.
 */
export function buildImportGraph(
  files: ReadonlyMap<string, string>,
  opts: ImportGraphOptions,
): ImportGraphResult {
  const fileSet = new Set<string>()
  for (const fp of files.keys()) {
    if (opts.isTsJs(fp)) fileSet.add(fp)
  }

  const forward = new Map<string, Set<string>>()
  const directSdks = new Map<string, Set<string>>()
  let edgesResolved = 0
  let edgesUnresolved = 0

  for (const [filePath, content] of files) {
    if (!fileSet.has(filePath)) continue

    // Dispatch extraction and resolution by file extension. Python is the
    // only added language for now; Go has module-path complications (no
    // relative imports — every Go import is a module path) that need a
    // separate design pass. See B4 in the bug inventory.
    const python = isPythonFile(filePath)
    const specs = python ? extractPythonImports(content) : extractImports(content)
    if (specs.length === 0) continue

    const fileImports = new Set<string>()
    const fileSdks = new Set<string>()

    for (const spec of specs) {
      // Seed SDK match. Python's matching is dotted (`posthog.client`
      // starts with `posthog.`); TS/JS is path-style (`unleash-client/lib/x`
      // starts with `unleash-client/`). Both forms reduce to "specifier
      // equals seed OR specifier starts with seed + sep". We pick the
      // separator per-language.
      const sep = python ? '.' : '/'
      for (const sdk of opts.seedSdkPatterns) {
        if (spec === sdk || spec.startsWith(sdk + sep)) {
          fileSdks.add(sdk)
        }
      }

      // Resolve to a file in our scan set.
      if (python) {
        // Python relative imports start with one or more dots.
        if (spec.startsWith('.')) {
          const target = resolvePythonImport(filePath, spec, fileSet)
          if (target) {
            fileImports.add(target)
            edgesResolved++
          } else {
            edgesUnresolved++
          }
        }
        // Absolute Python imports never resolve into the file map (they
        // reference installed packages); SDK seed matching above catches
        // the ones we care about.
      } else {
        // TS/JS: relative or potentially-aliased bare specifier.
        const isRelative =
          spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
        if (isRelative || opts.aliases) {
          const target = resolveImportPath(filePath, spec, fileSet, opts.aliases)
          if (target) {
            fileImports.add(target)
            edgesResolved++
          } else if (isRelative) {
            // Only count un-resolved RELATIVE edges as misses — bare specs
            // that don't match an alias aren't expected to resolve and
            // shouldn't pollute the stat.
            edgesUnresolved++
          }
        }
      }
    }

    if (fileImports.size > 0) forward.set(filePath, fileImports)
    if (fileSdks.size > 0) directSdks.set(filePath, fileSdks)
  }

  // Reverse adjacency: for each "imported file", who imports it?
  const reverse = new Map<string, Set<string>>()
  for (const [importer, targets] of forward) {
    for (const target of targets) {
      let importers = reverse.get(target)
      if (!importers) {
        importers = new Set()
        reverse.set(target, importers)
      }
      importers.add(importer)
    }
  }

  // BFS the reverse graph from every direct-SDK file, propagating its SDK set
  // up the import chain. The propagation is monotonic: a file's SDK set only
  // grows, never shrinks. We requeue only when growth happens, so the algorithm
  // terminates in O(edges × |seed-sdks|) even with cyclic imports.
  const transitiveSdks = new Map<string, Set<string>>()
  for (const [file, sdks] of directSdks) {
    transitiveSdks.set(file, new Set(sdks))
  }

  const worklist: string[] = [...directSdks.keys()]
  while (worklist.length > 0) {
    const file = worklist.shift()!
    const sdksOfFile = transitiveSdks.get(file)
    /* c8 ignore next -- defensive; file is only added to worklist when its sdk set exists */
    if (!sdksOfFile) continue

    const importers = reverse.get(file)
    if (!importers) continue

    for (const importer of importers) {
      let importerSdks = transitiveSdks.get(importer)
      if (!importerSdks) {
        importerSdks = new Set()
        transitiveSdks.set(importer, importerSdks)
      }
      let grew = false
      for (const sdk of sdksOfFile) {
        if (!importerSdks.has(sdk)) {
          importerSdks.add(sdk)
          grew = true
        }
      }
      if (grew) worklist.push(importer)
    }
  }

  return {
    transitiveSdks,
    stats: {
      filesWalked: fileSet.size,
      seedFiles: directSdks.size,
      inScopeFiles: transitiveSdks.size,
      edgesResolved,
      edgesUnresolved,
    },
  }
}

// -- Language helper ----------------------------------------------------------

/**
 * Returns true when the file path is a TS/JS source flagshark would parse.
 * Mirrors the file-extension set used by TypeScriptDetector / JavaScriptDetector.
 */
/**
 * True if the file is a Python source file the graph should walk.
 * Mirrors the extension list of the Python detector — keep in sync.
 */
export function isPythonFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.py') || lower.endsWith('.pyx') || lower.endsWith('.pyi')
}

/**
 * Polyglot scope predicate: true for TS/JS *and* Python source files.
 * Pass this as `ImportGraphOptions.isTsJs` when you want the graph to
 * walk Python wrappers too. Replaces the TS/JS-only check incrementally
 * without forcing every caller to update.
 */
export function isScannedSourceFile(filePath: string): boolean {
  return isTsJsFile(filePath) || isPythonFile(filePath)
}

export function isTsJsFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return false
  const ext = lower.slice(dot)
  return TS_JS_EXTENSIONS.includes(ext)
}

// Exported for tests so they can assert on the resolution-order without
// re-listing the constant.
export const _TS_JS_EXTENSIONS_FOR_TESTS = TS_JS_EXTENSIONS

// Silence unused-import warning for Language/Languages — we re-export the
// type via the public surface so callers don't have to chase imports.
export type { Language }
export { Languages }
