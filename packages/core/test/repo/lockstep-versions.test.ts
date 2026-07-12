/**
 * Lockstep-version assertion — fails CI when versioned workspace packages
 * have different `version` fields in their package.json.
 *
 * Why this exists: the release process bumps each package's version
 * manually, and our CLI / action both ship tarballs that depend on
 * @flagshark/core (resolved via `workspace:*` at pack time). If any
 * one package's version field drifts from the others, the release
 * goes out with mismatched versions in the published artifacts:
 *
 *   - User installs `flagshark@2.3.0`
 *   - flagshark@2.3.0 was built when CLI's package.json said 2.3.0
 *     but core's still said 2.2.1
 *   - bun pm pack rewrites @flagshark/core to "2.2.1" in the tarball
 *     (the workspace version at pack time)
 *   - User gets the new CLI bundle with OLD core at runtime
 *
 * This is exactly the v2.1.0 / v2.1.1 / v2.2.0 bug from earlier
 * today, but the workspace:* mechanism (PR #27) catches the LITERAL
 * pin variant. This test catches the VERSION-FIELD-DRIFT variant.
 *
 * Lives in core's test suite because core's vitest already runs in
 * every CI invocation. The check is repo-level — could equally live
 * elsewhere — but core's the natural home for "verifying the package
 * graph is sane".
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

interface PackageJson {
  name: string
  version: string
  private?: boolean
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPkg(rel: string): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8')) as PackageJson
}

describe('repo-level lockstep version assertion', () => {
  const core = readPkg('packages/core/package.json')
  const assessmentClient = readPkg('packages/assessment-client/package.json')
  const cli = readPkg('packages/cli/package.json')
  const action = readPkg('packages/action/package.json')

  it('all versioned workspace packages have the same version field', () => {
    expect(core.version, '@flagshark/core version').toBe(assessmentClient.version)
    expect(assessmentClient.version, '@flagshark/assessment-client version').toBe(cli.version)
    expect(core.version, '@flagshark/core version').toBe(cli.version)
    expect(cli.version, 'flagshark CLI version').toBe(action.version)
    expect(action.version, '@flagshark/action version').toBe(core.version)
  })

  it('CLI and action declare shared runtime packages via workspace:* (not literal versions)', () => {
    // Defends against the v2.1.0–v2.2.0 regression class: a literal
    // pin in dependencies bypasses `bun pm pack`'s rewrite and ships
    // mismatched versions to npm. workspace:* is the only safe form.
    expect(cli.dependencies?.['@flagshark/core'], 'CLI dep on core').toBe('workspace:*')
    expect(action.dependencies?.['@flagshark/core'], 'action dep on core').toBe('workspace:*')
    expect(
      action.dependencies?.['@flagshark/assessment-client'],
      'action dep on assessment client',
    ).toBe('workspace:*')
  })

  it('bundles the internal assessment client into public artifacts instead of publishing it', () => {
    expect(assessmentClient.private, 'assessment client is an internal workspace package').toBe(true)
    expect(cli.dependencies, 'CLI runtime dependencies').not.toHaveProperty(
      '@flagshark/assessment-client',
    )
    expect(cli.devDependencies?.['@flagshark/assessment-client'], 'CLI build dependency').toBe(
      'workspace:*',
    )
    expect(cli.scripts?.build, 'CLI build bundles the assessment client').not.toContain(
      '--external:@flagshark/assessment-client',
    )
  })

  it('version field is a valid semver string', () => {
    // Sanity check — protects against typos like "2.2.1.dev" or
    // accidental whitespace from sed mistakes.
    const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
    expect(core.version).toMatch(semver)
  })

  it('bun.lock workspaces section reports the same version as package.json', () => {
    // The publish bug class that v2.3.1 hit: `bun install` against an
    // existing lockfile treats a workspace package.json version bump as
    // a no-op and leaves the lockfile's workspaces section pinned to the
    // OLD version. `bun pm pack` then rewrites `workspace:*` using the
    // stale stored version, so flagshark@2.3.1 shipped depending on
    // @flagshark/core@2.2.1 — the new SDK detection + token preflight
    // never reached users. scripts/bump-version.sh now deletes the
    // lockfile before reinstalling; this test enforces the invariant.
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf-8')
    // bun.lock isn't strict JSON (it has trailing commas + comments) so
    // a string-window regex over the workspace entry is the cheap parse.
    // Capture the version field within the @flagshark/core workspace
    // block — match the workspace path key to anchor.
    const coreBlock = lock.match(
      /"packages\/core":\s*\{[^}]*"name":\s*"@flagshark\/core"[^}]*"version":\s*"([^"]+)"/,
    )
    expect(coreBlock, 'bun.lock has @flagshark/core workspace entry').not.toBeNull()
    expect(coreBlock![1], 'bun.lock workspaces[@flagshark/core].version').toBe(core.version)
    const assessmentClientBlock = lock.match(
      /"packages\/assessment-client":\s*\{[^}]*"name":\s*"@flagshark\/assessment-client"[^}]*"version":\s*"([^"]+)"/,
    )
    expect(
      assessmentClientBlock,
      'bun.lock has @flagshark/assessment-client workspace entry',
    ).not.toBeNull()
    expect(
      assessmentClientBlock![1],
      'bun.lock workspaces[@flagshark/assessment-client].version',
    ).toBe(assessmentClient.version)
  })
})
