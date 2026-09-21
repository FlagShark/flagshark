import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectAdmissionTree } from '../../src/migration/admission-tree.js'
import { makeTempRepo, writeFixtureFile, commitAll } from '../fixtures/repo-builder.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repo(): string {
  const dir = makeTempRepo()
  dirs.push(dir)
  return dir
}

function plainDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flagshark-admission-'))
  dirs.push(dir)
  return dir
}

describe('collectAdmissionTree — git index', () => {
  it('lists the index with symlink and submodule modes, sizes files, and reads only the preflight inputs', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{"name":"svc"}')
    writeFixtureFile(dir, 'package-lock.json', '{"lockfileVersion":3}')
    writeFixtureFile(dir, 'tsconfig.json', '{}')
    writeFixtureFile(dir, 'tsconfig.build.json', '{}')
    writeFixtureFile(dir, '.nvmrc', '22\n')
    writeFixtureFile(dir, 'src/app.ts', 'export {}')
    writeFixtureFile(dir, 'docs/notes.md', '# notes')
    symlinkSync('package.json', join(dir, 'link.json'))
    commitAll(dir, 'init')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`], { cwd: dir })
    // Untracked files are not part of what a push would carry.
    writeFileSync(join(dir, 'untracked.ts'), 'x')

    const view = collectAdmissionTree({ root: dir })
    expect(view.source).toBe('git-index')
    expect(view.enumeratedRoot).toBe(realpathSync(dir))
    expect(view.scope).toBe('')
    expect(view.incomplete).toBeUndefined()
    const byPath = new Map(view.entries.map((e) => [e.path, e]))
    expect(byPath.get('link.json')).toEqual({ path: 'link.json', kind: 'symlink' })
    expect(byPath.get('vendor/sub')).toEqual({ path: 'vendor/sub', kind: 'submodule' })
    expect(byPath.get('src/app.ts')).toEqual({ path: 'src/app.ts', kind: 'file', size: 9 })
    expect(byPath.has('untracked.ts')).toBe(false)
    expect([...view.files.keys()].sort()).toEqual(['.nvmrc', 'package-lock.json', 'package.json', 'tsconfig.build.json', 'tsconfig.json'])
    expect(view.files.get('package.json')).toBe('{"name":"svc"}')
  })

  it('leaves the size unset for an indexed file missing from the working tree and skips reading it', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{}')
    writeFixtureFile(dir, 'a.ts', 'x')
    commitAll(dir, 'init')
    rmSync(join(dir, 'package.json'))

    const view = collectAdmissionTree({ root: dir })
    expect(view.entries.find((e) => e.path === 'package.json')).toEqual({ path: 'package.json', kind: 'file' })
    expect(view.files.has('package.json')).toBe(false)
  })

  it('tolerates a read failure for an indexed path that is no longer a regular file', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{}')
    commitAll(dir, 'init')
    rmSync(join(dir, 'package.json'))
    mkdirSync(join(dir, 'package.json'))

    const view = collectAdmissionTree({ root: dir })
    expect(view.entries).toHaveLength(1)
    expect(view.files.size).toBe(0)
  })

  it('skips a preflight input over the hosted per-blob cap but reads a lockfile under its larger cap', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{}')
    writeFixtureFile(dir, 'tsconfig.json', '{'.padEnd(1024 * 1024 + 1, ' '))
    writeFixtureFile(dir, 'package-lock.json', '{'.padEnd(1024 * 1024 + 1, ' '))
    commitAll(dir, 'init')

    const view = collectAdmissionTree({ root: dir })
    expect(view.files.has('tsconfig.json')).toBe(false)
    expect(view.files.has('package-lock.json')).toBe(true)
  })

  it('merges scanned source files under repository-relative posix keys', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{}')
    writeFixtureFile(dir, 'src/flags.ts', 'sdk')
    commitAll(dir, 'init')

    const view = collectAdmissionTree({ root: dir, sourceFiles: new Map([[join(dir, 'src', 'flags.ts'), 'sdk']]) })
    expect(view.files.get('src/flags.ts')).toBe('sdk')
  })

  it('enumerates from the git toplevel when scanning a package inside a monorepo, scoping the sources', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{"workspaces":["packages/*"],"packageManager":"yarn@4.18.0"}')
    writeFixtureFile(dir, 'yarn.lock', '')
    writeFixtureFile(dir, 'packages/svc/package.json', '{"name":"svc"}')
    writeFixtureFile(dir, 'packages/svc/src/flags.ts', 'sdk')
    commitAll(dir, 'init')
    const scanDir = join(dir, 'packages', 'svc')

    const view = collectAdmissionTree({ root: scanDir, sourceFiles: new Map([[join(scanDir, 'src', 'flags.ts'), 'sdk']]) })
    expect(view.source).toBe('git-index')
    expect(view.enumeratedRoot).toBe(realpathSync(dir))
    expect(view.scope).toBe('packages/svc')
    expect(view.entries.map((e) => e.path).sort()).toEqual(['package.json', 'packages/svc/package.json', 'packages/svc/src/flags.ts', 'yarn.lock'])
    expect(view.files.get('package.json')).toContain('workspaces')
    expect(view.files.get('packages/svc/src/flags.ts')).toBe('sdk')
  })

  it('passes merge-conflict stages through as listed (the preflight collapses them)', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{}')
    commitAll(dir, 'init')
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'ours', encoding: 'utf-8' }).trim()
    execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: `100644 ${sha} 2\tconflict.ts\n100644 ${sha} 3\tconflict.ts\n` })

    const view = collectAdmissionTree({ root: dir })
    expect(view.entries.filter((e) => e.path === 'conflict.ts')).toHaveLength(2)
  })

  it('falls back to the filesystem when the repository has nothing tracked yet', () => {
    const dir = repo()
    writeFixtureFile(dir, 'package.json', '{}')
    const view = collectAdmissionTree({ root: dir })
    expect(view.source).toBe('filesystem')
    expect(view.entries.map((e) => e.path)).toEqual(['package.json'])
  })
})

describe('collectAdmissionTree — filesystem fallback', () => {
  it('walks a non-git directory, skipping .git and node_modules, naming symlinks, directories and nested repositories', () => {
    const dir = plainDir()
    writeFixtureFile(dir, 'package.json', '{"name":"svc"}')
    writeFixtureFile(dir, 'src/app.ts', 'export {}')
    writeFixtureFile(dir, 'node_modules/dep/index.js', 'x')
    writeFixtureFile(dir, 'vendor/lib/.git', 'gitdir: ../../.git/modules/lib')
    writeFixtureFile(dir, 'vendor/lib/index.js', 'x')
    symlinkSync('src', join(dir, 'src-link'))

    const view = collectAdmissionTree({ root: dir })
    expect(view.source).toBe('filesystem')
    expect([...view.entries].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'package.json', kind: 'file', size: 14 },
      { path: 'src', kind: 'directory' },
      { path: 'src-link', kind: 'symlink' },
      { path: 'src/app.ts', kind: 'file', size: 9 },
      { path: 'vendor', kind: 'directory' },
      { path: 'vendor/lib', kind: 'submodule' },
    ])
    expect(view.files.get('package.json')).toBe('{"name":"svc"}')
    expect(view.enumeratedRoot).toBe(dir)
    expect(view.scope).toBe('')
    expect(view.incomplete).toBeUndefined()
  })

  // Root can read anything, so the unreadable-directory case is only observable as a normal user.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'marks the view incomplete instead of throwing when a subdirectory cannot be listed',
    () => {
      const dir = plainDir()
      writeFixtureFile(dir, 'package.json', '{"name":"svc"}')
      writeFixtureFile(dir, 'private/secret.txt', 'x')
      writeFixtureFile(dir, 'src/flags.ts', 'sdk')
      chmodSync(join(dir, 'private'), 0o000)
      try {
        const view = collectAdmissionTree({ root: dir })
        expect(view.incomplete).toBe('unreadable directory: private')
        expect(view.entries.map((e) => e.path).sort()).toEqual(['package.json', 'private', 'src', 'src/flags.ts'])
        // Several unreadable directories are all named.
        chmodSync(join(dir, 'src'), 0o000)
        expect(collectAdmissionTree({ root: dir }).incomplete).toBe('unreadable directories: private, src')
      } finally {
        chmodSync(join(dir, 'private'), 0o755)
        chmodSync(join(dir, 'src'), 0o755)
      }

      // The scan directory itself being unreadable names `.` and yields no entries.
      const sealed = plainDir()
      chmodSync(sealed, 0o000)
      try {
        const view = collectAdmissionTree({ root: sealed })
        expect(view).toMatchObject({ entries: [], incomplete: 'unreadable directory: .', source: 'filesystem' })
      } finally {
        chmodSync(sealed, 0o755)
      }
    },
  )
})
