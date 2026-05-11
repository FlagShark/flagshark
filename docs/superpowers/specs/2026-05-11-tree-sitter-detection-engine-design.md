# Tree-sitter Detection Engine — Design Spec

**Status:** Draft for review
**Date:** 2026-05-11
**Scope:** Replace FlagShark's regex-based detection with AST-based detection via tree-sitter (WASM), rolled out tier-by-tier across the 13 supported languages.
**Coupled spec:** [2026-05-11-output-and-customizability-design.md](./2026-05-11-output-and-customizability-design.md) — the new `hardcoded` signal surfaces in output formats defined there; the customizability spec defines how users register custom tree-sitter queries.

---

## 1. Goals (ranked)

1. **Precision — eliminate false positives.** Today's regex matches flag names inside strings, comments, error messages, and unrelated identifier paths (e.g. a database call named `variation` in a file that happens to import LaunchDarkly elsewhere). Tree-sitter parses the file and only matches calls at real call positions, with real string literals at the documented `flagKeyIndex` argument. This is the dominant value of the migration.

2. **Recall — handle real-world formatting.** Today's regex misses:
   - Multi-line method calls beyond ~10 lines of continuation
   - Flag keys extracted to `const` bindings (`const FLAG = 'NEW_NAV'; client.variation(FLAG, …)`)
   - Calls split across template-literal boundaries or comments mid-expression
   - Provider clients renamed via destructuring or factory functions
   Tree-sitter's AST gives us reliable resolution of all of these without bespoke regex per case.

3. **New `hardcoded` signal.** `staleness.ts:191` already stubs `checkHardcodedSignal(_flag)` returning `null` with a "v2 placeholder" comment. With an AST we can identify calls where the default-value argument is a literal AND the result of the call is used as a binary boolean (`if (client.variation('FLAG', user, true)) { … }`) — strong evidence the flag has been removed upstream and the code now always takes the default branch. This is **icing**: ships in a later tier, not on the critical path.

## 2. Non-goals

- **Native bindings (node-tree-sitter).** Rejected because `npx flagshark` and the GitHub Action both require zero-compile install. WASM is fast enough for our scale (5–10s scans).
- **Hand-written AST walks per language.** Rejected in favor of declarative tree-sitter queries (`.scm` files). Imperative walks are how the regex code grew unmaintainable; we don't repeat that mistake.
- **Breaking the public `@flagshark/core` API.** No changes to `scanRepo`, `LanguageDetector`, `MethodConfig`, `FeatureFlagProvider`, or `FeatureFlag` shapes in v1.x. The engine swap is internal.
- **Removing regex.** Regex stays as the engine for non-tier-1 languages and as a fallback when a tree-sitter parse errors out. We don't delete `detectFlagsWithRegex` until a future v2.0 — and likely not then either.
- **A custom-query authoring UX in v1.** Power users *can* override queries via the customizability config (see the coupled spec), but we don't ship a query playground or REPL.

## 3. Architecture

### 3.1 Module layout

New code lives under `packages/core/src/detection/tree-sitter/`:

```
detection/
  tree-sitter/
    engine.ts              # detectFlagsWithTreeSitter() — the regex helper's twin
    parser-cache.ts        # singleton getParser(lang) — lazy WASM load, one parser per language per process
    query-runner.ts        # query compilation + match-walking helpers
    query-builder.ts       # synthesizes per-(language × method) queries from MethodConfig
    queries/
      typescript/
        method-call.scm    # generic "call_expression where callee matches @method-name and arg[N] is string"
        import.scm         # import-statement matcher for SDK-presence gating
      javascript/
        method-call.scm
        import.scm
      go/
        method-call.scm
        import.scm
      python/
        method-call.scm
        import.scm
```

The existing `detection/detectors/*.ts` files (one per language) stay. Each gains an opt-in:

```ts
new TypeScriptDetector({ engine: 'tree-sitter' })   // tier-1 default after M2
new TypeScriptDetector({ engine: 'regex' })         // current default; survives indefinitely
new TypeScriptDetector()                            // honors createDefaultRegistry() choice
```

