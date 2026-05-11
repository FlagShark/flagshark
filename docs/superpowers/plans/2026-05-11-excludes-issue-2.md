# Excludes & Config Loader — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve [FlagShark/flagshark#2](https://github.com/FlagShark/flagshark/issues/2). Add `.flagsharkignore` file + `excludes:` block in `.flagshark.yml` + built-in presets (`test-files`, `snapshots`, `examples`, `stories`, `fixtures`, `generated`). Removes the dominant source of false positives — issue documents 17/17 false positives on a real scan from test/example files.

**Architecture:** Three filter sources unioned into a single `Excluder` (paths-to-skip function) consumed by `scanner.ts` before file I/O:
1. Hardcoded `SKIP_DIRS` (`node_modules`, `.git`, …) — unchanged baseline
2. `.flagsharkignore` parsed with the `ignore` npm package
3. `excludes:` config block (`paths`, `files`, `presets`) merged from `.flagshark.yml`

A new `config/` module under `@flagshark/core` owns config discovery, parsing (yaml + zod), and the excluder builder.

**Tech Stack:**
- `ignore@^5.3.x` (gitignore-syntax matcher, MIT — what `npm`, `eslint`, `prettier` use)
- `yaml@^2.x` (YAML parser, ISC, ~50KB)
- `zod` (already a dep, used for CLI arg parsing today)
- vitest (existing)

**Spec:** [docs/superpowers/specs/2026-05-11-output-and-customizability-design.md](../specs/2026-05-11-output-and-customizability-design.md) §§3, 4, 6.2, 6.3, 6.5, 6.6, 11 (P2)

---

## Reference: file layout after this plan

```
packages/core/
├── package.json                            # +deps: ignore, yaml
├── src/
│   ├── config/                             # NEW
│   │   ├── index.ts                        # public re-exports
│   │   ├── schema.ts                       # zod FlagsharkConfig + sub-types
│   │   ├── defaults.ts                     # buildDefaultConfig()
│   │   ├── loader.ts                       # find/parse .flagshark.yml (walks upward)
│   │   ├── ignore-file.ts                  # find/parse .flagsharkignore
│   │   ├── presets.ts                      # PRESETS data + expandPresets()
│   │   ├── excluder.ts                     # buildExcluder({config, ignoreFilePatterns}) → (path) => bool
│   │   └── merge.ts                        # mergeConfig(defaults, file) + cli-override helper
│   ├── scan-repo.ts                        # +config option, excluded count
│   ├── scanner.ts                          # +excluder filter during walk
│   └── index.ts                            # +export config module
└── test/
    └── config/
        ├── loader.test.ts                  # NEW
        ├── ignore-file.test.ts             # NEW
        ├── presets.test.ts                 # NEW
        ├── excluder.test.ts                # NEW
        └── fixtures/
            ├── basic-config/.flagshark.yml
            ├── basic-ignore/.flagsharkignore
            └── nested-discovery/...

packages/cli/
└── src/cli.ts                              # +--config, --no-config, --no-ignore-file, --show-excluded
                                            # +verbose excluder rule listing
```

---

## Milestone map

| M | Outcome | Commit message |
|---|---|---|
| M0 | Worktree + branch | (no commit) |
| M1 | Dependencies installed | chore: add ignore + yaml for excludes feature |
| M2 | Zod schema + buildDefaultConfig (TDD) | feat(core): add config schema and defaults |
| M3 | `.flagshark.yml` loader (TDD) | feat(core): add .flagshark.yml loader |
| M4 | `.flagsharkignore` loader (TDD) | feat(core): add .flagsharkignore loader |
| M5 | Presets data + expansion (TDD) | feat(core): add exclude presets |
| M6 | `Excluder` builder (TDD): unions all sources, exposes `(path) → bool` + rule listing | feat(core): build unified excluder from all sources |
| M7 | Wire excluder into `scanner.ts` and surface `excludedCount` in result | feat(core): apply excludes during file walk |
| M8 | CLI flags: `--config`, `--no-config`, `--no-ignore-file`, `--show-excluded` + verbose rule listing | feat(cli): add config + excludes flags |
| M9 | Release notes + PR | (PR opened) |

---

## Milestone M0 — Worktree

### Task 0.1: Create worktree

- [ ] **Step 0.1.1: Create worktree off main**

```bash
cd /Users/joe/projects/flagshark
git worktree add ../flagshark-excludes -b feat/excludes-issue-2
cd ../flagshark-excludes
```

- [ ] **Step 0.1.2: Install + baseline**

```bash
bun install && bun run test
```

Expected: all existing tests pass.

---

## Milestone M1 — Dependencies

### Task 1.1: Add deps

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1.1.1: Add ignore + yaml**

```bash
cd packages/core
bun add ignore@^5.3.0 yaml@^2.4.0
```

Expected: `dependencies` gains 2 entries; `bun.lock` updated.

- [ ] **Step 1.1.2: Smoke-import each lib**

```bash
node --input-type=module -e "
import ignore from 'ignore'
import { parse } from 'yaml'
const ig = ignore().add(['*.test.ts', '!important.test.ts'])
console.log('test.test.ts ignored:', ig.ignores('test.test.ts'))
console.log('important.test.ts ignored:', ig.ignores('important.test.ts'))
console.log('yaml parse:', parse('hello: world'))
"
```

Expected:
```
test.test.ts ignored: true
important.test.ts ignored: false
yaml parse: { hello: 'world' }
```

### Task 1.2: Commit

```bash
cd /Users/joe/projects/flagshark-excludes
git add packages/core/package.json bun.lock
git commit -m "chore: add ignore + yaml for excludes feature"
```

---

## Milestone M2 — Config schema + defaults (TDD)

