import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const RELEASE_GUARDS = resolve(REPO_ROOT, 'scripts/release-guards.mjs')
const VERIFY_ARTIFACTS = resolve(
  REPO_ROOT,
  'scripts/verify-action-artifacts.mjs',
)
const directories: string[] = []

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`))
  directories.push(directory)
  return directory
}

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim()
}

function runScript(
  script: string,
  arguments_: string[],
  cwd: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
}

function writeVersions(root: string, version: string): void {
  for (const packageName of ['core', 'assessment-client', 'cli', 'action']) {
    const directory = join(root, 'packages', packageName)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
    )
  }
}

function initializeArtifactRepository(): string {
  const root = temporaryDirectory('flagshark-action-artifacts')
  mkdirSync(join(root, 'packages/action/dist/queries'), { recursive: true })
  mkdirSync(join(root, 'assess/dist'), { recursive: true })
  writeFileSync(join(root, 'packages/action/dist/action.cjs'), 'action\n')
  writeFileSync(
    join(root, 'packages/action/dist/queries/typescript.scm'),
    'query\n',
  )
  writeFileSync(join(root, 'assess/dist/index.cjs'), 'assessment\n')
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.email', 'test@flagshark.com')
  git(root, 'config', 'user.name', 'FlagShark Test')
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'generated action artifacts')
  return root
}

function remoteTagTarget(remote: string, tag: string): string {
  const output = execFileSync(
    'git',
    ['ls-remote', '--tags', '--refs', remote, `refs/tags/${tag}`],
    {
      encoding: 'utf8',
    },
  ).trim()
  return output.split(/\s+/u)[0] ?? ''
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('release tag guards', () => {
  it('wires fail-closed tag, artifact-tree, and atomic promotion guards into workflows', () => {
    const releaseWorkflow = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/release.yml'),
      'utf8',
    )
    const ciWorkflow = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/ci.yml'),
      'utf8',
    )
    const actionBuild = readFileSync(
      resolve(REPO_ROOT, 'packages/action/scripts/build.mjs'),
      'utf8',
    )
    expect(releaseWorkflow).toContain('release-guards.mjs verify-tag')
    expect(
      releaseWorkflow.indexOf('release-guards.mjs verify-tag'),
    ).toBeLessThan(releaseWorkflow.indexOf('npm publish'))
    expect(releaseWorkflow).toContain('verify-action-artifacts.mjs')
    expect(releaseWorkflow).toContain('release-guards.mjs promote-v2')
    expect(releaseWorkflow).not.toContain(
      'git push --force origin refs/tags/v2',
    )
    expect(ciWorkflow).toContain('verify-action-artifacts.mjs')
    expect(actionBuild).toContain('rmSync(distDir, { recursive: true, force: true })')
    expect(actionBuild).toContain('rmSync(assessmentDistDir, { recursive: true, force: true })')
  })

  it('requires the release tag and all versioned packages to agree before publishing', () => {
    const root = temporaryDirectory('flagshark-release-version')
    writeVersions(root, '2.10.0')

    const valid = runScript(RELEASE_GUARDS, ['verify-tag'], root, {
      RELEASE_TAG: 'v2.10.0',
    })
    expect(valid.status).toBe(0)
    expect(valid.stdout).toContain('matches all packages at 2.10.0')

    const linkedGuard = join(root, 'release-guards-link.mjs')
    symlinkSync(RELEASE_GUARDS, linkedGuard)
    const linked = runScript(linkedGuard, ['verify-tag'], root, {
      RELEASE_TAG: 'v2.10.0',
    })
    expect(linked.status).toBe(0)
    expect(linked.stdout).toContain('matches all packages at 2.10.0')

    const mistagged = runScript(RELEASE_GUARDS, ['verify-tag'], root, {
      RELEASE_TAG: 'v2.10.1',
    })
    expect(mistagged.status).toBe(1)
    expect(mistagged.stderr).toContain('does not match package version v2.10.0')

    writeFileSync(
      join(root, 'packages/cli/package.json'),
      `${JSON.stringify({ name: 'cli', version: '2.9.9' })}\n`,
    )
    const divergent = runScript(RELEASE_GUARDS, ['verify-tag'], root, {
      RELEASE_TAG: 'v2.10.0',
    })
    expect(divergent.status).toBe(1)
    expect(divergent.stderr).toContain('Versioned packages are not in lockstep')
  })

  it('never rolls the floating v2 tag back to an older stable release', () => {
    const remote = temporaryDirectory('flagshark-release-remote')
    git(remote, 'init', '--bare', '--quiet')
    const source = temporaryDirectory('flagshark-release-source')
    git(source, 'init', '--quiet')
    git(source, 'config', 'user.email', 'test@flagshark.com')
    git(source, 'config', 'user.name', 'FlagShark Test')

    writeVersions(source, '2.9.9')
    git(source, 'add', '.')
    git(source, 'commit', '--quiet', '-m', 'v2.9.9')
    const olderCommit = git(source, 'rev-parse', 'HEAD')
    git(source, 'tag', 'v2.9.9')
    git(source, 'tag', '--annotate', 'v2', '-m', 'floating v2', olderCommit)

    writeVersions(source, '2.10.0')
    git(source, 'add', '.')
    git(source, 'commit', '--quiet', '-m', 'v2.10.0')
    const latestCommit = git(source, 'rev-parse', 'HEAD')
    git(source, 'tag', 'v2.10.0')
    git(source, 'remote', 'add', 'origin', remote)
    git(source, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main', '--tags')

    const checkout = temporaryDirectory('flagshark-release-checkout')
    git(checkout, 'clone', '--quiet', remote, '.')
    git(checkout, 'checkout', '--quiet', '--detach', 'v2.9.9')
    const superseded = runScript(RELEASE_GUARDS, ['promote-v2'], checkout, {
      RELEASE_TAG: 'v2.9.9',
    })
    expect(superseded.status).toBe(0)
    expect(superseded.stdout).toContain('already been superseded by v2.10.0')

    git(checkout, 'checkout', '--quiet', '--detach', 'v2.10.0')
    git(remote, 'update-ref', 'refs/tags/v2.10.0', olderCommit)
    const movedReleaseTag = runScript(
      RELEASE_GUARDS,
      ['promote-v2'],
      checkout,
      { RELEASE_TAG: 'v2.10.0' },
    )
    expect(movedReleaseTag.status).toBe(1)
    expect(movedReleaseTag.stderr).toContain('moved after checkout')
    git(remote, 'update-ref', 'refs/tags/v2.10.0', latestCommit)

    const hook = join(checkout, '.git/hooks/pre-push')
    writeFileSync(
      hook,
      `#!/usr/bin/env sh\nrm -- "$0"\ngit --git-dir="${remote}" update-ref refs/tags/v2 ${olderCommit}\n`,
    )
    chmodSync(hook, 0o755)
    const promoted = runScript(RELEASE_GUARDS, ['promote-v2'], checkout, {
      RELEASE_TAG: 'v2.10.0',
    })
    expect(promoted.status).toBe(0)
    expect(promoted.stdout).toContain('Promoted v2 to v2.10.0')
    expect(remoteTagTarget(remote, 'v2')).toBe(latestCommit)

    git(checkout, 'checkout', '--quiet', '--detach', 'v2.9.9')
    const lateOlderRun = runScript(RELEASE_GUARDS, ['promote-v2'], checkout, {
      RELEASE_TAG: 'v2.9.9',
    })
    expect(lateOlderRun.status).toBe(0)
    expect(remoteTagTarget(remote, 'v2')).toBe(latestCommit)
    expect(remoteTagTarget(remote, 'v2')).not.toBe(olderCommit)
  })
})

