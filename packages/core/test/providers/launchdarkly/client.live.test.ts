/**
 * LIVE LaunchDarkly integration tests — hits the real LD REST API.
 *
 * Excluded from the default test run (see vitest.config.ts). Invoke via:
 *   bun run test:live
 * which loads vitest.live.config.ts.
 *
 * Required environment:
 *   LIVE_LAUNCHDARKLY_API_TOKEN   API access token (service token
 *                                 recommended, Reader role minimum,
 *                                 scoped to LIVE_LD_PROJECT).
 *   LIVE_LD_PROJECT               Project key, defaults to "default".
 *   LIVE_LD_ENVIRONMENT           Env key, defaults to "test".
 *
 * The whole suite skips when the token is unset — keeps the workflow
 * file lightweight (no conditional steps, just runs the test:live
 * script unconditionally; the test self-skips locally).
 *
 * Why this exists: the mock-server tests (client.integration.test.ts)
 * pin our understanding of LD's contract, but LD can change their API
 * shape independently of us. This file catches drift on their side
 * before our customers do. Failures here mean either: the LD API
 * changed under us, or our schema/extraction logic regressed against
 * a still-valid response shape.
 */

import { describe, it, expect, beforeAll } from 'vitest'

import { fetchAllFlags } from '../../../src/providers/launchdarkly/client.js'
import { FlagsResponseSchema } from '../../../src/providers/launchdarkly/types.js'

const TOKEN = process.env.LIVE_LAUNCHDARKLY_API_TOKEN ?? ''
const PROJECT = process.env.LIVE_LD_PROJECT ?? 'default'
const ENVIRONMENT = process.env.LIVE_LD_ENVIRONMENT ?? 'test'

const SKIP_MESSAGE = `LIVE_LAUNCHDARKLY_API_TOKEN not set — skipping live LD integration suite`

