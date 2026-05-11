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
