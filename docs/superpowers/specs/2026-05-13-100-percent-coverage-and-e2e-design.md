# 100% Test Coverage + Local-State E2E Testing — Design

**Status:** Design / pending implementation plan
**Date:** 2026-05-13
**Scope:** All three workspace packages — `@flagshark/core`, `flagshark` (CLI), `@flagshark/action`

## 1. Goal

Reach and enforce **100% line + branch + function + statement coverage** across every package, and add **local-state end-to-end testing** that exercises the two real user entry points — the CLI binary and the GitHub Action — without touching the network.

"Local-state" here means: tests build a real git repository in a temp directory with controlled commit history, run the actual built CLI binary or the actual Action entrypoint against it, and assert on observable outputs (stdout, stderr, exit code, files written, GitHub Actions outputs, posted comments). No network, no real GitHub API.

## 2. Today's state

- **`packages/core`** — 18 test files, 131 tests, all passing. Coverage config exists in `vitest.config.ts` but excludes the 9 regex-only language detectors (`src/detection/detectors/*.ts` minus the 4 tree-sitter ones) and `src/detection/index.ts`. `@vitest/coverage-v8` is not installed, so coverage never actually runs.
- **`packages/cli`** — 0 tests. `vitest.config.ts` has `passWithNoTests: true`. Both `src/cli.ts` and `src/formatter.ts` are untested.
- **`packages/action`** — 0 tests. No vitest config. Single bundled-for-Actions file `src/index.ts`.
- **No E2E suite exists.** The closest existing tests are `scan-repo.test.ts` and `scanner-excludes.test.ts`, which build temp git repos and call `scanRepo()` directly — this is library-level E2E, not entry-point E2E.
- **Duplicated infrastructure:** `makeTempRepo()` is inlined in both `scan-repo.test.ts` and `scanner-excludes.test.ts`.

## 3. Approach: phased ratchet

Four PRs, each independently mergeable. Each phase raises its package's coverage threshold to lock in the prior work. CI fails on regression.

| Phase | Lands | Core gate | CLI gate | Action gate |
|---|---|---|---|---|
| 1 — Foundation | Coverage tooling, shared fixture helper, CI workflow | 80% (floor) | disabled | disabled |
| 2 — Core gaps | Regex corpus + remove vitest excludes + audit | **100%** | disabled | disabled |
| 3 — CLI E2E | `parseArgs`/`formatter` unit tests + spawn-binary E2E + `cli.ts` refactor | 100% | **100%** | disabled |
| 4 — Action E2E | DI refactor + fake `@actions/core`/`@actions/github` + E2E suite | 100% | 100% | **100%** |

Pragmatic carve-outs are allowed: `/* v8 ignore next */` annotations on a thin set of unreachable lines (notably the `process.exit`/`run()` bottom-of-module shims). Each annotation must carry a one-line WHY comment. Target: ≤3 annotations repo-wide.

## 4. File & directory layout

```
packages/
  core/
    test/
      fixtures/
        repo-builder.ts          # NEW — extracted makeTempRepo() + helpers
        tree-sitter/             # existing
        regex/                   # NEW — 9-language regex corpus
          {java,kotlin,swift,ruby,csharp,php,rust,cpp,objc}/
            launchdarkly/
              positive/basic.{ext}
              negative/no-import.{ext}
              expected.json
          ruby/
            file-types/positive/{Rakefile,lib.gemspec}   # branch coverage for supportsFile
      regex-corpus.test.ts       # NEW
    vitest.config.ts             # CHANGE — drop excludes, add 100% threshold

  cli/
    src/
      cli.ts                     # CHANGE — extract runCli(argv, io) returning exit code
      main.ts                    # NEW — thin entry: process.exit(await runCli(...))
      formatter.ts               # existing
    test/
      unit/
        parse-args.test.ts       # NEW
        formatter.test.ts        # NEW
      e2e/
        version-help.test.ts     # NEW
        scan-basic.test.ts       # NEW
        scan-config.test.ts      # NEW
        scan-ignore.test.ts      # NEW
        scan-output.test.ts      # NEW
        scan-diff.test.ts        # NEW
        scan-errors.test.ts      # NEW
      helpers/
        run-cli.ts               # NEW — spawnSync wrapper
    vitest.config.ts             # CHANGE — drop passWithNoTests, add coverage + 100% threshold

  action/
    src/
      run.ts                     # NEW — exported run(deps), purely DI'd
      index.ts                   # CHANGE — thin entry calling run()
    test/
      unit/
        input-parsing.test.ts    # NEW
      e2e/
        scan-changed-pr.test.ts  # NEW
        scan-full.test.ts        # NEW
        fail-threshold.test.ts   # NEW
        sarif-output.test.ts     # NEW
        comment-update.test.ts   # NEW
        output-format.test.ts    # NEW
        error-path.test.ts       # NEW
        summary.test.ts          # NEW
      helpers/
        run-action.ts            # NEW — wires fake core + github, calls run()
        fake-actions-core.ts     # NEW — implements the @actions/core surface used
        fake-octokit.ts          # NEW — implements the Octokit subset used
    vitest.config.ts             # NEW

.github/workflows/
  ci.yml                         # CHANGE — add fetch-depth: 0, replace test step with test:coverage
```

