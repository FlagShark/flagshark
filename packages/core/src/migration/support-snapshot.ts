/**
 * Typed loader for the hosted migration-support registry snapshot.
 *
 * The scanner classifies lock-in strictly from this snapshot so the free CLI
 * can never claim a migration path the hosted product does not admit. The data
 * lives in `support-snapshot.json` (verbatim copy) and
 * `support-snapshot.data.ts` (generated TypeScript module); both are written by
 * `scripts/sync-support-snapshot.ts` and must not be edited by hand.
 */

import { SUPPORT_SNAPSHOT_DATA } from './support-snapshot.data.js'

/** Pipeline stages a cell can reach in the hosted product, weakest first. */
export type SupportStage = 'inventory' | 'assessment' | 'preview' | 'draft-pr' | 'verification'

export interface SupportCellPackage {
  name: string
  versionRange: string
}

export interface SupportCell {
  /** Registry cell id, e.g. `adopt-openfeature/launchdarkly-node-server/ecmascript/server`. */
  id: string
  version: number
  source: {
    provider: string
    sdk: { id: string; packages: readonly SupportCellPackage[] }
    language: { id: string; dialects: readonly string[] }
    runtimeFlavour: string
  }
  openFeatureTarget: { standard: string; sdkPackage: string; runtimeFlavour: string }
  capabilities: readonly SupportStage[]
  highestStage: SupportStage
  limitations: readonly string[]
}

export interface SupportSnapshot {
  schemaVersion: 1
  generatedFrom: string
  generatedAt: string
  sourceRevision: string
  sourceKind: string
  cells: readonly SupportCell[]
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

/**
 * Validates the shape the scanner depends on and returns a deeply frozen
 * snapshot. Throws on a schema the scanner does not understand rather than
 * silently classifying against unknown data.
 */
export function loadSupportSnapshot(raw: unknown): SupportSnapshot {
  const candidate = raw as Partial<SupportSnapshot> | null
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('support snapshot must be an object')
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error(`support snapshot schemaVersion must be 1, got ${JSON.stringify(candidate.schemaVersion)}`)
  }
  if (typeof candidate.sourceRevision !== 'string' || candidate.sourceRevision.length === 0) {
    throw new Error('support snapshot is missing sourceRevision')
  }
  if (!Array.isArray(candidate.cells)) {
    throw new Error('support snapshot cells must be an array')
  }
  return deepFreeze(candidate as SupportSnapshot)
}

/** The hosted registry snapshot this build of the scanner classifies against. */
export const SUPPORT_SNAPSHOT: SupportSnapshot = loadSupportSnapshot(SUPPORT_SNAPSHOT_DATA)