Goal: a zod schema that captures the v1 shape from the spec (`threshold`, `excludes`, `suppress`, `paths`, `providers`, `output`, `healthScore`, `engine`), plus `buildDefaultConfig()` that returns the all-defaults object. We only **use** the `excludes` + `threshold` + (later phases) fields in this plan, but defining the full schema upfront avoids re-validating later.

### Task 2.1: Write the schema and defaults

**Files:**
- Create: `packages/core/src/config/schema.ts`
- Create: `packages/core/src/config/defaults.ts`
- Create: `packages/core/test/config/schema.test.ts`

- [ ] **Step 2.1.1: Write the failing test**

`packages/core/test/config/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { FlagsharkConfigSchema } from '../../src/config/schema.js'
import { buildDefaultConfig } from '../../src/config/defaults.js'

describe('FlagsharkConfigSchema', () => {
  it('accepts an empty object — every key is optional', () => {
    expect(FlagsharkConfigSchema.safeParse({}).success).toBe(true)
  })

  it('accepts the full example from the spec', () => {
    const input = {
      threshold: 6,
      excludes: {
        paths: ['examples/**'],
        files: ['**/*.test.ts'],
        presets: ['test-files'],
      },
      suppress: { flags: ['INTERNAL_DEBUG_*'] },
      paths: [
        { match: 'src/critical/**', threshold: 3 },
      ],
    }
    const result = FlagsharkConfigSchema.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('rejects unknown preset names', () => {
    const result = FlagsharkConfigSchema.safeParse({
      excludes: { presets: ['not-a-real-preset'] },
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-positive thresholds', () => {
    const result = FlagsharkConfigSchema.safeParse({ threshold: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects non-string entries in path arrays', () => {
    const result = FlagsharkConfigSchema.safeParse({
      excludes: { paths: ['ok.ts', 123] as unknown as string[] },
    })
    expect(result.success).toBe(false)
  })
})

describe('buildDefaultConfig', () => {
  it('returns an empty-but-valid config', () => {
    const cfg = buildDefaultConfig()
    expect(cfg.threshold).toBe(6)
    expect(cfg.excludes.paths).toEqual([])
    expect(cfg.excludes.files).toEqual([])
    expect(cfg.excludes.presets).toEqual([])
    expect(cfg.suppress.flags).toEqual([])
    expect(cfg.paths).toEqual([])
  })

  it('parses successfully with the same schema', () => {
    const cfg = buildDefaultConfig()
    expect(FlagsharkConfigSchema.safeParse(cfg).success).toBe(true)
  })
})
```

- [ ] **Step 2.1.2: Run test, verify fail**

```bash
cd packages/core && bun run test config/schema
```

Expected: FAIL — modules don't exist.

- [ ] **Step 2.1.3: Implement the schema**

`packages/core/src/config/schema.ts`:

```ts
import { z } from 'zod'

const PRESET_NAMES = [
  'test-files',
  'snapshots',
  'examples',
  'stories',
  'fixtures',
  'generated',
] as const

export const PresetNameSchema = z.enum(PRESET_NAMES)
export type PresetName = z.infer<typeof PresetNameSchema>

export const ExcludesSchema = z.object({
  paths: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  presets: z.array(PresetNameSchema).default([]),
}).default({})

export const SuppressSchema = z.object({
  flags: z.array(z.string()).default([]),
}).default({})

export const PathRuleSchema = z.object({
  match: z.string(),
  threshold: z.number().int().positive().optional(),
})

export const MethodConfigSchema = z.object({
  name: z.string(),
  flagKeyIndex: z.number().int(),
})

export const CustomProviderSchema = z.object({
  language: z.enum([
    'typescript', 'javascript', 'go', 'python', 'java',
    'kotlin', 'swift', 'ruby', 'csharp', 'php', 'rust',
    'cpp', 'objc',
  ]),
  name: z.string(),
  importPattern: z.string().optional(),
  enabled: z.boolean().default(true),
  methods: z.array(MethodConfigSchema),
})

export const OutputConfigSchema = z.object({
  format: z.enum(['text', 'json', 'sarif', 'markdown', 'csv']).default('text'),
  groupBy: z.enum(['file', 'provider', 'signal', 'none']).default('file'),
  sortBy: z.enum(['age', 'name', 'count']).default('age'),
  color: z.enum(['auto', 'always', 'never']).default('auto'),
  maxDisplay: z.number().int().positive().default(10),
}).default({})

export const HealthScoreSchema = z.object({
  weights: z.object({
    age: z.number().nonnegative().default(1.0),
    lowUsage: z.number().nonnegative().default(0.5),
    hardcoded: z.number().nonnegative().default(2.0),
  }).default({}),
}).default({})

export const EngineSchema = z.record(
  z.string(),
  z.enum(['regex', 'tree-sitter']),
).default({})

export const FlagsharkConfigSchema = z.object({
  threshold: z.number().int().positive().default(6),
  excludes: ExcludesSchema,
  suppress: SuppressSchema,
  paths: z.array(PathRuleSchema).default([]),
  providers: z.array(CustomProviderSchema).default([]),
  output: OutputConfigSchema,
  healthScore: HealthScoreSchema,
  engine: EngineSchema,
}).strict()

export type FlagsharkConfig = z.infer<typeof FlagsharkConfigSchema>
export type ExcludesConfig = z.infer<typeof ExcludesSchema>
export type SuppressConfig = z.infer<typeof SuppressSchema>
export type PathRuleConfig = z.infer<typeof PathRuleSchema>
export type OutputConfig = z.infer<typeof OutputConfigSchema>
```

- [ ] **Step 2.1.4: Implement defaults**

`packages/core/src/config/defaults.ts`:

```ts
import { FlagsharkConfigSchema, type FlagsharkConfig } from './schema.js'

export function buildDefaultConfig(): FlagsharkConfig {
  // Parse an empty object — schema fills in all defaults.
  return FlagsharkConfigSchema.parse({})
}
```

- [ ] **Step 2.1.5: Run test, verify pass**

```bash
bun run test config/schema
```

Expected: 7 tests pass.

### Task 2.2: Commit

```bash
git add packages/core/src/config/ packages/core/test/config/
git commit -m "feat(core): add config schema and defaults"
```

---

## Milestone M3 — `.flagshark.yml` loader (TDD)

Goal: walk `cwd` upward looking for `.flagshark.yml` or `.flagshark.yaml`; parse with `yaml`; validate with zod; return `{ config, path } | null`.

### Task 3.1: Write the failing test

**Files:**
- Create: `packages/core/src/config/loader.ts`
- Create: `packages/core/test/config/loader.test.ts`

- [ ] **Step 3.1.1: Write the test**

`packages/core/test/config/loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfigFile } from '../../src/config/loader.js'

describe('loadConfigFile', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'flagshark-loader-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('returns null when no config exists', async () => {
    expect(await loadConfigFile(workDir)).toBeNull()
  })

  it('reads .flagshark.yml from cwd', async () => {
    writeFileSync(join(workDir, '.flagshark.yml'), 'threshold: 3\n')
    const result = await loadConfigFile(workDir)
    expect(result?.config.threshold).toBe(3)
    expect(result?.path).toBe(join(workDir, '.flagshark.yml'))
  })

  it('reads .flagshark.yaml extension', async () => {
    writeFileSync(join(workDir, '.flagshark.yaml'), 'threshold: 4\n')
    const result = await loadConfigFile(workDir)
    expect(result?.config.threshold).toBe(4)
  })

  it('walks upward from cwd subdirectory', async () => {
    writeFileSync(join(workDir, '.flagshark.yml'), 'threshold: 7\n')
    const sub = join(workDir, 'a', 'b', 'c')
    mkdirSync(sub, { recursive: true })
    const result = await loadConfigFile(sub)
    expect(result?.config.threshold).toBe(7)
  })

  it('stops at the first matched parent', async () => {
    writeFileSync(join(workDir, '.flagshark.yml'), 'threshold: 6\n')
    const child = join(workDir, 'child')
    mkdirSync(child)
    writeFileSync(join(child, '.flagshark.yml'), 'threshold: 9\n')
    const sub = join(child, 'sub')
    mkdirSync(sub)
    const result = await loadConfigFile(sub)
    expect(result?.config.threshold).toBe(9)
  })

  it('throws a clean error on invalid YAML', async () => {
    writeFileSync(join(workDir, '.flagshark.yml'), 'threshold: : :\n')
    await expect(loadConfigFile(workDir)).rejects.toThrow(/Invalid YAML/)
  })

  it('throws a clean error on schema violation', async () => {
    writeFileSync(join(workDir, '.flagshark.yml'), 'threshold: -1\n')
    await expect(loadConfigFile(workDir)).rejects.toThrow(/threshold/)
  })

  it('rejects unknown top-level keys (strict schema)', async () => {
    writeFileSync(join(workDir, '.flagshark.yml'), 'unknown_key: hello\n')
    await expect(loadConfigFile(workDir)).rejects.toThrow(/unknown/i)
  })
})
```

- [ ] **Step 3.1.2: Run, verify fail**

```bash
bun run test config/loader
```

Expected: FAIL — `loader.ts` doesn't exist.

- [ ] **Step 3.1.3: Implement the loader**

`packages/core/src/config/loader.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse as parseYaml, YAMLParseError } from 'yaml'

import { FlagsharkConfigSchema, type FlagsharkConfig } from './schema.js'

const FILENAMES = ['.flagshark.yml', '.flagshark.yaml']

export interface LoadedConfig {
  config: FlagsharkConfig
  path: string
}

export async function loadConfigFile(startDir: string): Promise<LoadedConfig | null> {
  const home = homedir()
  let dir = resolve(startDir)

  for (;;) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        return readAndValidate(candidate)
      }
    }
    const parent = dirname(dir)
    if (parent === dir || dir === home || dir === '/') return null
    dir = parent
  }
}

function readAndValidate(path: string): LoadedConfig {
  const raw = readFileSync(path, 'utf-8')

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new Error(`Invalid YAML in ${path}: ${err.message}`)
    }
    throw err
  }

  if (parsed == null || typeof parsed !== 'object') {
    return { config: FlagsharkConfigSchema.parse({}), path }
  }

  const result = FlagsharkConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid .flagshark.yml at ${path}: ${issues}`)
  }
  return { config: result.data, path }
}
```

- [ ] **Step 3.1.4: Run, verify pass**

```bash
bun run test config/loader
```

Expected: 8 tests pass.

### Task 3.2: Commit

```bash
git add packages/core/src/config/loader.ts packages/core/test/config/loader.test.ts
git commit -m "feat(core): add .flagshark.yml loader"
```

---

## Milestone M4 — `.flagsharkignore` loader (TDD)

Goal: discover `.flagsharkignore` alongside `.flagshark.yml`, parse the file as a list of gitignore patterns (strip comments + blank lines), return `string[]`.

### Task 4.1: Test + implement

**Files:**
- Create: `packages/core/src/config/ignore-file.ts`
- Create: `packages/core/test/config/ignore-file.test.ts`

- [ ] **Step 4.1.1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadIgnoreFile } from '../../src/config/ignore-file.js'

describe('loadIgnoreFile', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'flagshark-ignore-'))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('returns null when .flagsharkignore is absent', async () => {
    expect(await loadIgnoreFile(workDir)).toBeNull()
  })

  it('reads and parses a flat ignore file', async () => {
    writeFileSync(join(workDir, '.flagsharkignore'),
      'examples/\n' +
      '# comment\n' +
      '\n' +
      '**/*.test.ts\n' +
      '!examples/important.ts\n')
    const result = await loadIgnoreFile(workDir)
    expect(result?.patterns).toEqual([
      'examples/',
      '**/*.test.ts',
      '!examples/important.ts',
    ])
    expect(result?.path).toBe(join(workDir, '.flagsharkignore'))
  })

  it('walks upward like the yaml loader', async () => {
    writeFileSync(join(workDir, '.flagsharkignore'), 'foo/\n')
    const sub = join(workDir, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    const result = await loadIgnoreFile(sub)
    expect(result?.patterns).toEqual(['foo/'])
  })
})
```