## 5. Phase 1 — Foundation

**Changes:**

1. Add `@vitest/coverage-v8` to `devDependencies` in each package (`core`, `cli`, `action`).
2. Add per-package `test:coverage` script + a root `test:coverage` that fans out.
3. Fill in `coverage` config in each `vitest.config.ts` with `provider: 'v8'`, reporters `['text', 'lcov', 'html']`, include `src/**/*.ts`. Threshold floor of 80% on core; thresholds unset (disabled) on cli/action since they have no tests yet.
4. Extract `makeTempRepo()` and a new `commitAll(dir, msg, dateISO?)` helper to `packages/core/test/fixtures/repo-builder.ts`. Update `scan-repo.test.ts` and `scanner-excludes.test.ts` to import. Pure refactor.
5. Update `.github/workflows/ci.yml` — add `fetch-depth: 0` to the checkout step, swap `bun run test` for `bun run test:coverage`, append an `actions/upload-artifact` step for `packages/*/coverage/lcov.info`.

**Acceptance:**

- `bun run test:coverage` succeeds locally and in CI.
- All existing tests still pass.
- CI green at the chosen floor.

**Out:** No threshold bumps beyond floor, no new test files, no vitest exclude removal.

## 6. Phase 2 — Close core coverage gaps

**Regex corpus.** Mirrors the existing `tree-sitter/` corpus shape — `positive/` + `negative/` + `expected.json` per provider per language. Minimum per language: **one provider** (LaunchDarkly, for consistency with the tree-sitter corpus) × (one positive + one negative). Ruby gets two extra positive fixtures (`Rakefile`, `lib.gemspec`) to cover the special-case branches in `supportsFile` at `packages/core/src/detection/detectors/ruby.ts:27-36`.

A new harness file `test/regex-corpus.test.ts` mirrors `test/tree-sitter/corpus.test.ts` — same `expected.json` schema, pointed at `detectFlagsWithRegex` instead of `detectFlagsWithTreeSitter`.

**Vitest config change** in `packages/core/vitest.config.ts`:

```diff
- exclude: ['src/detection/detectors/*.ts', 'src/detection/index.ts'],
```

**Audit + close remaining gaps.** After the corpus and exclude removal, run coverage and add targeted unit tests for any remaining uncovered lines/branches. Likely candidates:
- `staleness.ts` — file with no git history; untracked file
- `config/loader.ts` — malformed YAML, file-not-found error paths
- `scan-repo.ts` — `noConfig: true` branch; `engine: 'regex'` branch; error-path logger calls
- `polyglot-analyzer.ts` — unsupported language

Use `/* v8 ignore next */` only for genuinely unreachable code (e.g. exhaustive-switch defaults that throw). Each annotation gets a one-line WHY comment.

**Bump core threshold to 100%** for lines, branches, functions, statements.

**Acceptance:**

- `bun run --filter '@flagshark/core' test:coverage` reports 100/100/100/100.
- ≤2 `v8 ignore` annotations in core, each with a WHY comment.

**Explicit non-goal:** full provider-breadth corpus (every provider × every regex-only language). That's a follow-up backlog item — not gated.

## 7. Phase 3 — CLI E2E

**Refactor `cli.ts`** to expose a testable `runCli(argv, io)`:

