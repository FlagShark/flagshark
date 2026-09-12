import { describe, it, expect } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanRepo } from '../../src/scan-repo.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(here, '../fixtures/migration/launch-fixture')

const NODE_SERVER_CELL = {
  id: 'adopt-openfeature/launchdarkly-node-server/ecmascript/server',
  version: 2,
  highestStage: 'verification',
} as const

/**
 * `test/fixtures/migration/launch-fixture/source/flags.ts` is a copy of the
 * hosted product's launch-readiness fixture (LaunchDarkly Node server SDK,
 * `boolVariation` calls). It holds three evaluations:
 *
 *   - `CHECKOUT_KEY` — a const-held key (`const CHECKOUT_KEY = 'checkout-v2'`)
 *   - `'search-v2'` and `'emergency-stop'` — literal keys
 *
 * The scanner only extracts literal string keys, plus — for TypeScript and
 * JavaScript on the default tree-sitter engine — a const declared in the same
 * file. It does not follow imports, function parameters or anything the
 * hosted compiler frontend proves before a migration is admitted. So the
 * default scan reports all three call sites here (the const is same-file),
 * while the regex engine reports exactly the two literal-key call sites; the
 * const-held key is intentionally outside what regex detection claims.
 */
describe('lock-in summary on the launch fixture', () => {
  it('default engine: three call sites (two literal keys + one same-file const), all draft-pr via ecmascript/server@2', async () => {
    const result = await scanRepo({ cwd: fixtureDir, noConfig: true, noIgnoreFile: true })

    expect(result.totalFlags).toBe(3)
    expect(result.detectedProviders).toEqual(['@launchdarkly/node-server-sdk'])

    const lockIn = result.lockIn!
    expect(lockIn.callSites).toBe(3)
    expect(lockIn.uniqueFlags).toBe(3)
    expect(lockIn.totals).toEqual({
      'already-openfeature': 0,
      'needs-review': 0,
      'draft-pr': 3,
      preview: 0,
      assessment: 0,
      'detection-only': 0,
    })
    expect(lockIn.providers).toEqual([
      {
        provider: 'LaunchDarkly Node Server SDK',
        packages: ['@launchdarkly/node-server-sdk'],
        languages: ['typescript'],
        callSites: 3,
        uniqueFlags: 3,
        cell: NODE_SERVER_CELL,
        classification: 'draft-pr',
        needsReview: 0,
      },
    ])
    expect(lockIn.registry.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
  })

  it('regex engine: exactly the two literal-key call sites, both draft-pr', async () => {
    const result = await scanRepo({ cwd: fixtureDir, noConfig: true, noIgnoreFile: true, engine: 'regex' })

    // The const-held `checkout-v2` is not detected here: regex detection
    // never resolves identifiers, and the hosted compiler frontend is what
    // proves const-bound keys.
    expect(result.staleFlags.map((f) => f.name).sort()).toEqual(['emergency-stop', 'search-v2'])

    const lockIn = result.lockIn!
    expect(lockIn.callSites).toBe(2)
    expect(lockIn.uniqueFlags).toBe(2)
    expect(lockIn.totals['draft-pr']).toBe(2)
    expect(lockIn.providers).toHaveLength(1)
    expect(lockIn.providers[0]).toMatchObject({
      provider: 'LaunchDarkly Node Server SDK',
      callSites: 2,
      uniqueFlags: 2,
      cell: NODE_SERVER_CELL,
      classification: 'draft-pr',
    })
  })
})