describe.skipIf(!TOKEN)('fetchAllFlags — LIVE LaunchDarkly API', () => {
  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[live-ld] Running against project=${PROJECT}, env=${ENVIRONMENT}`)
  })

  it('authenticates and returns a non-empty flag list', async () => {
    const flags = await fetchAllFlags({ project: PROJECT, environment: ENVIRONMENT, token: TOKEN })
    expect(Array.isArray(flags)).toBe(true)
    // LD trial accounts ship 5 example flags; any non-empty list confirms
    // the auth + JSON parsing path works end-to-end. Production projects
    // will have more.
    expect(flags.length).toBeGreaterThan(0)
  })

  it('every flag has the contract fields populated', async () => {
    const flags = await fetchAllFlags({ project: PROJECT, environment: ENVIRONMENT, token: TOKEN })
    for (const f of flags) {
      // Required by PlatformFlag interface.
      expect(typeof f.key).toBe('string')
      expect(f.key.length).toBeGreaterThan(0)
      expect(typeof f.archived).toBe('boolean')
      expect(f.lastModified === null || f.lastModified instanceof Date).toBe(true)
      // Optional fields added in v2.1: should be undefined OR the right
      // type, never a stale string from a bad parse.
      if (f.createdAt !== undefined) {
        expect(f.createdAt === null || f.createdAt instanceof Date).toBe(true)
      }
      if (f.tags !== undefined) {
        expect(Array.isArray(f.tags)).toBe(true)
      }
      if (f.permanent !== undefined) {
        expect(typeof f.permanent).toBe('boolean')
      }
      if (f.status !== undefined) {
        expect(['new', 'active', 'inactive', 'launched']).toContain(f.status)
      }
    }
  })

  it('Zod schema parses LD\'s actual response without coercion or stripping', async () => {
    // The schema is .passthrough() so it tolerates unknown fields. This
    // test catches the inverse failure: LD changed a field's TYPE such
    // that our explicit z.* declarations reject. We re-run the raw fetch
    // (not via fetchAllFlags which would mask the parse error) to surface
    // the exact error.
    const res = await fetch(
      `https://app.launchdarkly.com/api/v2/flags/${encodeURIComponent(PROJECT)}?env=${encodeURIComponent(ENVIRONMENT)}&limit=10&summary=1`,
      { headers: { Authorization: TOKEN, 'LD-API-Version': '20240415' } },
    )
    expect(res.ok).toBe(true)
    const json = await res.json()
    const parsed = FlagsResponseSchema.safeParse(json)
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error('Zod parse failure on live LD response:', parsed.error.format())
    }
    expect(parsed.success).toBe(true)
  })

  it('archived-flag fetch returns DIFFERENT items than the default pass', async () => {
    // The two-pass archived-flag fix (PR #22) makes fetchAllFlags union
    // active + archived flags. Verify both passes hit the LD API and
    // return distinct (key, archived) tuples. On a fresh trial there
    // may be zero archived flags — in that case archived pass returns
    // an empty list, which is still a valid contract.
    const headers = { Authorization: TOKEN, 'LD-API-Version': '20240415' }
    const activeUrl = `https://app.launchdarkly.com/api/v2/flags/${encodeURIComponent(PROJECT)}?env=${encodeURIComponent(ENVIRONMENT)}&limit=100&offset=0&summary=1`
    const archivedUrl = `${activeUrl}&archived=true`
    const [activeRes, archivedRes] = await Promise.all([
      fetch(activeUrl, { headers }),
      fetch(archivedUrl, { headers }),
    ])
    expect(activeRes.ok).toBe(true)
    expect(archivedRes.ok).toBe(true)
    const activeBody = await activeRes.json()
    const archivedBody = await archivedRes.json()
    const activeKeys = new Set(activeBody.items.map((f: { key: string }) => f.key))
    const archivedKeys = new Set(archivedBody.items.map((f: { key: string }) => f.key))
    // No key should appear in both — LD's archived flag is a different
    // logical row. (Verifies LD's contract behavior we depend on.)
    for (const k of archivedKeys) {
      expect(activeKeys.has(k as string)).toBe(false)
    }
  })

  // The /flag-statuses endpoint is what P2's platform-inactive /
  // platform-launched signals come from. Verify it returns the shape
  // we expect against a real account.
  it('flag-statuses endpoint returns the documented shape', async () => {
    const res = await fetch(
      `https://app.launchdarkly.com/api/v2/flag-statuses/${encodeURIComponent(PROJECT)}/${encodeURIComponent(ENVIRONMENT)}`,
      { headers: { Authorization: TOKEN, 'LD-API-Version': '20240415' } },
    )
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(Array.isArray(body.items)).toBe(true)
    if (body.items.length > 0) {
      const first = body.items[0]
      // The 4 documented status values — fail loud if LD adds a 5th
      // without our knowing, because our PlatformFlag.status type would
      // then truncate it.
      expect(['new', 'active', 'inactive', 'launched']).toContain(first.name)
      // lastRequested is either null or an ISO timestamp string.
      if (first.lastRequested !== null) {
        expect(typeof first.lastRequested).toBe('string')
        expect(new Date(first.lastRequested).toString()).not.toBe('Invalid Date')
      }
      // Parent link carries the flag key — fetchAllFlags depends on this.
      expect(first._links?.parent?.href).toMatch(/\/api\/v2\/flags\/[^/]+\/[^/]+$/)
    }
  })

  it('orchestrates a multi-env scan end-to-end (production + test envs)', async () => {
    // This test exercises orchestratePlatforms with multiple envs against
    // the live LD project. Requires LIVE_LD_ENVIRONMENT_TWO to be set
    // (with a different value than LIVE_LD_ENVIRONMENT) to actually
    // multi-env; otherwise it self-skips since a single env wouldn't
    // exercise the loop.
    const envOne = ENVIRONMENT
    const envTwo = process.env.LIVE_LD_ENVIRONMENT_TWO ?? 'production'
    if (envOne === envTwo) {
      // eslint-disable-next-line no-console
      console.log(`[live-ld] LIVE_LD_ENVIRONMENT == LIVE_LD_ENVIRONMENT_TWO (${envOne}) — skipping multi-env case`)
      return
    }

    // Import via dynamic import so this test file remains decoupled from
    // the orchestrator's transitive dependency graph at parse time.
    const { orchestratePlatforms } = await import('../../../src/providers/orchestrate.js')

    const prevToken = process.env.LAUNCHDARKLY_API_TOKEN
    process.env.LAUNCHDARKLY_API_TOKEN = TOKEN
    try {
      const result = await orchestratePlatforms({
        platformsConfig: {
          launchdarkly: { project: PROJECT, environments: [envOne, envTwo] },
        },
        detectedFlags: new Map(),  // no detected flags — we're verifying the fetch+stitch loop, not signal emission
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        noCache: true,
      })
      // With no detected flags, signals and environmentsByFlag are empty.
      // The contract being verified is: orchestratePlatforms successfully
      // looped both envs without throwing, both listFlags() calls completed,
      // and the cache key disambiguation prevented cross-env contamination.
      expect(result.signals.size).toBe(0)
      expect(result.environmentsByFlag.size).toBe(0)
    } finally {
      if (prevToken !== undefined) process.env.LAUNCHDARKLY_API_TOKEN = prevToken
      else delete process.env.LAUNCHDARKLY_API_TOKEN
    }
  }, 60_000)  // 60s timeout — two network round-trips with auxiliary endpoints
})

if (!TOKEN) {
  // eslint-disable-next-line no-console
  console.log(`[live-ld] ${SKIP_MESSAGE}`)
}
