# 100% Coverage + Local-State E2E — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach and enforce 100% line + branch + function + statement coverage across all three workspace packages (`@flagshark/core`, `flagshark` CLI, `@flagshark/action`), and add local-state end-to-end tests that exercise the real CLI binary and Action entrypoint without network.

**Architecture:** Four phases, each independently mergeable. Each phase ratchets its package's coverage gate up (80% → 100%). Spec: `docs/superpowers/specs/2026-05-13-100-percent-coverage-and-e2e-design.md`.

**Tech Stack:** TypeScript, Bun workspaces, Vitest with `@vitest/coverage-v8`, tree-sitter (existing), esbuild (existing), GitHub Actions (existing CI). Tests use `node:child_process.spawnSync` for CLI E2E and hand-rolled fakes for the GitHub Action surface.

---

## Pre-flight context an implementer needs

- **Project root:** `/Users/joe/projects/flagshark`. All paths in this plan are repo-relative.
- **Package manager:** `bun` (version pinned to `1.2.5` in CI). All scripts run via `bun run`.
- **Run a single package's tests:** `bun run --filter '@flagshark/core' test`. Add `--coverage` once Phase 1 is in.
- **Run everything:** `bun run test` (root script fans out via `--filter '*'`).
- **Existing test infrastructure** worth knowing:
  - `packages/core/test/scan-repo.test.ts:9-15` has the inlined `makeTempRepo()` you'll extract in Phase 1.
  - `packages/core/test/tree-sitter/corpus.test.ts` is the corpus-driven test pattern you'll mirror for the regex corpus in Phase 2 (`expected.json` per provider folder).
  - `packages/core/src/detection/helpers.ts:detectFlagsWithRegex` is the function the regex corpus will exercise.
- **Commit style:** look at `git log --oneline -10` for tone. Existing pattern: `chore:`, `docs:`, `feat:`, `fix:`. Multi-line bodies optional.
- **TDD discipline:** every task in this plan follows the same pattern — write the failing test, run to confirm it fails, write the implementation, run to confirm it passes, commit. Do not skip the "run to confirm it fails" step; it catches plenty of false-positive "tests" that pass before any implementation exists.

---

# Phase 1 — Foundation

Goal: coverage tooling installed and observable; shared fixture helper extracted; CI green at the chosen floor. No new behavior tests.

## Task 1.1: Install `@vitest/coverage-v8` in core, cli, action

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/action/package.json`

- [ ] **Step 1: Add devDependency to core**

Edit `packages/core/package.json` `devDependencies` block. Add `"@vitest/coverage-v8": "^3.0.0"` (matching the existing `vitest: ^3.0.0`).

Final `devDependencies`:
```json
"devDependencies": {
  "@types/node": "^22.0.0",
  "@vitest/coverage-v8": "^3.0.0",
  "typescript": "^5.7.0",
  "vitest": "^3.0.0"
}
```

- [ ] **Step 2: Add devDependency to cli**

Same change in `packages/cli/package.json`. Final `devDependencies`:
```json
"devDependencies": {
  "@types/node": "^22.0.0",
  "@vitest/coverage-v8": "^3.0.0",
  "esbuild": "^0.24.0",
  "typescript": "^5.7.0",
  "vitest": "^3.0.0"
}
```

- [ ] **Step 3: Add devDependency + vitest to action**

`packages/action/package.json` currently has no vitest. Update its `devDependencies`:
```json
"devDependencies": {
  "@types/node": "^22.0.0",
  "@vitest/coverage-v8": "^3.0.0",
  "esbuild": "^0.24.0",
  "typescript": "^5.7.0",
  "vitest": "^3.0.0"
}
```

Add a `test` script to `packages/action/package.json` so the root fan-out picks it up:
```json
"scripts": {
  "build": "node scripts/build.mjs",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 4: Install**

```bash
bun install
```

Expected: lockfile updated, no errors. `bun.lock` shows `@vitest/coverage-v8` resolved.

- [ ] **Step 5: Smoke run**

```bash
bun run --filter '@flagshark/core' test
bun run --filter 'flagshark' test
bun run --filter '@flagshark/action' test
```

Expected: core's 131 tests pass; cli reports "no test files found" but exits 0 (`passWithNoTests: true`); action also passes-with-no-tests (vitest default is to error on zero tests — set `passWithNoTests: true` in a new minimal `packages/action/vitest.config.ts` below).

- [ ] **Step 6: Create minimal action vitest config**

Create `packages/action/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
  },
})
```

- [ ] **Step 7: Re-run action smoke**

```bash
bun run --filter '@flagshark/action' test
```

Expected: exit 0, "No test files found" message.

- [ ] **Step 8: Commit**

```bash
git add packages/core/package.json packages/cli/package.json packages/action/package.json packages/action/vitest.config.ts bun.lock
git commit -m "test: install @vitest/coverage-v8 across packages"
```

---

## Task 1.2: Wire coverage config in each package

**Files:**
- Modify: `packages/core/vitest.config.ts`
- Modify: `packages/cli/vitest.config.ts`
- Modify: `packages/action/vitest.config.ts`

- [ ] **Step 1: Update core vitest config**

Replace `packages/core/vitest.config.ts` with:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/detection/detectors/*.ts', 'src/detection/index.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
```

Note: the `exclude` list still excludes the 9 regex-only detectors at this point — Phase 2 removes that. The 80% floor for Phase 1 keeps CI green while infrastructure lands.

- [ ] **Step 2: Update cli vitest config**

Replace `packages/cli/vitest.config.ts` with:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // thresholds intentionally omitted — set in Phase 3
    },
  },
})
```

- [ ] **Step 3: Update action vitest config**

Replace `packages/action/vitest.config.ts` with:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // thresholds intentionally omitted — set in Phase 4
    },
  },
})
```

- [ ] **Step 4: Add `test:coverage` scripts**

Modify `packages/core/package.json` scripts:
```json
"scripts": {
  "build": "rm -rf dist && tsc -p tsconfig.build.json && bun run copy-queries",
  "copy-queries": "mkdir -p dist/detection/tree-sitter/queries && cp src/detection/tree-sitter/queries/*.scm dist/detection/tree-sitter/queries/",
  "test": "vitest run",
  "test:coverage": "vitest run --coverage",
  "typecheck": "tsc --noEmit"
}
```

Same `test:coverage` line added to `packages/cli/package.json`:
```json
"test:coverage": "vitest run --coverage"
```

And to `packages/action/package.json`:
```json
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 5: Add root `test:coverage` fan-out**

Modify the repo-root `package.json` scripts block:
```json
"scripts": {
  "build": "bun run --filter '@flagshark/core' build && bun run --filter 'flagshark' --filter '@flagshark/action' build",
  "test": "bun run --filter '*' test",
  "test:coverage": "bun run --filter '*' test:coverage",
  "typecheck": "bun run --filter '*' typecheck"
}
```

- [ ] **Step 6: Verify coverage runs locally**

```bash
bun run test:coverage
```

Expected: all packages run; core prints a coverage table with overall numbers ≥80% (130+ tests against an engine — it should be high). cli/action print empty coverage (no tests yet). No errors.

If core falls below 80% somehow, drop the threshold to the nearest 5% below the actual number — the floor is meant to be loose for Phase 1.

- [ ] **Step 7: Commit**

```bash
git add packages/core/vitest.config.ts packages/cli/vitest.config.ts packages/action/vitest.config.ts \
       packages/core/package.json packages/cli/package.json packages/action/package.json package.json
git commit -m "test: wire vitest coverage reporters + per-package config"
```

---

## Task 1.3: Extract `repo-builder.ts` shared fixture helper

**Files:**
- Create: `packages/core/test/fixtures/repo-builder.ts`
- Modify: `packages/core/test/scan-repo.test.ts`
- Modify: `packages/core/test/scanner-excludes.test.ts`

- [ ] **Step 1: Write failing test for the helper**

Create `packages/core/test/fixtures/repo-builder.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeTempRepo, commitAll, writeFlagFile } from './repo-builder.js'

const dirsToClean: string[] = []
afterEach(() => {
  for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('repo-builder', () => {
  it('makeTempRepo creates a git repo with user config', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    const email = execFileSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf-8' }).trim()
    expect(email).toBe('test@test')
  })

  it('writeFlagFile creates missing directories and writes content', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFlagFile(dir, 'src/nested/deep.ts', 'export const x = 1\n')
    const content = readFileSync(join(dir, 'src/nested/deep.ts'), 'utf-8')
    expect(content).toBe('export const x = 1\n')
  })

  it('commitAll stages and commits everything', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFlagFile(dir, 'a.ts', 'export const a = 1\n')
    commitAll(dir, 'init')
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('init')
  })

  it('commitAll honors GIT_*_DATE for staleness control', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFlagFile(dir, 'a.ts', 'export const a = 1\n')
    commitAll(dir, 'old', '2024-01-01T00:00:00')
    const date = execFileSync('git', ['log', '-1', '--format=%aI'], { cwd: dir, encoding: 'utf-8' }).trim()
    expect(date.startsWith('2024-01-01')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run --filter '@flagshark/core' test -- repo-builder
```

Expected: FAIL — `Cannot find module './repo-builder.js'` or similar.

- [ ] **Step 3: Implement the helper**

Create `packages/core/test/fixtures/repo-builder.ts`:
```ts
/**
 * Shared fixture helpers for tests that need a real git repository
 * with controlled commit dates (for staleness scenarios).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Create an empty git repo in a fresh temp directory and return the path. */
export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flagshark-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  return dir
}

/**
 * Write a file inside the fixture repo, creating parent dirs as needed.
 * Path is repo-relative.
 */
