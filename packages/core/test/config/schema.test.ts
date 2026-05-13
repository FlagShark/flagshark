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

describe('FlagsharkConfigSchema — platforms field', () => {
  it('accepts an empty platforms map', () => {
    const r = FlagsharkConfigSchema.safeParse({ platforms: {} })
    expect(r.success).toBe(true)
  })

  it('accepts a platforms entry with token_env', () => {
    const r = FlagsharkConfigSchema.safeParse({
      platforms: { launchdarkly: { project: 'p', environment: 'e', token_env: 'MY_TOKEN' } },
    })
    expect(r.success).toBe(true)
  })

  it('passes through unknown keys (validated at platform-use time)', () => {
    const r = FlagsharkConfigSchema.safeParse({
      platforms: { launchdarkly: { project: 'p', environment: 'e', custom_field: 'x' } },
    })
    expect(r.success).toBe(true)
  })

  it('rejects platforms as an array (must be record)', () => {
    const r = FlagsharkConfigSchema.safeParse({ platforms: [] })
    expect(r.success).toBe(false)
  })

  it('omits platforms field by default', () => {
    const r = FlagsharkConfigSchema.parse({})
    expect(r.platforms).toBeUndefined()
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