- [ ] **Step 4.1.2: Run, fail**

```bash
bun run test config/ignore-file
```

- [ ] **Step 4.1.3: Implement**

`packages/core/src/config/ignore-file.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface LoadedIgnore {
  patterns: string[]
  path: string
}

export async function loadIgnoreFile(startDir: string): Promise<LoadedIgnore | null> {
  const home = homedir()
  let dir = resolve(startDir)

  for (;;) {
    const candidate = join(dir, '.flagsharkignore')
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf-8')
      const patterns = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
      return { patterns, path: candidate }
    }
    const parent = dirname(dir)
    if (parent === dir || dir === home || dir === '/') return null
    dir = parent
  }
}
```

- [ ] **Step 4.1.4: Run, pass**

```bash
bun run test config/ignore-file
```

Expected: 3 tests pass.

### Task 4.2: Commit

```bash
git add packages/core/src/config/ignore-file.ts packages/core/test/config/ignore-file.test.ts
git commit -m "feat(core): add .flagsharkignore loader"
```

---

## Milestone M5 — Presets (TDD)

Goal: a frozen `PRESETS` data structure mapping preset name → array of glob patterns. `expandPresets(names)` returns the union.

### Task 5.1: Implement

**Files:**
- Create: `packages/core/src/config/presets.ts`
- Create: `packages/core/test/config/presets.test.ts`

- [ ] **Step 5.1.1: Failing test**

```ts
import { describe, it, expect } from 'vitest'

import { PRESETS, expandPresets } from '../../src/config/presets.js'

describe('PRESETS', () => {
  it('has the six documented preset names', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(
      ['examples', 'fixtures', 'generated', 'snapshots', 'stories', 'test-files'],
    )
  })

  it('test-files includes common JS/TS patterns', () => {
    const patterns = PRESETS['test-files']
    expect(patterns).toContain('**/*.test.ts')
    expect(patterns).toContain('**/*.spec.tsx')
    expect(patterns).toContain('**/__tests__/**')
  })

  it('test-files includes patterns from non-JS languages', () => {
    const patterns = PRESETS['test-files']
    expect(patterns).toContain('**/*_test.go')
    expect(patterns).toContain('**/test_*.py')
    expect(patterns).toContain('**/*Test.java')
    expect(patterns).toContain('**/*_spec.rb')
  })

  it('snapshots covers jest and ava conventions', () => {
    expect(PRESETS['snapshots']).toContain('**/*.snap')
    expect(PRESETS['snapshots']).toContain('**/__snapshots__/**')
  })
})

describe('expandPresets', () => {
  it('returns empty array for empty input', () => {
    expect(expandPresets([])).toEqual([])
  })

  it('returns the union of named presets in order', () => {
    const result = expandPresets(['snapshots', 'examples'])
    expect(result).toContain('**/*.snap')
    expect(result).toContain('examples/**')
  })

  it('deduplicates patterns across overlapping presets', () => {
    // If two presets shared a pattern, it should appear once.
    // (Today none of our presets overlap, but the contract holds.)
    const result = expandPresets(['test-files', 'test-files'])
    const set = new Set(result)
    expect(set.size).toBe(result.length)
  })
})
```

- [ ] **Step 5.1.2: Run, fail**

```bash
bun run test config/presets
```

- [ ] **Step 5.1.3: Implement**

`packages/core/src/config/presets.ts`:

```ts
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
```

- [ ] **Step 5.1.4: Run, pass**

```bash
bun run test config/presets
```

Expected: 7 tests pass.

### Task 5.2: Commit

```bash
git add packages/core/src/config/presets.ts packages/core/test/config/presets.test.ts
git commit -m "feat(core): add exclude presets"
```

---

## Milestone M6 — Excluder (TDD)

Goal: a builder that takes a config + ignore-file patterns and returns:

- `shouldExclude(path: string): boolean`
- `effectiveRules: string[]` (for `--verbose` listing)

Uses the `ignore` npm package for pattern matching (gitignore semantics, `!` negation).

### Task 6.1: Test + implement

**Files:**
- Create: `packages/core/src/config/excluder.ts`
- Create: `packages/core/test/config/excluder.test.ts`

- [ ] **Step 6.1.1: Failing test**

