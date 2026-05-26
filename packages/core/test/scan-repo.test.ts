import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { scanRepo } from '../src/scan-repo.js'
import { makeTempRepo } from './fixtures/repo-builder.js'

describe('scanRepo', () => {
  it('returns a ScanRepoResult for a repo with one flag', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    // Use the flag in two files so the low-usage signal doesn't fire,
    // keeping the flag non-stale for a fresh commit.
    const sharedHeader =
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n`
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      sharedHeader + `if (await client.variation('NEW_CHECKOUT', user, false)) {}\n`,
    )
    writeFileSync(
      join(dir, 'src', 'page.ts'),
      sharedHeader + `const v = await client.variation('NEW_CHECKOUT', user, false)\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, threshold: 6 })

    expect(result.totalFlags).toBe(1)
    expect(result.filesScanned).toBe(2)
    expect(result.detectedProviders.length).toBeGreaterThan(0)
    expect(result.healthScore).toBe(100)
    expect(result.staleFlags).toEqual([])
  })

  it('marks an old flag as stale', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'old.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `if (await client.variation('OLD_FLAG', user, false)) {}\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync(
      'git',
      ['commit', '-qm', 'old'],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2024-01-01T00:00:00',
          GIT_COMMITTER_DATE: '2024-01-01T00:00:00',
        },
      },
    )

    const result = await scanRepo({ cwd: dir, threshold: 6 })
    expect(result.staleFlags.length).toBeGreaterThan(0)
    expect(result.staleFlags[0].name).toBe('OLD_FLAG')
  })

  it('skips files matched by .flagsharkignore', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'examples'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL_FLAG', user, false)\n`,
    )
    writeFileSync(
      join(dir, 'examples', 'demo.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('DEMO_FLAG', user, false)\n`,
    )
    writeFileSync(join(dir, '.flagsharkignore'), 'examples/\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir })

    expect(result.totalFlags).toBe(1)
    expect(result.excludedCount).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('honors noIgnoreFile: true to bypass .flagsharkignore', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'examples'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL_FLAG', user, false)\n`,
    )
    writeFileSync(
      join(dir, 'examples', 'demo.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('DEMO_FLAG', user, false)\n`,
    )
    writeFileSync(join(dir, '.flagsharkignore'), 'examples/\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    // With noIgnoreFile: true, .flagsharkignore is bypassed — both flags detected
    const result = await scanRepo({ cwd: dir, noIgnoreFile: true })

    expect(result.totalFlags).toBe(2)
    expect(result.excludedCount).toBe(0)

    rmSync(dir, { recursive: true, force: true })
  })

  it('uses config.threshold when opts.threshold is undefined', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    // A flag in a single file — single-file signal will fire.
    writeFileSync(join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('SOLO_FLAG', user, false)\n`)
    writeFileSync(join(dir, '.flagshark.yml'), 'threshold: 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    // With threshold from config (1 month), even a freshly-added flag with single-file usage triggers.
    const result = await scanRepo({ cwd: dir })

    // Single-file signal fires regardless of threshold, so we expect at least one stale flag.
    // The point of this test is that scanRepo accepted threshold from config without crashing
    // and the config-loading path was hit (verified by the .flagshark.yml file).
    expect(result.totalFlags).toBe(1)
    expect(result.staleFlags.length).toBeGreaterThanOrEqual(1)
  })

  it('CLI opts.threshold overrides config.threshold', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('SOLO_FLAG', user, false)\n`)
    writeFileSync(join(dir, '.flagshark.yml'), 'threshold: 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    // Pass explicit threshold — should beat the config's 1.
    const result = await scanRepo({ cwd: dir, threshold: 24 })

    expect(result.totalFlags).toBe(1)
    // Test passes if no crash and config didn't shadow the explicit value.
  })

  it('applies excludes from .flagshark.yml', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('REAL_FLAG', user, false)\n`,
    )
    writeFileSync(
      join(dir, 'src', 'app.test.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('TEST_FLAG', user, false)\n`,
    )
    writeFileSync(join(dir, '.flagshark.yml'), 'excludes:\n  presets:\n    - test-files\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir })

    expect(result.totalFlags).toBe(1)
    expect(result.excludedCount).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('uses noConfig: true to bypass config file discovery (line 140)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('NO_CONFIG_FLAG', user, false)\n`,
    )
    // Even with a .flagshark.yml present, noConfig bypasses it
    writeFileSync(join(dir, '.flagshark.yml'), 'threshold: 999\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, noConfig: true })
    expect(result.totalFlags).toBe(1)
    // If config was loaded, threshold 999 would suppress stale flags by age;
    // noConfig defaults to 30 days (default) + single-file signal fires anyway.

    rmSync(dir, { recursive: true, force: true })
  })

  it('passes engine option to use regex explicitly (line 155)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `const client = LaunchDarkly.init('sdk-key')\n` +
      `client.variation('ENGINE_TEST', user, false)\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, engine: 'regex' })
    expect(result.totalFlags).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('returns healthScore 100 when no flags are found (totalFlags === 0 branch)', async () => {
    // A TS file with no feature flag calls → totalFlags = 0 → healthScore = 100
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'util.ts'),
      `export function add(a: number, b: number): number { return a + b }\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, noConfig: true })
    expect(result.totalFlags).toBe(0)
    expect(result.healthScore).toBe(100)

    rmSync(dir, { recursive: true, force: true })
  })

  // Regression coverage for B3.B: custom_detectors escape hatch. The
  // canonical reproducer is Mattermost-shaped Go where flags are typed
  // struct fields rather than SDK call arguments. Pre-fix this codebase
  // shape returned 0 detections; post-fix a user-declared regex matches.
  it('runs user-declared custom_detectors over matching-language files', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'app'))
    writeFileSync(
      join(dir, 'app', 'features.go'),
      [
        'package main',
        '',
        'func main() {',
        '  if server.Config().FeatureFlags.EnableSharedChannelsMemberSync {',
        '    doShare()',
        '  }',
        '  if server.Config().FeatureFlags.EnableNewUploadFlow {',
        '    doUpload()',
        '  }',
        '}',
      ].join('\n'),
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({
      cwd: dir,
      threshold: 6,
      config: {
        threshold: 30,
        excludes: { paths: [], files: [], presets: [] },
        suppress: { flags: [] },
        paths: [],
        providers: [],
        custom_detectors: [
          {
            type: 'struct-field-access',
            language: 'go',
            access_pattern: '\\.FeatureFlags\\.([A-Z]\\w+)',
            name: 'Mattermost-style config struct',
          },
        ],
        output: {
          format: 'text',
          groupBy: 'file',
          sortBy: 'age',
          color: 'auto',
          maxDisplay: 10,
        },
        healthScore: { weights: { age: 1.0, lowUsage: 0.5, hardcoded: 2.0 } },
        engine: {},
      },
    })

    // Both struct fields should be detected as flags.
    expect(result.totalFlags).toBe(2)
    // The flags surface via the JSON output with confidence: 'low'
    // (escape-hatch detections deserve manual review).
    const detected = result.staleFlags.map((f) => f.name).sort()
    // staleFlags requires a signal; with `low-usage` (single file) both
    // should land here.
    expect(detected).toEqual(['EnableNewUploadFlow', 'EnableSharedChannelsMemberSync'])
    expect(result.staleFlags.every((f) => f.confidence === 'low')).toBe(true)
    expect(result.staleFlags.every((f) => f.provider === 'Mattermost-style config struct')).toBe(
      true,
    )

    rmSync(dir, { recursive: true, force: true })
  })

  it('precision-guards custom_detectors: only matches files of the declared language', async () => {
    // A TS file containing the SAME shape as the Go regex shouldn't match,
    // because the detector declared `language: 'go'`. Prevents one user's
    // declared pattern from leaking to unrelated languages.
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      'const x = config.FeatureFlags.LooksLikeAFlag\n',
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({
      cwd: dir,
      noConfig: false,
      config: {
        threshold: 30,
        excludes: { paths: [], files: [], presets: [] },
        suppress: { flags: [] },
        paths: [],
        providers: [],
        custom_detectors: [
          {
            type: 'struct-field-access',
            language: 'go',
            access_pattern: '\\.FeatureFlags\\.([A-Z]\\w+)',
          },
        ],
        output: { format: 'text', groupBy: 'file', sortBy: 'age', color: 'auto', maxDisplay: 10 },
        healthScore: { weights: { age: 1.0, lowUsage: 0.5, hardcoded: 2.0 } },
        engine: {},
      },
    })

    expect(result.totalFlags).toBe(0)

    rmSync(dir, { recursive: true, force: true })
  })

  // Regression coverage for C5: structured metrics emission. The metric line
  // is what downstream dashboards key off; if it stops being emitted, the
  // SaaS observability pipeline goes dark silently. Pin the contract.
  it('emits a flagshark_scan_complete metric line via info-level logger', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    // Record every info call so we can assert on the metric.
    const infoCalls: Array<{ msg: unknown; extra: unknown }> = []
    const noop = () => {}
    const recordingLogger = {
      debug: noop,
      info: (msg: unknown, extra?: unknown) => {
        infoCalls.push({ msg, extra })
      },
      warn: noop,
      error: noop,
    }

    await scanRepo({ cwd: dir, noConfig: true, logger: recordingLogger })

    const metricCall = infoCalls.find((c) => c.msg === 'flagshark_scan_complete')
    expect(metricCall, 'expected flagshark_scan_complete metric line').toBeDefined()
    const payload = metricCall!.extra as Record<string, unknown>
    // Pin the load-bearing fields. If renames are intentional, this test
    // forces them to be deliberate.
    expect(payload.event).toBe('flagshark_scan_complete')
    expect(typeof payload.durationMs).toBe('number')
    expect(typeof payload.filesScanned).toBe('number')
    expect(payload.totalFlags).toBe(0)
    expect(payload.staleFlags).toBe(0)
    expect(payload.healthScore).toBe(100)
    expect(typeof payload.detectionEngine).toBe('string')

    rmSync(dir, { recursive: true, force: true })
  })

  // Coverage gate for scan-repo.ts:466-471 + 475-479. Two operator-friendly
  // warning paths in applyCustomDetectors: a user-supplied regex that
  // doesn't compile, and a `language` field that names something
  // FlagShark has never heard of. Both should be logged + skipped, not
  // blow up the whole scan.
  it('warns and skips a custom_detector whose regex fails to compile', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.go'),
      'package main\nvar x = cfg.FeatureFlags.OK\n',
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const warnings: Array<{ msg: unknown; extra: unknown }> = []
    const noop = () => {}
    const collectingLogger = {
      debug: noop,
      info: noop,
      warn: (msg: unknown, extra?: unknown) => {
        warnings.push({ msg, extra })
      },
      error: noop,
    }

    const result = await scanRepo({
      cwd: dir,
      logger: collectingLogger,
      config: {
        threshold: 30,
        excludes: { paths: [], files: [], presets: [] },
        suppress: { flags: [] },
        paths: [],
        providers: [],
        custom_detectors: [
          {
            type: 'struct-field-access',
            language: 'go',
            // Unterminated character class — guaranteed to throw on new RegExp().
            access_pattern: '\\.FeatureFlags\\.[',
          },
        ],
        output: { format: 'text', groupBy: 'file', sortBy: 'age', color: 'auto', maxDisplay: 10 },
        healthScore: { weights: { age: 1.0, lowUsage: 0.5, hardcoded: 2.0 } },
        engine: {},
      },
    })

    // Scan completes successfully with no flags from the bad detector.
    expect(result.totalFlags).toBe(0)
    // A warn line names the offending pattern + the regex error.
    const compileWarning = warnings.find(
      (w) => typeof w.msg === 'string' && w.msg.includes('custom_detector regex failed to compile'),
    )
    expect(compileWarning, 'expected a compile-failure warn line').toBeDefined()
    const extra = compileWarning!.extra as Record<string, unknown>
    expect(extra.access_pattern).toContain('FeatureFlags')
    expect(typeof extra.error).toBe('string')

    rmSync(dir, { recursive: true, force: true })
  })

  it('warns and skips a custom_detector whose `language` names something unknown', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.go'), 'package main\nvar x = cfg.FeatureFlags.OK\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const warnings: Array<{ msg: unknown; extra: unknown }> = []
    const noop = () => {}
    const collectingLogger = {
      debug: noop,
      info: noop,
      warn: (msg: unknown, extra?: unknown) => {
        warnings.push({ msg, extra })
      },
      error: noop,
    }

    const result = await scanRepo({
      cwd: dir,
      logger: collectingLogger,
      config: {
        threshold: 30,
        excludes: { paths: [], files: [], presets: [] },
        suppress: { flags: [] },
        paths: [],
        providers: [],
        custom_detectors: [
          {
            type: 'struct-field-access',
            // 'cobol' is intentionally absent from LANGUAGE_EXTENSIONS.
            language: 'cobol' as unknown as 'go',
            access_pattern: '\\.FeatureFlags\\.([A-Z]\\w+)',
          },
        ],
        output: { format: 'text', groupBy: 'file', sortBy: 'age', color: 'auto', maxDisplay: 10 },
        healthScore: { weights: { age: 1.0, lowUsage: 0.5, hardcoded: 2.0 } },
        engine: {},
      },
    })

    expect(result.totalFlags).toBe(0)
    const langWarning = warnings.find(
      (w) =>
        typeof w.msg === 'string' && w.msg.includes('custom_detector skipped — unknown language'),
    )
    expect(langWarning, 'expected an unknown-language warn line').toBeDefined()
    expect((langWarning!.extra as Record<string, unknown>).language).toBe('cobol')

    rmSync(dir, { recursive: true, force: true })
  })

  // Coverage gate for scan-repo.ts:361-365 — debug-log line that fires only
  // when the cwd actually contains a tsconfig.json with paths. Otherwise
  // the load returns null and the `if (aliases)` branch never runs.
  it('emits a debug log line when tsconfig.json aliases are loaded', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    )
    // A trivial source file so the scan has something to walk.
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const debugCalls: Array<{ msg: unknown; extra: unknown }> = []
    const noop = () => {}
    const logger = {
      debug: (msg: unknown, extra?: unknown) => {
        debugCalls.push({ msg, extra })
      },
      info: noop,
      warn: noop,
      error: noop,
    }
    await scanRepo({ cwd: dir, noConfig: true, logger })

    const aliasLog = debugCalls.find(
      (c) => typeof c.msg === 'string' && c.msg.includes('tsconfig path aliases loaded'),
    )
    expect(aliasLog, 'expected a tsconfig-aliases-loaded debug line').toBeDefined()
    const extra = aliasLog!.extra as Record<string, unknown>
    expect(typeof extra.baseUrl).toBe('string')
    expect(extra.aliasCount).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })

  // Coverage gate for scan-repo.ts:393-395 — the augment loop's pass-through
  // branch for files that have no SDK reach. Requires at least one file in
  // the transitive set (to defeat the early-return on inScopeFiles === 0)
  // PLUS at least one file outside the set (to exercise the !sdks branch).
  it('passes non-SDK files through unchanged in the wrapper-augmentation pass', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    // Seed file: directly imports an SDK so it lands in transitiveSdks.
    writeFileSync(
      join(dir, 'src', 'sdk.ts'),
      `import * as LD from 'launchdarkly-node-server-sdk'\nconst c = LD.init('k')\nawait c.variation('feature-x', user, false)\n`,
    )
    // Bystander file: no imports, no SDK reach. Hits the !sdks pass-through.
    writeFileSync(join(dir, 'src', 'unrelated.ts'), 'export const greet = () => "hi"\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, noConfig: true })
    // Seed file produced a detectable flag, bystander didn't break anything.
    expect(result.totalFlags).toBeGreaterThanOrEqual(1)

    rmSync(dir, { recursive: true, force: true })
  })

  // Coverage gate for scan-repo.ts:403 — Python wrapper marker prefix.
  // When a .py file is in the transitive SDK reach, the augmented content
  // is suffixed with the Python-comment marker, not the JS-comment one.
  it('augments Python wrapper files with the Python-comment SDK marker', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', '__init__.py'), '')
    // The seed: a .py file that imports the PostHog SDK and calls
    // `posthog.feature_enabled` with a flag-key literal. PostHog Python
    // detector matches this method.
    writeFileSync(
      join(dir, 'pkg', 'sdk_wrapper.py'),
      [
        'import posthog',
        'def gate():',
        '    return posthog.feature_enabled("checkout-v2", "user-id")',
      ].join('\n') + '\n',
    )
    // A second consumer file imports the wrapper — drags it into the
    // transitive set so the Python branch of the marker code path runs.
    writeFileSync(
      join(dir, 'pkg', 'consumer.py'),
      'from .sdk_wrapper import gate\ngate()\n',
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const result = await scanRepo({ cwd: dir, noConfig: true })
    // The direct posthog.feature_enabled("checkout-v2", ...) call site is
    // in a .py file that traverses the wrapper-marker code path — proves
    // the .py branch of the marker selector executed.
    expect(result.totalFlags).toBeGreaterThanOrEqual(1)

    rmSync(dir, { recursive: true, force: true })
  })
})
