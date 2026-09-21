/**
 * A failure inside the hosted-admission tree collector must never fail the
 * scan: the report still comes out, and every locally checkable gate is
 * reported as unknown. The collector is mocked at the module boundary because
 * nothing on disk makes it throw without also breaking the scan itself.
 */
import { describe, it, expect, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { scanRepo } from '../src/scan-repo.js'
import { makeTempRepo } from './fixtures/repo-builder.js'

vi.mock('../src/migration/admission-tree.js', () => ({
  collectAdmissionTree: vi.fn(() => {
    throw new Error('EACCES: permission denied, scandir')
  }),
}))

describe('scanRepo — hosted-admission preflight failure', () => {
  it('still returns the full report and reports every local gate as unknown', async () => {
    const dir = makeTempRepo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'svc', dependencies: { '@launchdarkly/node-server-sdk': '^9.11.0' } }))
    const body =
      `import { init } from '@launchdarkly/node-server-sdk'\n` +
      `const client = init('k')\n` +
      `export const f = () => client.boolVariation('checkout-v2', ctx, false)\n`
    writeFileSync(join(dir, 'src', 'a.ts'), body)
    writeFileSync(join(dir, 'src', 'b.ts'), body)
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
    const warnings: unknown[][] = []

    const result = await scanRepo({ cwd: dir, noConfig: true, noIgnoreFile: true, logger: { debug: () => {}, info: () => {}, warn: (...a) => { warnings.push(a) }, error: () => {} } })

    expect(result.totalFlags).toBe(1)
    const lockIn = result.lockIn!
    expect(lockIn.providers[0].classification).toBe('draft-pr')
    expect(lockIn.hostedAdmission).toHaveLength(1)
    const { preflight } = lockIn.hostedAdmission[0]
    expect(preflight.gates.some((g) => g.status === 'refuse')).toBe(false)
    expect(preflight.gates.some((g) => g.status === 'pass')).toBe(false)
    expect(preflight.gates[0].detail).toContain('tree enumeration incomplete (tree could not be read: EACCES: permission denied, scandir)')
    expect(warnings[0][0]).toBe('Hosted-admission preflight could not read the tree; every local gate is reported as unknown')

    // The thrown value need not be an Error.
    const { collectAdmissionTree } = await import('../src/migration/admission-tree.js')
    vi.mocked(collectAdmissionTree).mockImplementationOnce(() => {
      throw 'plain string'
    })
    const again = await scanRepo({ cwd: dir, noConfig: true, noIgnoreFile: true })
    expect(again.lockIn!.hostedAdmission[0].preflight.gates[0].detail).toContain('tree could not be read: plain string')
  })
})