`createDefaultRegistry()` (in `detection/index.ts`) is the single place that decides per-language engine selection. Until tier-1 ships, this is `regex` everywhere — exactly today's behavior.

### 3.2 Detector contract — unchanged

```ts
export interface LanguageDetector {
  language(): Language
  fileExtensions(): string[]
  detectFlags(filename: string, content: string): FeatureFlag[]
  supportsFile(filename: string): boolean
  getProviders(): FeatureFlagProvider[]
}
```

The engine swap happens *inside* `detectFlags`:

```ts
// packages/core/src/detection/detectors/typescript.ts
export class TypeScriptDetector implements LanguageDetector {
  constructor(private opts: { engine?: 'regex' | 'tree-sitter' } = {}) {
    this.providers = opts.providers ?? defaultTypeScriptProviders()
    this.engine = opts.engine ?? 'regex'
  }

  detectFlags(filename: string, content: string): FeatureFlag[] {
    return this.engine === 'tree-sitter'
      ? detectFlagsWithTreeSitter(filename, content, this.language(), this.providers)
      : detectFlagsWithRegex(filename, content, this.language(), this.providers)
  }
}
```

Both helpers return the same `FeatureFlag[]` shape. Consumers (`PolyglotAnalyzer`, `scanRepo`, formatters, the GitHub Action) are unaware of the engine choice.

### 3.3 Parser cache

```ts
// detection/tree-sitter/parser-cache.ts

import Parser from 'web-tree-sitter'

const parsers = new Map<Language, Parser>()
const initialized = { value: false }
const initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (initialized.value) return
  if (initPromise) return initPromise
  initPromise = Parser.init()
  await initPromise
  initialized.value = true
}

const WASM_PATHS: Record<Language, string> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  go:         'tree-sitter-go/tree-sitter-go.wasm',
  python:     'tree-sitter-python/tree-sitter-python.wasm',
  // tier 2+ added incrementally
}

export async function getParser(lang: Language): Promise<Parser> {
  await ensureInit()
  const cached = parsers.get(lang)
  if (cached) return cached

  const wasmPath = WASM_PATHS[lang]
  if (!wasmPath) throw new Error(`No tree-sitter grammar registered for ${lang}`)

  const resolvedPath = resolveWasmPath(wasmPath)
  const Language_ = await Parser.Language.load(resolvedPath)
  const parser = new Parser()
  parser.setLanguage(Language_)
  parsers.set(lang, parser)
  return parser
}
```

`resolveWasmPath` lives in `parser-cache.ts` and handles three environments:

1. **CLI (Node + node_modules present):** `createRequire(import.meta.url).resolve('tree-sitter-typescript/tree-sitter-typescript.wasm')`.
2. **Action bundle (esbuild CJS bundle, no node_modules at runtime):** WASM blobs are *copied* into `packages/action/dist/grammars/` at build time. Resolution: `path.join(__dirname, 'grammars', 'tree-sitter-typescript.wasm')`.
3. **Test environment (vitest):** same as CLI.

The build step that copies WASM blobs is one of the M2 deliverables.

**One parser per language per process**, reused across files. `web-tree-sitter`'s `Parser` is stateful but `parser.parse(content)` returns a fresh `Tree`; we never mutate the parser between parses. Concurrent parsing in different worker contexts would be problematic, but `PolyglotAnalyzer` runs at `p-limit` concurrency 10 *in the same event loop*, so a single parser instance is fine — `parser.parse` is synchronous.

### 3.4 Query design

Each language gets one **method-call query template** that's parameterized at runtime per `MethodConfig`. We do *not* hand-write a query per provider per method.

**Template — TypeScript** (`queries/typescript/method-call.scm`):

```scheme
; Match: <receiver>.<method>(<arg0>, <arg1>, ...)
(call_expression
  function: [
    (member_expression
      object: (_) @receiver
      property: (property_identifier) @method)
    (identifier) @method
  ]
  arguments: (arguments) @args) @call
```

At runtime, `query-builder.ts` produces a runtime predicate set:

```ts
// For each provider × method:
//   - Filter matches where @method capture text === method.name
//   - Walk @args children, find the string literal at position method.flagKeyIndex
//   - Validate via isValidFlagKey
```

We do *not* try to do everything inside the `.scm` (tree-sitter's `#eq?` predicate works for exact equality, but for our case post-walk JS is clearer and lets us reuse `isValidFlagKey` + `extractStringArgument`-equivalents).

**Goal 2 (const-extracted flag keys)** is handled with a second pass: when `@args[flagKeyIndex]` is an `identifier` (not a string literal), walk the scope chain via tree-sitter to find a `(variable_declarator name: (identifier) @name value: (string))` binding with matching `@name`. We cap scope-walk at file scope (no cross-file resolution — out of scope for v1).

**Goal 1 (precision)** is automatic — the AST already excludes comment/string contents from `call_expression` nodes. Zero work needed.

**Future goal 3 (hardcoded signal)** uses the same `@args` capture: identify calls where the default-value argument (`method.flagKeyIndex + 1` for LaunchDarkly-style, or the provider's documented default position) is a boolean/string/number/null literal. Recorded as a flag's metadata; staleness analysis picks it up. Lands in a later tier.

### 3.5 Import gating (provider attribution)

The regex engine gates on `content.includes(importPattern)` — fast string check. The tree-sitter engine keeps the same fast check for performance (parsing is cheap, but skipping un-importable providers is cheaper). The `import.scm` queries are reserved for *correctness* improvements (e.g., correctly attributing flags when an SDK is imported via dynamic `require`) — not on the v1 critical path.

### 3.6 Error handling

`parser.parse(content)` never throws — tree-sitter parsers are designed to produce a partial tree from malformed input, with `ERROR` nodes in place of un-parseable regions. We treat queries that don't match anything as zero flags, not as errors. If `getParser` itself fails (WASM load error), we propagate the error up to `PolyglotAnalyzer`, which records it as a `partial` analysis and *falls back to the regex engine for that file*. This means a missing or corrupted WASM doesn't break a scan — it just degrades silently to v1 behavior.

## 4. Tier rollout

Each tier ships as its own minor release of `@flagshark/core` and a coordinated CLI/Action release.

| Tier | Languages | Why grouped | Target release |
|---|---|---|---|
| **T1** | TypeScript, JavaScript, Go, Python | Highest user population (LaunchDarkly/Unleash/Statsig majority). All have first-party grammars with prebuilt `.wasm`. | `@flagshark/core@1.3.0` |
| **T2** | Java, Ruby | Strong enterprise + Rails populations. Official grammars. | `@flagshark/core@1.4.0` |
| **T3** | C#, PHP, Rust | Official grammars. C# WASM is 5 MB (largest); Rust 1 MB; PHP 1 MB. | `@flagshark/core@1.5.0` |
| **T4** | C, C++, Objective-C | All have official/prebuilt grammars. C++ transitively depends on C grammar (already handled by upstream). | `@flagshark/core@1.6.0` |
| **T5** | Kotlin, Swift | Community grammars without prebuilt `.wasm`. Requires our CI WASM-build pipeline (see §7). | `@flagshark/core@1.7.0` |
| **T6** | (no new languages) | The `hardcoded` staleness signal lands here, alongside dead-branch detection. | `@flagshark/core@1.8.0` |

CLI and Action share the major+minor of `@flagshark/core`; their patches drift independently.

### 4.1 Within a tier

Each tier is one PR, one release. We don't ship languages one-at-a-time within a tier — bundle size & test setup amortize better in a group. A tier is "done" when:
- All languages in the tier have tree-sitter as default in `createDefaultRegistry()`.
- The test corpus (§6) passes for all languages in the tier.
- A real-world smoke-test repo per language has been scanned and the diff vs regex review approved (see §6.3).

## 5. Distribution & packaging

### 5.1 Direct dependencies

`packages/core/package.json` adds:

```jsonc
{
  "dependencies": {
    "p-limit": "^6.0.0",
    "web-tree-sitter": "^0.25.0",
    "tree-sitter-typescript": "^0.23.0",
    "tree-sitter-javascript": "^0.25.0",
    "tree-sitter-go": "^0.25.0",
    "tree-sitter-python": "^0.25.0"
    // tier 2+ added on their tier's release
  }
}
```

Each `tree-sitter-<lang>` package ships its `.wasm` directly in the tarball (we verified). For T5 (Kotlin/Swift), we don't depend on the upstream npm packages — instead, we vendor pre-built `.wasm` files under `packages/core/grammars/` (see §7).

### 5.2 Action bundle

The Action's esbuild build copies all needed `.wasm` files into `packages/action/dist/grammars/` and bundles `action.cjs` with `__dirname`-relative resolution. The action.yml stays at `main: packages/action/dist/action.cjs`. New build script:

```bash
# packages/action/scripts/build.sh
esbuild src/index.ts \
  --bundle --platform=node --target=node20 --format=cjs \
  --outfile=dist/action.cjs \
  --loader:.wasm=file \
  --asset-names=grammars/[name]
```

Equivalently, a small Node script that copies `node_modules/tree-sitter-*/tree-sitter-*.wasm` into `dist/grammars/` before bundling.

### 5.3 Package size budget

| Tier ships | Approx WASM added | Total `@flagshark/core` tarball |
|---|---|---|
| T1 | ~1.6 MB (TS 1.5 + JS 0.4 + Go 0.5 + Py 0.5, plus dedup) | ~3 MB |
| T2 | +2.5 MB (Java 0.4 + Ruby 2) | ~5 MB |
| T3 | +7 MB (C# 5 + PHP 1 + Rust 1) | ~11 MB |
| T4 | +4 MB (C 0.6 + C++ 3.4 + ObjC ~0.5) | ~15 MB |
| T5 | +1 MB (Kotlin + Swift, estimated) | ~16 MB |

This is acceptable for an npx CLI (one-time `node_modules` cost) and a CI Action (cached between runs). Compare: `prettier` is ~8 MB, `eslint` is ~30 MB unpacked. **Soft cap at 20 MB unpacked for `@flagshark/core`** — if T5 blows this, we revisit (likely by stripping grammar source from the published tarball — keeping only `.wasm` + license).

### 5.4 Tree shaking unused WASM

The `Parser.Language.load(path)` call is lazy — `.wasm` files are read from disk only when a language is encountered in the repo being scanned. A pure-Go repo scanned by our CLI never loads the C# WASM. This holds the runtime memory budget low regardless of tier count.

## 6. Testing

### 6.1 Test corpus structure

```
packages/core/test/fixtures/tree-sitter/
  typescript/
    launchdarkly/
      positive/
        single-line.ts                 # client.variation('FLAG', user, false)
        multi-line.ts                  # 5-line variation() call
        const-extracted.ts             # const FLAG = 'X'; client.variation(FLAG, ...)
        nested-call.ts                 # if (await client.variation('X', user, false)) {}
        comment-mid-expression.ts      # client.variation(/* todo */ 'X', user, false)
      negative/
        flag-in-comment.ts             # // TODO: enable FLAG
        flag-in-string.ts              # throw new Error("FLAG_NAME is disabled")
        unrelated-variation.ts         # db.variation({schema: 'X'})  (no LD import)
        shadowed-client.ts             # const client = new Database(); client.variation('X')
      expected.json                    # ground truth: array of {file, line, flag, provider}
    unleash/
      positive/ ...
      negative/ ...
      expected.json
    posthog/ ...
  javascript/ ...
  go/ ...
  python/ ...
```

Each `expected.json` is the source of truth — the test harness reads it and asserts `detectFlagsWithTreeSitter` returns exactly those flags (no more, no fewer).

### 6.2 Parameterized test runner

```ts
// packages/core/test/tree-sitter/corpus.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES_ROOT = new URL('../fixtures/tree-sitter/', import.meta.url).pathname

for (const language of readdirSync(FIXTURES_ROOT)) {
  describe(`tree-sitter / ${language}`, () => {
    const langRoot = join(FIXTURES_ROOT, language)
    for (const provider of readdirSync(langRoot)) {
      const expected = JSON.parse(readFileSync(join(langRoot, provider, 'expected.json'), 'utf-8'))
      for (const fixture of expected) {
        it(`${provider} / ${fixture.file}`, async () => {
          const filePath = join(langRoot, provider, fixture.file)
          const content = readFileSync(filePath, 'utf-8')
          const flags = await detectFlagsWithTreeSitter(filePath, content, language, providersFor(provider))
          expect(flags).toEqual(fixture.flags)
        })
      }
    }
  })
}
```

This means adding a new provider or fixture is one fixture file + one entry in `expected.json` — no test code to touch.

### 6.3 Cross-engine smoke test

For each tier, before flipping the default in `createDefaultRegistry`, we run a manual smoke pass:

```bash
# scan a real repo with both engines, diff the outputs
flagshark scan --engine=regex /tmp/some-real-repo > /tmp/regex.json
flagshark scan --engine=tree-sitter /tmp/some-real-repo > /tmp/ts.json
diff <(jq -S .staleFlags /tmp/regex.json) <(jq -S .staleFlags /tmp/ts.json)
```

The diff is reviewed by hand. Any flags that the tree-sitter engine finds but regex doesn't (recall wins) or vice versa (regression risk) get investigated. Common cause for "regex found, tree-sitter didn't": a real call that our query template doesn't cover yet — fix and add to corpus. Common cause for "tree-sitter found, regex didn't": a multi-line or const-extracted call. These are wins; record and move on.

Smoke-test repos per language:

| Language | Smoke repo |
|---|---|
| TypeScript | `microsoft/vscode` (sampled), or a known-stale fixture from FlagShark's own dogfooding |
| JavaScript | `expressjs/express`, `webpack/webpack` |
| Go | `kubernetes/kubernetes` (massive — sample one directory) |
| Python | `django/django` |
| (later tiers) | pick representative open-source repos with known flag SDK usage |

### 6.4 Engine-selection escape hatch (CLI flag)

`flagshark scan --engine=regex` and `--engine=tree-sitter` exist *only* to support the cross-engine smoke test. Not documented in `--help` for end users. Reuses the existing `args.engine` parsing scaffolding.

## 7. Building WASM for community grammars (T5)

Kotlin (`fwcd/tree-sitter-kotlin`) and Swift (`alex-pinkus/tree-sitter-swift`) don't ship prebuilt `.wasm`. We build them ourselves at `@flagshark/core` release time via a new CI workflow:

```yaml
# .github/workflows/build-grammars.yml — runs on demand, commits artifacts
name: Build community grammars (WASM)
on:
  workflow_dispatch:
    inputs:
      grammars:
        description: 'Comma-separated grammar names (e.g. tree-sitter-kotlin,tree-sitter-swift)'
        required: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g tree-sitter-cli
      - run: |
          for g in $(echo "${{ inputs.grammars }}" | tr ',' ' '); do
            git clone https://github.com/fwcd/$g /tmp/$g
            (cd /tmp/$g && tree-sitter generate && tree-sitter build --wasm)
            cp /tmp/$g/*.wasm packages/core/grammars/
          done
      - uses: peter-evans/create-pull-request@v6
        with:
          title: "build(grammars): rebuild WASM for ${{ inputs.grammars }}"
          branch: build-grammars-${{ github.run_id }}
```

These vendored `.wasm` files live in `packages/core/grammars/` and are committed to git. The package's `files` field includes `grammars/`. The parser cache resolves them via `path.join(packageRoot, 'grammars', `tree-sitter-${lang}.wasm`)`.

We rebuild only when the upstream grammar bumps version (~yearly) — manual is fine.

## 8. Performance

Targets (M1 MacBook, single core):

| Files | Regex (current) | Tree-sitter (projected) |
|---|---|---|
| 100 TS files | <100 ms | ~300 ms |
| 1,000 TS files | ~1 s | ~3 s |
| 10,000 TS files | ~10 s | ~30 s |

Tree-sitter parsing is ~3–5× slower than regex line-scanning, but absolute numbers stay acceptable. We do nothing to optimize beyond:

1. **One parser instance per language**, reused across files (cuts parser init).
2. **`p-limit` concurrency 10** (same as today; no benefit to higher since parsing is CPU-bound and Node is single-threaded).
3. **Import-gate skip** (don't parse files that don't import any flag SDK).

We do **not** ship caching to disk in v1. If a future user reports slow scans on a multi-million-file repo, we revisit.

## 9. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `web-tree-sitter` API changes between minor versions | Medium | Build break | Pin `^0.25.0` (current stable), test against `0.26+` in a follow-up |
| WASM resolution breaks in Action bundle | Medium | Action regression | Smoke-test the built `action.cjs` locally before publish; add a CI step that runs the action against a fixture repo |
| Grammar updates change AST node names (breaking queries) | Medium | Detection regression | Pin grammar versions exactly; bump in dedicated PRs with corpus re-validation |
| Const-resolution recall worse than expected for certain idioms | High | User confusion | Document scope: file-local only, no cross-file. Open up custom queries (output-spec) for users who want more |
| Recall regresses for niche regex patterns | Medium | Lost users | Cross-engine smoke test before each tier flip; ability to opt back to regex via config |
| Bundle balloons past 20 MB in T3/T4 | Medium | npm install slow | Measure each tier; consider stripping non-`.wasm` files from the published tarball |
| Kotlin/Swift WASM build pipeline flaky | Low | T5 slips | T5 is the last tier and not blocking value; can be deferred indefinitely |

## 10. Open questions

1. **Should we expose `--engine` as a public CLI flag?** The internal use is smoke testing. Making it public lets users opt out if tree-sitter misbehaves. *Lean: yes, public, undocumented in `--help` but in README's troubleshooting section.*

2. **Do we measure per-file engine choice in telemetry?** Right now FlagShark has no telemetry. Out of scope.

3. **Should custom user-defined providers be regex-only initially?** Yes — the customizability spec defines a YAML provider schema that maps to `MethodConfig`. That config feeds whichever engine the language is configured for. A user adding a custom provider in TypeScript automatically gets tree-sitter detection of it.

4. **Const-extraction across multiple `const`s (chained)?** `const A = 'X'; const B = A; client.variation(B, …)`. Out of scope for v1 — only direct `const NAME = '...'` resolution.

5. **What about variables declared via `let`/`var`?** `var` and `let` allow reassignment; treating them as constants is unsafe. We resolve only `const` (TS/JS) and equivalent immutable bindings per language (`final` in Java, `:=` once in Go's tree-sitter terms, etc. — finalized when each tier lands).

## 11. Phasing summary

Since the v1.2.0 release (commit `3069587`), `@flagshark/core` and `flagshark` (CLI) ship at the same version. Each release below bumps both packages together. The Action ships via the `vX` git tag whenever the repo releases. A single minor release may include both a tree-sitter tier *and* an output-spec phase (see the companion spec's phasing) — version numbers below are illustrative, not exclusive.

| Phase | Deliverable | Release |
|---|---|---|
| P0 | Spec written + reviewed | (this doc) |
| P1 | Implementation plan written (writing-plans skill) | docs/superpowers/plans/ |
| P2 | Tier 1 implementation: parser-cache, query-runner, TS/JS/Go/Python detectors + corpus + cross-engine smoke | `v1.3.0-pre.0` (default still regex) |
| P3 | Tier 1 flip default to tree-sitter | `v1.3.0` |
| P4 | Tier 2 (Java, Ruby) | `v1.4.0` |
| P5 | Tier 3 (C#, PHP, Rust) | `v1.5.0` |
| P6 | Tier 4 (C, C++, ObjC) | `v1.6.0` |
| P7 | Tier 5 (Kotlin, Swift) — requires CI WASM build | `v1.7.0` |
| P8 | `hardcoded` staleness signal | `v1.8.0` |

P1 (writing-plans) is the next step after this spec is approved. P2 is the first multi-week development phase.
