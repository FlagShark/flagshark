/**
 * End-to-end: `scanRepo` on repositories that reach LaunchDarkly through a
 * wrapper — the shape 13 of the 15 surveyed public repositories use. Covers the
 * flags reported, how they flow into the lock-in summary and the hosted-admission
 * preflight, the detection-coverage metric, and the local-only invariant.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

import { scanRepo } from '../src/scan-repo.js'
import { commitAll, makeTempRepo, writeFixtureFile } from './fixtures/repo-builder.js'

const SDK = '@launchdarkly/node-server-sdk'

/** A manifest the hosted-admission preflight has no reason to refuse. */
const ADMISSIBLE_MANIFEST = JSON.stringify(
  {
    name: 'wrapper-parity-fixture',
    version: '1.0.0',
    private: true,
    packageManager: 'npm@10.9.8',
    scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
    dependencies: { [SDK]: '9.7.0' },
  },
  null,
  2,
)

const LOCKFILE = JSON.stringify({ name: 'wrapper-parity-fixture', lockfileVersion: 3, packages: {} }, null, 2)

/** Every wrapper shape the survey found, in one repository. */
const WRAPPER_SOURCES: Record<string, string> = {
  // 1. plain function wrapper
  'src/featureFlags.ts': `
import * as LaunchDarkly from '${SDK}'
let ldClient: LaunchDarkly.LDClient | null = null
export async function getFlag(flagKey: string, context: LaunchDarkly.LDContext, defaultValue: boolean) {
  return ldClient!.variation(flagKey, context, defaultValue)
}
`,
  // 2. class-method wrapper over a constructor-injected client (Nest-style)
  'src/launchdarkly.service.ts': `
import type { LDClient } from '${SDK}'
export class LaunchDarklyService {
  constructor(private readonly client: LDClient) {}
  async getBooleanValue(key: string, fallback: boolean) {
    return this.client.boolVariation(key, { key: 'anonymous' }, fallback)
  }
}
`,
  // 3. static-class wrapper, 4. singleton wrapper
  'src/toggles.ts': `
import { init } from '${SDK}'
const client = init('sdk-key', { offline: true })
export class Toggles {
  static async on(key: string) {
    return client.boolVariation(key, { key: 'anonymous' }, false)
  }
}
export const toggles = {
  variant(key: string) {
    return client.stringVariation(key, { key: 'anonymous' }, 'off')
  },
}
`,
  'src/keys.ts': `
export const NAV_FLAG = 'new-nav'
export const GROUPS = { CHECKOUT: 'checkout-v2' }
`,
  'src/routes.ts': `
import { getFlag } from './featureFlags'
import { Toggles, toggles } from './toggles'
import { GROUPS, NAV_FLAG } from './keys'
export async function handler(context: { key: string }) {
  return [
    await getFlag(GROUPS.CHECKOUT, context, false),
    await getFlag(NAV_FLAG, context, false),
    await Toggles.on('static-gate'),
    toggles.variant('variant-gate'),
  ]
}
`,
  // 5. Nest-style service method reached through the injected handle
  'src/orders.service.ts': `
import { LaunchDarklyService } from './launchdarkly.service'
export class OrdersService {
  constructor(private readonly flags: LaunchDarklyService) {}
  async place() {
    return this.flags.getBooleanValue('orders-v2', false)
  }
}
`,
}

function buildRepo(sources: Record<string, string>, manifest = ADMISSIBLE_MANIFEST): string {
  const dir = makeTempRepo()
  writeFixtureFile(dir, 'package.json', manifest)
  writeFixtureFile(dir, 'package-lock.json', LOCKFILE)
  writeFixtureFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }, null, 2))
  for (const [path, content] of Object.entries(sources)) writeFixtureFile(dir, path, content)
  commitAll(dir, 'wrapper parity fixture', '2025-01-01T00:00:00Z')
  return dir
}

