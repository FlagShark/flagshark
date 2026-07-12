#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const GENERATED_DIRECTORIES = ['packages/action/dist', 'assess/dist']
const REQUIRED_ENTRYPOINTS = [
  'packages/action/dist/action.cjs',
  'assess/dist/index.cjs',
]

function git(arguments_, cwd, options = {}) {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function listFiles(directory, root) {
  if (!existsSync(directory)) return []
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(root, path).split(sep).join('/'))
      }
    }
  }
  visit(directory)
  return files.sort()
}

export function verifyActionArtifacts(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim()
  const tracked = git(['ls-files', '-z', '--', ...GENERATED_DIRECTORIES], root)
    .split('\0')
    .filter(Boolean)
    .sort()
  const onDisk = GENERATED_DIRECTORIES.flatMap((directory) =>
    listFiles(resolve(root, directory), root),
  ).sort()

  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    if (
      !tracked.includes(entrypoint) ||
      !existsSync(resolve(root, entrypoint))
    ) {
      throw new Error(
        `Required generated Action entrypoint is not committed: ${entrypoint}`,
      )
    }
    if (!lstatSync(resolve(root, entrypoint)).isFile()) {
      throw new Error(
        `Required generated Action entrypoint is not a regular file: ${entrypoint}`,
      )
    }
  }

  const untrackedOutput = onDisk.filter((path) => !tracked.includes(path))
  const missingOutput = tracked.filter((path) => !onDisk.includes(path))
  if (untrackedOutput.length > 0 || missingOutput.length > 0) {
    throw new Error(
      [
        'Generated Action artifact tree does not match the committed file list.',
        ...untrackedOutput.map((path) => `Untracked generated file: ${path}`),
        ...missingOutput.map((path) => `Missing generated file: ${path}`),
      ].join('\n'),
    )
  }

  const diff = spawnSync(
    'git',
    ['diff', '--quiet', 'HEAD', '--', ...GENERATED_DIRECTORIES],
    { cwd: root, stdio: 'ignore' },
  )
  if (diff.error) throw diff.error
  if (diff.status !== 0) {
    throw new Error(
      'Committed Action artifacts differ from a clean build; rebuild and commit the entire generated trees.',
    )
  }
}

function main() {
  try {
    verifyActionArtifacts()
    process.stdout.write(
      'Committed Action artifact trees match the build output.\n',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Action artifact verification failed: ${message}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) main()
