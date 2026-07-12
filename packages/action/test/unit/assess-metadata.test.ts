import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('migration assessment Action metadata', () => {
  const root = resolve(import.meta.dirname, '..', '..', '..', '..')
  const metadata = readFileSync(resolve(root, 'assess/action.yml'), 'utf8')
  const documentation = readFileSync(resolve(root, 'assess/README.md'), 'utf8')
  const actionPackage = JSON.parse(
    readFileSync(resolve(root, 'packages/action/package.json'), 'utf8'),
  ) as {
    version: string
  }

  it('defines a separate node24 Action and its safe report outputs', () => {
    expect(metadata).toMatch(/using:\s*["']?node24["']?/u)
    expect(metadata).toMatch(/main:\s*["']?dist\/index\.cjs["']?/u)
    expect(metadata).toMatch(
      /api-url:[\s\S]*?default:\s*["']?https:\/\/api\.flagshark\.com\/api["']?/u,
    )
    expect(metadata).toMatch(
      /oidc-audience:[\s\S]*?default:\s*["']?https:\/\/api\.flagshark\.com["']?/u,
    )
    expect(metadata).toContain('assessment-id:')
    expect(metadata).toContain('status-url:')
    expect(metadata).toContain('markdown-report-path:')
    expect(metadata).toContain('json-report-path:')
    expect(metadata).toContain('include-report-in-job-summary:')
    expect(metadata).toMatch(/default:\s*["']?false["']?/u)
    expect(metadata).not.toContain('github-token')
  })

  it('documents minimal OIDC permissions, App acquisition, and explicit artifact upload', () => {
    expect(documentation).toContain('id-token: write')
    expect(documentation).toContain('not need `actions/checkout` or `contents: read`')
    expect(documentation).toContain('install the FlagShark GitHub App')
    expect(documentation).toContain('connect the LaunchDarkly project')
    expect(documentation).toContain('defaults to `https://api.flagshark.com/api`')
    expect(documentation).toContain('`https://api.flagshark.com`')
    expect(documentation).not.toContain('uses: actions/checkout')
    expect(documentation).toContain('actions/upload-artifact@v4')
    expect(documentation).toContain('retention-days: 1')
    expect(documentation).toContain('available to everyone with read access')
    expect(documentation).toContain('FlagShark/flagshark/assess@v2')
    expect(documentation).toContain('never pass `GITHUB_TOKEN`')
    expect(documentation).toContain('disabled by default')
    expect(documentation).toContain('invite-only onboarding')
    expect(documentation).toContain('joe@flagshark.com')
  })

  it('keeps private analysis code outside the public Action dependency boundary', () => {
    const clientPackage = JSON.parse(
      readFileSync(resolve(root, 'packages/assessment-client/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(clientPackage.dependencies ?? {}).not.toHaveProperty('@flagshark/core')

    const bundle = readFileSync(resolve(root, 'assess/dist/index.cjs'), 'utf8')
    expect(bundle).toContain(JSON.stringify(actionPackage.version))
    for (const privateEngineIdentifier of [
      'assessMigrationFromSources',
      'buildMigrationAssessmentReport',
      'classifyLaunchDarklyFlagConfig',
      'launchdarkly-typescript-analyzer',
      '@flagshark/core',
      'tree-sitter',
    ]) {
      expect(bundle).not.toContain(privateEngineIdentifier)
    }
  })
})