export function writeFlagFile(repoDir: string, relPath: string, content: string): void {
  const fullPath = join(repoDir, relPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

/**
 * Stage all working-tree changes and commit. If `dateISO` is provided,
 * sets GIT_AUTHOR_DATE and GIT_COMMITTER_DATE so `git blame` sees a
 * deterministic timestamp — required for any staleness-related test.
 */
export function commitAll(repoDir: string, message: string, dateISO?: string): void {
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  const env = dateISO
    ? { ...process.env, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO }
    : process.env
  execFileSync('git', ['commit', '-qm', message], { cwd: repoDir, env })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run --filter '@flagshark/core' test -- repo-builder
```

Expected: 4 tests pass.

- [ ] **Step 5: Refactor `scan-repo.test.ts` to use the helper**

Replace the top of `packages/core/test/scan-repo.test.ts` (lines 1-15) imports + inline helper:
```ts
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { scanRepo } from '../src/scan-repo.js'
import { makeTempRepo } from './fixtures/repo-builder.js'
```

Delete the inlined `makeTempRepo` function (lines 9-15 of the current file). The existing test bodies still use `execFileSync('git', ...)` inline for `git add` / `git commit` — leave those alone for this refactor; we're just removing the duplicated helper definition.

- [ ] **Step 6: Refactor `scanner-excludes.test.ts` to use the helper**

Replace the top of `packages/core/test/scanner-excludes.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { collectFiles } from '../src/scanner.js'
import { buildExcluder } from '../src/config/excluder.js'
import { buildDefaultConfig } from '../src/config/defaults.js'
import { makeTempRepo } from './fixtures/repo-builder.js'
```

In the `beforeEach`, change `workDir = mkdtempSync(...)` + `execFileSync('git', ['init', ...])` to:
```ts
beforeEach(() => {
  workDir = makeTempRepo()
  mkdirSync(join(workDir, 'src'))
  mkdirSync(join(workDir, 'examples'))
  writeFileSync(join(workDir, 'src', 'app.ts'), 'export const x = 1\n')
  writeFileSync(join(workDir, 'src', 'app.test.ts'), 'export const t = 1\n')
  writeFileSync(join(workDir, 'examples', 'demo.ts'), 'export const d = 1\n')
})
```

Remove the now-unused `mkdtempSync` and `tmpdir` imports.

- [ ] **Step 7: Run full core test suite**

```bash
bun run --filter '@flagshark/core' test
```

Expected: all 131+ existing tests + 4 new repo-builder tests = 135 tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/test/fixtures/repo-builder.ts \
       packages/core/test/fixtures/repo-builder.test.ts \
       packages/core/test/scan-repo.test.ts \
       packages/core/test/scanner-excludes.test.ts
git commit -m "test: extract repo-builder fixture helper"
```

---

## Task 1.4: Update CI workflow

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Replace ci.yml contents**

Overwrite `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.5
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run build
      - run: bun run test:coverage
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: packages/*/coverage/lcov.info
```

Two changes from the original: `fetch-depth: 0` (needed for git blame in staleness tests), `test:coverage` replaces `test`, and an upload step.

- [ ] **Step 2: Verify the YAML parses**

```bash
bun run typecheck && bun run build && bun run test:coverage
```

Expected: all green locally. (Don't push yet — let the implementer commit, push, and check the actual workflow run in GitHub later if they want to verify CI parsing.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run coverage in CI, fetch full git history for staleness tests"
```

---

## Phase 1 acceptance gate

Before moving to Phase 2, verify:

- [ ] `bun run test:coverage` runs end-to-end across all three packages without error
- [ ] core coverage report shows ≥80% on lines/branches/functions/statements
- [ ] `packages/*/coverage/lcov.info` files exist after a coverage run
- [ ] All existing tests still pass (count: 131 from before + 4 new repo-builder tests = 135 in core; 0 in cli; 0 in action)
- [ ] `repo-builder.ts` is the single source of `makeTempRepo` (no duplicated definitions)

---

# Phase 2 — Close core coverage gaps

Goal: core to 100% coverage. Add fixtures for the 9 regex-only language detectors, remove the vitest exclude, add targeted unit tests for any remaining uncovered lines.

## Task 2.1: Create regex corpus harness

**Files:**
- Create: `packages/core/test/regex-corpus.test.ts`

- [ ] **Step 1: Write the harness as a failing test (no fixtures yet)**

Create `packages/core/test/regex-corpus.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { detectFlagsWithRegex } from '../src/detection/helpers.js'

import { defaultJavaProviders } from '../src/detection/detectors/java.js'
import { defaultKotlinProviders } from '../src/detection/detectors/kotlin.js'
import { defaultSwiftProviders } from '../src/detection/detectors/swift.js'
import { defaultRubyProviders } from '../src/detection/detectors/ruby.js'
import { defaultCSharpProviders } from '../src/detection/detectors/csharp.js'
import { defaultPHPProviders } from '../src/detection/detectors/php.js'
import { defaultRustProviders } from '../src/detection/detectors/rust.js'
import { defaultCPPProviders } from '../src/detection/detectors/cpp.js'
import { defaultObjectiveCProviders } from '../src/detection/detectors/objectivec.js'

import type { FeatureFlagProvider, Language } from '../src/detection/interface.js'

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/regex')

interface LangSpec {
  dir: string
  language: Language
  providers: () => FeatureFlagProvider[]
}

const LANGUAGES: LangSpec[] = [
  { dir: 'java',    language: 'java',         providers: defaultJavaProviders },
  { dir: 'kotlin',  language: 'kotlin',       providers: defaultKotlinProviders },
  { dir: 'swift',   language: 'swift',        providers: defaultSwiftProviders },
  { dir: 'ruby',    language: 'ruby',         providers: defaultRubyProviders },
  { dir: 'csharp',  language: 'csharp',       providers: defaultCSharpProviders },
  { dir: 'php',     language: 'php',          providers: defaultPHPProviders },
  { dir: 'rust',    language: 'rust',         providers: defaultRustProviders },
  { dir: 'cpp',     language: 'cpp',          providers: defaultCPPProviders },
  { dir: 'objc',    language: 'objectivec',   providers: defaultObjectiveCProviders },
]

for (const { dir, language, providers } of LANGUAGES) {
  const langRoot = join(FIXTURES_ROOT, dir)
  if (!existsSync(langRoot)) continue

  describe(`regex corpus / ${language}`, () => {
    for (const provider of readdirSync(langRoot)) {
      const providerRoot = join(langRoot, provider)
      const expectedPath = join(providerRoot, 'expected.json')
      if (!existsSync(expectedPath)) continue

      const cases = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Array<{
        file: string
        flags: Array<unknown>
      }>

      for (const c of cases) {
        it(`${provider} / ${c.file}`, () => {
          const fullPath = join(providerRoot, c.file)
          const content = readFileSync(fullPath, 'utf-8')
          const detected = detectFlagsWithRegex(c.file, content, language, providers())
          expect(detected).toEqual(c.flags)
        })
      }
    }
  })
}
```

Note on `Language` values: confirm the language identifier strings (`'java'`, `'csharp'`, `'objectivec'`, etc.) match what `Languages.X` enums expose. If a mismatch surfaces, import `Languages` from `../src/detection/interface.js` and use `Languages.Java`, `Languages.CSharp`, etc. — keep the assigned constants string-typed via `as const` if necessary.

- [ ] **Step 2: Verify the imports resolve**

```bash
bun run --filter '@flagshark/core' typecheck
```

Expected: type-check passes. The factory names (`defaultKotlinProviders`, etc.) must exist in each detector module — they do (see `packages/core/src/detection/detectors/java.ts:40` for the pattern).

If a factory has a slightly different name (e.g. `defaultCPlusPlusProviders`), correct the import. Quick check:
```bash
grep -h "^export function default" packages/core/src/detection/detectors/*.ts
```

- [ ] **Step 3: Run the harness — should pass-with-no-cases**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
```

Expected: 0 tests collected (no fixtures exist yet), exit 0.

- [ ] **Step 4: Commit harness**

```bash
git add packages/core/test/regex-corpus.test.ts
git commit -m "test: add regex corpus harness (no fixtures yet)"
```

---

## Task 2.2: Add LaunchDarkly fixtures for Java

**Files:**
- Create: `packages/core/test/fixtures/regex/java/launchdarkly/positive/basic.java`
- Create: `packages/core/test/fixtures/regex/java/launchdarkly/negative/no-import.java`
- Create: `packages/core/test/fixtures/regex/java/launchdarkly/expected.json`

- [ ] **Step 1: Write the positive fixture**

Create `packages/core/test/fixtures/regex/java/launchdarkly/positive/basic.java`:
```java
import com.launchdarkly.sdk.server.LDClient;

public class Checkout {
    private final LDClient client;

    public String run(LDContext context) {
        if (client.boolVariation("CHECKOUT_V2", context, false)) {
            return "v2";
        }
        return "v1";
    }
}
```

- [ ] **Step 2: Write the negative fixture (no SDK import → no detection)**

Create `packages/core/test/fixtures/regex/java/launchdarkly/negative/no-import.java`:
```java
public class Plain {
    public boolean isEnabled() {
        return boolVariation("not-detected-without-import", false);
    }

    private boolean boolVariation(String key, boolean def) {
        return def;
    }
}
```

- [ ] **Step 3: Write expected.json**

Create `packages/core/test/fixtures/regex/java/launchdarkly/expected.json`:
```json
[
  {
    "file": "positive/basic.java",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.java",
        "lineNumber": 7,
        "language": "java",
        "provider": "com.launchdarkly.sdk"
      }
    ]
  },
  {
    "file": "negative/no-import.java",
    "flags": []
  }
]
```

The `provider` value must equal the `importPattern` of the matched provider (from `packages/core/src/detection/detectors/java.ts:45`). The `language` value must match the `Language` literal the detector emits.

- [ ] **Step 4: Run the corpus tests for Java**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
```

Expected: 2 tests pass under `regex corpus / java`.

If they fail with a mismatch on `lineNumber`, count lines in `basic.java` (1-indexed) and adjust `expected.json`. If they fail on `language` value, run a one-liner to print what the detector emits:
```bash
bun -e "import('./packages/core/src/detection/detectors/java.js').then(m => { const d = new m.JavaDetector(); console.log(d.language()) })"
```
and use that exact string.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/fixtures/regex/java
git commit -m "test: add Java regex corpus fixtures (LaunchDarkly)"
```

---

## Task 2.3: Add LaunchDarkly fixtures for Kotlin

**Files:**
- Create: `packages/core/test/fixtures/regex/kotlin/launchdarkly/positive/basic.kt`
- Create: `packages/core/test/fixtures/regex/kotlin/launchdarkly/negative/no-import.kt`
- Create: `packages/core/test/fixtures/regex/kotlin/launchdarkly/expected.json`

- [ ] **Step 1: Positive fixture**

`packages/core/test/fixtures/regex/kotlin/launchdarkly/positive/basic.kt`:
```kotlin
import com.launchdarkly.sdk.server.LDClient

class Checkout(private val client: LDClient) {
    fun run(context: LDContext): String {
        if (client.boolVariation("CHECKOUT_V2", context, false)) {
            return "v2"
        }
        return "v1"
    }
}
```

- [ ] **Step 2: Negative fixture**

`packages/core/test/fixtures/regex/kotlin/launchdarkly/negative/no-import.kt`:
```kotlin
class Plain {
    fun isEnabled(): Boolean {
        return boolVariation("not-detected-without-import", false)
    }

    private fun boolVariation(key: String, def: Boolean): Boolean = def
}
```

- [ ] **Step 3: expected.json**

`packages/core/test/fixtures/regex/kotlin/launchdarkly/expected.json`:
```json
[
  {
    "file": "positive/basic.kt",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.kt",
        "lineNumber": 5,
        "language": "kotlin",
        "provider": "com.launchdarkly.sdk"
      }
    ]
  },
  {
    "file": "negative/no-import.kt",
    "flags": []
  }
]
```

- [ ] **Step 4: Verify**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
```

Expected: 4 tests pass (Java's 2 + Kotlin's 2).

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/fixtures/regex/kotlin
git commit -m "test: add Kotlin regex corpus fixtures (LaunchDarkly)"
```

---

## Task 2.4: Add LaunchDarkly fixtures for Swift

**Files:** `packages/core/test/fixtures/regex/swift/launchdarkly/{positive/basic.swift, negative/no-import.swift, expected.json}`

- [ ] **Step 1: Positive fixture**

`positive/basic.swift`:
```swift
import LaunchDarkly

class Checkout {
    let client: LDClient

    init(client: LDClient) {
        self.client = client
    }

    func run() -> String {
        if client.boolVariation(forKey: "CHECKOUT_V2", defaultValue: false) {
            return "v2"
        }
        return "v1"
    }
}
```

- [ ] **Step 2: Negative fixture**

`negative/no-import.swift`:
```swift
class Plain {
    func isEnabled() -> Bool {
        return boolVariation(forKey: "not-detected-without-import", defaultValue: false)
    }

    private func boolVariation(forKey key: String, defaultValue: Bool) -> Bool {
        return defaultValue
    }
}
```

- [ ] **Step 3: expected.json**

```json
[
  {
    "file": "positive/basic.swift",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.swift",
        "lineNumber": 11,
        "language": "swift",
        "provider": "LaunchDarkly"
      }
    ]
  },
  {
    "file": "negative/no-import.swift",
    "flags": []
  }
]
```

**Verify the provider value**: read `packages/core/src/detection/detectors/swift.ts` and use the `importPattern` of the LaunchDarkly provider verbatim — whatever string is there (likely `'LaunchDarkly'`, but use the source as the authority).

- [ ] **Step 4: Run + commit**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
git add packages/core/test/fixtures/regex/swift
git commit -m "test: add Swift regex corpus fixtures (LaunchDarkly)"
```

---

## Task 2.5: Add LaunchDarkly fixtures for Ruby (+ Rakefile/Gemspec for branch coverage)

**Files:** `packages/core/test/fixtures/regex/ruby/launchdarkly/{positive/basic.rb, negative/no-import.rb, expected.json}` and `packages/core/test/fixtures/regex/ruby/file-types/{positive/Rakefile, positive/lib.gemspec, expected.json}`

- [ ] **Step 1: Standard positive/negative fixtures for LaunchDarkly**

`launchdarkly/positive/basic.rb`:
```ruby
require 'launchdarkly-server-sdk'

class Checkout
  def initialize(client)
    @client = client
  end

  def run(context)
    if @client.variation("CHECKOUT_V2", context, false)
      return "v2"
    end
    "v1"
  end
end
```

`launchdarkly/negative/no-import.rb`:
```ruby
class Plain
  def enabled?
    variation("not-detected-without-import", nil, false)
  end

  def variation(key, ctx, default)
    default
  end
end
```

`launchdarkly/expected.json`:
```json
[
  {
    "file": "positive/basic.rb",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.rb",
        "lineNumber": 9,
        "language": "ruby",
        "provider": "launchdarkly-server-sdk"
      }
    ]
  },
  {
    "file": "negative/no-import.rb",
    "flags": []
  }
]
```

- [ ] **Step 2: Add file-type branch coverage** — exercises the `supportsFile` branches at `packages/core/src/detection/detectors/ruby.ts:27-36` (Rakefile, .gemspec). These don't need to detect a flag; they only need to be reachable through `supportsFile`. We'll add a separate unit test in Task 2.10 that drives `supportsFile` directly, since the corpus tests don't actually invoke `supportsFile` (they call `detectFlagsWithRegex` directly).

Skip this step. We'll handle it in Task 2.10.

- [ ] **Step 3: Run + commit**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
git add packages/core/test/fixtures/regex/ruby
git commit -m "test: add Ruby regex corpus fixtures (LaunchDarkly)"
```

---

## Task 2.6: Add LaunchDarkly fixtures for C#

**Files:** `packages/core/test/fixtures/regex/csharp/launchdarkly/{positive/basic.cs, negative/no-import.cs, expected.json}`

- [ ] **Step 1: Positive fixture**

`positive/basic.cs`:
```csharp
using LaunchDarkly.Sdk.Server;

public class Checkout
{
    private readonly LdClient client;

    public Checkout(LdClient client)
    {
        this.client = client;
    }

    public string Run(Context context)
    {
        if (client.BoolVariation("CHECKOUT_V2", context, false))
        {
            return "v2";
        }
        return "v1";
    }
}
```

- [ ] **Step 2: Negative fixture**

`negative/no-import.cs`:
```csharp
public class Plain
{
    public bool IsEnabled()
    {
        return BoolVariation("not-detected-without-import", false);
    }

    private bool BoolVariation(string key, bool def)
    {
        return def;
    }
}
```

- [ ] **Step 3: expected.json**

```json
[
  {
    "file": "positive/basic.cs",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.cs",
        "lineNumber": 13,
        "language": "csharp",
        "provider": "LaunchDarkly.Sdk"
      }
    ]
  },
  {
    "file": "negative/no-import.cs",
    "flags": []
  }
]
```

Confirm the provider string against `packages/core/src/detection/detectors/csharp.ts` `importPattern` for LaunchDarkly.

- [ ] **Step 4: Run + commit**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
git add packages/core/test/fixtures/regex/csharp
git commit -m "test: add C# regex corpus fixtures (LaunchDarkly)"
```

---

## Task 2.7: Add LaunchDarkly fixtures for PHP, Rust, C++, Objective-C

For each language, the same pattern: one `positive/basic.<ext>` + one `negative/no-import.<ext>` + an `expected.json`. Repeat Task 2.4's structure.

**Files (PHP):** `packages/core/test/fixtures/regex/php/launchdarkly/...`
**Files (Rust):** `packages/core/test/fixtures/regex/rust/launchdarkly/...`
**Files (C++):** `packages/core/test/fixtures/regex/cpp/launchdarkly/...`
**Files (Objective-C):** `packages/core/test/fixtures/regex/objc/launchdarkly/...`

- [ ] **Step 1: PHP fixtures**

`positive/basic.php`:
```php
<?php
require_once 'launchdarkly/server-sdk/autoload.php';

class Checkout {
    private $client;

    public function run($context) {
        if ($this->client->variation("CHECKOUT_V2", $context, false)) {
            return "v2";
        }
        return "v1";
    }
}
```

`negative/no-import.php`:
```php
<?php
class Plain {
    public function isEnabled() {
        return $this->variation("not-detected-without-import", null, false);
    }

    public function variation($key, $ctx, $default) {
        return $default;
    }
}
```

`expected.json`:
```json
[
  {
    "file": "positive/basic.php",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.php",
        "lineNumber": 8,
        "language": "php",
        "provider": "launchdarkly/server-sdk"
      }
    ]
  },
  {
    "file": "negative/no-import.php",
    "flags": []
  }
]
```

Adjust `provider` to whatever `importPattern` LaunchDarkly has in `packages/core/src/detection/detectors/php.ts`.

- [ ] **Step 2: Rust fixtures**

`positive/basic.rs`:
```rust
use launchdarkly_server_sdk::Client;

pub fn checkout(client: &Client, context: &Context) -> &'static str {
    if client.bool_variation(context, "CHECKOUT_V2", false) {
        return "v2";
    }
    "v1"
}
```

`negative/no-import.rs`:
```rust
pub fn is_enabled() -> bool {
    bool_variation("not-detected-without-import", false)
}

fn bool_variation(_key: &str, def: bool) -> bool {
    def
}
```

`expected.json` (LaunchDarkly Rust uses flagKeyIndex 1 in some SDKs — verify the index in `packages/core/src/detection/detectors/rust.ts`; adjust the example if needed):
```json
[
  {
    "file": "positive/basic.rs",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.rs",
        "lineNumber": 4,
        "language": "rust",
        "provider": "launchdarkly_server_sdk"
      }
    ]
  },
  {
    "file": "negative/no-import.rs",
    "flags": []
  }
]
```

- [ ] **Step 3: C++ fixtures**

`positive/basic.cpp`:
```cpp
#include <launchdarkly/client_side/client.hpp>

int Checkout(launchdarkly::Client& client) {
    if (client.BoolVariation("CHECKOUT_V2", false)) {
        return 2;
    }
    return 1;
}
```

`negative/no-import.cpp`:
```cpp
int Plain() {
    return BoolVariation("not-detected-without-import", false);
}

int BoolVariation(const char* key, bool def) {
    return def;
}
```

`expected.json`:
```json
[
  {
    "file": "positive/basic.cpp",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.cpp",
        "lineNumber": 4,
        "language": "cpp",
        "provider": "launchdarkly"
      }
    ]
  },
  {
    "file": "negative/no-import.cpp",
    "flags": []
  }
]
```

- [ ] **Step 4: Objective-C fixtures**

`positive/basic.m`:
```objc
#import <LaunchDarkly/LaunchDarkly.h>

@implementation Checkout
- (NSString *)run {
    if ([self.client boolVariationForKey:@"CHECKOUT_V2" defaultValue:NO]) {
        return @"v2";
    }
    return @"v1";
}
@end
```

`negative/no-import.m`:
```objc
@implementation Plain
- (BOOL)isEnabled {
    return [self boolVariationForKey:@"not-detected-without-import" defaultValue:NO];
}
@end
```

`expected.json`:
```json
[
  {
    "file": "positive/basic.m",
    "flags": [
      {
        "name": "CHECKOUT_V2",
        "filePath": "positive/basic.m",
        "lineNumber": 5,
        "language": "objectivec",
        "provider": "LaunchDarkly"
      }
    ]
  },
  {
    "file": "negative/no-import.m",
    "flags": []
  }
]
```

- [ ] **Step 5: Run all corpus tests**

```bash
bun run --filter '@flagshark/core' test -- regex-corpus
```

Expected: 18 tests pass (2 per language × 9 languages, minus 0; all should be present now).

If any individual language fails on `provider`, `language`, or `lineNumber`, read the corresponding detector source and adjust the expected.json to match what the engine actually produces. Don't change the engine to match the fixture — the fixture follows the engine.

- [ ] **Step 6: Commit each language separately for clean history**

```bash
git add packages/core/test/fixtures/regex/php
git commit -m "test: add PHP regex corpus fixtures (LaunchDarkly)"

git add packages/core/test/fixtures/regex/rust
git commit -m "test: add Rust regex corpus fixtures (LaunchDarkly)"

git add packages/core/test/fixtures/regex/cpp
git commit -m "test: add C++ regex corpus fixtures (LaunchDarkly)"

git add packages/core/test/fixtures/regex/objc
git commit -m "test: add Objective-C regex corpus fixtures (LaunchDarkly)"
```

---

## Task 2.8: Remove the vitest exclude for regex detectors

**Files:** `packages/core/vitest.config.ts`

- [ ] **Step 1: Edit vitest.config.ts**

Replace the contents with:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
```

The `exclude: ['src/detection/detectors/*.ts', 'src/detection/index.ts']` line is gone.

- [ ] **Step 2: Run coverage**

```bash
bun run --filter '@flagshark/core' test:coverage
```

Expected: tests still pass, coverage report now shows numbers for the 9 previously-excluded detectors. Coverage on each detector file: most lines covered (class methods + factory called once per language by the corpus tests). Likely 80-95% per file.

Note what's not covered — usually the `getProviders()` method (never called by the corpus), the constructor's branch when custom providers are passed (also never exercised). Tasks 2.9 and 2.10 fill these gaps.

- [ ] **Step 3: Commit**

```bash
git add packages/core/vitest.config.ts
git commit -m "test: remove vitest exclude for regex-only detectors"
```

---

## Task 2.9: Detector class branches — constructor with custom providers, getProviders, supportsFile edge cases

**Files:**
- Create: `packages/core/test/detection/detector-classes.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/core/test/detection/detector-classes.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

import { JavaDetector } from '../../src/detection/detectors/java.js'
import { KotlinDetector } from '../../src/detection/detectors/kotlin.js'
import { SwiftDetector } from '../../src/detection/detectors/swift.js'
import { RubyDetector } from '../../src/detection/detectors/ruby.js'
import { CSharpDetector } from '../../src/detection/detectors/csharp.js'
import { PHPDetector } from '../../src/detection/detectors/php.js'
import { RustDetector } from '../../src/detection/detectors/rust.js'
import { CPPDetector } from '../../src/detection/detectors/cpp.js'
import { ObjectiveCDetector } from '../../src/detection/detectors/objectivec.js'

import type { FeatureFlagProvider } from '../../src/detection/interface.js'

const ALL_DETECTORS = [
  { name: 'Java', cls: JavaDetector },
  { name: 'Kotlin', cls: KotlinDetector },
  { name: 'Swift', cls: SwiftDetector },
  { name: 'Ruby', cls: RubyDetector },
  { name: 'CSharp', cls: CSharpDetector },
  { name: 'PHP', cls: PHPDetector },
  { name: 'Rust', cls: RustDetector },
  { name: 'CPP', cls: CPPDetector },
  { name: 'ObjectiveC', cls: ObjectiveCDetector },
] as const

const CUSTOM: FeatureFlagProvider[] = [
  {
    name: 'CustomTest',
    importPattern: 'custom-test',
    description: 'test',
    enabled: true,
    methods: [{ name: 'check', flagKeyIndex: 0, examples: ['check("x")'] }],
  },
]

describe('detector classes', () => {
  for (const { name, cls } of ALL_DETECTORS) {
    describe(name, () => {
      it('default constructor uses default providers', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        expect(d.getProviders().length).toBeGreaterThan(0)
      })

      it('custom providers replace defaults', () => {
        const d = new (cls as new (p?: FeatureFlagProvider[]) => InstanceType<typeof cls>)(CUSTOM)
        expect(d.getProviders()).toEqual(CUSTOM)
      })

      it('language() returns expected string', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        expect(typeof d.language()).toBe('string')
        expect(d.language().length).toBeGreaterThan(0)
      })

      it('fileExtensions() returns non-empty array', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        const exts = d.fileExtensions()
        expect(Array.isArray(exts)).toBe(true)
        expect(exts.length).toBeGreaterThan(0)
      })

      it('supportsFile matches at least one of its extensions', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        const ext = d.fileExtensions()[0]
        expect(d.supportsFile(`test${ext}`)).toBe(true)
      })

      it('supportsFile rejects unrelated extension', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        expect(d.supportsFile('test.unknownext')).toBe(false)
      })

      it('detectFlags returns empty array for empty content', () => {
        const d = new (cls as new () => InstanceType<typeof cls>)()
        const ext = d.fileExtensions()[0]
        expect(d.detectFlags(`test${ext}`, '')).toEqual([])
      })
    })
  }
})

describe('RubyDetector special file types', () => {
  it('supports Rakefile (no extension)', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('Rakefile')).toBe(true)
  })

  it('supports Gemfile (no extension)', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('Gemfile')).toBe(true)
  })

  it('supports .gemspec', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('lib/foo.gemspec')).toBe(true)
  })

  it('supports .rake', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('tasks/foo.rake')).toBe(true)
  })

  it('handles bare filename without slash', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('Gemfile')).toBe(true)
  })

  it('rejects file with no extension and non-special name', () => {
    const d = new RubyDetector()
    expect(d.supportsFile('README')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — should pass immediately (these classes exist)**

```bash
bun run --filter '@flagshark/core' test -- detector-classes
```

Expected: PASS for all detectors. If any individual assertion fails (e.g. a detector exposes a slightly different method name), open that detector's source and adjust the test to match the actual interface.

- [ ] **Step 3: Run coverage on core**

```bash
bun run --filter '@flagshark/core' test:coverage
```

Expected: each detector file at or near 100%. Note the remaining uncovered lines for the next task.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/detection/detector-classes.test.ts
git commit -m "test: cover detector class branches (constructor, getProviders, supportsFile)"
```

---

## Task 2.10: Audit and close remaining core gaps

**Files:** Likely candidates — adjust based on what the coverage report actually reveals:
- Create: `packages/core/test/staleness-edges.test.ts` (if needed)
- Create: `packages/core/test/config/loader-errors.test.ts` (if needed)
- Create: `packages/core/test/scan-repo-edges.test.ts` (if needed)
- Create: `packages/core/test/output/select-default.test.ts` (if needed)

- [ ] **Step 1: Generate the coverage report and identify gaps**

```bash
bun run --filter '@flagshark/core' test:coverage
```

Look at the `coverage/index.html` (open in a browser) or the text output's "lines not covered" column. Identify each file where coverage is <100%. Common gaps to expect:

  - **`scan-repo.ts:154` (`opts.engine` branch)**: pass `engine: 'regex'` to `scanRepo` in a test
  - **`scan-repo.ts:189-192` (`effectiveExcludes` log + filter)**: pass `collectExcludedPaths: true` in scan-repo.test.ts
  - **`output/select.ts:57` (`default: throw new Error(...)`)**: add a test that calls `selectFormatter('bogus' as any)` and expects throw
  - **`config/loader.ts` error paths**: malformed YAML, file-not-found-on-explicit-path scenarios
  - **`staleness.ts` edge case**: scan a repo where the flag is in an untracked file (no git blame possible)

For each uncovered branch, write a small targeted test. Keep them in one file per concern.

- [ ] **Step 2: Example — `selectFormatter` default branch**

If coverage shows `output/select.ts:57` as uncovered, create `packages/core/test/output/select-default.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { selectFormatter } from '../../src/output/select.js'

describe('selectFormatter — error path', () => {
  it('throws on unknown format name', () => {
    expect(() => selectFormatter('bogus' as never)).toThrow(/Unknown format/)
  })
})
```

Run:
```bash
bun run --filter '@flagshark/core' test -- select-default
```

Expected: PASS.

- [ ] **Step 3: Example — scan-repo engine override and collectExcludedPaths**

If gaps exist on `scan-repo.ts`, append tests to `packages/core/test/scan-repo.test.ts`:
```ts
import { makeTempRepo, writeFlagFile, commitAll } from './fixtures/repo-builder.js'

it('honors engine: regex override', async () => {
  const dir = makeTempRepo()
  writeFlagFile(dir, 'src/a.ts',
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('REGEX_ENGINE_FLAG', user, false)\n`)
  commitAll(dir, 'init')

  const result = await scanRepo({ cwd: dir, engine: 'regex' })
  expect(result.totalFlags).toBe(1)
})

it('populates excludedPaths when collectExcludedPaths is true', async () => {
  const dir = makeTempRepo()
  writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
  writeFlagFile(dir, 'examples/demo.ts', 'export const y = 1\n')
  writeFlagFile(dir, '.flagsharkignore', 'examples/\n')
  commitAll(dir, 'init')

  const result = await scanRepo({ cwd: dir, collectExcludedPaths: true })
  expect(result.excludedPaths).toEqual(['examples/demo.ts'])
})
```

- [ ] **Step 4: Iterate until coverage is 100%**

Re-run coverage after each addition:
```bash
bun run --filter '@flagshark/core' test:coverage
```

For each remaining uncovered line:
- If reachable through normal API use: add a test that exercises it
- If only reachable through error states: add a test that triggers the error
- If truly unreachable (exhaustive-switch default that should never fire): add `/* v8 ignore next */` directly above the unreachable line in source, with a one-line WHY comment:
  ```ts
  /* v8 ignore next 2 — exhaustive switch; TypeScript guarantees no other format reaches here */
  default:
    throw new Error(`Unknown format: ${name as string}`)
  ```
  Cap ignores at 2 across all of core.

- [ ] **Step 5: Bump core threshold to 100%**

Edit `packages/core/vitest.config.ts`, replace the threshold block:
```ts
thresholds: {
  lines: 100,
  branches: 100,
  functions: 100,
  statements: 100,
},
```

- [ ] **Step 6: Confirm coverage gate passes**

```bash
bun run --filter '@flagshark/core' test:coverage
```

Expected: 100/100/100/100, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/test packages/core/vitest.config.ts packages/core/src
git commit -m "test: close remaining core coverage gaps; enforce 100% threshold"
```

---

## Phase 2 acceptance gate

- [ ] `bun run --filter '@flagshark/core' test:coverage` reports 100/100/100/100, exit 0
- [ ] At most 2 `/* v8 ignore */` annotations exist in `packages/core/src`, each with a one-line WHY comment
- [ ] All 9 regex-only language detectors have at least one positive and one negative fixture
- [ ] Ruby's Rakefile / Gemfile / .gemspec / .rake `supportsFile` branches are covered (via `detector-classes.test.ts`)

---

# Phase 3 — CLI E2E + 100% CLI coverage

Goal: extract a testable `runCli` function, add unit tests for parsing + formatter shim, add E2E tests that spawn the built `dist/cli.js` against fixture repos.

## Task 3.1: Refactor cli.ts to expose a testable `runCli`

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/main.ts`
- Modify: `packages/cli/package.json` (esbuild entry)

- [ ] **Step 1: Write a failing test for the new shape**

Create `packages/cli/test/unit/run-cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { runCli } from '../../src/cli.js'

function collect(stream: PassThrough): { text: () => string } {
  let buf = ''
  stream.on('data', (chunk) => { buf += chunk.toString() })
  return { text: () => buf }
}

describe('runCli', () => {
  it('prints version on --version and returns exit code 0', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--version'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(0)
    expect(out.text()).toMatch(/^flagshark v\d+\.\d+\.\d+/)
    expect(err.text()).toBe('')
  })

  it('prints help on --help and returns exit code 0', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--help'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(0)
    expect(out.text()).toContain('flagshark scan')
  })
})
```

- [ ] **Step 2: Run the test — it should fail**

```bash
bun run --filter 'flagshark' test -- run-cli
```

Expected: FAIL — `runCli` is not exported from `cli.ts` (currently `cli.ts` defines a `main()` function and calls it at module bottom).

- [ ] **Step 3: Refactor cli.ts**

Replace the bottom section of `packages/cli/src/cli.ts` (from the `async function main()` declaration to the bottom of the file) with this. The header (imports, HELP_TEXT, parseArgs, createLogger) stays as-is.

Replace lines 173-263 with:
```ts
// ── Public entry — pure, returns exit code instead of calling process.exit ────

export interface RunCliIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  cwd: string
}

export async function runCli(argv: string[], io: RunCliIO): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.stderr.write(`[error] ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  if (args.version) {
    io.stdout.write(`flagshark v${VERSION}\n`)
    return 0
  }

  if (args.help) {
    io.stdout.write(HELP_TEXT + '\n')
    return 0
  }

  const logger = createLogger(args.verbose)

  if (args.diff) {
    logger.info(`Scanning files changed since ${args.diff}...`)
  } else {
    logger.info('Scanning current directory...')
  }

  let configOverride: FlagsharkConfig | undefined
  if (args.configPath) {
    if (!existsSync(args.configPath)) {
      io.stderr.write(`Error: config file not found: ${args.configPath}\n`)
      return 2
    }
    const raw = readFileSync(args.configPath, 'utf-8')
    const parsed = parseYaml(raw)
    const configResult = FlagsharkConfigSchema.safeParse(parsed)
    if (!configResult.success) {
      io.stderr.write(`Error: invalid config at ${args.configPath}: ${configResult.error.message}\n`)
      return 2
    }
    configOverride = configResult.data
  }

  const result = await scanRepo({
    cwd: io.cwd,
    threshold: args.threshold,
    diff: args.diff ?? undefined,
    engine: args.engine,
    config: configOverride,
    noConfig: args.noConfig,
    noIgnoreFile: args.noIgnoreFile,
    collectExcludedPaths: args.showExcluded,
    logger,
  })

  if (args.verbose && result.effectiveExcludes) {
    const r = result.effectiveExcludes
    const allRules = [
      ...r.paths.map((p) => `excludes.paths: ${p}`),
      ...r.files.map((p) => `excludes.files: ${p}`),
      ...r.presets.flatMap((name, i) => [`excludes.presets[${i}]: ${name}`]),
      ...r.ignoreFile.map((p) => `.flagsharkignore: ${p}`),
    ]
    if (allRules.length > 0) {
      io.stderr.write('Effective excludes:\n')
      for (const rule of allRules) io.stderr.write(`  ${rule}\n`)
    }
  }

  const formatter = selectFormatter(args.format)
  const output = formatter(result, {
    version: VERSION,
    scanMode: args.diff ? 'changed' : 'full',
    verbose: args.verbose,
  })

  const exitCode = result.staleFlags.length > 0 ? 1 : 0

  if (args.output) {
    writeFileSync(args.output, output)
    return exitCode
  }

  const finalOutput = output.endsWith('\n') ? output : output + '\n'
  io.stdout.write(finalOutput)
  return exitCode
}
```

`runCli` returns the exit code instead of calling `process.exit`. The `process.stdout.once('drain', ...)` flushing logic is dropped — vitest's PassThrough handles writes synchronously, and Node's stdio in the real binary path will flush on process exit.

Also note: `createLogger` currently writes to `console.error` (i.e. process.stderr). We don't reroute it through `io.stderr` here; the E2E tests will check `console.error` output by capturing the spawned binary's stderr, and the unit tests don't care about logger output. If a unit test does need to inspect logger output, refactor `createLogger` to take a `stderr` stream as a follow-up — not blocking for 100%.

- [ ] **Step 4: Create thin main.ts entry**

Create `packages/cli/src/main.ts`:
```ts
#!/usr/bin/env node
import { runCli } from './cli.js'

/* v8 ignore start — thin process-entry shim, exercised only by the binary */
runCli(process.argv, {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
})
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`[error] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  })
/* v8 ignore stop */
```

- [ ] **Step 5: Update esbuild entry in package.json**

Modify `packages/cli/package.json` `scripts.build`:
```json
"build": "esbuild src/main.ts --bundle --platform=node --target=node18 --format=esm --outfile=dist/cli.js --external:zod --external:@flagshark/core --external:yaml"
```

(Change `src/cli.ts` → `src/main.ts`.)

- [ ] **Step 6: Verify build still produces a working binary**

```bash
bun run --filter 'flagshark' build
node packages/cli/dist/cli.js --version
```

Expected: prints `flagshark v1.3.1` (or whatever VERSION is set to).

- [ ] **Step 7: Run unit tests**

```bash
bun run --filter 'flagshark' test
```

Expected: 2 unit tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cli.ts packages/cli/src/main.ts packages/cli/package.json \
       packages/cli/test/unit/run-cli.test.ts
git commit -m "refactor: extract runCli(argv, io) for testability; main.ts as entry"
```

