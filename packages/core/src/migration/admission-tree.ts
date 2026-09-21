/**
 * Builds the in-memory tree view the hosted-admission preflight reads.
 *
 * The hosted collector works on a committed tree, so the git index is the
 * closest local analogue: it lists exactly what a push would carry, with the
 * modes that name symlinks and submodules. A directory that is not a git
 * repository, has no git binary, or has nothing tracked yet falls back to a
 * filesystem walk that skips `.git` and `node_modules`.
 *
 * Only the small files the preflight reads are loaded: every `package.json`,
 * npm lockfiles, `tsconfig*.json` and `.nvmrc`, each under the hosted
 * collector's per-blob cap. The scanned source files are merged in so the
 * SDK-surface gate can look at them without a second read.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { HOSTED_ADMISSION_LIMITS } from './hosted-admission.js'

import type { AdmissionTreeEntry, AdmissionTreeView } from './hosted-admission.js'

export interface CollectAdmissionTreeOptions {
  /** Absolute path of the repository root being scanned. */
  root: string
  /** Scanned source files keyed by absolute path, as `collectFiles` returns them. */
  sourceFiles?: ReadonlyMap<string, string>
}

export interface CollectedAdmissionTree extends AdmissionTreeView {
  /** How the tree was enumerated. */
  source: 'git-index' | 'filesystem'
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

/** `git ls-files --stage` over the index; `null` when git is unavailable, the directory is not a repository, or nothing is tracked. */
function listGitIndex(root: string): AdmissionTreeEntry[] | null {
  let output: string
  try {
    output = execFileSync('git', ['ls-files', '-z', '--cached', '--stage'], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
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
    else entries.push({ path, kind: 'file', size: sizeOf(join(root, path)) })
  }
  return entries.length > 0 ? entries : null
}

function walkFilesystem(root: string): AdmissionTreeEntry[] {
  const entries: AdmissionTreeEntry[] = []
  const visit = (dir: string) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIP.has(dirent.name)) continue
      const absolute = join(dir, dirent.name)
      const path = toPosix(relative(root, absolute))
      if (dirent.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink' })
      } else if (dirent.isDirectory()) {
        if (existsSync(join(absolute, '.git'))) {
          entries.push({ path, kind: 'submodule' })
        } else {
          entries.push({ path, kind: 'directory' })
          visit(absolute)
        }
      } else if (dirent.isFile()) {
        entries.push({ path, kind: 'file', size: sizeOf(absolute) })
      }
    }
  }
  visit(root)
  return entries
}

export function collectAdmissionTree(options: CollectAdmissionTreeOptions): CollectedAdmissionTree {
  const { root } = options
  const fromGit = listGitIndex(root)
  const entries = fromGit ?? walkFilesystem(root)
  const files = new Map<string, string>()

  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const cap = readCap(entry.path.slice(entry.path.lastIndexOf('/') + 1))
    if (cap === undefined || entry.size === undefined || entry.size > cap) continue
    try {
      files.set(entry.path, readFileSync(join(root, entry.path), 'utf-8'))
    } catch {
      // A file that vanished between listing and reading is simply not read; its gate reports unknown.
    }
  }

  for (const [absolute, content] of options.sourceFiles ?? []) {
    files.set(toPosix(relative(root, absolute)), content)
  }

  return { entries, files, source: fromGit ? 'git-index' : 'filesystem' }
}
