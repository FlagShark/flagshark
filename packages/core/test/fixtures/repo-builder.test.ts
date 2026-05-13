import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeTempRepo, commitAll, writeFixtureFile } from './repo-builder.js'

const dirsToClean: string[] = []
afterEach(() => {
  for (const d of dirsToClean.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('repo-builder', () => {
  it('makeTempRepo creates a git repo with user config', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    const email = execFileSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf-8' }).trim()
    expect(email).toBe('test@test')
  })

  it('writeFixtureFile creates missing directories and writes content', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'src/nested/deep.ts', 'export const x = 1\n')
    const content = readFileSync(join(dir, 'src/nested/deep.ts'), 'utf-8')
    expect(content).toBe('export const x = 1\n')
  })

  it('commitAll stages and commits everything', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'a.ts', 'export const a = 1\n')
    commitAll(dir, 'init')
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('init')
  })

  it('commitAll honors GIT_*_DATE for staleness control', () => {
    const dir = makeTempRepo()
    dirsToClean.push(dir)
    writeFixtureFile(dir, 'a.ts', 'export const a = 1\n')
    commitAll(dir, 'old', '2024-01-01T00:00:00')
    const date = execFileSync('git', ['log', '-1', '--format=%aI'], { cwd: dir, encoding: 'utf-8' }).trim()
    expect(date.startsWith('2024-01-01')).toBe(true)
  })
})