describe('scanRepo — wrapper-mediated evaluations', () => {
  let repoDir: string
  beforeAll(() => {
    repoDir = buildRepo(WRAPPER_SOURCES)
  })
  afterAll(() => rmSync(repoDir, { recursive: true, force: true }))

  it('detects every surveyed wrapper shape and names the flag at each caller', async () => {
    const result = await scanRepo({ cwd: repoDir, noConfig: true, noIgnoreFile: true })

    expect(result.totalFlags).toBe(5)
    expect(result.detectedProviders).toEqual([SDK])

    const surface = result.evaluationSurface!
    expect(surface.wrappers.map((wrapper) => wrapper.label).sort()).toEqual([
      'LaunchDarklyService.getBooleanValue()',
      'Toggles.on()',
      'getFlag()',
      'toggles.variant()',
    ])
    // Four wrapper bodies forward a parameter (delegated); five callers name a
    // flag; nothing is left unexplained.
    expect(surface).toMatchObject({ sites: 9, accountedFor: 5, delegated: 4, unaccountedFor: 0 })
    expect(surface.gaps).toEqual([])
    expect(surface.sites).toBe(surface.accountedFor + surface.delegated + surface.unaccountedFor)
  })

  it('flows wrapper-mediated flags into the lock-in summary as a weaker detection', async () => {
    const result = await scanRepo({ cwd: repoDir, noConfig: true, noIgnoreFile: true })
    const lockIn = result.lockIn!

    expect(lockIn.callSites).toBe(5)
    expect(lockIn.totals['needs-review']).toBe(5)
    expect(lockIn.totals['draft-pr']).toBe(0)
    expect(lockIn.providers[0]).toMatchObject({
      provider: 'LaunchDarkly Node Server SDK',
      callSites: 5,
      uniqueFlags: 5,
      classification: 'needs-review',
      needsReview: 5,
    })
    // A repository whose only evaluations are wrapper-mediated is described for
    // what it is: every occurrence is a weaker detection, so the scan does not
    // claim a hosted draft-PR path for it and runs no preflight to promise one.
    expect(lockIn.hostedAdmission).toEqual([])
  })

  it('never touches the network', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    await scanRepo({ cwd: repoDir, noConfig: true, noIgnoreFile: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaves the regex engine measuring regex-only detection', async () => {
    const result = await scanRepo({ cwd: repoDir, noConfig: true, noIgnoreFile: true, engine: 'regex' })
    expect(result.totalFlags).toBe(0)
    expect(result.evaluationSurface).toBeUndefined()
  })
})

describe('scanRepo — wrapper detection and the hosted-admission preflight', () => {
  let repoDir: string
  afterAll(() => rmSync(repoDir, { recursive: true, force: true }))

  it('cannot turn a refusing gate into a passing one', async () => {
    // A direct literal call keeps the provider on the draft-PR stage, so the
    // preflight runs; the manifest has no `test` script, so it refuses. Adding
    // wrapper-mediated call sites must not change that verdict.
    const withoutTestScript = JSON.stringify(
      {
        name: 'wrapper-parity-refused',
        version: '1.0.0',
        private: true,
        packageManager: 'npm@10.9.8',
        scripts: { typecheck: 'tsc --noEmit' },
        dependencies: { [SDK]: '9.7.0' },
      },
      null,
      2,
    )
    repoDir = buildRepo(
      {
        ...WRAPPER_SOURCES,
        'src/direct.ts': `
import { init } from '${SDK}'
const client = init('sdk-key', { offline: true })
export const direct = () => client.boolVariation('direct-literal', { key: 'anonymous' }, false)
`,
      },
      withoutTestScript,
    )

    const result = await scanRepo({ cwd: repoDir, noConfig: true, noIgnoreFile: true })
    const lockIn = result.lockIn!

    expect(lockIn.totals['draft-pr-refused']).toBe(1)
    expect(lockIn.totals['needs-review']).toBe(5)
    expect(lockIn.providers[0]).toMatchObject({ classification: 'draft-pr-refused', needsReview: 5 })
    expect(lockIn.hostedAdmission).toHaveLength(1)
    expect(lockIn.hostedAdmission[0].preflight.admissible).toBe(false)
    expect(
      lockIn.hostedAdmission[0].preflight.gates.filter((gate) => gate.status === 'refuse').map((gate) => gate.id),
    ).toEqual(['test-script'])
    // `sdk-api-surface` is derived from the committed tree, not from the
    // detections: every member call in these SDK-importing files is catalogued,
    // so it passes — and still says out loud that the receiver proof is hosted.
    // Wrapper detection neither widens nor narrows it.
    const apiSurface = lockIn.hostedAdmission[0].preflight.gates.find((gate) => gate.id === 'sdk-api-surface')!
    expect(apiSurface.status).toBe('pass')
    expect(apiSurface.detail).toContain('the receiver proof itself still requires the hosted analyzer')
  })
})

describe('scanRepo — an honest zero', () => {
  let repoDir: string
  afterAll(() => rmSync(repoDir, { recursive: true, force: true }))

  it('reports the sites it could not attribute instead of a confident zero', async () => {
    repoDir = buildRepo({
      'src/flags.ts': `
import { init } from '${SDK}'
const client = init('sdk-key', { offline: true })
export function evaluate(team: string, feature: string) {
  return client.boolVariation(\`\${team}-\${feature}\`, { key: 'anonymous' }, false)
}
`,
    })

    const result = await scanRepo({ cwd: repoDir, noConfig: true, noIgnoreFile: true })
    expect(result.totalFlags).toBe(0)
    const surface = result.evaluationSurface!
    expect(surface).toMatchObject({ sites: 1, accountedFor: 0, delegated: 0, unaccountedFor: 1 })
    expect(surface.gaps).toEqual([
      expect.objectContaining({ reason: 'computed-key', count: 1, sample: 'src/flags.ts:5' }),
    ])
  })
})

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
