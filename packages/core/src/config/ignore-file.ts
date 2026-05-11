import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface LoadedIgnore {
  patterns: string[]
  path: string
}

export async function loadIgnoreFile(startDir: string): Promise<LoadedIgnore | null> {
  const home = homedir()
  let dir = resolve(startDir)

  for (;;) {
    const candidate = join(dir, '.flagsharkignore')
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf-8')
      const patterns = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
      return { patterns, path: candidate }
    }
    const parent = dirname(dir)
    if (parent === dir || dir === home || dir === '/') return null
    dir = parent
  }
}