describe('committed Action artifact guard', () => {
  it('accepts a clean, fully tracked generated tree', () => {
    const root = initializeArtifactRepository()
    const linkedVerifier = join(root, 'verify-action-artifacts-link.mjs')
    symlinkSync(VERIFY_ARTIFACTS, linkedVerifier)
    const result = runScript(linkedVerifier, [], root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('artifact trees match')
  })

  it('rejects stale copied query assets that the old CJS-only check missed', () => {
    const root = initializeArtifactRepository()
    writeFileSync(
      join(root, 'packages/action/dist/queries/typescript.scm'),
      'stale query\n',
    )
    const result = runScript(VERIFY_ARTIFACTS, [], root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('differ from a clean build')
  })

  it('rejects untracked build output, including a regenerated deleted entrypoint', () => {
    const extraRoot = initializeArtifactRepository()
    writeFileSync(
      join(extraRoot, 'packages/action/dist/queries/new-language.scm'),
      'new\n',
    )
    const extra = runScript(VERIFY_ARTIFACTS, [], extraRoot)
    expect(extra.status).toBe(1)
    expect(extra.stderr).toContain('Untracked generated file')

    const deletedRoot = initializeArtifactRepository()
    git(deletedRoot, 'rm', '--quiet', 'packages/action/dist/action.cjs')
    writeFileSync(
      join(deletedRoot, 'packages/action/dist/action.cjs'),
      'regenerated\n',
    )
    const deleted = runScript(VERIFY_ARTIFACTS, [], deletedRoot)
    expect(deleted.status).toBe(1)
    expect(deleted.stderr).toContain('entrypoint is not committed')
  })
})
