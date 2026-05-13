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

  it('returns default config for a file that parses to null (lines 47-48)', async () => {
    // YAML `~` or empty file parses to null — hits the `parsed == null` branch
    writeFileSync(join(workDir, '.flagshark.yml'), '~\n')
    const result = await loadConfigFile(workDir)
    expect(result).not.toBeNull()
    expect(result?.config).toBeDefined()
    // Should use default schema (no threshold override)
    expect(result?.config.threshold).toBe(6)
  })

  it('returns default config for a file that parses to a non-object scalar', async () => {
    // YAML `42` parses to a number — not an object, hits the `typeof parsed !== 'object'` branch
    writeFileSync(join(workDir, '.flagshark.yml'), '42\n')
    const result = await loadConfigFile(workDir)
    expect(result).not.toBeNull()
    expect(result?.config).toBeDefined()
  })
})
