/**
 * Lockstep-version assertion — fails CI when packages/{core,cli,action}
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
  dependencies?: Record<string, string>
}

function readPkg(rel: string): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8')) as PackageJson
}

describe('repo-level lockstep version assertion', () => {
  const core = readPkg('packages/core/package.json')
  const cli = readPkg('packages/cli/package.json')
  const action = readPkg('packages/action/package.json')

  it('all three packages have the same version field', () => {
    expect(core.version, '@flagshark/core version').toBe(cli.version)
    expect(cli.version, 'flagshark CLI version').toBe(action.version)
    expect(action.version, '@flagshark/action version').toBe(core.version)
  })

  it('CLI and action declare @flagshark/core via workspace:* (not literal version)', () => {
    // Defends against the v2.1.0–v2.2.0 regression class: a literal
    // pin in dependencies bypasses `bun pm pack`'s rewrite and ships
    // mismatched versions to npm. workspace:* is the only safe form.
    expect(cli.dependencies?.['@flagshark/core'], 'CLI dep on core').toBe('workspace:*')
    expect(action.dependencies?.['@flagshark/core'], 'action dep on core').toBe('workspace:*')
  })

  it('version field is a valid semver string', () => {
    // Sanity check — protects against typos like "2.2.1.dev" or
    // accidental whitespace from sed mistakes.
    const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
    expect(core.version).toMatch(semver)
  })
})
