#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSIONED_PACKAGES = [
  'packages/core/package.json',
  'packages/assessment-client/package.json',
  'packages/cli/package.json',
  'packages/action/package.json',
]
const STABLE_V2_TAG = /^v(2)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

function git(arguments_, cwd, options = {}) {
  return execFileSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function packageVersions(cwd) {
  return VERSIONED_PACKAGES.map((path) => {
    const parsed = JSON.parse(readFileSync(resolve(cwd, path), 'utf8'))
    if (
      !parsed ||
      typeof parsed.version !== 'string' ||
      parsed.version.length === 0
    ) {
      throw new Error(`${path} does not contain a valid version`)
    }
    return { path, version: parsed.version }
  })
}

export function verifyReleaseTag(releaseTag, cwd = process.cwd()) {
  if (!releaseTag) throw new Error('RELEASE_TAG is required')
  const versions = packageVersions(cwd)
  const expectedVersion = versions[0].version
  for (const { path, version } of versions.slice(1)) {
    if (version !== expectedVersion) {
      throw new Error(
        `Versioned packages are not in lockstep: ${path} is ${version}, expected ${expectedVersion}`,
      )
    }
  }
  const expectedTag = `v${expectedVersion}`
  if (releaseTag !== expectedTag) {
    throw new Error(
      `Release tag ${releaseTag} does not match package version ${expectedTag}`,
    )
  }
  return expectedVersion
}

function parseStableV2Tag(tag) {
  const match = STABLE_V2_TAG.exec(tag)
  if (!match) return undefined
  return {
    tag,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
  }
}

function compareVersions(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return 0
}

function remoteTags(cwd) {
  const output = git(['ls-remote', '--tags', '--refs', 'origin'], cwd)
  if (!output) return new Map()
  return new Map(
    output.split('\n').map((line) => {
      const [objectId, ref] = line.trim().split(/\s+/u)
      return [ref.replace(/^refs\/tags\//u, ''), objectId]
    }),
  )
}

function highestStableV2Tag(tags) {
  const stable = [...tags.keys()].map(parseStableV2Tag).filter(Boolean)
  stable.sort(compareVersions)
  return stable.at(-1)?.tag
}

export function promoteStableV2Tag(releaseTag, cwd = process.cwd()) {
  verifyReleaseTag(releaseTag, cwd)
  if (!parseStableV2Tag(releaseTag)) {
    throw new Error(
      `Refusing to promote non-stable v2 release tag: ${releaseTag}`,
    )
  }

  git(
    [
      'fetch',
      '--force',
      'origin',
      `refs/tags/${releaseTag}:refs/tags/${releaseTag}`,
    ],
    cwd,
  )
  const releaseCommit = git(['rev-list', '-n', '1', releaseTag], cwd)
  if (!/^[a-f0-9]{40,64}$/u.test(releaseCommit)) {
    throw new Error(`Could not resolve release commit for ${releaseTag}`)
  }
  const checkedOutCommit = git(['rev-parse', 'HEAD'], cwd)
  if (releaseCommit !== checkedOutCommit) {
    throw new Error(
      `Release tag ${releaseTag} moved after checkout; refusing to promote an unverified commit`,
    )
  }

  let lastPushError = ''
  // A lease failure means another release changed v2 between our read and
  // write. Re-read the remote: an older run then yields to the new highest
  // version, while the highest run retries against the new exact object ID.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const tags = remoteTags(cwd)
    if (!tags.has(releaseTag)) {
      throw new Error(`Release tag is not present on origin: ${releaseTag}`)
    }
    const highest = highestStableV2Tag(tags)
    if (highest !== releaseTag) {
      process.stdout.write(
        `Not moving v2: ${releaseTag} has already been superseded by ${highest ?? 'another release'}.\n`,
      )
      return { promoted: false, highest }
    }

    const expectedCurrent = tags.get('v2') ?? ''
    const push = spawnSync(
      'git',
      [
        'push',
        `--force-with-lease=refs/tags/v2:${expectedCurrent}`,
        'origin',
        `${releaseCommit}:refs/tags/v2`,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (push.error) throw push.error
    if (push.status === 0) {
      process.stdout.write(`Promoted v2 to ${releaseTag} (${releaseCommit}).\n`)
      return { promoted: true, highest: releaseTag }
    }
    lastPushError = push.stderr.trim()
  }
  throw new Error(
    `Atomic v2 promotion failed after five guarded attempts. ${lastPushError}`,
  )
}

function main() {
  const command = process.argv[2]
  const releaseTag = process.env.RELEASE_TAG ?? ''
  try {
    if (command === 'verify-tag') {
      const version = verifyReleaseTag(releaseTag)
      process.stdout.write(
        `Release tag ${releaseTag} matches all packages at ${version}.\n`,
      )
    } else if (command === 'promote-v2') {
      promoteStableV2Tag(releaseTag)
    } else {
      throw new Error('Usage: release-guards.mjs <verify-tag|promote-v2>')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Release guard failed: ${message}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) main()