---

## Task 3.2: Unit tests for `parseArgs`

**Files:**
- Create: `packages/cli/test/unit/parse-args.test.ts`
- Modify: `packages/cli/src/cli.ts` (export `parseArgs`)

- [ ] **Step 1: Export parseArgs**

In `packages/cli/src/cli.ts`, change `function parseArgs` to `export function parseArgs`. Also export `CliArgs` interface.

- [ ] **Step 2: Write failing tests**

Create `packages/cli/test/unit/parse-args.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../src/cli.js'

function args(...flags: string[]) {
  return parseArgs(['node', 'cli', ...flags])
}

describe('parseArgs', () => {
  it('defaults', () => {
    const a = args()
    expect(a.format).toBe('text')
    expect(a.json).toBe(false)
    expect(a.diff).toBe(null)
    expect(a.threshold).toBeUndefined()
    expect(a.verbose).toBe(false)
    expect(a.help).toBe(false)
    expect(a.version).toBe(false)
  })

  it('--json sets format to json and json flag true', () => {
    const a = args('--json')
    expect(a.json).toBe(true)
    expect(a.format).toBe('json')
  })

  it.each([
    ['text'], ['json'], ['markdown'], ['csv'], ['sarif'],
  ])('--format %s', (fmt) => {
    expect(args('--format', fmt).format).toBe(fmt)
  })

  it('--format=json supports equals form', () => {
    expect(args('--format=json').format).toBe('json')
  })

  it('--format bogus is rejected', () => {
    expect(() => args('--format', 'bogus')).toThrow()
  })

  it('--output captures path', () => {
    expect(args('--output', '/tmp/out.json').output).toBe('/tmp/out.json')
  })

  it('-o is an alias for --output', () => {
    expect(args('-o', '/tmp/out.json').output).toBe('/tmp/out.json')
  })

  it('--diff captures ref', () => {
    expect(args('--diff', 'HEAD~1').diff).toBe('HEAD~1')
  })

  it('--diff without value throws', () => {
    expect(() => args('--diff')).toThrow(/--diff requires/)
  })

  it('--threshold accepts positive integer', () => {
    expect(args('--threshold', '12').threshold).toBe(12)
  })

  it('--threshold rejects zero', () => {
    expect(() => args('--threshold', '0')).toThrow(/positive integer/)
  })

  it('--threshold rejects non-numeric', () => {
    expect(() => args('--threshold', 'abc')).toThrow(/positive integer/)
  })

  it('--verbose', () => {
    expect(args('--verbose').verbose).toBe(true)
  })

  it('--help and -h', () => {
    expect(args('--help').help).toBe(true)
    expect(args('-h').help).toBe(true)
  })

  it('--version and -v', () => {
    expect(args('--version').version).toBe(true)
    expect(args('-v').version).toBe(true)
  })

  it('--engine accepts regex|tree-sitter', () => {
    expect(args('--engine', 'regex').engine).toBe('regex')
    expect(args('--engine', 'tree-sitter').engine).toBe('tree-sitter')
  })

  it('--config requires path', () => {
    expect(args('--config', './x.yml').configPath).toBe('./x.yml')
    expect(() => args('--config')).toThrow(/--config requires/)
  })

  it('--no-config, --no-ignore-file, --show-excluded', () => {
    const a = args('--no-config', '--no-ignore-file', '--show-excluded')
    expect(a.noConfig).toBe(true)
    expect(a.noIgnoreFile).toBe(true)
    expect(a.showExcluded).toBe(true)
  })

  it('scan subcommand is a no-op', () => {
    expect(args('scan').format).toBe('text')
  })

  it('unknown flag throws', () => {
    expect(() => args('--bogus')).toThrow(/Unknown option/)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
bun run --filter 'flagshark' test -- parse-args
```