```ts
// packages/cli/src/cli.ts
export async function runCli(argv: string[], io: {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  cwd: string
}): Promise<number> {
  // all current main() logic; returns exit code instead of process.exit
}

// packages/cli/src/main.ts (new entry point; bin/flagshark.mjs points here)
import { runCli } from './cli.js'
runCli(process.argv, { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() })
  .then((code) => process.exit(code))
  .catch((err) => { console.error(err); process.exit(2) })   // v8 ignore: process-entry shim
```

Esbuild bundle entry in `packages/cli/package.json` retargets to `src/main.ts`.

**Coverage strategy.** Spawning the built binary doesn't yield child-process v8 coverage. So:

- **In-process unit tests** drive `parseArgs` and `formatter` directly and provide the coverage signal. These satisfy the 100% gate.
- **E2E tests** spawn `dist/cli.js` via `spawnSync` from `test/helpers/run-cli.ts` and assert on stdout/stderr/exit code/file writes. They are a correctness gate, not a coverage gate.

**Pretest build.** `packages/cli/package.json`:

```json
"scripts": {
  "test": "bun run build && vitest run",
  "test:coverage": "bun run build && vitest run --coverage"
}
```

**Test matrix:**

| File | Covers |
|---|---|
| `unit/parse-args.test.ts` | Every switch case, every error throw, `--flag=value` form, unknown flag |
| `unit/formatter.test.ts` | Every branch of `formatter.ts` |
| `e2e/version-help.test.ts` | `--version`, `--help`, `-h`, `-v`, no args, unknown flag → exit 2 |
| `e2e/scan-basic.test.ts` | Happy path; exit 0 (no stale) and exit 1 (stale found) |
| `e2e/scan-config.test.ts` | Auto-discovery, `--config`, `--no-config`, malformed config → exit 2 |
| `e2e/scan-ignore.test.ts` | `.flagsharkignore` discovery, `--no-ignore-file`, `--show-excluded` |
| `e2e/scan-output.test.ts` | `--format` × 5, `--output <path>`, `--json` alias |
| `e2e/scan-diff.test.ts` | `--diff HEAD~1` with multi-commit fixture, missing arg → exit 2 |
| `e2e/scan-errors.test.ts` | Bad `--threshold`, `--engine`, `--format` values |

E2E tests reuse `repo-builder.ts` from `packages/core/test/fixtures/`.

**Bump cli threshold to 100%.**

**Acceptance:**

- `bun run --filter 'flagshark' test:coverage` reports 100/100/100/100.
- Every CLI flag documented in HELP_TEXT has at least one E2E test asserting on observable behavior.
- At most one `v8 ignore` annotation in cli (`main.ts`), with a WHY comment.

## 8. Phase 4 — Action E2E

**Refactor `index.ts`** to extract a DI'd `run()`:

```ts
// packages/action/src/run.ts (new)
export async function run(deps: {
  core: typeof import('@actions/core')
  github: typeof import('@actions/github')
  cwd: string
  scanRepoFn?: typeof scanRepo   // injectable; defaults to real
}): Promise<void> {
  // all current logic; no top-level side effects, no module-load process.env writes
}

// packages/action/src/index.ts (entry; bundled by esbuild)
import * as core from '@actions/core'
import * as github from '@actions/github'
import { run } from './run.js'
run({ core, github, cwd: process.cwd() })   // v8 ignore: process-entry shim
```

The `process.env.FLAGSHARK_WASM_DIR` / `FLAGSHARK_QUERIES_DIR` writes that currently happen at module load in `index.ts` move into `index.ts` as the side-effect prelude before importing `run`, so `run.ts` is import-safe in tests.

**Fakes.** Hand-rolled, explicit, in `test/helpers/`:

- **`fake-actions-core.ts`** — implements `getInput`, `info`, `warning`, `debug`, `error`, `setOutput`, `setFailed`, and the `summary.addHeading/addRaw/addTable/write` chain that `run()` calls. Exposes `inputs` (input source), `outputs` (captured `setOutput` calls), `summaryBuffer`, `failed`, `warnings`, `infos` for test assertions.
- **`fake-octokit.ts`** — implements `rest.issues.listComments/createComment/updateComment` against an in-memory `CommentStore`. Exposes the store and a `calls` counter for assertions.
- **`run-action.ts`** — composes fakes, builds a fake `github.context` with optional `payload.pull_request`, calls `run()`, returns the captured state.

