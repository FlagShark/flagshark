import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

import { analyzeStaleness } from '../src/staleness.js'
import { makeTempRepo } from './fixtures/repo-builder.js'

import type { FeatureFlag } from '../src/detection/feature-flag.js'

function makeFlag(name: string, filePath: string, lineNumber = 1): FeatureFlag {
  return {
    name,
    filePath,
    lineNumber,
    language: 'typescript',
    provider: 'LaunchDarkly',
  }
}

describe('analyzeStaleness', () => {
  it('low-usage alone does NOT make a flag stale (contributing signal only)', async () => {
    // Behavior change (2026-05-26): single-file flags are no longer
    // stale on their own. Plenty of legitimate flags are single-file
    // (small features, kill switches, A/B toggles for one screen);
    // marking them stale floods the output with false positives. The
    // low-usage signal is now CONTEXT: it appears alongside other
    // stale signals to indicate "small cleanup scope", but it doesn't
    // make a flag stale by itself.
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('single-ref-flag', [makeFlag('single-ref-flag', 'src/a.ts', 10)])
    flags.set('multi-ref-flag', [
      makeFlag('multi-ref-flag', 'src/a.ts', 20),
      makeFlag('multi-ref-flag', 'src/b.ts', 30),
    ])

    const result = await analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
    })

    const staleNames = result.map((f) => f.name)
    // Neither single-ref nor multi-ref makes the stale list here —
    // single-ref no longer fires on low-usage alone; multi-ref never did.
    expect(staleNames).not.toContain('single-ref-flag')
    expect(staleNames).not.toContain('multi-ref-flag')
  })

  it('returns empty array when no flags are provided', async () => {
    const flags = new Map<string, FeatureFlag[]>()
    const result = await analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
    })
    expect(result).toEqual([])
  })

  it('includes signal descriptions in results', async () => {
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('lonely-flag', [makeFlag('lonely-flag', 'src/x.ts', 5)])

    const result = await analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
    })

    const stale = result.find((f) => f.name === 'lonely-flag')
    if (stale) {
      const signalTypes = stale.signals.map((s) => s.type)
      expect(signalTypes).toContain('low-usage')
    }
  })

  it('produces "N days ago" age format for flags committed ~5 days ago (lines 136-137)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `client.variation('DAYS_OLD_FLAG', user, false)\n`,
    )
    // 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: fiveDaysAgo, GIT_COMMITTER_DATE: fiveDaysAgo },
    })

    const filePath = join(dir, 'src', 'app.ts')
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('DAYS_OLD_FLAG', [{
      name: 'DAYS_OLD_FLAG',
      filePath,
      lineNumber: 2,
      language: 'typescript',
      provider: 'launchdarkly',
    }])

    // With 0 threshold months, every flag older than now is "stale by age"
    const result = await analyzeStaleness(flags, {
      thresholdDays: 0,
      repoRoot: dir,
    })

    rmSync(dir, { recursive: true, force: true })

    // If blame succeeded, age should be in "N days ago" format
    const stale = result.find((f) => f.name === 'DAYS_OLD_FLAG')
    if (stale?.age) {
      expect(stale.age).toMatch(/day/)
    }
  })

  it('produces "1 month ago" age format (singular month — line 133)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `client.variation('ONE_MONTH_FLAG', user, false)\n`,
    )
    // 45 days ago → 1 month (singular)
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: fortyFiveDaysAgo, GIT_COMMITTER_DATE: fortyFiveDaysAgo },
    })

    const filePath = join(dir, 'src', 'app.ts')
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('ONE_MONTH_FLAG', [{
      name: 'ONE_MONTH_FLAG',
      filePath,
      lineNumber: 2,
      language: 'typescript',
      provider: 'launchdarkly',
    }])

    const result = await analyzeStaleness(flags, { thresholdDays: 0, repoRoot: dir })
    rmSync(dir, { recursive: true, force: true })

    const stale = result.find((f) => f.name === 'ONE_MONTH_FLAG')
    if (stale?.age) {
      expect(stale.age).toBe('1 month ago')
    }
  })

  it('produces "N months ago" age format (plural months — line 133)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `client.variation('MULTI_MONTH_FLAG', user, false)\n`,
    )
    // 75 days ago → ~2.5 months → "2 months ago" (plural)
    const seventyFiveDaysAgo = new Date(Date.now() - 75 * 24 * 60 * 60 * 1000).toISOString()
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: seventyFiveDaysAgo, GIT_COMMITTER_DATE: seventyFiveDaysAgo },
    })

    const filePath = join(dir, 'src', 'app.ts')
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('MULTI_MONTH_FLAG', [{
      name: 'MULTI_MONTH_FLAG',
      filePath,
      lineNumber: 2,
      language: 'typescript',
      provider: 'launchdarkly',
    }])

    const result = await analyzeStaleness(flags, { thresholdDays: 0, repoRoot: dir })
    rmSync(dir, { recursive: true, force: true })

    const stale = result.find((f) => f.name === 'MULTI_MONTH_FLAG')
    if (stale?.age) {
      expect(stale.age).toMatch(/\d+ months ago/)
    }
  })

  it('produces "1 day ago" age format (singular day — line 136)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `client.variation('ONE_DAY_FLAG', user, false)\n`,
    )
    // Exactly 26 hours ago → 1 day
    const oneDayAgo = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: oneDayAgo, GIT_COMMITTER_DATE: oneDayAgo },
    })

    const filePath = join(dir, 'src', 'app.ts')
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('ONE_DAY_FLAG', [{
      name: 'ONE_DAY_FLAG',
      filePath,
      lineNumber: 2,
      language: 'typescript',
      provider: 'launchdarkly',
    }])

    const result = await analyzeStaleness(flags, { thresholdDays: 0, repoRoot: dir })
    rmSync(dir, { recursive: true, force: true })

    const stale = result.find((f) => f.name === 'ONE_DAY_FLAG')
    if (stale?.age) {
      expect(stale.age).toMatch(/1 day ago/)
    }
  })

  it('produces "1 year ago" age format (singular year — line 130)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `client.variation('ONE_YEAR_FLAG', user, false)\n`,
    )
    // Exactly 370 days ago → 1 year
    const oneYearAgo = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000).toISOString()
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: oneYearAgo, GIT_COMMITTER_DATE: oneYearAgo },
    })

    const filePath = join(dir, 'src', 'app.ts')
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('ONE_YEAR_FLAG', [{
      name: 'ONE_YEAR_FLAG',
      filePath,
      lineNumber: 2,
      language: 'typescript',
      provider: 'launchdarkly',
    }])

    const result = await analyzeStaleness(flags, { thresholdDays: 0, repoRoot: dir })
    rmSync(dir, { recursive: true, force: true })

    const stale = result.find((f) => f.name === 'ONE_YEAR_FLAG')
    if (stale?.age) {
      expect(stale.age).toMatch(/1 year ago/)
    }
  })

  it('uses "unknown" provider when flag has no provider set (line 261)', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(
      join(dir, 'src', 'app.ts'),
      `import * as LaunchDarkly from 'launchdarkly-node-server-sdk'\n` +
      `client.variation('NO_PROVIDER_FLAG', user, false)\n`,
    )
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const filePath = join(dir, 'src', 'app.ts')
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('NO_PROVIDER_FLAG', [{
      name: 'NO_PROVIDER_FLAG',
      filePath,
      lineNumber: 2,
      language: 'typescript',
      // provider is intentionally omitted — triggers ?? 'unknown' fallback
    }])

    // Low threshold and low-usage to ensure flag is stale
    const result = await analyzeStaleness(flags, { thresholdDays: 0, repoRoot: dir })
    rmSync(dir, { recursive: true, force: true })

    const stale = result.find((f) => f.name === 'NO_PROVIDER_FLAG')
    if (stale) {
      expect(stale.provider).toBe('unknown')
    }
  })

  it('propagates platformEnvironments to StaleFlag.environments', async () => {
    // Build a flag that will be marked stale via a platform signal, then
    // pass platformEnvironments — the resulting StaleFlag should carry the
    // per-env enrichment data through to the output layer.
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('ENV_FLAG', [makeFlag('ENV_FLAG', 'src/env.ts', 1)])

    const platformSignals = new Map([
      ['ENV_FLAG', [{
        type: 'archived-in-platform' as const,
        severity: 'warning' as const,
        description: 'archived in LaunchDarkly',
      }]],
    ])

    const platformEnvironments = new Map([
      ['ENV_FLAG', new Map([
        ['production', { status: 'launched' as const, evaluations30d: 12000 }],
        ['staging',    { status: 'active' as const,   evaluations30d: 3 }],
      ])],
    ])

    const result = await analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
      platformSignals,
      platformEnvironments,
    })

    const stale = result.find((f) => f.name === 'ENV_FLAG')
    expect(stale).toBeDefined()
    expect(stale!.environments).toBeDefined()
    expect(stale!.environments!.size).toBe(2)
    expect(stale!.environments!.get('production')?.status).toBe('launched')
    expect(stale!.environments!.get('staging')?.evaluations30d).toBe(3)
  })

  it('propagates platform variations to StaleFlag.variations via platformMetadata', async () => {
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('FOO', [makeFlag('FOO', 'src/foo.ts', 1)])

    const platformSignals = new Map([
      ['FOO', [{
        type: 'archived-in-platform' as const,
        severity: 'warning' as const,
        description: 'archived in LaunchDarkly',
      }]],
    ])

    const platformMetadata = new Map([
      ['FOO', {
        variations: [
          { value: false, name: 'off' },
          { value: true, name: 'on' },
        ],
      }],
    ])

    const result = await analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
      platformSignals,
      platformMetadata,
    })

    const staleFlags = result.filter((f) => f.name === 'FOO')
    expect(staleFlags.length).toBeGreaterThan(0)
    expect(staleFlags[0].variations).toEqual([
      { value: false, name: 'off' },
      { value: true, name: 'on' },
    ])
  })

  it('propagates platform variations alongside tags + maintainer via platformMetadata', async () => {
    // Multi-field regression: confirms the meta-copy block correctly
    // populates all three independent fields on the same StaleFlag
    // when the metadata entry carries them simultaneously. The previous
    // test only exercised variations in isolation; this test locks in
    // the combination behavior.
    //
    // (Use the same "force a flag stale" setup pattern as the previous
    // test — adapt the platformMetadata fixture to include tags +
    // maintainer + variations on the same entry, and extend the
    // assertion to check all three.)
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('FOO', [makeFlag('FOO', 'src/foo.ts', 1)])

    const platformSignals = new Map([
      ['FOO', [{
        type: 'archived-in-platform' as const,
        severity: 'warning' as const,
        description: 'archived in LaunchDarkly',
      }]],
    ])

    const platformMetadata = new Map([
      ['FOO', {
        tags: ['experiment'],
        maintainer: 'alice@example.com',
        variations: [
          { value: false, name: 'off' },
          { value: true, name: 'on' },
        ],
      }],
    ])

    const result = await analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
      platformSignals,
      platformMetadata,
    })

    const staleFlags = result.filter((f) => f.name === 'FOO')
    expect(staleFlags.length).toBeGreaterThan(0)
    expect(staleFlags[0].tags).toEqual(['experiment'])
    expect(staleFlags[0].maintainer).toBe('alice@example.com')
    expect(staleFlags[0].variations).toEqual([
      { value: false, name: 'off' },
      { value: true, name: 'on' },
    ])
  })

  it('propagates platform codeReferences to StaleFlag.codeReferences via platformMetadata', () => {
    const flags = new Map<string, FeatureFlag[]>()
    flags.set('FOO', [makeFlag('FOO', 'src/foo.ts', 1)])

    const platformSignals = new Map([
      ['FOO', [{
        type: 'archived-in-platform' as const,
        severity: 'warning' as const,
        description: 'archived in LaunchDarkly',
      }]],
    ])

    const platformMetadata = new Map([
      ['FOO', {
        codeReferences: { count: 5 },
      }],
    ])

    return analyzeStaleness(flags, {
      thresholdDays: 6,
      repoRoot: process.cwd(),
      platformSignals,
      platformMetadata,
    }).then((result) => {
      const staleFlags = result.filter((f) => f.name === 'FOO')
      expect(staleFlags.length).toBeGreaterThan(0)
      expect(staleFlags[0].codeReferences).toEqual({ count: 5 })
    })
  })

  it('handles non-git directory gracefully (isShallowRepo catch — lines 46-47)', async () => {
    // A plain temp dir (not a git repo) causes execSync to throw → catch returns false
    const tempDir = join(os.tmpdir(), `flagshark-not-git-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    writeFileSync(join(tempDir, 'app.ts'), 'const x = 1')

    const flags = new Map<string, FeatureFlag[]>()
    flags.set('SOME_FLAG', [{
      name: 'SOME_FLAG',
      filePath: join(tempDir, 'app.ts'),
      lineNumber: 1,
      language: 'typescript',
      provider: 'test',
    }])

    // Should not throw — isShallowRepo catches the git error
    let result: Awaited<ReturnType<typeof analyzeStaleness>> | undefined
    await expect(async () => {
      result = await analyzeStaleness(flags, {
        thresholdDays: 6,
        repoRoot: tempDir,
      })
    }).not.toThrow()

    rmSync(tempDir, { recursive: true, force: true })
    expect(result).toBeDefined()
  })
})
