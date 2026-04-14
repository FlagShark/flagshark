/**
 * File system scanner that wraps PolyglotAnalyzer.
 *
 * Reads files from disk, filters by supported extensions,
 * and feeds them to the detection engine.
 *
 *   walkDir() → filterFiles() → readFiles() → PolyglotAnalyzer.analyzeFiles()
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  'env',
])

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

export interface ScanOptions {
  root: string
  supportedExtensions: Set<string>
  diffRef?: string // if set, only scan files changed since this ref
}

/**
 * Collects files to scan, reads their contents, and returns a Map<filePath, content>.
 */
export function collectFiles(options: ScanOptions): Map<string, string> {
  const { root, supportedExtensions, diffRef } = options
  const files = new Map<string, string>()

  let filePaths: string[]

  if (diffRef) {
    filePaths = getDiffFiles(diffRef, supportedExtensions)
  } else {
    filePaths = walkDir(root, supportedExtensions)
  }

  for (const fp of filePaths) {
    try {
      const stat = statSync(fp)
      if (stat.size > MAX_FILE_SIZE) {
        continue
      }
      if (stat.size === 0) {
        continue
      }
      files.set(fp, readFileSync(fp, 'utf-8'))
    } catch {
      // Skip unreadable files
    }
  }

  return files
}

/**
 * Get files changed since a git ref.
 */
function getDiffFiles(ref: string, supportedExtensions: Set<string>): string[] {
  try {
    const output = execFileSync('git', ['diff', ref, '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf-8',
      timeout: 30000,
    })
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => supportedExtensions.has(extname(line)))
  } catch {
    throw new Error(`Failed to get diff from ref "${ref}". Is this a git repository?`)
  }
}

/**
 * Recursively walk a directory, returning paths to supported source files.
 */
function walkDir(dir: string, supportedExtensions: Set<string>): string[] {
  const results: string[] = []

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue
      }
      if (entry.name.startsWith('.')) {
        continue
      }

      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, supportedExtensions))
      } else if (entry.isFile()) {
        const ext = extname(entry.name)
        if (supportedExtensions.has(ext)) {
          results.push(fullPath)
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return results
}
