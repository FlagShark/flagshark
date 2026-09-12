import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SUPPORT_SNAPSHOT, loadSupportSnapshot } from '../../src/migration/support-snapshot.js'
import { SUPPORT_SNAPSHOT_DATA } from '../../src/migration/support-snapshot.data.js'

const here = dirname(fileURLToPath(import.meta.url))
const jsonPath = resolve(here, '../../src/migration/support-snapshot.json')

describe('SUPPORT_SNAPSHOT (copied hosted registry)', () => {
  it('is schemaVersion 1 with 15 cells and a source revision', () => {
    expect(SUPPORT_SNAPSHOT.schemaVersion).toBe(1)
    expect(SUPPORT_SNAPSHOT.cells).toHaveLength(15)
    expect(SUPPORT_SNAPSHOT.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(SUPPORT_SNAPSHOT.generatedAt).toBe('2026-09-09')
  })

  it('only the LaunchDarkly Node server ecmascript cell @2 reaches verification', () => {
    const verified = SUPPORT_SNAPSHOT.cells.filter((c) => c.highestStage === 'verification')
    expect(verified).toHaveLength(1)
    expect(verified[0].id).toBe('adopt-openfeature/launchdarkly-node-server/ecmascript/server')
    expect(verified[0].version).toBe(2)
    expect(verified[0].capabilities).toContain('draft-pr')
  })

  it('is deeply frozen so nothing at runtime can widen what the hosted product admits', () => {
    expect(Object.isFrozen(SUPPORT_SNAPSHOT)).toBe(true)
    expect(Object.isFrozen(SUPPORT_SNAPSHOT.cells)).toBe(true)
    expect(Object.isFrozen(SUPPORT_SNAPSHOT.cells[0].source.sdk.packages[0])).toBe(true)
    expect(() => {
      ;(SUPPORT_SNAPSHOT.cells[0] as { highestStage: string }).highestStage = 'verification'
    }).toThrow()
  })

  it('the generated data module matches the verbatim JSON copy', () => {
    const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
    expect(SUPPORT_SNAPSHOT_DATA).toEqual(json)
  })
})

describe('loadSupportSnapshot validation', () => {
  const valid = { schemaVersion: 1, sourceRevision: 'abc', generatedAt: '2026-01-01', cells: [] }

  it('accepts a minimal valid snapshot and freezes it', () => {
    const snap = loadSupportSnapshot(valid)
    expect(snap.sourceRevision).toBe('abc')
    expect(Object.isFrozen(snap)).toBe(true)
    // Loading an already-frozen object is a no-op rather than an error.
    expect(loadSupportSnapshot(snap)).toBe(snap)
  })

  it('rejects non-objects', () => {
    expect(() => loadSupportSnapshot(null)).toThrow('must be an object')
    expect(() => loadSupportSnapshot('nope')).toThrow('must be an object')
  })

  it('rejects an unknown schemaVersion', () => {
    expect(() => loadSupportSnapshot({ ...valid, schemaVersion: 2 })).toThrow('schemaVersion must be 1')
  })

  it('rejects a missing or empty sourceRevision', () => {
    expect(() => loadSupportSnapshot({ ...valid, sourceRevision: undefined })).toThrow('sourceRevision')
    expect(() => loadSupportSnapshot({ ...valid, sourceRevision: '' })).toThrow('sourceRevision')
  })

  it('rejects cells that are not an array', () => {
    expect(() => loadSupportSnapshot({ ...valid, cells: {} })).toThrow('cells must be an array')
  })
})