```ts
import { describe, it, expect } from 'vitest'

import { buildExcluder } from '../../src/config/excluder.js'
import { buildDefaultConfig } from '../../src/config/defaults.js'

describe('buildExcluder', () => {
  it('excludes nothing for an empty config', () => {
    const ex = buildExcluder({ config: buildDefaultConfig(), ignoreFilePatterns: [] })
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
    expect(ex.shouldExclude('examples/demo.ts')).toBe(false)
  })

  it('applies excludes.paths', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    expect(ex.shouldExclude('examples/demo.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('applies excludes.files', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.files = ['**/*.test.ts']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    expect(ex.shouldExclude('src/app.test.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('applies excludes.presets', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.presets = ['test-files']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    expect(ex.shouldExclude('src/app.test.ts')).toBe(true)
    expect(ex.shouldExclude('foo_test.go')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('applies .flagsharkignore patterns', () => {
    const ex = buildExcluder({
      config: buildDefaultConfig(),
      ignoreFilePatterns: ['examples/', '**/*.test.ts'],
    })
    expect(ex.shouldExclude('examples/demo.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.test.ts')).toBe(true)
  })

  it('honors !-negation from .flagsharkignore', () => {
    const ex = buildExcluder({
      config: buildDefaultConfig(),
      ignoreFilePatterns: ['examples/', '!examples/important.ts'],
    })
    expect(ex.shouldExclude('examples/demo.ts')).toBe(true)
    expect(ex.shouldExclude('examples/important.ts')).toBe(false)
  })

  it('unions config and .flagsharkignore (either excludes → excluded)', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['src/legacy/**']
    const ex = buildExcluder({
      config: cfg,
      ignoreFilePatterns: ['examples/'],
    })
    expect(ex.shouldExclude('src/legacy/x.ts')).toBe(true)
    expect(ex.shouldExclude('examples/x.ts')).toBe(true)
    expect(ex.shouldExclude('src/app.ts')).toBe(false)
  })

  it('exposes effectiveRules for verbose output', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    cfg.excludes.presets = ['snapshots']
    const ex = buildExcluder({
      config: cfg,
      ignoreFilePatterns: ['legacy/'],
    })
    expect(ex.effectiveRules).toEqual({
      paths: ['examples/**'],
      files: [],
      presets: ['snapshots'],
      presetPatterns: ['**/*.snap', '**/__snapshots__/**'],
      ignoreFile: ['legacy/'],
    })
  })

  it('treats absolute and repo-relative paths consistently', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    const ex = buildExcluder({ config: cfg, ignoreFilePatterns: [] })
    // The excluder normalises input — relative paths only.
    expect(ex.shouldExclude('examples/x.ts')).toBe(true)
    expect(ex.shouldExclude('./examples/x.ts')).toBe(true)
  })
})
```

- [ ] **Step 6.1.2: Run, fail**

```bash
bun run test config/excluder
```

- [ ] **Step 6.1.3: Implement**

`packages/core/src/config/excluder.ts`:

```ts
import ignoreModule from 'ignore'

import { expandPresets } from './presets.js'

import type { FlagsharkConfig } from './schema.js'

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

export function buildExcluder(input: BuildExcluderInput): Excluder {
  const { config, ignoreFilePatterns } = input

  const presetPatterns = expandPresets(config.excludes.presets)

  const allPatterns: string[] = [
    ...config.excludes.paths,
    ...config.excludes.files,
    ...presetPatterns,
    ...ignoreFilePatterns,
  ]

  const matcher = ignore().add(allPatterns)

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
```

- [ ] **Step 6.1.4: Run, pass**

```bash
bun run test config/excluder
```

Expected: 9 tests pass.

### Task 6.2: Public exports

**Files:**
- Create: `packages/core/src/config/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 6.2.1: Write `packages/core/src/config/index.ts`**

```ts
export { buildDefaultConfig } from './defaults.js'
export { loadConfigFile, type LoadedConfig } from './loader.js'
export { loadIgnoreFile, type LoadedIgnore } from './ignore-file.js'
export { buildExcluder, type Excluder, type EffectiveRules, type BuildExcluderInput } from './excluder.js'
export { expandPresets, PRESETS } from './presets.js'
export {
  FlagsharkConfigSchema,
  type FlagsharkConfig,
  type ExcludesConfig,
  type SuppressConfig,
  type PathRuleConfig,
  type OutputConfig,
  type PresetName,
} from './schema.js'
```

- [ ] **Step 6.2.2: Re-export from package root**

Append to `packages/core/src/index.ts`:

```ts
// Config module
export * from './config/index.js'
```

- [ ] **Step 6.2.3: Typecheck**

```bash
bun run --filter '@flagshark/core' typecheck
```

Expected: no errors.

### Task 6.3: Commit

```bash
git add packages/core/src/config/ packages/core/test/config/ packages/core/src/index.ts
git commit -m "feat(core): build unified excluder from all sources"
```

---

## Milestone M7 — Wire excluder into scanner + scanRepo

Goal: `scanRepo` accepts an optional `config`. The scanner uses the excluder to skip files. `excludedCount` surfaces in the result.

### Task 7.1: Wire scanner

**Files:**
- Modify: `packages/core/src/scanner.ts`
- Create: `packages/core/test/scanner-excludes.test.ts`

- [ ] **Step 7.1.1: Read the current scanner**

```bash
cat packages/core/src/scanner.ts
```

Note the current `collectFiles` signature: `(opts: { root, supportedExtensions, diffRef? }) => Map<string, string>`.

- [ ] **Step 7.1.2: Write a failing test for excludes integration**

`packages/core/test/scanner-excludes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { collectFiles } from '../src/scanner.js'
import { buildExcluder } from '../src/config/excluder.js'
import { buildDefaultConfig } from '../src/config/defaults.js'