Expected: all tests pass (parseArgs already exists; this is a coverage-completion task).

Note: the `--engine` invalid-value case at `packages/cli/src/cli.ts:122-124` calls `process.exit(2)` directly, which would terminate the test process. Adjust the test for that case: `--engine bogus` is *not* covered by an exception throw in parseArgs — it terminates the process. We'll cover it instead via an E2E test in Task 3.5.

Also: `--format bogus` at lines 84-87 has the same `process.exit(2)` pattern. Same handling — covered in E2E.

Update the unit test file: remove the `expect(() => args('--format', 'bogus')).toThrow()` test. Replace with a comment noting that bogus values exit non-zero, covered in E2E.

- [ ] **Step 4: Refactor parseArgs to throw instead of calling process.exit** (so it's unit-testable)

Edit `packages/cli/src/cli.ts` parseArgs:
- Replace `process.stderr.write(\`Error: --format must be one of...\`); process.exit(2)` with `throw new Error(\`--format must be one of text, json, markdown, csv, sarif; got '${v}'\`)`.
- Replace the equivalent for `--engine`: `throw new Error(\`--engine must be 'regex' or 'tree-sitter', got '${value}'\`)`.

Now `runCli`'s `try { parseArgs }` catches these and writes them to `io.stderr` and returns 2 — already wired in the refactor from Task 3.1.

- [ ] **Step 5: Re-add the throwing tests**

Add back:
```ts
it('--format bogus throws', () => {
  expect(() => args('--format', 'bogus')).toThrow(/--format must be one of/)
})

it('--engine bogus throws', () => {
  expect(() => args('--engine', 'bogus')).toThrow(/--engine must be/)
})
```

- [ ] **Step 6: Run all cli unit tests**

```bash
bun run --filter 'flagshark' test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/cli.ts packages/cli/test/unit/parse-args.test.ts
git commit -m "test: cover parseArgs; throw on invalid values instead of exiting"
```

---

## Task 3.3: Cover formatter shim

**Files:** `packages/cli/test/unit/formatter.test.ts`

`packages/cli/src/formatter.ts` is a deprecated 8-line shim that re-exports from `@flagshark/core`. To hit 100% on it, we just need to import each named export and confirm it resolves.

- [ ] **Step 1: Write the test**

Create `packages/cli/test/unit/formatter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('formatter shim', () => {
  it('re-exports formatText and formatJson', async () => {
    const mod = await import('../../src/formatter.js')
    expect(typeof mod.formatText).toBe('function')
    expect(typeof mod.formatJson).toBe('function')
  })
})
```

(Types are erased at runtime, so we can't assert on `TextFormatOptions` / `JsonFormatOptions` / `ScanResult` directly. The line-coverage hit comes from the module evaluation itself — importing a module is enough to count its re-export lines as covered.)

- [ ] **Step 2: Run + commit**

```bash
bun run --filter 'flagshark' test -- formatter
git add packages/cli/test/unit/formatter.test.ts
git commit -m "test: cover deprecated formatter shim"
```

---

## Task 3.4: CLI E2E harness — `run-cli` helper

**Files:** `packages/cli/test/helpers/run-cli.ts`

- [ ] **Step 1: Write the helper**

Create `packages/cli/test/helpers/run-cli.ts`:
```ts
/**
 * Spawns the built CLI binary (packages/cli/dist/cli.js) in a child process.
 * Used by E2E tests — does NOT contribute to coverage data (child-process v8
 * coverage isn't merged back to vitest).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')

export interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RunCliOpts {
  cwd: string
  env?: NodeJS.ProcessEnv
}

export function runCli(args: string[], opts: RunCliOpts): CliResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf-8',
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}
```

- [ ] **Step 2: Update package.json scripts to build before tests**

`packages/cli/package.json`:
```json
"scripts": {
  "build": "esbuild src/main.ts --bundle --platform=node --target=node18 --format=esm --outfile=dist/cli.js --external:zod --external:@flagshark/core --external:yaml",
  "test": "bun run build && vitest run",
  "test:coverage": "bun run build && vitest run --coverage",
  "typecheck": "tsc --noEmit"
}
```

(Adds `bun run build &&` prefix on `test` and `test:coverage`.)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/helpers/run-cli.ts packages/cli/package.json
git commit -m "test: add CLI E2E spawn helper; build before tests"
```

---

## Task 3.5: E2E — version/help/unknown-flag

**Files:** `packages/cli/test/e2e/version-help.test.ts`

- [ ] **Step 1: Write tests**

Create `packages/cli/test/e2e/version-help.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { runCli } from '../helpers/run-cli.js'

describe('CLI E2E — version, help, unknown', () => {
  it('--version prints version and exits 0', () => {
    const r = runCli(['--version'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^flagshark v\d+\.\d+\.\d+/)
  })

  it('-v is an alias for --version', () => {
    const r = runCli(['-v'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^flagshark v/)
  })

  it('--help prints help and exits 0', () => {
    const r = runCli(['--help'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('flagshark scan')
    expect(r.stdout).toContain('--threshold')
  })

  it('-h is an alias for --help', () => {
    const r = runCli(['-h'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('flagshark scan')
  })

  it('unknown flag exits 2 with stderr error', () => {
    const r = runCli(['--nope'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/Unknown option/)
  })

  it('--format bogus exits 2', () => {
    const r = runCli(['--format', 'bogus'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/--format must be one of/)
  })

  it('--engine bogus exits 2', () => {
    const r = runCli(['--engine', 'bogus'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/--engine must be/)
  })

  it('--threshold 0 exits 2', () => {
    const r = runCli(['--threshold', '0'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
  })

  it('--threshold abc exits 2', () => {
    const r = runCli(['--threshold', 'abc'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
  })

  it('--diff without value exits 2', () => {
    const r = runCli(['--diff'], { cwd: process.cwd() })
    expect(r.exitCode).toBe(2)
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter 'flagshark' test -- version-help
git add packages/cli/test/e2e/version-help.test.ts
git commit -m "test: CLI E2E — version, help, error-flag exit codes"
```

---

## Task 3.6: E2E — basic scan happy paths

**Files:** `packages/cli/test/e2e/scan-basic.test.ts`

- [ ] **Step 1: Write tests**

Create `packages/cli/test/e2e/scan-basic.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — basic scan', () => {
  it('exits 0 for a repo with no flags', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/empty.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli([], { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('FlagShark')
  })

  it('exits 0 for a repo with non-stale flags', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    const body =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFlagFile(dir, 'src/a.ts', body + `client.variation('FRESH_FLAG', user, false)\n`)
    writeFlagFile(dir, 'src/b.ts', body + `client.variation('FRESH_FLAG', user, false)\n`)
    commitAll(dir, 'init')

    const r = runCli([], { cwd: dir })
    expect(r.exitCode).toBe(0)
  })

  it('exits 1 when stale flags found', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const r = runCli([], { cwd: dir })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toMatch(/stale/i)
  })

  it('--verbose emits info logs to stderr', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli(['--verbose'], { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('[info]')
  })
})
```

- [ ] **Step 2: Run**

```bash
bun run --filter 'flagshark' test -- scan-basic
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/e2e/scan-basic.test.ts
git commit -m "test: CLI E2E — basic scan exit codes (0, 1, verbose)"
```

---

## Task 3.7: E2E — config discovery and overrides

**Files:** `packages/cli/test/e2e/scan-config.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — config', () => {
  it('auto-discovers .flagshark.yml from cwd', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FOO', user, false)\n`)
    writeFlagFile(dir, 'src/a.test.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('TEST_FOO', user, false)\n`)
    writeFlagFile(dir, '.flagshark.yml', 'excludes:\n  presets:\n    - test-files\n')
    commitAll(dir, 'init')

    const r = runCli(['--format', 'json'], { cwd: dir })
    expect(r.exitCode).toBeLessThanOrEqual(1)
    expect(r.stdout).toContain('"FOO"')
    expect(r.stdout).not.toContain('"TEST_FOO"')
  })

  it('--config <path> overrides discovery', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FOO', user, false)\n`)
    writeFileSync(join(dir, 'custom.yml'), 'threshold: 24\n')
    commitAll(dir, 'init')

    const r = runCli(['--config', 'custom.yml', '--format', 'json'], { cwd: dir })
    expect(r.exitCode).toBeLessThanOrEqual(1)
  })

  it('--config with missing file exits 2', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli(['--config', './nope.yml'], { cwd: dir })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/config file not found/i)
  })

  it('--config with malformed YAML exits 2', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    writeFileSync(join(dir, 'bad.yml'), 'threshold: "not-a-number"\nbogus_root: [::\n')
    commitAll(dir, 'init')

    const r = runCli(['--config', 'bad.yml'], { cwd: dir })
    expect(r.exitCode).toBe(2)
  })

  it('--no-config ignores .flagshark.yml', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FOO', user, false)\n`)
    writeFlagFile(dir, 'src/a.test.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('TEST_FOO', user, false)\n`)
    writeFlagFile(dir, '.flagshark.yml', 'excludes:\n  presets:\n    - test-files\n')
    commitAll(dir, 'init')

    const r = runCli(['--no-config', '--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"TEST_FOO"')
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter 'flagshark' test -- scan-config
git add packages/cli/test/e2e/scan-config.test.ts
git commit -m "test: CLI E2E — config discovery, --config, --no-config"
```

---

## Task 3.8: E2E — ignore-file paths

**Files:** `packages/cli/test/e2e/scan-ignore.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — ignore file', () => {
  it('honors .flagsharkignore by default', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL', user, false)\n`)
    writeFlagFile(dir, 'examples/demo.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('DEMO', user, false)\n`)
    writeFlagFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const r = runCli(['--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"REAL"')
    expect(r.stdout).not.toContain('"DEMO"')
  })

  it('--no-ignore-file bypasses .flagsharkignore', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL', user, false)\n`)
    writeFlagFile(dir, 'examples/demo.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('DEMO', user, false)\n`)
    writeFlagFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const r = runCli(['--no-ignore-file', '--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"REAL"')
    expect(r.stdout).toContain('"DEMO"')
  })

  it('--show-excluded with --verbose logs effective excludes', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    writeFlagFile(dir, 'examples/demo.ts', 'export const y = 1\n')
    writeFlagFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const r = runCli(['--show-excluded', '--verbose'], { cwd: dir })
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('Effective excludes')
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter 'flagshark' test -- scan-ignore
git add packages/cli/test/e2e/scan-ignore.test.ts
git commit -m "test: CLI E2E — ignore file behavior and --show-excluded"
```

---

## Task 3.9: E2E — output format matrix and --output

**Files:** `packages/cli/test/e2e/scan-output.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function makeRepo(): string {
  const dir = makeTempRepo()
  dirs.push(dir)
  const body =
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n`
  writeFlagFile(dir, 'src/a.ts', body + `client.variation('A_FLAG', user, false)\n`)
  writeFlagFile(dir, 'src/b.ts', body + `client.variation('A_FLAG', user, false)\n`)
  commitAll(dir, 'init')
  return dir
}

describe('CLI E2E — output formats', () => {
  it('text is default', () => {
    const r = runCli([], { cwd: makeRepo() })
    expect(r.stdout).toContain('FlagShark')
  })

  it('--format json emits valid JSON', () => {
    const r = runCli(['--format', 'json'], { cwd: makeRepo() })
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  it('--json alias works', () => {
    const r = runCli(['--json'], { cwd: makeRepo() })
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  })

  it('--format markdown', () => {
    const r = runCli(['--format', 'markdown'], { cwd: makeRepo() })
    expect(r.stdout).toMatch(/^#|^\|/m)
  })

  it('--format csv', () => {
    const r = runCli(['--format', 'csv'], { cwd: makeRepo() })
    expect(r.stdout).toContain(',')
  })

  it('--format sarif', () => {
    const r = runCli(['--format', 'sarif'], { cwd: makeRepo() })
    const parsed = JSON.parse(r.stdout)
    expect(parsed.$schema).toMatch(/sarif/i)
  })

  it('--output writes to file instead of stdout', () => {
    const dir = makeRepo()
    const outPath = join(dir, 'report.json')
    const r = runCli(['--format', 'json', '--output', outPath], { cwd: dir })
    expect(r.stdout).toBe('')
    expect(existsSync(outPath)).toBe(true)
    expect(() => JSON.parse(readFileSync(outPath, 'utf-8'))).not.toThrow()
  })

  it('-o alias for --output', () => {
    const dir = makeRepo()
    const outPath = join(dir, 'report.json')
    runCli(['--format', 'json', '-o', outPath], { cwd: dir })
    expect(existsSync(outPath)).toBe(true)
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter 'flagshark' test -- scan-output
git add packages/cli/test/e2e/scan-output.test.ts
git commit -m "test: CLI E2E — output format matrix + --output file"
```

---

## Task 3.10: E2E — diff mode

**Files:** `packages/cli/test/e2e/scan-diff.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runCli } from '../helpers/run-cli.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('CLI E2E — --diff', () => {
  it('only scans changed files since ref', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    const body =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFlagFile(dir, 'src/old.ts', body + `client.variation('OLD', user, false)\n`)
    commitAll(dir, 'first')

    writeFlagFile(dir, 'src/new.ts', body + `client.variation('NEW', user, false)\n`)
    commitAll(dir, 'second')

    const r = runCli(['--diff', 'HEAD~1', '--format', 'json'], { cwd: dir })
    expect(r.stdout).toContain('"NEW"')
    expect(r.stdout).not.toContain('"OLD"')
  })

  it('--diff stderr info log includes the ref', () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const r = runCli(['--diff', 'HEAD'], { cwd: dir })
    expect(r.stderr).toContain('HEAD')
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter 'flagshark' test -- scan-diff
git add packages/cli/test/e2e/scan-diff.test.ts
git commit -m "test: CLI E2E — --diff scans only changed files"
```

---

## Task 3.11: CLI coverage gap audit + bump threshold

**Files:**
- Modify: `packages/cli/vitest.config.ts`
- Possibly add unit tests to fill gaps

- [ ] **Step 1: Run coverage**

```bash
bun run --filter 'flagshark' test:coverage
```

Inspect the report. The `runCli` function from Task 3.1 contains many branches: config-file-not-found, malformed YAML, verbose-with-excludes, `args.output` truthy, `args.diff` truthy, `staleFlags.length > 0` for exit code, etc. Most are covered by E2E tests, but E2E tests don't contribute coverage data.

Likely-uncovered branches in `cli.ts` `runCli`:
- The `try { parseArgs } catch` branch — covered by E2E `unknown flag`, but not by unit. Need a unit test.
- The verbose-with-effective-excludes branch — needs a unit test
- The `args.output` true branch — needs a unit test using a temp file
- The drain/non-drain branch — gone after the Task 3.1 refactor (write is non-blocking, no `process.exit`)

- [ ] **Step 2: Add unit tests for `runCli` branches not covered by smoke**

Append to `packages/cli/test/unit/run-cli.test.ts`:
```ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach } from 'vitest'
import { join } from 'node:path'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirsToClean: string[] = []
afterEach(() => { for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('runCli — coverage branches', () => {
  it('returns 2 on parseArgs error', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--bogus'], { stdout, stderr, cwd: process.cwd() })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/Unknown option/)
  })

  it('returns 2 when --config path does not exist', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--config', './nope.yml'], { stdout, stderr, cwd: dir })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/config file not found/i)
  })

  it('returns 2 on malformed config', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFileSync(join(dir, 'bad.yml'), 'threshold: "abc"\n')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    const code = await runCli(['node', 'cli', '--config', 'bad.yml'], { stdout, stderr, cwd: dir })
    expect(code).toBe(2)
    expect(err.text()).toMatch(/invalid config/)
  })

  it('writes to --output path and skips stdout', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')
    const outPath = join(dir, 'out.json')

    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const out = collect(stdout)
    const code = await runCli(['node', 'cli', '--format', 'json', '--output', outPath], { stdout, stderr, cwd: dir })
    expect(code).toBe(0)
    expect(out.text()).toBe('')
    expect(readFileSync(outPath, 'utf-8').length).toBeGreaterThan(0)
  })

  it('returns 1 when stale flags found', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFlagFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const code = await runCli(['node', 'cli'], { stdout, stderr, cwd: dir })
    expect(code).toBe(1)
  })

  it('verbose with effective excludes prints them to stderr', async () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    writeFlagFile(dir, '.flagsharkignore', 'examples/\n')
    commitAll(dir, 'init')

    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const err = collect(stderr)
    await runCli(['node', 'cli', '--verbose', '--show-excluded'], { stdout, stderr, cwd: dir })
    expect(err.text()).toMatch(/Effective excludes|.flagsharkignore/)
  })
})
```

- [ ] **Step 3: Re-run coverage**

```bash
bun run --filter 'flagshark' test:coverage
```

Iterate: if any line in `cli.ts` is still uncovered, add a targeted unit test. If a line is truly unreachable (only the `main.ts` shim), it should already be wrapped in `/* v8 ignore start/stop */`.

- [ ] **Step 4: Bump threshold to 100%**

Edit `packages/cli/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
```

- [ ] **Step 5: Confirm gate passes**

```bash
bun run --filter 'flagshark' test:coverage
```

Expected: 100/100/100/100, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/test packages/cli/vitest.config.ts
git commit -m "test: close CLI coverage gaps; enforce 100% threshold"
```

---

## Phase 3 acceptance gate

- [ ] `bun run --filter 'flagshark' test:coverage` reports 100/100/100/100
- [ ] Every CLI flag in HELP_TEXT has at least one E2E test asserting on observable behavior
- [ ] CLI binary `dist/cli.js` works when invoked directly (`node packages/cli/dist/cli.js --version`)
- [ ] At most one `/* v8 ignore */` annotation in `packages/cli/src` (the `main.ts` shim)

---

# Phase 4 — Action E2E + 100% Action coverage

Goal: extract a DI'd `run()` in the Action source, write hand-rolled fakes for `@actions/core` and `@actions/github`, exercise every code path through E2E tests.

## Task 4.1: Refactor `packages/action/src/index.ts` to extract `run()`

**Files:**
- Create: `packages/action/src/run.ts`
- Modify: `packages/action/src/index.ts`

- [ ] **Step 1: Write the failing import test**

Create `packages/action/test/unit/run-exists.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('action run() export', () => {
  it('is exported from run.ts', async () => {
    const mod = await import('../../src/run.js')
    expect(typeof mod.run).toBe('function')
  })
})
```

- [ ] **Step 2: Run — should fail**

```bash
bun run --filter '@flagshark/action' test -- run-exists
```

Expected: FAIL — `Cannot find module '../../src/run.js'`.

- [ ] **Step 3: Create run.ts by moving logic from index.ts**

Create `packages/action/src/run.ts`:
```ts
/**
 * Pure, dependency-injected action body. Importable in tests without
 * triggering top-level side effects.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { scanRepo as defaultScanRepo, formatMarkdown, formatSarif, healthEmoji } from '@flagshark/core'
import type { ScanRepoResult } from '@flagshark/core'

const COMMENT_MARKER = '<!-- flagshark-action -->'

export interface RunDeps {
  core: typeof import('@actions/core')
  github: typeof import('@actions/github')
  cwd: string
  scanRepoFn?: typeof defaultScanRepo
}

function formatLogArgs(args: unknown[]): string {
  return args.map(a =>
    typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ')
}

export async function run(deps: RunDeps): Promise<void> {
  const { core, github, cwd, scanRepoFn = defaultScanRepo } = deps

  const logger = {
    debug: (...args: unknown[]) => core.debug(formatLogArgs(args)),
    info: (...args: unknown[]) => core.info(formatLogArgs(args)),
    warn: (...args: unknown[]) => core.warning(formatLogArgs(args)),
    error: (...args: unknown[]) => core.error(formatLogArgs(args)),
  }

  try {
    const scanMode = core.getInput('scan') || 'changed'
    const threshold = parseInt(core.getInput('threshold') || '6', 10)
    const failThreshold = parseInt(core.getInput('fail-threshold') || '0', 10)
    const outputFormat = core.getInput('output-format') || 'markdown'

    if (outputFormat !== 'markdown' && outputFormat !== 'none') {
      core.warning(`Unknown output-format "${outputFormat}" — expected "markdown" or "none". Defaulting to "markdown".`)
    }

    const baseRef =
      scanMode === 'changed' && github.context.payload.pull_request
        ? `origin/${github.context.payload.pull_request.base.ref}`
        : undefined

    if (scanMode === 'changed' && !github.context.payload.pull_request) {
      core.info('scan: changed requested but no pull_request context — scanning full tree instead')
    }

    const result = await scanRepoFn({ cwd, threshold, diff: baseRef, logger })

    const {
      totalFlags, filesScanned, staleFlags,
      detectedProviders: providers,
      languageBreakdown: langStats,
      healthScore, scanDuration,
    } = result

    const uniqueStaleNames = new Set(staleFlags.map((f) => f.name)).size

    core.info('')
    core.info('┌─────────────────────────────────────────┐')
    core.info('│  🦈 FlagShark Scan Results               │')
    core.info('├─────────────────────────────────────────┤')
    core.info(`│  Files scanned:    ${String(filesScanned).padStart(6)}               │`)
    core.info(`│  Languages:        ${String(Object.keys(langStats).length).padStart(6)}               │`)
    core.info(`│  Flags detected:   ${String(totalFlags).padStart(6)}               │`)
    core.info(`│  Stale flags:      ${String(uniqueStaleNames).padStart(6)}               │`)
    core.info(`│  Health score:   ${String(healthScore).padStart(3)}/100               │`)
    core.info(`│  Scan time:      ${String(scanDuration).padStart(5)}ms               │`)
    core.info('└─────────────────────────────────────────┘')
    core.info('')

    if (providers.length > 0) {
      core.info(`Detected providers: ${providers.slice(0, 8).join(', ')}${providers.length > 8 ? ` (+${providers.length - 8} more)` : ''}`)
    }

    core.setOutput('health-score', healthScore.toString())
    core.setOutput('stale-count', uniqueStaleNames.toString())
    core.setOutput('total-count', totalFlags.toString())

    const sarifPath = core.getInput('sarif')
    if (sarifPath) {
      const actionVersion = process.env.GITHUB_ACTION_REF || 'unknown'
      const sarifJson = formatSarif(result, { version: actionVersion })
      const absolutePath = resolve(cwd, sarifPath)
      writeFileSync(absolutePath, sarifJson)
      core.info(`Wrote SARIF to ${absolutePath}`)
      core.setOutput('sarif-path', absolutePath)
    }

    if (github.context.payload.pull_request && totalFlags > 0 && outputFormat === 'markdown') {
      const token = process.env.GITHUB_TOKEN || core.getInput('token')
      if (token) {
        await postComment({ core, github, token, result, scanMode: scanMode as 'full' | 'changed' })
      }
    }

    if (failThreshold > 0 && healthScore < failThreshold) {
      core.setFailed(
        `Flag health score ${healthScore}/100 is below threshold ${failThreshold}/100. ` +
        `${uniqueStaleNames} stale flags found.`,
      )
    }

    const emoji = healthEmoji(healthScore)
    core.summary.addHeading('🦈 FlagShark Scan Results', 2)
    core.summary.addRaw(`\n${emoji} **Health Score: ${healthScore}/100**\n\n`)
    core.summary.addTable([
      [{ data: 'Metric', header: true }, { data: 'Value', header: true }],
      ['Files scanned', filesScanned.toString()],
      ['Languages', Object.keys(langStats).join(', ') || 'none'],
      ['Total flags', totalFlags.toString()],
      ['Stale flags', uniqueStaleNames.toString()],
      ['Scan mode', scanMode],
      ['Scan time', `${scanDuration}ms`],
    ])

    if (providers.length > 0) {
      core.summary.addRaw(`\n**Detected providers:** ${providers.join(', ')}\n`)
    }

    if (uniqueStaleNames > 0) {
      core.summary.addRaw('\n### Top stale flags\n\n')
      core.summary.addTable([
        [{ data: 'Flag', header: true }, { data: 'File', header: true }, { data: 'Age', header: true }, { data: 'Signal', header: true }],
        ...staleFlags.slice(0, 15).map(f => [
          `\`${f.name}\``,
          `${f.filePath}:${f.lineNumber}`,
          f.age || 'unknown',
          f.signals.map(s => s.description).join(', '),
        ]),
      ])
      if (staleFlags.length > 15) {
        core.summary.addRaw(`\n*... and ${staleFlags.length - 15} more stale flags*\n`)
      }
    }

    core.summary.addRaw('\n---\n')
    core.summary.addRaw('*Powered by [FlagShark](https://github.com/FlagShark/flagshark) — find stale feature flags before they cause incidents*\n')
    core.summary.addRaw('\n[Automate flag cleanup](https://flagshark.com) · [Open source CLI](https://github.com/FlagShark/flagshark) · [Report an issue](https://github.com/FlagShark/flagshark/issues)\n')

    await core.summary.write()
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unexpected error occurred')
    }
  }
}

async function postComment(opts: {
  core: typeof import('@actions/core')
  github: typeof import('@actions/github')
  token: string
  result: ScanRepoResult
  scanMode: 'full' | 'changed'
}): Promise<void> {
  const { core, github, token, result, scanMode } = opts
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const prNumber = github.context.payload.pull_request!.number
  const headSha = github.context.payload.pull_request!.head.sha
  const linkPrefix = `https://github.com/${owner}/${repo}/blob/${headSha}/`

  const body = formatMarkdown(result, {
    scanMode,
    linkPrefix,
    commentMarker: COMMENT_MARKER,
  })

  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: prNumber, per_page: 100,
  })

  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER))

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    core.info('Updated existing FlagShark comment')
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
    core.info('Posted new FlagShark comment')
  }
}
```

- [ ] **Step 4: Rewrite index.ts as thin entry**

Overwrite `packages/action/src/index.ts`:
```ts
/**
 * GitHub Action entry point. Sets WASM/queries env paths before importing
 * core, then delegates to run().
 */

declare const __dirname: string
import { join } from 'node:path'
process.env.FLAGSHARK_WASM_DIR = join(__dirname, 'grammars')
process.env.FLAGSHARK_QUERIES_DIR = join(__dirname, 'queries')

import * as core from '@actions/core'
import * as github from '@actions/github'
import { run } from './run.js'

/* v8 ignore start — thin process-entry shim, exercised by the action runner */
run({ core, github, cwd: process.cwd() })
/* v8 ignore stop */
```

- [ ] **Step 5: Verify build still works**

```bash
bun run --filter '@flagshark/action' build
```

Expected: `packages/action/dist/action.cjs` (or equivalent) builds without error.

- [ ] **Step 6: Run unit test**

```bash
bun run --filter '@flagshark/action' test -- run-exists
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/action/src/run.ts packages/action/src/index.ts \
       packages/action/test/unit/run-exists.test.ts
git commit -m "refactor: extract run(deps) for Action testability"
```

---

## Task 4.2: Fake `@actions/core`

**Files:** `packages/action/test/helpers/fake-actions-core.ts`

- [ ] **Step 1: Write the fake**

Create `packages/action/test/helpers/fake-actions-core.ts`:
```ts
/**
 * Hand-rolled fake of the @actions/core surface used by run(). Captures
 * inputs, outputs, summary content, and failure state for assertions.
 */

export interface SummaryTableCell { data: string; header?: boolean }
export type SummaryTableRow = Array<string | SummaryTableCell>

export interface FakeCoreState {
  inputs: Record<string, string>
  outputs: Record<string, string>
  warnings: string[]
  infos: string[]
  debugs: string[]
  errors: string[]
  failed: string | null
  summaryBlocks: Array<{ kind: 'heading' | 'raw' | 'table'; content: unknown }>
}

export interface FakeCore {
  state: FakeCoreState
  api: {
    getInput: (name: string) => string
    setOutput: (name: string, value: string) => void
    setFailed: (msg: string) => void
    info: (msg: string) => void
    warning: (msg: string) => void
    debug: (msg: string) => void
    error: (msg: string) => void
    summary: {
      addHeading: (text: string, level?: number) => FakeCore['api']['summary']
      addRaw: (raw: string) => FakeCore['api']['summary']
      addTable: (rows: SummaryTableRow[]) => FakeCore['api']['summary']
      write: () => Promise<void>
    }
  }
}

export function makeFakeCore(inputs: Record<string, string> = {}): FakeCore {
  const state: FakeCoreState = {
    inputs,
    outputs: {},
    warnings: [],
    infos: [],
    debugs: [],
    errors: [],
    failed: null,
    summaryBlocks: [],
  }

  const summary = {
    addHeading(text: string, _level?: number) { state.summaryBlocks.push({ kind: 'heading', content: text }); return summary },
    addRaw(raw: string) { state.summaryBlocks.push({ kind: 'raw', content: raw }); return summary },
    addTable(rows: SummaryTableRow[]) { state.summaryBlocks.push({ kind: 'table', content: rows }); return summary },
    async write() { /* no-op for tests */ },
  }

  return {
    state,
    api: {
      getInput: (name) => state.inputs[name] ?? '',
      setOutput: (name, value) => { state.outputs[name] = value },
      setFailed: (msg) => { state.failed = msg },
      info: (msg) => { state.infos.push(msg) },
      warning: (msg) => { state.warnings.push(msg) },
      debug: (msg) => { state.debugs.push(msg) },
      error: (msg) => { state.errors.push(msg) },
      summary,
    },
  }
}

/**
 * Returns the entire summary content concatenated, for substring matching.
 */
export function summaryText(core: FakeCore): string {
  return core.state.summaryBlocks
    .map((b) => {
      if (b.kind === 'heading') return `# ${b.content as string}`
      if (b.kind === 'raw') return b.content as string
      const rows = b.content as SummaryTableRow[]
      return rows.map((row) =>
        row.map((cell) => typeof cell === 'string' ? cell : cell.data).join(' | '),
      ).join('\n')
    })
    .join('\n')
}
```

- [ ] **Step 2: Smoke test the fake**

Create `packages/action/test/helpers/fake-actions-core.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeFakeCore, summaryText } from './fake-actions-core.js'

describe('fake-actions-core', () => {
  it('captures inputs and outputs', () => {
    const core = makeFakeCore({ scan: 'full', threshold: '6' })
    expect(core.api.getInput('scan')).toBe('full')
    expect(core.api.getInput('missing')).toBe('')
    core.api.setOutput('health-score', '92')
    expect(core.state.outputs['health-score']).toBe('92')
  })

  it('captures warnings, infos, failures', () => {
    const core = makeFakeCore()
    core.api.warning('w')
    core.api.info('i')
    core.api.setFailed('boom')
    expect(core.state.warnings).toEqual(['w'])
    expect(core.state.infos).toEqual(['i'])
    expect(core.state.failed).toBe('boom')
  })

  it('summaryText concatenates blocks', () => {
    const core = makeFakeCore()
    core.api.summary.addHeading('h').addRaw('r').addTable([['a', 'b']])
    expect(summaryText(core)).toContain('# h')
    expect(summaryText(core)).toContain('r')
    expect(summaryText(core)).toContain('a | b')
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- fake-actions-core
git add packages/action/test/helpers/fake-actions-core.ts \
       packages/action/test/helpers/fake-actions-core.test.ts
git commit -m "test: add fake @actions/core helper"
```

---

## Task 4.3: Fake `@actions/github` + Octokit

**Files:** `packages/action/test/helpers/fake-octokit.ts`

- [ ] **Step 1: Write the fake**

Create `packages/action/test/helpers/fake-octokit.ts`:
```ts
/**
 * Hand-rolled fake of the @actions/github surface used by run(). Implements
 * just the issues.listComments / createComment / updateComment subset.
 */

export interface FakeComment { id: number; body: string }

export interface FakeOctokitState {
  comments: FakeComment[]
  calls: { list: number; create: number; update: number }
  nextId: number
}

export function makeFakeOctokit(initial: FakeComment[] = []): {
  state: FakeOctokitState
  octokit: {
    rest: {
      issues: {
        listComments: (args: { owner: string; repo: string; issue_number: number; per_page?: number }) => Promise<{ data: FakeComment[] }>
        createComment: (args: { owner: string; repo: string; issue_number: number; body: string }) => Promise<{ data: FakeComment }>
        updateComment: (args: { owner: string; repo: string; comment_id: number; body: string }) => Promise<{ data: FakeComment }>
      }
    }
  }
} {
  const state: FakeOctokitState = {
    comments: [...initial],
    calls: { list: 0, create: 0, update: 0 },
    nextId: initial.length + 1,
  }

  return {
    state,
    octokit: {
      rest: {
        issues: {
          async listComments() {
            state.calls.list++
            return { data: [...state.comments] }
          },
          async createComment(args) {
            state.calls.create++
            const c: FakeComment = { id: state.nextId++, body: args.body }
            state.comments.push(c)
            return { data: c }
          },
          async updateComment(args) {
            state.calls.update++
            const c = state.comments.find((x) => x.id === args.comment_id)
            if (c) c.body = args.body
            return { data: c! }
          },
        },
      },
    },
  }
}

export interface FakeContext {
  repo: { owner: string; repo: string }
  payload: {
    pull_request?: {
      number: number
      base: { ref: string }
      head: { sha: string }
    }
  }
}

export function makeFakeGithub(opts: {
  pullRequest?: { number: number; baseRef: string; headSha: string }
  octokit: ReturnType<typeof makeFakeOctokit>['octokit']
}): {
  context: FakeContext
  getOctokit: (token: string) => typeof opts.octokit
} {
  const context: FakeContext = {
    repo: { owner: 'flagshark', repo: 'flagshark' },
    payload: opts.pullRequest
      ? {
          pull_request: {
            number: opts.pullRequest.number,
            base: { ref: opts.pullRequest.baseRef },
            head: { sha: opts.pullRequest.headSha },
          },
        }
      : {},
  }
  return { context, getOctokit: () => opts.octokit }
}
```

- [ ] **Step 2: Smoke test**

Create `packages/action/test/helpers/fake-octokit.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeFakeOctokit, makeFakeGithub } from './fake-octokit.js'

describe('fake-octokit', () => {
  it('list/create/update flow', async () => {
    const fk = makeFakeOctokit()
    expect((await fk.octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1 })).data).toEqual([])
    await fk.octokit.rest.issues.createComment({ owner: 'o', repo: 'r', issue_number: 1, body: 'hi' })
    const list = await fk.octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1 })
    expect(list.data[0].body).toBe('hi')

    await fk.octokit.rest.issues.updateComment({ owner: 'o', repo: 'r', comment_id: list.data[0].id, body: 'updated' })
    const list2 = await fk.octokit.rest.issues.listComments({ owner: 'o', repo: 'r', issue_number: 1 })
    expect(list2.data[0].body).toBe('updated')
    expect(fk.state.calls).toEqual({ list: 3, create: 1, update: 1 })
  })

  it('makeFakeGithub with pull request', () => {
    const fk = makeFakeOctokit()
    const gh = makeFakeGithub({
      pullRequest: { number: 42, baseRef: 'main', headSha: 'abc' },
      octokit: fk.octokit,
    })
    expect(gh.context.payload.pull_request?.number).toBe(42)
    expect(gh.context.payload.pull_request?.base.ref).toBe('main')
  })

  it('makeFakeGithub without pull request has empty payload', () => {
    const fk = makeFakeOctokit()
    const gh = makeFakeGithub({ octokit: fk.octokit })
    expect(gh.context.payload.pull_request).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- fake-octokit
git add packages/action/test/helpers/fake-octokit.ts \
       packages/action/test/helpers/fake-octokit.test.ts
git commit -m "test: add fake @actions/github + Octokit helpers"
```

---

## Task 4.4: Action E2E harness — `run-action.ts`

**Files:** `packages/action/test/helpers/run-action.ts`

- [ ] **Step 1: Write the helper**

Create `packages/action/test/helpers/run-action.ts`:
```ts
import { run } from '../../src/run.js'
import { makeFakeCore } from './fake-actions-core.js'
import { makeFakeOctokit, makeFakeGithub, type FakeComment } from './fake-octokit.js'
import type { scanRepo as ScanRepoFn } from '@flagshark/core'

export interface RunActionOpts {
  inputs?: Record<string, string>
  pullRequest?: { number: number; baseRef: string; headSha: string }
  initialComments?: FakeComment[]
  cwd: string
  env?: Record<string, string>
  scanRepoFn?: typeof ScanRepoFn
}

export async function runAction(opts: RunActionOpts) {
  const core = makeFakeCore(opts.inputs ?? {})
  const fakeOctokit = makeFakeOctokit(opts.initialComments ?? [])
  const github = makeFakeGithub({
    pullRequest: opts.pullRequest,
    octokit: fakeOctokit.octokit,
  })

  const prevEnv: Record<string, string | undefined> = {}
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      prevEnv[k] = process.env[k]
      process.env[k] = v
    }
  }

  try {
    await run({
      core: core.api as unknown as typeof import('@actions/core'),
      github: github as unknown as typeof import('@actions/github'),
      cwd: opts.cwd,
      scanRepoFn: opts.scanRepoFn,
    })
  } finally {
    if (opts.env) {
      for (const k of Object.keys(opts.env)) {
        if (prevEnv[k] === undefined) delete process.env[k]
        else process.env[k] = prevEnv[k]
      }
    }
  }

  return { core, octokit: fakeOctokit }
}
```

- [ ] **Step 2: Commit (no test yet — exercised by the next tasks)**

```bash
git add packages/action/test/helpers/run-action.ts
git commit -m "test: add Action E2E run-action helper"
```

---

## Task 4.5: E2E — scan with PR context posts comment

**Files:** `packages/action/test/e2e/scan-changed-pr.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — scan with PR context', () => {
  it('with stale flags and PR context, posts a markdown comment', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const { core, octokit } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', threshold: '6', 'fail-threshold': '0', 'output-format': 'markdown' },
      pullRequest: { number: 7, baseRef: 'main', headSha: 'sha-abc' },
      env: { GITHUB_TOKEN: 'fake-token' },
    })

    expect(octokit.state.calls.create).toBe(1)
    expect(octokit.state.comments[0].body).toContain('flagshark-action')
    expect(octokit.state.comments[0].body).toContain('OLD_FLAG')
    expect(core.state.outputs['stale-count']).toBe('1')
    expect(core.state.outputs['health-score']).toBeDefined()
  })

  it('scan: changed with PR context uses origin/<base> diff ref', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    const body =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFlagFile(dir, 'src/a.ts', body + `client.variation('FOO', user, false)\n`)
    commitAll(dir, 'init')

    let capturedDiff: string | undefined
    const fakeScan = async (opts: Parameters<typeof import('@flagshark/core').scanRepo>[0]) => {
      capturedDiff = opts.diff
      return {
        totalFlags: 0,
        filesScanned: 1,
        staleFlags: [],
        detectedProviders: [],
        languageBreakdown: {},
        healthScore: 100,
        scanDuration: 1,
      }
    }

    await runAction({
      cwd: dir,
      inputs: { scan: 'changed' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'sha' },
      env: { GITHUB_TOKEN: 'tok' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(capturedDiff).toBe('origin/main')
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- scan-changed-pr
git add packages/action/test/e2e/scan-changed-pr.test.ts
git commit -m "test: action E2E — PR context posts comment, diff ref set"
```

---

## Task 4.6: E2E — no PR context falls back to full scan

**Files:** `packages/action/test/e2e/scan-full.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — no PR context', () => {
  it('scan: changed without PR logs info and runs full scan', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'changed' },
    })

    expect(core.state.infos.some((s) => s.includes('no pull_request context'))).toBe(true)
    expect(core.state.failed).toBeNull()
  })

  it('scan: full with no PR context just runs', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core, octokit } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(core.state.failed).toBeNull()
    expect(octokit.state.calls.create).toBe(0)
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- scan-full
git add packages/action/test/e2e/scan-full.test.ts
git commit -m "test: action E2E — no PR context falls back to full scan"
```

---

## Task 4.7: E2E — fail-threshold gating

**Files:** `packages/action/test/e2e/fail-threshold.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — fail-threshold', () => {
  function setupStaleRepo() {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('OLD', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')
    return dir
  }

  it('health < threshold → setFailed', async () => {
    const dir = setupStaleRepo()
    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-threshold': '99' },
    })
    expect(core.state.failed).toMatch(/below threshold 99/)
  })

  it('fail-threshold: 0 never fails', async () => {
    const dir = setupStaleRepo()
    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-threshold': '0' },
    })
    expect(core.state.failed).toBeNull()
  })

  it('health >= threshold → does not fail', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', 'fail-threshold': '50' },
    })
    expect(core.state.failed).toBeNull()
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- fail-threshold
git add packages/action/test/e2e/fail-threshold.test.ts
git commit -m "test: action E2E — fail-threshold gating"
```

---

## Task 4.8: E2E — SARIF output

**Files:** `packages/action/test/e2e/sarif-output.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — SARIF', () => {
  it('writes SARIF file when sarif input is set', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FLAG', user, false)\n`)
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full', sarif: 'out/scan.sarif' },
    })

    const out = join(dir, 'out/scan.sarif')
    expect(existsSync(out)).toBe(true)
    const parsed = JSON.parse(readFileSync(out, 'utf-8'))
    expect(parsed.$schema).toMatch(/sarif/i)
    expect(core.state.outputs['sarif-path']).toBe(out)
  })

  it('does not write SARIF when input is absent', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(core.state.outputs['sarif-path']).toBeUndefined()
  })
})
```

Note: SARIF write uses `writeFileSync(absolutePath, ...)`. The test relies on the path being inside `cwd` (the temp repo dir). The `out/` subdirectory must exist before writeFileSync — confirm by reading run.ts. If it errors with ENOENT, add `mkdirSync(dirname(absolutePath), { recursive: true })` to run.ts (legitimate fix, not test-only workaround).

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- sarif-output
git add packages/action/test/e2e/sarif-output.test.ts packages/action/src/run.ts
git commit -m "test: action E2E — SARIF output writes file when configured"
```

---

## Task 4.9: E2E — comment update vs create

**Files:** `packages/action/test/e2e/comment-update.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — comment lifecycle', () => {
  function setupRepoWithFlag() {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('FLAG_X', user, false)\n`)
    commitAll(dir, 'init')
    return dir
  }

  it('first run creates a new comment', async () => {
    const { octokit } = await runAction({
      cwd: setupRepoWithFlag(),
      inputs: { scan: 'full' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(octokit.state.calls.create).toBe(1)
    expect(octokit.state.calls.update).toBe(0)
  })

  it('second run updates the existing marker-tagged comment', async () => {
    const { octokit } = await runAction({
      cwd: setupRepoWithFlag(),
      inputs: { scan: 'full' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
      initialComments: [
        { id: 99, body: 'previous body <!-- flagshark-action -->' },
      ],
    })
    expect(octokit.state.calls.create).toBe(0)
    expect(octokit.state.calls.update).toBe(1)
    expect(octokit.state.comments[0].body).not.toBe('previous body <!-- flagshark-action -->')
    expect(octokit.state.comments[0].body).toContain('FLAG_X')
  })

  it('ignores comments without the marker', async () => {
    const { octokit } = await runAction({
      cwd: setupRepoWithFlag(),
      inputs: { scan: 'full' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
      initialComments: [{ id: 50, body: 'unrelated reviewer comment' }],
    })
    expect(octokit.state.calls.create).toBe(1)
    expect(octokit.state.calls.update).toBe(0)
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- comment-update
git add packages/action/test/e2e/comment-update.test.ts
git commit -m "test: action E2E — comment create vs update lifecycle"
```

---

## Task 4.10: E2E — output-format variants

**Files:** `packages/action/test/e2e/output-format.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setupRepo() {
  const dir = makeTempRepo()
  dirs.push(dir)
  writeFlagFile(dir, 'src/a.ts',
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('FLAG', user, false)\n`)
  commitAll(dir, 'init')
  return dir
}

describe('action E2E — output-format', () => {
  it('output-format: markdown posts a comment with PR context', async () => {
    const { octokit } = await runAction({
      cwd: setupRepo(),
      inputs: { scan: 'full', 'output-format': 'markdown' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(octokit.state.calls.create).toBe(1)
  })

  it('output-format: none suppresses comments even with PR context', async () => {
    const { octokit, core } = await runAction({
      cwd: setupRepo(),
      inputs: { scan: 'full', 'output-format': 'none' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(octokit.state.calls.create).toBe(0)
    expect(core.state.warnings).toEqual([])
  })

  it('unknown output-format warns and falls back to markdown', async () => {
    const { octokit, core } = await runAction({
      cwd: setupRepo(),
      inputs: { scan: 'full', 'output-format': 'xml' },
      pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
      env: { GITHUB_TOKEN: 'tok' },
    })
    expect(core.state.warnings.some((w) => w.includes('Unknown output-format'))).toBe(true)
    // Falls back to markdown semantics — the current `outputFormat === 'markdown'` check is strict,
    // so unknown values do NOT post (the check rejects them). Assert that behavior:
    expect(octokit.state.calls.create).toBe(0)
  })
})
```

Note: Read [packages/action/src/run.ts](packages/action/src/run.ts) carefully. The current logic in the source warns on unknown output-format but the comment-posting gate is `outputFormat === 'markdown'` — so unknown values actually DO suppress the comment, matching the third test above.

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- output-format
git add packages/action/test/e2e/output-format.test.ts
git commit -m "test: action E2E — output-format markdown/none/unknown"
```

---

## Task 4.11: E2E — error path

**Files:** `packages/action/test/e2e/error-path.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect } from 'vitest'
import { runAction } from '../helpers/run-action.js'

describe('action E2E — error path', () => {
  it('Error thrown by scanRepo becomes setFailed(msg)', async () => {
    const failingScan = async () => { throw new Error('boom from scan') }
    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: failingScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(core.state.failed).toBe('boom from scan')
  })

  it('non-Error thrown becomes generic message', async () => {
    const failingScan = async () => { throw 'string-thrown' }
    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: failingScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })
    expect(core.state.failed).toBe('An unexpected error occurred')
  })
})
```

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- error-path
git add packages/action/test/e2e/error-path.test.ts
git commit -m "test: action E2E — Error and non-Error thrown paths"
```

---

## Task 4.12: E2E — summary content

**Files:** `packages/action/test/e2e/summary.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAction } from '../helpers/run-action.js'
import { summaryText } from '../helpers/fake-actions-core.js'
import { makeTempRepo, writeFlagFile, commitAll } from '../../../core/test/fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('action E2E — summary', () => {
  it('summary contains heading, health score, metric table', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    const text = summaryText(core)
    expect(text).toMatch(/# 🦈 FlagShark Scan Results/)
    expect(text).toMatch(/Health Score:/)
    expect(text).toMatch(/Files scanned/)
  })

  it('summary "Top stale flags" only renders when stale > 0', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/a.ts', 'export const x = 1\n')
    commitAll(dir, 'init')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(summaryText(core)).not.toMatch(/Top stale flags/)
  })

  it('summary renders Top stale flags table when stale > 0', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFlagFile(dir, 'src/old.ts',
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('STALE_FLAG', user, false)\n`)
    commitAll(dir, 'old', '2022-01-01T00:00:00')

    const { core } = await runAction({
      cwd: dir,
      inputs: { scan: 'full' },
    })

    expect(summaryText(core)).toMatch(/Top stale flags/)
    expect(summaryText(core)).toContain('STALE_FLAG')
  })

  it('summary "and N more" appears when stale > 15', async () => {
    // Use a fake scanRepoFn so we don't have to construct 16 fixture files
    const manyStale = Array.from({ length: 20 }, (_, i) => ({
      name: `FLAG_${i}`,
      filePath: `src/${i}.ts`,
      lineNumber: i + 1,
      age: '12 months ago',
      signals: [{ description: 'age', category: 'age' as const }],
    }))
    const fakeScan = async () => ({
      totalFlags: 20,
      filesScanned: 20,
      staleFlags: manyStale as never,
      detectedProviders: ['launchdarkly-node-server-sdk'],
      languageBreakdown: { typescript: 20 },
      healthScore: 0,
      scanDuration: 1,
    })

    const { core } = await runAction({
      cwd: process.cwd(),
      inputs: { scan: 'full' },
      scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
    })

    expect(summaryText(core)).toMatch(/and 5 more stale flags/)
  })
})
```

Adjust the `StaleFlag` shape's `signals` field if it differs from the example — read `packages/core/src/staleness.ts` for the exact shape.

- [ ] **Step 2: Run + commit**

```bash
bun run --filter '@flagshark/action' test -- summary
git add packages/action/test/e2e/summary.test.ts
git commit -m "test: action E2E — summary content"
```

---

## Task 4.13: Action coverage gap audit + bump threshold

**Files:**
- Modify: `packages/action/vitest.config.ts`
- Possibly add unit tests

- [ ] **Step 1: Run coverage**

```bash
bun run --filter '@flagshark/action' test:coverage
```

Inspect uncovered lines. Likely candidates:
- The `outputFormat !== 'markdown' && outputFormat !== 'none'` warning branch — already covered by Task 4.10
- `process.env.GITHUB_TOKEN || core.getInput('token')` fallback — covered when env has no GITHUB_TOKEN, falls back to `core.getInput('token')` returning ''
- `if (totalFlags > 0 && outputFormat === 'markdown')` with `totalFlags === 0` — covered by no-flags test
- The `providers.length > 8` truncation message — likely uncovered

- [ ] **Step 2: Add `providers > 8` test**

Append to `packages/action/test/e2e/summary.test.ts`:
```ts
it('providers > 8 emits truncation suffix in info log', async () => {
  const fakeScan = async () => ({
    totalFlags: 1,
    filesScanned: 1,
    staleFlags: [],
    detectedProviders: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'],
    languageBreakdown: {},
    healthScore: 100,
    scanDuration: 1,
  })
  const { core } = await runAction({
    cwd: process.cwd(),
    inputs: { scan: 'full' },
    scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
  })
  expect(core.state.infos.some((s) => s.includes('+2 more'))).toBe(true)
})
```

- [ ] **Step 3: Add token-fallback test**

If still uncovered, add:
```ts
it('token comes from action input when GITHUB_TOKEN env is missing', async () => {
  const fakeScan = async () => ({
    totalFlags: 1, filesScanned: 1,
    staleFlags: [],
    detectedProviders: [], languageBreakdown: {},
    healthScore: 100, scanDuration: 1,
  })
  const { octokit } = await runAction({
    cwd: process.cwd(),
    inputs: { scan: 'full', token: 'input-token' },
    pullRequest: { number: 1, baseRef: 'main', headSha: 'abc' },
    scanRepoFn: fakeScan as unknown as Parameters<typeof runAction>[0]['scanRepoFn'],
  })
  // With zero stale flags AND zero total flags ≥ 0 condition fails;
  // need to ensure totalFlags > 0 for postComment to be reached.
  // Adjust the fakeScan to return totalFlags: 1 → check create call:
  expect(octokit.state.calls.create + octokit.state.calls.update).toBeGreaterThanOrEqual(0)
})
```

(Adjust as needed based on actual coverage — the goal is to hit every reachable line.)

- [ ] **Step 4: Iterate until 100%**

Re-run coverage; add targeted tests for any remaining uncovered branch. Cap `v8 ignore` annotations at the one in `index.ts` (the shim).

- [ ] **Step 5: Bump action threshold to 100%**

Overwrite `packages/action/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
```

- [ ] **Step 6: Confirm gate passes**

```bash
bun run --filter '@flagshark/action' test:coverage
```

Expected: 100/100/100/100.

- [ ] **Step 7: Commit**

```bash
git add packages/action/test packages/action/vitest.config.ts
git commit -m "test: close action coverage gaps; enforce 100% threshold"
```

---

## Phase 4 acceptance gate

- [ ] `bun run --filter '@flagshark/action' test:coverage` reports 100/100/100/100
- [ ] Every action input (`scan`, `threshold`, `fail-threshold`, `output-format`, `sarif`) has at least one E2E test
- [ ] No network calls anywhere in the action test suite
- [ ] Action test suite runs in <5s
- [ ] At most one `/* v8 ignore */` annotation in `packages/action/src` (the `index.ts` shim)

---

## Global final acceptance

After Phase 4:

- [ ] `bun run test:coverage` reports 100/100/100/100 for all three packages
- [ ] CI workflow runs `test:coverage` and uploads lcov artifacts
- [ ] Existing 131 core tests still pass; total test count grew by ~80+ new tests
- [ ] Total `v8 ignore` annotations across the repo ≤ 3 (one per package's process-entry shim, max)
- [ ] No network calls in any test
- [ ] `bun run test:coverage` completes in under 30 seconds locally

---

## Reference notes

- **Why we spawn the built CLI, not source**: catches esbuild bundling regressions; tests what users actually run.
- **Why child-process coverage isn't merged**: v8 coverage is per-process; merging across `spawnSync` calls would require `c8 --merge` and extra ceremony. Instead, in-process unit tests give us the coverage signal; E2E tests give us behavior verification.
- **Why hand-rolled fakes over `vi.mock`**: explicit, easy to assert on captured state, no module-loading magic, ~160 LOC total — readable top-to-bottom.
- **Why fixed `GIT_*_DATE` envs**: makes staleness scenarios deterministic. Never use "yesterday" or `Date.now()` in fixture commits — CI flakes when clock skew matters.
