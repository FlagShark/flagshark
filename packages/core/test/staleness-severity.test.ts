import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { analyzeStaleness } from '../src/staleness.js'
import { makeTempRepo, writeFixtureFile, commitAll } from './fixtures/repo-builder.js'
import type { FeatureFlag } from '../src/detection/feature-flag.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function detectedMap(flags: FeatureFlag[]): Map<string, FeatureFlag[]> {
  const m = new Map<string, FeatureFlag[]>()
  for (const f of flags) {
    const arr = m.get(f.name) ?? []
    arr.push(f)
    m.set(f.name, arr)
  }
  return m
}

describe('analyzeStaleness — severity on existing signals', () => {
  it('age signal has severity warning', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'OLD_FLAG'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'OLD_FLAG'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const flags: FeatureFlag[] = [
      { name: 'OLD_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'OLD_FLAG', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), { thresholdDays: 6, repoRoot: dir })
    const stale = result.find((s) => s.name === 'OLD_FLAG')
    const ageSignal = stale?.signals.find((s) => s.type === 'age')
    expect(ageSignal?.severity).toBe('warning')
  })

  it('low-usage signal has severity warning when it appears as context', async () => {
    // low-usage is no longer a primary stale signal — needs another
    // signal to make the flag stale. Set the commit date old enough
    // that the age signal fires; the low-usage signal then appears
    // alongside it as contributing context.
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'SOLO_OLD_FLAG'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const flags: FeatureFlag[] = [
      { name: 'SOLO_OLD_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), { thresholdDays: 6, repoRoot: dir })
    const stale = result.find((s) => s.name === 'SOLO_OLD_FLAG')
    expect(stale).toBeDefined()
    const lowUsage = stale?.signals.find((s) => s.type === 'low-usage')
    expect(lowUsage?.severity).toBe('warning')
  })
})

describe('analyzeStaleness — platform signals', () => {
  it('platform signal alone is enough to mark flag stale', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'PRESENT'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'PRESENT'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'PRESENT', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'PRESENT', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['PRESENT', [{
      type: 'missing-in-platform' as const,
      severity: 'error' as const,
      description: 'not in LD',
    }]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    const stale = result.find((s) => s.name === 'PRESENT')
    expect(stale).toBeDefined()
    expect(stale?.signals[0].type).toBe('missing-in-platform')
    expect(stale?.signals[0].severity).toBe('error')
  })

  it('platform signal stacks with age signal', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'OLD_AND_ARCHIVED'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'OLD_AND_ARCHIVED'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const flags: FeatureFlag[] = [
      { name: 'OLD_AND_ARCHIVED', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'OLD_AND_ARCHIVED', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['OLD_AND_ARCHIVED', [{
      type: 'archived-in-platform' as const,
      severity: 'warning' as const,
      description: 'archived in LD',
    }]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    const stale = result.find((s) => s.name === 'OLD_AND_ARCHIVED')
    const types = stale?.signals.map((s) => s.type) ?? []
    expect(types).toContain('age')
    expect(types).toContain('archived-in-platform')
  })

  it('does not affect flags without platform signals', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'FRESH'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'FRESH'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'FRESH', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'FRESH', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals: new Map() },
    )
    expect(result.find((s) => s.name === 'FRESH')).toBeUndefined()
  })
})

describe('analyzeStaleness — platform-permanent suppression', () => {
  // LD's `temporary: false` (mapped to PlatformFlag.permanent: true) means
  // the user explicitly wants this flag preserved — kill-switches,
  // long-lived experiment overrides, operational config. We should NOT
  // surface age or low-usage signals for those, even when they look
  // stale by the usual heuristics. We SHOULD still surface
  // missing-in-platform / archived-in-platform — those represent real
  // platform-vs-code mismatches the user needs to know about.

  it('suppresses the age signal for a permanent flag committed years ago', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'PERM_KILL_SWITCH'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'PERM_KILL_SWITCH'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00') // ~4 years old

    const flags: FeatureFlag[] = [
      { name: 'PERM_KILL_SWITCH', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'PERM_KILL_SWITCH', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['PERM_KILL_SWITCH', [{
      type: 'platform-permanent' as const,
      severity: 'info' as const,
      description: 'marked permanent in LaunchDarkly',
    }]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    // Permanent flag with no other stale signals → not in stale list.
    expect(result.find((s) => s.name === 'PERM_KILL_SWITCH')).toBeUndefined()
  })

  it('suppresses low-usage signal for a permanent flag in only one file', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'KILL_SWITCH_ONE_FILE'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'KILL_SWITCH_ONE_FILE', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['KILL_SWITCH_ONE_FILE', [{
      type: 'platform-permanent' as const,
      severity: 'info' as const,
      description: 'marked permanent in LaunchDarkly',
    }]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    // Without the permanent marker this would have a low-usage signal.
    expect(result.find((s) => s.name === 'KILL_SWITCH_ONE_FILE')).toBeUndefined()
  })

  it('still emits archived-in-platform even for a permanent flag (archive wins)', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'ARCHIVED_PERMANENT'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'ARCHIVED_PERMANENT'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'ARCHIVED_PERMANENT', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'ARCHIVED_PERMANENT', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    // Cross-reference's archive-vs-permanent precedence resolves to
    // archive (covered separately); here we simulate the cross-reference
    // output where archive-in-platform is emitted alongside the
    // permanent marker (e.g. across multiple platforms).
    const platformSignals = new Map([['ARCHIVED_PERMANENT', [
      {
        type: 'archived-in-platform' as const,
        severity: 'warning' as const,
        description: 'archived in LaunchDarkly',
      },
      {
        type: 'platform-permanent' as const,
        severity: 'info' as const,
        description: 'marked permanent in LaunchDarkly',
      },
    ]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    const stale = result.find((s) => s.name === 'ARCHIVED_PERMANENT')
    expect(stale).toBeDefined()
    const types = stale!.signals.map((s) => s.type)
    expect(types).toContain('archived-in-platform')
    // platform-permanent MUST be filtered out of the user-facing signals.
    expect(types).not.toContain('platform-permanent')
  })

  it('reports age in human-readable form even when the age signal is suppressed', async () => {
    // Operators still want to know how old a permanent flag is when
    // looking at the output, even though we don't shout about it. The
    // `age` field on StaleFlag is populated independently of the age
    // signal — but this flag has no other signals so it should not
    // appear in the stale list at all. Instead, verify via a flag that
    // has both permanent + a missing-in-platform (impossible in real
    // life but useful for the assertion): permanent set, archived
    // signal still fires, age string carries the human-readable form.
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'PERM_AND_ARCHIVED'\n`)
    writeFixtureFile(dir, 'b.ts', `const x = 'PERM_AND_ARCHIVED'\n`)
    commitAll(dir, 'init', '2022-01-01T00:00:00')

    const flags: FeatureFlag[] = [
      { name: 'PERM_AND_ARCHIVED', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
      { name: 'PERM_AND_ARCHIVED', filePath: 'b.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const platformSignals = new Map([['PERM_AND_ARCHIVED', [
      { type: 'archived-in-platform' as const, severity: 'warning' as const, description: 'archived in LaunchDarkly' },
      { type: 'platform-permanent' as const, severity: 'info' as const, description: 'marked permanent in LaunchDarkly' },
    ]]])

    const result = await analyzeStaleness(
      detectedMap(flags),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    const stale = result.find((s) => s.name === 'PERM_AND_ARCHIVED')
    expect(stale).toBeDefined()
    expect(stale!.age).toBeDefined()
    // Age signal should be SUPPRESSED, but the age string is preserved.
    expect(stale!.signals.map((s) => s.type)).not.toContain('age')
  })
})

describe('analyzeStaleness — platform metadata propagation (P3)', () => {
  // Tags, maintainer, and platform-status flow from the cross-reference
  // layer through to each emitted StaleFlag so output formatters can
  // surface them without re-querying the platform.

  // These tests previously relied on low-usage to mark single-file
  // flags stale; that's no longer enough on its own, so each fixture
  // pairs the flag with a platform signal (missing-in-platform) so
  // it IS genuinely stale, then asserts the metadata propagation we
  // actually care about.
  const missingSignal: import('../src/providers/interface.js').PlatformSignal = {
    type: 'missing-in-platform',
    severity: 'error',
    description: 'referenced in code but not found in LaunchDarkly',
  }

  it('attaches tags from platformMetadata to the emitted StaleFlag', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'TAGGED_FLAG'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'TAGGED_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
      platformSignals: new Map([['TAGGED_FLAG', [missingSignal]]]),
      platformMetadata: new Map([
        ['TAGGED_FLAG', { tags: ['kill-switch', 'auth'] }],
      ]),
    })
    const stale = result.find((s) => s.name === 'TAGGED_FLAG')
    expect(stale).toBeDefined()
    expect(stale!.tags).toEqual(['kill-switch', 'auth'])
  })

  it('attaches maintainer from platformMetadata to the emitted StaleFlag', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'OWNED_FLAG'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'OWNED_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
      platformSignals: new Map([['OWNED_FLAG', [missingSignal]]]),
      platformMetadata: new Map([
        ['OWNED_FLAG', { maintainer: 'Jane Doe <jane@example.com>' }],
      ]),
    })
    expect(result.find((s) => s.name === 'OWNED_FLAG')!.maintainer).toBe(
      'Jane Doe <jane@example.com>',
    )
  })

  it('attaches platformStatus from platformMetadata to the emitted StaleFlag', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'STATUS_FLAG'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'STATUS_FLAG', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
      platformSignals: new Map([['STATUS_FLAG', [missingSignal]]]),
      platformMetadata: new Map([['STATUS_FLAG', { status: 'launched' }]]),
    })
    expect(result.find((s) => s.name === 'STATUS_FLAG')!.platformStatus).toBe('launched')
  })

  it('leaves tags/maintainer/platformStatus absent when no metadata is provided', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'NO_META'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'NO_META', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
      platformSignals: new Map([['NO_META', [missingSignal]]]),
      // No platformMetadata.
    })
    const stale = result.find((s) => s.name === 'NO_META')
    expect(stale).toBeDefined()
    expect(stale!.tags).toBeUndefined()
    expect(stale!.maintainer).toBeUndefined()
    expect(stale!.platformStatus).toBeUndefined()
  })

  it('skips empty-array tags so output formatters don\'t render an empty cell', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'a.ts', `const x = 'EMPTY_TAGS'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      { name: 'EMPTY_TAGS', filePath: 'a.ts', lineNumber: 1, language: 'typescript', provider: 'launchdarkly-node-server-sdk' },
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
      platformSignals: new Map([['EMPTY_TAGS', [missingSignal]]]),
      platformMetadata: new Map([['EMPTY_TAGS', { tags: [] }]]),
    })
    expect(result.find((s) => s.name === 'EMPTY_TAGS')!.tags).toBeUndefined()
  })
})

describe('analyzeStaleness — test-only references signal', () => {
  // A flag referenced only in test/spec files is unlikely to be a real
  // production toggle — it's either an SDK-test fixture, a prototype
  // that was never deployed, or experiment leftover. Emit a PRIMARY
  // stale signal (unlike low-usage which is contributing-only).

  function flagAt(name: string, path: string): FeatureFlag {
    return {
      name,
      filePath: path,
      lineNumber: 1,
      language: 'typescript',
      provider: 'launchdarkly-node-server-sdk',
    }
  }

  it.each([
    'src/foo.test.ts',
    'src/foo.spec.ts',
    'src/foo-test.tsx',
    'src/foo_test.go',
    'src/test_foo.py',
    'src/FooTest.java',
    'src/FooTests.java',
    'src/__tests__/foo.ts',
    'src/__mocks__/foo.ts',
    'test/foo.ts',
    'tests/foo.ts',
    'spec/foo.ts',
  ])('marks a flag as test-only when its only ref is %s', async (path) => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, path, `const x = 'TEST_ONLY_FLAG'\n`)
    commitAll(dir, 'init')

    const result = await analyzeStaleness(
      detectedMap([flagAt('TEST_ONLY_FLAG', path)]),
      { thresholdDays: 6, repoRoot: dir },
    )
    const stale = result.find((s) => s.name === 'TEST_ONLY_FLAG')
    expect(stale, `expected ${path} to be classified as a test file`).toBeDefined()
    expect(stale!.signals.map((s) => s.type)).toContain('test-only-references')
  })

  it('does NOT mark as test-only when at least one ref is in a production file', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/app.ts', `const x = 'MIXED_FLAG'\n`)
    writeFixtureFile(dir, 'src/app.test.ts', `const x = 'MIXED_FLAG'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      flagAt('MIXED_FLAG', 'src/app.ts'),
      flagAt('MIXED_FLAG', 'src/app.test.ts'),
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
    })
    // Mixed = not test-only = no signal from THIS detector. Without
    // a primary stale signal, the flag isn't on the stale list at all.
    expect(result.find((s) => s.name === 'MIXED_FLAG')).toBeUndefined()
  })

  it('test-only is a PRIMARY signal (puts a flag on the stale list by itself)', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/lonely.test.ts', `const x = 'LONELY'\n`)
    commitAll(dir, 'init')

    const result = await analyzeStaleness(
      detectedMap([flagAt('LONELY', 'src/lonely.test.ts')]),
      { thresholdDays: 6, repoRoot: dir },
    )
    // No platform signals, no age signal (just-committed), low-usage
    // alone wouldn't make it stale anymore — only test-only-references
    // is putting LONELY on the stale list here.
    expect(result.find((s) => s.name === 'LONELY')).toBeDefined()
  })

  it('test-only is suppressed for permanent flags', async () => {
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/lonely.test.ts', `const x = 'PERM_TEST'\n`)
    commitAll(dir, 'init')

    const platformSignals = new Map<string, import('../src/providers/interface.js').PlatformSignal[]>([
      [
        'PERM_TEST',
        [
          {
            type: 'platform-permanent' as const,
            severity: 'info' as const,
            description: 'marked permanent in LaunchDarkly',
          },
        ],
      ],
    ])
    const result = await analyzeStaleness(
      detectedMap([flagAt('PERM_TEST', 'src/lonely.test.ts')]),
      { thresholdDays: 6, repoRoot: dir, platformSignals },
    )
    // Permanent flag with only test references and no other signal → not stale.
    expect(result.find((s) => s.name === 'PERM_TEST')).toBeUndefined()
  })

  it('does not misclassify a production "tester.ts" or "specification.ts" file', async () => {
    // Boundary check on the regexes: "tester", "specification", and
    // "main_testing.go" are not test files, even though they contain
    // 'test' / 'spec' substrings.
    const dir = makeTempRepo()
    dirs.push(dir)
    writeFixtureFile(dir, 'src/tester.ts', `const x = 'PROD_TESTER'\n`)
    writeFixtureFile(dir, 'src/specification.ts', `const x = 'PROD_SPEC'\n`)
    commitAll(dir, 'init')

    const flags: FeatureFlag[] = [
      flagAt('PROD_TESTER', 'src/tester.ts'),
      flagAt('PROD_SPEC', 'src/specification.ts'),
    ]
    const result = await analyzeStaleness(detectedMap(flags), {
      thresholdDays: 6,
      repoRoot: dir,
    })
    expect(result.find((s) => s.name === 'PROD_TESTER')).toBeUndefined()
    expect(result.find((s) => s.name === 'PROD_SPEC')).toBeUndefined()
  })
})