describe('collectFiles with excluder', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'flagshark-scanner-ex-'))
    execFileSync('git', ['init', '-q'], { cwd: workDir })
    mkdirSync(join(workDir, 'src'))
    mkdirSync(join(workDir, 'examples'))
    writeFileSync(join(workDir, 'src', 'app.ts'), 'export const x = 1\n')
    writeFileSync(join(workDir, 'src', 'app.test.ts'), 'export const t = 1\n')
    writeFileSync(join(workDir, 'examples', 'demo.ts'), 'export const d = 1\n')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('excludes files matching excluder when one is supplied', () => {
    const cfg = buildDefaultConfig()
    cfg.excludes.paths = ['examples/**']
    cfg.excludes.presets = ['test-files']
    const excluder = buildExcluder({ config: cfg, ignoreFilePatterns: [] })

    const { files, excludedCount } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
      excluder,
    })

    const paths = [...files.keys()].sort()
    expect(paths).toEqual([join(workDir, 'src', 'app.ts')])
    expect(excludedCount).toBe(2)  // app.test.ts + demo.ts
  })

  it('returns excludedCount: 0 when no excluder is provided', () => {
    const { files, excludedCount } = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
    })

    expect(files.size).toBe(3)
    expect(excludedCount).toBe(0)
  })
})
```

- [ ] **Step 7.1.3: Run, fail**

```bash
bun run test scanner-excludes
```

Expected: FAIL. `collectFiles` doesn't accept `excluder` or return `excludedCount`.

- [ ] **Step 7.1.4: Update `collectFiles` signature**

In `packages/core/src/scanner.ts`, change the function signature and return shape:

```ts
import { relative } from 'node:path'

import type { Excluder } from './config/excluder.js'

export interface ScanOptions {
  root: string
  supportedExtensions: Set<string>
  diffRef?: string
  excluder?: Excluder
}

export interface CollectFilesResult {
  files: Map<string, string>
  excludedCount: number
}

export function collectFiles(opts: ScanOptions): CollectFilesResult {
  // ... existing walk code ...

  // For each candidate file, before reading content:
  // const relativePath = relative(opts.root, fullPath)
  // if (opts.excluder?.shouldExclude(relativePath)) {
  //   excludedCount++
  //   continue
  // }
}
```

Locate the exact walk loop in the current `scanner.ts` and insert the excluder check right after extension matching but before file read. Increment a local `excludedCount` counter; return `{ files, excludedCount }` instead of the bare map.

**Update every caller** of `collectFiles` to destructure the new return shape:

```bash
grep -rn 'collectFiles(' packages/core/src packages/core/test packages/cli/src packages/action/src
```

For each caller, replace `const files = collectFiles(...)` with `const { files, excludedCount } = collectFiles(...)`. Most callers pass the result straight into the analyzer — just extract `files` from the new tuple.

- [ ] **Step 7.1.5: Run all tests**

```bash
bun run test
```

Expected: scanner-excludes test now passes; no other tests broken.

### Task 7.2: Wire `scanRepo`

**Files:**
- Modify: `packages/core/src/scan-repo.ts`
- Modify: `packages/core/test/scan-repo.test.ts`

- [ ] **Step 7.2.1: Add `config` option + propagate excluder**

In `packages/core/src/scan-repo.ts`:

```ts
import { buildDefaultConfig } from './config/defaults.js'
import { buildExcluder } from './config/excluder.js'
import { loadConfigFile } from './config/loader.js'
import { loadIgnoreFile } from './config/ignore-file.js'

import type { FlagsharkConfig } from './config/schema.js'

export interface ScanRepoOptions {
  cwd: string
  threshold?: number
  diff?: string
  signal?: AbortSignal
  logger?: ScanLogger
  /** Explicit config to use. If undefined, scanRepo discovers .flagshark.yml + .flagsharkignore from cwd upward. */
  config?: FlagsharkConfig
  /** Set true to skip auto-discovery (used by `--no-config`). */
  noConfig?: boolean
  /** Set true to skip .flagsharkignore (used by `--no-ignore-file`). */
  noIgnoreFile?: boolean
}

export interface ScanRepoResult {
  totalFlags: number
  staleFlags: StaleFlag[]
  detectedProviders: string[]
  languageBreakdown: Record<string, number>
  healthScore: number
  scanDuration: number
  excludedCount?: number
}
```

In the body of `scanRepo`:

```ts
const config =
  opts.config ??
  (opts.noConfig ? buildDefaultConfig() : (await loadConfigFile(opts.cwd))?.config ?? buildDefaultConfig())

const ignoreFile =
  opts.noIgnoreFile ? null : await loadIgnoreFile(opts.cwd)

const excluder = buildExcluder({
  config,
  ignoreFilePatterns: ignoreFile?.patterns ?? [],
})

logger.debug('Effective excludes', excluder.effectiveRules)

const { files, excludedCount } = collectFiles({
  root: opts.cwd,
  supportedExtensions,
  diffRef: opts.diff,
  excluder,
})

// ... rest of scan ...

return {
  totalFlags,
  staleFlags,
  detectedProviders,
  languageBreakdown: analysisResult.languages,
  healthScore,
  scanDuration: Math.round(performance.now() - start),
  excludedCount,
}
```

The threshold resolution should also use `config.threshold` if `opts.threshold` is undefined:

```ts
const threshold = opts.threshold ?? config.threshold
```

- [ ] **Step 7.2.2: Write a TDD test for the integration**

Append to `packages/core/test/scan-repo.test.ts`:

```ts
it('skips files matched by .flagsharkignore', async () => {
  const dir = makeTempRepo()
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'examples'))
  writeFileSync(join(dir, 'src', 'app.ts'),
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('REAL_FLAG', user, false)\n`)
  writeFileSync(join(dir, 'examples', 'demo.ts'),
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('DEMO_FLAG', user, false)\n`)
  writeFileSync(join(dir, '.flagsharkignore'), 'examples/\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

  const result = await scanRepo({ cwd: dir })

  expect(result.totalFlags).toBe(1)
  expect(result.excludedCount).toBe(1)
})

it('honors --no-ignore-file (noIgnoreFile: true) to bypass .flagsharkignore', async () => {
  const dir = makeTempRepo()
  // same setup as previous test ...
  // Result with noIgnoreFile should pick up DEMO_FLAG too.
})

