/**
 * Builds the in-memory tree view the hosted-admission preflight reads.
 *
 * The hosted planner reads the whole repository, so the view is enumerated
 * from the git toplevel (`git rev-parse --show-toplevel`), not from the scan
 * directory: a workspace package scanned from its own folder still sees the
 * root manifest, its `workspaces` and the yarn/pnpm markers the planner would
 * refuse on. The index is the closest local analogue of the committed tree: it
 * lists exactly what a push would carry, with the modes that name symlinks and
 * submodules. A directory that is not a git repository, has no git binary, or
 * has nothing tracked yet falls back to a filesystem walk of the scan
 * directory that skips `.git` and `node_modules`; an unreadable subdirectory
 * marks the view incomplete instead of aborting the scan.
 *
 * Only the small files the preflight reads are loaded: every `package.json`,
 * npm lockfiles, `tsconfig*.json` and `.nvmrc`, each under the hosted
 * collector's per-blob cap. The scanned source files are merged in, keyed
 * relative to the enumerated root, so the SDK-surface gate can look at them
 * without a second read.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { HOSTED_ADMISSION_LIMITS } from './hosted-admission.js'

import type { Dirent } from 'node:fs'
import type { AdmissionTreeEntry, AdmissionTreeView } from './hosted-admission.js'

export interface CollectAdmissionTreeOptions {
  /** Absolute path of the directory being scanned. */
  root: string
  /** Scanned source files keyed by absolute path, as `collectFiles` returns them. */
  sourceFiles?: ReadonlyMap<string, string>
}

export interface CollectedAdmissionTree extends AdmissionTreeView {
  /** How the tree was enumerated. */
  source: 'git-index' | 'filesystem'
  /** Absolute path the entries are relative to: the git toplevel, or the scan directory outside git. */
  enumeratedRoot: string
  /** The scan directory relative to `enumeratedRoot` (`''` when they coincide). */
  scope: string
}

const NPM_LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json)$/u
const WALK_SKIP = new Set(['.git', 'node_modules'])

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Files the preflight reads by content, with the hosted per-blob cap that applies to each. */
function readCap(base: string): number | undefined {
  if (NPM_LOCKFILE.test(base)) return HOSTED_ADMISSION_LIMITS.maxNpmLockfileBytes
  if (base === 'package.json' || base === '.nvmrc' || /^tsconfig(?:\.[^/]+)?\.json$/u.test(base)) {
    return HOSTED_ADMISSION_LIMITS.maxBlobBytes
  }
  return undefined
}

function sizeOf(absolute: string): number | undefined {
  try {
    return lstatSync(absolute).size
  } catch {
    return undefined
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

interface GitIndex {
  toplevel: string
  entries: AdmissionTreeEntry[]
}

/**
 * `git ls-files --stage` over the whole repository's index; `null` when git is
 * unavailable, the directory is not a repository, or nothing is tracked.
 * Merge-conflict stages list one path several times; the preflight collapses
 * duplicates, so they are passed through as listed.
 */
function listGitIndex(root: string): GitIndex | null {
  let toplevel: string
  let output: string
  try {
    toplevel = git(['rev-parse', '--show-toplevel'], root).trim()
    output = git(['ls-files', '-z', '--cached', '--stage'], toplevel)
  } catch {
    return null
  }
  const entries: AdmissionTreeEntry[] = []
  for (const record of output.split('\0')) {
    if (record.length === 0) continue
    const tab = record.indexOf('\t')
    const mode = record.slice(0, 6)
    const path = record.slice(tab + 1)
    if (mode === '120000') entries.push({ path, kind: 'symlink' })
    else if (mode === '160000') entries.push({ path, kind: 'submodule' })
    else entries.push({ path, kind: 'file', size: sizeOf(join(toplevel, path)) })
  }
  return entries.length > 0 ? { toplevel, entries } : null
}

interface Walk {
  entries: AdmissionTreeEntry[]
  /** Directories that could not be listed; the view is incomplete when non-empty. */
  unreadable: string[]
}

function walkFilesystem(root: string): Walk {
  const walk: Walk = { entries: [], unreadable: [] }
  const visit = (dir: string) => {
    let dirents: Dirent[]
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      walk.unreadable.push(toPosix(relative(root, dir)) || '.')
      return
    }
    for (const dirent of dirents) {
      if (WALK_SKIP.has(dirent.name)) continue
      const absolute = join(dir, dirent.name)
      const path = toPosix(relative(root, absolute))
      if (dirent.isSymbolicLink()) {
        walk.entries.push({ path, kind: 'symlink' })
      } else if (dirent.isDirectory()) {
        if (existsSync(join(absolute, '.git'))) {
          walk.entries.push({ path, kind: 'submodule' })
        } else {
          walk.entries.push({ path, kind: 'directory' })
          visit(absolute)
        }
      } else if (dirent.isFile()) {
        walk.entries.push({ path, kind: 'file', size: sizeOf(absolute) })
      }
    }
  }
  visit(root)
  return walk
}

export function collectAdmissionTree(options: CollectAdmissionTreeOptions): CollectedAdmissionTree {
  const { root } = options
  const fromGit = listGitIndex(root)
  const enumeratedRoot = fromGit ? fromGit.toplevel : root
  const walk = fromGit ? undefined : walkFilesystem(root)
  const entries = fromGit ? fromGit.entries : walk!.entries
  const files = new Map<string, string>()

  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const cap = readCap(entry.path.slice(entry.path.lastIndexOf('/') + 1))
    if (cap === undefined || entry.size === undefined || entry.size > cap) continue
    try {
      files.set(entry.path, readFileSync(join(enumeratedRoot, entry.path), 'utf-8'))
    } catch {
      // A file that vanished between listing and reading is simply not read; its gate reports unknown.
    }
  }

  // Source paths come from the scan directory; git reports the toplevel as a
  // real path, so resolve the scan directory the same way before relating.
  const scope = fromGit ? toPosix(relative(enumeratedRoot, realpathSync(root))) : ''
  for (const [absolute, content] of options.sourceFiles ?? []) {
    const underScan = toPosix(relative(root, absolute))
    files.set(scope.length > 0 ? `${scope}/${underScan}` : underScan, content)
  }

  const unreadable = walk?.unreadable ?? []
  return {
    entries,
    files,
    ...(unreadable.length > 0 ? { incomplete: `unreadable director${unreadable.length === 1 ? 'y' : 'ies'}: ${unreadable.slice(0, 3).join(', ')}` } : {}),
    source: fromGit ? 'git-index' : 'filesystem',
    enumeratedRoot,
    scope,
  }
}
