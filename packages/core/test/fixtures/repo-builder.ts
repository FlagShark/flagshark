/**
 * Shared fixture helpers for tests that need a real git repository
 * with controlled commit dates (for staleness scenarios).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Create an empty git repo in a fresh temp directory and return the path. */
export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flagshark-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  return dir
}

/**
 * Write a file inside the fixture repo, creating parent dirs as needed.
 * Path is repo-relative.
 */
export function writeFlagFile(repoDir: string, relPath: string, content: string): void {
  const fullPath = join(repoDir, relPath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content)
}

/**
 * Stage all working-tree changes and commit. If `dateISO` is provided,
 * sets GIT_AUTHOR_DATE and GIT_COMMITTER_DATE so `git blame` sees a
 * deterministic timestamp — required for any staleness-related test.
 */
export function commitAll(repoDir: string, message: string, dateISO?: string): void {
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  const env = dateISO
    ? { ...process.env, GIT_AUTHOR_DATE: dateISO, GIT_COMMITTER_DATE: dateISO }
    : process.env
  execFileSync('git', ['commit', '-qm', message], { cwd: repoDir, env })
}