**Why fakes over `vi.mock`:** explicit assertions on `core.outputs['health-score']` are more direct than spy call inspection; the fake surfaces are small (the action only uses ~10 functions across both modules); the test code reads top-to-bottom without indirection.

**Test matrix:**

| File | Covers |
|---|---|
| `unit/input-parsing.test.ts` | Numeric parsing, default fallbacks, unknown `output-format` → warning + fallback |
| `e2e/scan-changed-pr.test.ts` | PR context + `scan: changed` → diff ref set, comment posted, outputs set |
| `e2e/scan-full.test.ts` | No PR context + `scan: changed` → info log, fallback to full scan |
| `e2e/fail-threshold.test.ts` | Health < threshold → `setFailed`; ≥ threshold → not called; `0` → never called |
| `e2e/sarif-output.test.ts` | SARIF path set → file written, output set; absent → no file |
| `e2e/comment-update.test.ts` | First run creates; second run updates the marker-tagged comment |
| `e2e/output-format.test.ts` | `none` → no comment; `markdown` → comment; bogus → warning + fallback |
| `e2e/error-path.test.ts` | `scanRepoFn` throws Error → `setFailed(err.message)`; non-Error throw → generic message |
| `e2e/summary.test.ts` | Summary table, top-stale section gated on stale > 0, "and N more" line on stale > 15 |

Fixture repos reuse `repo-builder.ts` for staleness scenarios.

**Bump action threshold to 100%.**

**Acceptance:**

- `bun run --filter '@flagshark/action' test:coverage` reports 100/100/100/100.
- Every input documented in the README (`scan`, `threshold`, `fail-threshold`, `output-format`, `sarif`) has at least one E2E test.
- No network calls; suite deterministic and fast (<5s).
- At most one `v8 ignore` annotation in action (`index.ts`), with a WHY comment.

## 9. CI workflow

Modify the existing `.github/workflows/ci.yml`. Current shape:

```yaml
- uses: actions/checkout@v4
- uses: oven-sh/setup-bun@v2
  with: { bun-version: 1.2.5 }
- run: bun install --frozen-lockfile
- run: bun run build
- run: bun run typecheck
- run: bun run test
```

Replace with:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }                  # required for git blame in staleness tests
- uses: oven-sh/setup-bun@v2
  with: { bun-version: 1.2.5 }
- run: bun install --frozen-lockfile
- run: bun run typecheck
- run: bun run build                        # required so CLI E2E can spawn dist/cli.js
- run: bun run test:coverage
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: coverage
    path: packages/*/coverage/lcov.info
```

The `fetch-depth: 0` change lands in Phase 1; the `test:coverage` swap lands in Phase 1 (so the coverage gate is visible in CI from day one); the artifact upload lands in Phase 1.

## 10. Risks & mitigations

- **100% coverage produces false confidence.** Mitigation: each phase PR description must enumerate behaviors tested, not just coverage % delta. Reviewers check both.
- **Flakiness from git-timing.** Mitigation: `repo-builder.ts` uses fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` env vars; never `Date.now()` or "yesterday"-style relative dates.
- **CLI E2E coupling to esbuild.** Mitigation: `pretest` builds the CLI; coverage and behavior tests both see the same artifact.
- **Threshold churn.** Mitigation: each phase's threshold bump is one commit. Rollback is trivial if a gate misfires.

## 11. Out of scope (non-goals)

- Mutation testing (Stryker etc.) — disproportionate effort for codebase size.
- Provider-breadth corpus across all 13 providers × 9 regex languages — backlog, not gated.
- Snapshot tests beyond what already exists in `test/output/*.test.ts`.
- Real-GitHub-API integration tests — fakes are intentional. We test our code, not octokit.
- Performance benchmarks.

## 12. Steady-state — what "done" looks like

- `bun run test` → all three packages green in ~5s.
- `bun run test:coverage` → 100/100/100/100 per package; CI fails on regression.
- `v8 ignore` annotations limited to thin process-entry shims (~3 total repo-wide), each with a WHY comment.
- New code without tests fails CI. Reviewers stop having to ask "did you add tests?".
- Every CLI flag has an E2E test. Every Action input has an E2E test. Every regex detector has fixture coverage.
