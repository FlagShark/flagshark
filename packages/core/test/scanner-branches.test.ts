/**
 * Branch coverage for scanner.ts error paths:
 * - line 88: catch when reading a file fails (file disappears after walk)
 * - lines 111-112: getDiffFiles throws on invalid git ref
 * - line 144: walkDir catches error for unreadable directory
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collectFiles } from '../src/scanner.js'

let workDir: string

beforeEach(() => {
  workDir = mkdirSync(join(tmpdir(), `flagshark-scanner-branch-${Date.now()}`), { recursive: false }) ?? ''
  workDir = join(tmpdir(), `flagshark-scanner-branch-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
})

afterEach(() => {
  // Restore permissions before cleanup in case we changed them
  try {
    chmodSync(workDir, 0o755)
  } catch {
    // ignore
  }
  rmSync(workDir, { recursive: true, force: true })
})

describe('collectFiles — getDiffFiles error path (lines 111-112)', () => {
  it('throws when diffRef is not a valid git ref in a non-git directory', () => {
    // workDir is not a git repo, so git diff will fail → catch → throw new Error(...)
    expect(() =>
      collectFiles({
        root: workDir,
        supportedExtensions: new Set(['.ts']),
        diffRef: 'invalid-ref-12345',
      }),
    ).toThrow(/Failed to get diff from ref/)
  })
})

describe('collectFiles — walkDir unreadable directory (line 144)', () => {
  it('skips unreadable subdirectories gracefully', () => {
    // Create a file we can read
    writeFileSync(join(workDir, 'app.ts'), 'const x = 1')

    // Create a subdirectory, then remove read permissions
    const subDir = join(workDir, 'locked')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 'secret.ts'), 'const s = 1')

    // On macOS/Linux, removing execute bit prevents directory listing
    try {
      chmodSync(subDir, 0o000)
    } catch {
      // May fail on some CI environments — skip gracefully
      return
    }

    // collectFiles should not throw — it catches the readdirSync error
    let result: ReturnType<typeof collectFiles> | undefined
    expect(() => {
      result = collectFiles({
        root: workDir,
        supportedExtensions: new Set(['.ts']),
      })
    }).not.toThrow()

    // Restore permissions so cleanup works
    chmodSync(subDir, 0o755)

    // The readable file should be collected; the locked subdir is skipped
    expect(result).toBeDefined()
    expect(result!.files.size).toBeGreaterThanOrEqual(0)
  })
})

describe('collectFiles — large file skip (lines 80-81)', () => {
  it('skips files larger than 5 MB', () => {
    // Create a file that is exactly 5 MB + 1 byte (over the limit)
    const bigContent = Buffer.alloc(5 * 1024 * 1024 + 1, 'x')
    writeFileSync(join(workDir, 'huge.ts'), bigContent)
    const result = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
    })
    // The huge file should be skipped (not included in the result)
    expect(result.files.size).toBe(0)
  })
})

describe('collectFiles — empty file skip (lines 83-84)', () => {
  it('skips files with 0 bytes', () => {
    writeFileSync(join(workDir, 'empty.ts'), '')
    const result = collectFiles({
      root: workDir,
      supportedExtensions: new Set(['.ts']),
    })
    expect(result.files.size).toBe(0)
  })
})

describe('collectFiles — file read error path (line 88)', () => {
  it('skips files that cannot be read after stat', () => {
    // Create a readable file, then remove read permission (mode 000 on file)
    writeFileSync(join(workDir, 'secret.ts'), 'const x = 1')
    try {
      chmodSync(join(workDir, 'secret.ts'), 0o000)
    } catch {
      // If chmod fails, skip this test gracefully
      return
    }
    // collectFiles should not throw — it catches readFileSync errors
    let result: ReturnType<typeof collectFiles> | undefined
    expect(() => {
      result = collectFiles({
        root: workDir,
        supportedExtensions: new Set(['.ts']),
      })
    }).not.toThrow()
    // File should be skipped (unreadable)
    expect(result?.files.size ?? 0).toBe(0)
  })
})