it('applies excludes from .flagshark.yml', async () => {
  const dir = makeTempRepo()
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'app.ts'),
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('REAL_FLAG', user, false)\n`)
  writeFileSync(join(dir, 'src', 'app.test.ts'),
    `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
    `const client = LaunchDarkly.init('sdk-key')\n` +
    `client.variation('TEST_FLAG', user, false)\n`)
  writeFileSync(join(dir, '.flagshark.yml'),
    'excludes:\n  presets:\n    - test-files\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

  const result = await scanRepo({ cwd: dir })

  expect(result.totalFlags).toBe(1)
  expect(result.excludedCount).toBe(1)
})
```

- [ ] **Step 7.2.3: Run**

```bash
bun run test scan-repo
```

Expected: existing tests still pass; new excludes tests pass.

### Task 7.3: Commit

```bash
git add packages/core/src/scan-repo.ts packages/core/src/scanner.ts \
        packages/core/test/scan-repo.test.ts packages/core/test/scanner-excludes.test.ts
git commit -m "feat(core): apply excludes during file walk"
```

---

## Milestone M8 — CLI flags + verbose rule listing

Goal: end-users can use `--config`, `--no-config`, `--no-ignore-file`, `--show-excluded`. Verbose mode prints the effective excluder rules at scan start.

### Task 8.1: Parse the new flags

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 8.1.1: Add the args**

In `parseArgs`, add:

```ts
} else if (a === '--config') {
  args.configPath = process.argv[++i]
} else if (a === '--no-config') {
  args.noConfig = true
} else if (a === '--no-ignore-file') {
  args.noIgnoreFile = true
} else if (a === '--show-excluded') {
  args.showExcluded = true
```

In the `args` interface:

```ts
configPath?: string
noConfig?: boolean
noIgnoreFile?: boolean
showExcluded?: boolean
```

- [ ] **Step 8.1.2: Update HELP_TEXT**

Locate `HELP_TEXT` and add a new section:

```
Configuration:
  --config <path>          Use this config file (overrides .flagshark.yml discovery)
  --no-config              Skip config file discovery
  --no-ignore-file         Skip .flagsharkignore discovery
  --show-excluded          Show excluded files in text output
```

### Task 8.2: Thread config into scanRepo

**Files:**
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 8.2.1: Load explicit config or use discovery**

Replace the `scanRepo` call in `main()`:

```ts
let configOverride: FlagsharkConfig | undefined
if (args.configPath) {
  // Explicit path — read and validate without walking
  const raw = readFileSync(args.configPath, 'utf-8')
  const parsed = parseYaml(raw)
  const result = FlagsharkConfigSchema.safeParse(parsed)
  if (!result.success) {
    process.stderr.write(`Error: invalid config at ${args.configPath}: ${result.error.message}\n`)
    process.exit(2)
  }
  configOverride = result.data
}

const result = await scanRepo({
  cwd: process.cwd(),
  threshold: args.threshold,
  diff: args.diff ?? undefined,
  engine: args.engine,
  config: configOverride,
  noConfig: args.noConfig,
  noIgnoreFile: args.noIgnoreFile,
  logger,
})
```

Add the imports:

```ts
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { FlagsharkConfigSchema, type FlagsharkConfig } from '@flagshark/core'
```

### Task 8.3: Verbose rule listing

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/core/src/scan-repo.ts`

- [ ] **Step 8.3.1: Expose effective rules from scanRepo**

In `ScanRepoResult` (`scan-repo.ts`), add:

```ts
/** Diagnostic — populated only when logger.debug level is active or callers explicitly opt in. */
effectiveExcludes?: EffectiveRules
```

Import `EffectiveRules` from `./config/excluder.js`.

In the body, after building the excluder:

```ts
if (opts.logger?.debug) {
  // Always set when scanRepo has a logger that uses debug; cheap.
  // CLI sets logger.debug to no-op unless --verbose.
}
```

Simpler: always include it in the result (it's tiny — at most ~50 strings):

```ts
return {
  // ... existing fields ...
  excludedCount,
  effectiveExcludes: excluder.effectiveRules,
}
```

- [ ] **Step 8.3.2: Print effective rules at the start of verbose scans**

In `packages/cli/src/cli.ts`, after parsing args and before the scanRepo call:

```ts
if (args.verbose) {
  // We don't have the rules yet — they're computed inside scanRepo.
  // Instead, log them after scanRepo returns using result.effectiveExcludes.
}
```

After the `scanRepo` call:

```ts
if (args.verbose && result.effectiveExcludes) {
  const r = result.effectiveExcludes
  const allRules = [
    ...r.paths.map((p) => `excludes.paths: ${p}`),
    ...r.files.map((p) => `excludes.files: ${p}`),
    ...r.presets.flatMap((name, i) => [`excludes.presets[${i}]: ${name}`]),
    ...r.ignoreFile.map((p) => `.flagsharkignore: ${p}`),
  ]
  if (allRules.length > 0) {
    process.stderr.write('Effective excludes:\n')
    for (const rule of allRules) process.stderr.write(`  ${rule}\n`)
  }
}
```

- [ ] **Step 8.3.3: Surface `excludedCount` in text output**

Locate where the text formatter renders the summary header (in `packages/cli/src/formatter.ts`). Add a line below the "Scanned X files" line:

```ts
if (result.excludedCount && result.excludedCount > 0) {
  output += `(${result.excludedCount} excluded via .flagsharkignore + excludes)\n`
}
```

Adjust styling to match the existing formatter (probably indented).

### Task 8.4: Smoke-test

- [ ] **Step 8.4.1: Build the CLI**

```bash
cd packages/cli && bun run build
```

- [ ] **Step 8.4.2: Smoke against a fixture repo**

```bash
mkdir -p /tmp/flagshark-excludes-smoke/src /tmp/flagshark-excludes-smoke/examples
cat > /tmp/flagshark-excludes-smoke/src/app.ts <<'EOF'
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'
const client = LaunchDarkly.init('sdk-key')
const x = client.variation('REAL_FLAG', user, false)
EOF
cat > /tmp/flagshark-excludes-smoke/examples/demo.ts <<'EOF'
import * as LaunchDarkly from 'launchdarkly-node-server-sdk'
const client = LaunchDarkly.init('sdk-key')
const x = client.variation('DEMO_FLAG', user, false)
EOF
cat > /tmp/flagshark-excludes-smoke/.flagsharkignore <<'EOF'
examples/
EOF
cd /tmp/flagshark-excludes-smoke && git init -q && git add . && git commit -qm 'init'
node /Users/joe/projects/flagshark-excludes/packages/cli/bin/flagshark.mjs scan --verbose
```

Expected output should contain:
- "Effective excludes: .flagsharkignore: examples/"
- "1 excluded via .flagsharkignore + excludes"
- Only `REAL_FLAG` reported, not `DEMO_FLAG`.

### Task 8.5: Commit

```bash
cd /Users/joe/projects/flagshark-excludes
git add packages/cli/src/cli.ts packages/cli/src/formatter.ts \
        packages/core/src/scan-repo.ts
git commit -m "feat(cli): add config + excludes flags and verbose rule listing"
```

---

## Milestone M9 — PR

### Task 9.1: Open PR

- [ ] **Step 9.1.1: Push**

```bash
git push -u origin feat/excludes-issue-2
```

- [ ] **Step 9.1.2: Open PR**

```bash
gh pr create --title "feat: .flagsharkignore + excludes config (resolves #2)" --body "$(cat <<'EOF'
## Summary

Resolves [#2](https://github.com/FlagShark/flagshark/issues/2).

- Adds `.flagsharkignore` (gitignore-style file at repo root) parsed via the `ignore` npm package
- Adds `.flagshark.yml` config loader with `excludes:` block (`paths` / `files` / `presets`)
- Built-in presets: `test-files`, `snapshots`, `examples`, `stories`, `fixtures`, `generated` — all opt-in
- New CLI flags: `--config`, `--no-config`, `--no-ignore-file`, `--show-excluded`
- New `excludedCount` field in `ScanRepoResult`
- `--verbose` prints effective exclude rules at scan start

## Backward compat

- Zero behavior change for users without `.flagshark.yml` or `.flagsharkignore`
- `SKIP_DIRS` (node_modules, .git, etc.) preserved as unconditional baseline
- All existing flags continue to work

## Test plan

- [x] Schema validation (zod tests for every shape)
- [x] Config loader walks upward correctly
- [x] `.flagsharkignore` walks upward correctly
- [x] Presets expand to correct pattern sets
- [x] Excluder unions all sources; honors `!`-negation
- [x] Scanner skips matched files before reading content
- [x] `scanRepo` reports `excludedCount`
- [x] CLI flags wire end-to-end
- [x] Smoke test on a real fixture repo with mixed `examples/` + `*.test.ts`

## Releases

Ships in `v1.3.0` alongside tree-sitter T1. See [docs/superpowers/specs/2026-05-11-output-and-customizability-design.md](docs/superpowers/specs/2026-05-11-output-and-customizability-design.md) §11.
EOF
)"
```

- [ ] **Step 9.1.3: Wait for CI green + human review**

Manual gate. Pause here.

### Task 9.2: Land

After merge to main and merge of the companion tree-sitter PR (or before — order doesn't matter):

The unified `v1.3.0` release tag is cut from the tree-sitter PR's release task (M12 of the tree-sitter plan). Both features land in that release. No separate release for this plan.

---

## Self-Review

**Spec coverage:**

- ✅ Spec §6.2 (.flagsharkignore): M4
- ✅ Spec §6.3 (excludes: config block): M2, M3, M6, M7
- ✅ Spec §6.5 (presets): M5
- ✅ Spec §6.6 (excludedCount in result): M7
- ✅ Spec §8 (--config, --no-config, --no-ignore-file, --show-excluded, --verbose): M8
- ✅ Spec §11 P2 deliverable scope: every checklist item covered
- 🟡 Spec §6.4 (suppress.flags): deferred to a later plan (P5 in spec phasing)
- 🟡 Spec §7 (per-path threshold rules): deferred to a later plan (P6)
- 🟡 Spec §3.1 (formatters folder split): deferred to P3
- 🟡 Spec §3.2 (custom providers config field): schema includes it (M2.1.3), but wiring into the registry is deferred — schema-validate-only for now

**Placeholder scan:** no TBDs. Every step has the actual code, the actual file paths, and an expected outcome.

**Type consistency:**
- `FlagsharkConfig` zod-inferred type defined in `schema.ts`, used in `defaults.ts`, `loader.ts`, `excluder.ts`, `scan-repo.ts`, `cli.ts`. ✓
- `Excluder` defined in `excluder.ts`, used in `scanner.ts`, `scan-repo.ts`. ✓
- `EffectiveRules` defined in `excluder.ts`, used in `scan-repo.ts`, `cli.ts`. ✓
- `CollectFilesResult` defined in M7.1.4; all callers updated in same step. ✓
- `PRESETS` keyed by `PresetName` enum — zod schema's `PresetNameSchema` and `PRESETS` map share the same source of truth. ✓

**Ambiguity check:**
- The `ignore` npm package's default-export shape is sometimes `.default` and sometimes the module itself depending on bundler. M6.1.3 handles this defensively with `(ignoreModule as ... ).default ?? ignoreModule`.
- M7.1.4 says "update every caller of `collectFiles`" — explicit grep command provided so the engineer can find them all.
- M8.3.2 puts effective-rules logging in the CLI rather than scanRepo because the verbose flag is CLI-level. The rules are still available to non-CLI consumers via `result.effectiveExcludes`.
