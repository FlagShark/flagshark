/**
 * Lock-in summary: how many flag call sites sit behind each provider SDK, and
 * how much of that falls inside a registered hosted migration cell.
 *
 * Every detected occurrence is a call site with a literal key (detectors are
 * import-gated and only extract literal string keys — plus, for TS/JS on the
 * tree-sitter engine, a const declared in the same file). Each occurrence resolves
 * to its provider definition through the provider string the detector recorded
 * (`importPattern || name`), then to a registry cell purely by data: a cell
 * matches when one of its SDK package names equals the provider's import
 * pattern or an alias AND the cell's dialects include the occurrence language.
 * The only family treated specially is OpenFeature itself, which is not
 * lock-in.
 */

import { getImportPattern } from '../detection/interface.js'
import { HOSTED_ADMISSION_PREFLIGHTS } from './hosted-admission.js'
import { SUPPORT_SNAPSHOT } from './support-snapshot.js'

import type { FeatureFlag } from '../detection/feature-flag.js'
import type { FeatureFlagProvider } from '../detection/interface.js'
import type { AdmissionTreeView, HostedAdmissionPreflight } from './hosted-admission.js'
import type { SupportCell, SupportSnapshot, SupportStage } from './support-snapshot.js'

export type LockInClassification =
  | 'already-openfeature'
  | 'needs-review'
  | 'draft-pr'
  | 'draft-pr-refused'
  | 'preview'
  | 'assessment'
  | 'detection-only'

export const LOCK_IN_CLASSIFICATIONS: readonly LockInClassification[] = [
  'draft-pr',
  'draft-pr-refused',
  'preview',
  'assessment',
  'needs-review',
  'detection-only',
  'already-openfeature',
]

/**
 * User-facing wording per classification. Deliberately says what the hosted
 * product can prove, never how fast it is: no "automatic", no "minutes", and
 * never "available" — a draft PR is decided by the hosted planner, so the
 * scanner says "may qualify" at best and names the refusing gates otherwise.
 */
export const LOCK_IN_LABELS: Record<LockInClassification, string> = {
  'draft-pr': 'may qualify for a hosted draft PR — the hosted planner decides',
  'draft-pr-refused': 'hosted draft PR refused by the local preflight — see gates',
  preview: 'preview only',
  assessment: 'assessment only',
  'needs-review': 'needs review (weaker detection)',
  'detection-only': 'detection only (no migration cell)',
  'already-openfeature': 'already on OpenFeature (not lock-in)',
}

export interface LockInCellRef {
  id: string
  version: number
  highestStage: SupportStage
}

/** The local admission preflight run for one draft-PR-stage cell the scan matched. */
export interface LockInHostedAdmission {
  cell: LockInCellRef
  preflight: HostedAdmissionPreflight
}

export interface LockInProviderSummary {
  /** Provider display name from the detector registry, or the raw provider string when unknown. */
  provider: string
  /** Import pattern plus aliases for the provider; empty when the provider is not in the registry. */
  packages: string[]
  /** Languages the occurrences were found in, sorted. */
  languages: string[]
  callSites: number
  uniqueFlags: number
  /** Highest-version cell any occurrence of this provider matched; null when none did. */
  cell: LockInCellRef | null
  classification: LockInClassification
  /** Occurrences detected with medium or low confidence. */
  needsReview: number
}

export interface LockInSummary {
  schemaVersion: 1
  registry: { sourceRevision: string; generatedAt: string }
  callSites: number
  uniqueFlags: number
  totals: Record<LockInClassification, number>
  /** Sorted by callSites descending, then provider name. */
  providers: LockInProviderSummary[]
  /**
   * Local hosted-admission preflights, one per draft-PR-stage cell matched
   * (see `hosted-admission.ts`). Empty when no such cell matched or the
   * summary was built without a tree view. A refusing preflight turns the
   * cell's `draft-pr` occurrences into `draft-pr-refused`.
   */
  hostedAdmission: LockInHostedAdmission[]
}

const STAGE_CLASSIFICATION: Record<SupportStage, LockInClassification> = {
  inventory: 'assessment',
  assessment: 'assessment',
  preview: 'preview',
  'draft-pr': 'draft-pr',
  verification: 'draft-pr',
}

interface ProviderDefinition {
  name: string
  packages: string[]
}

/** The OpenFeature SDK family across languages: `@openfeature/*` (JS/TS), `dev.openfeature` (JVM), `openfeature` (Python). */
function isOpenFeaturePackage(pkg: string): boolean {
  return pkg === 'openfeature' || pkg.startsWith('@openfeature/') || pkg.startsWith('dev.openfeature')
}

function buildProviderIndex(providers: FeatureFlagProvider[]): Map<string, ProviderDefinition> {
  const index = new Map<string, ProviderDefinition>()
  for (const provider of providers) {
    const importPattern = getImportPattern(provider)
    const packages = [importPattern, ...(provider.importAliases ?? [])].filter((p) => p.length > 0)
    const definition: ProviderDefinition = { name: provider.name, packages }
    // Detectors record `importPattern || name`, so both are lookup keys.
    // First definition wins: TS and JS detectors share one provider list.
    for (const key of [...packages, provider.name]) {
      if (!index.has(key)) index.set(key, definition)
    }
  }
  return index
}

function matchCell(packages: string[], language: string, snapshot: SupportSnapshot): SupportCell | null {
  let best: SupportCell | null = null
  for (const cell of snapshot.cells) {
    const packageMatches = cell.source.sdk.packages.some((pkg) => packages.includes(pkg.name))
    if (!packageMatches || !cell.source.language.dialects.includes(language)) continue
    if (best === null || cell.version > best.version) best = cell
  }
  return best
}

function emptyTotals(): Record<LockInClassification, number> {
  return {
    'already-openfeature': 0,
    'needs-review': 0,
    'draft-pr': 0,
    'draft-pr-refused': 0,
    preview: 0,
    assessment: 0,
    'detection-only': 0,
  }
}

/**
 * Runs the local preflight for a cell at most once per summary. Without a
 * tree view, or for a cell with no local preflight, the classification stays
 * `draft-pr` ("may qualify") — never a promise, and never a refusal that was
 * not actually checked.
 */
class AdmissionMemo {
  private readonly results = new Map<string, HostedAdmissionPreflight | null>()
  readonly entries: LockInHostedAdmission[] = []

  constructor(private readonly tree: AdmissionTreeView | undefined) {}

  refuses(cell: SupportCell): boolean {
    let preflight = this.results.get(cell.id)
    if (preflight === undefined) {
      const run = this.tree === undefined ? undefined : HOSTED_ADMISSION_PREFLIGHTS[cell.id]
      preflight = run === undefined ? null : run(this.tree!)
      this.results.set(cell.id, preflight)
      if (preflight !== null) {
        this.entries.push({ cell: { id: cell.id, version: cell.version, highestStage: cell.highestStage }, preflight })
      }
    }
    return preflight !== null && !preflight.admissible
  }
}

interface ProviderAccumulator {
  key: string
  definition: ProviderDefinition | undefined
  openFeature: boolean
  languages: Set<string>
  names: Set<string>
  callSites: number
  needsReview: number
  cell: SupportCell | null
}

/**
 * Classify an occurrence. Order: OpenFeature SDK usage is never lock-in;
 * a weaker detection (medium/low confidence) inside a cell is `needs-review`
 * rather than migratable; a high-confidence occurrence takes the cell's
 * highest stage; anything outside every cell is `detection-only` (weak
 * detections included — with no cell there is nothing a review could unlock).
 * A `draft-pr` stage whose local admission preflight refuses becomes
 * `draft-pr-refused`.
 */
function classifyOccurrence(
  openFeature: boolean,
  weak: boolean,
  cell: SupportCell | null,
  admission: AdmissionMemo,
): LockInClassification {
  if (openFeature) return 'already-openfeature'
  if (cell === null) return 'detection-only'
  if (weak) return 'needs-review'
  const classification = STAGE_CLASSIFICATION[cell.highestStage]
  if (classification === 'draft-pr' && admission.refuses(cell)) return 'draft-pr-refused'
  return classification
}

export function summarizeLockIn(
  flags: FeatureFlag[],
  providers: FeatureFlagProvider[],
  snapshot: SupportSnapshot = SUPPORT_SNAPSHOT,
  admissionTree?: AdmissionTreeView,
): LockInSummary {
  const index = buildProviderIndex(providers)
  const totals = emptyTotals()
  const rows = new Map<string, ProviderAccumulator>()
  const allNames = new Set<string>()
  const admission = new AdmissionMemo(admissionTree)

  for (const flag of flags) {
    const key = flag.provider || 'unknown'
    const definition = index.get(key)
    const packages = definition?.packages ?? []
    const openFeature = packages.some(isOpenFeaturePackage)
    const weak = flag.confidence === 'medium' || flag.confidence === 'low'
    const cell = openFeature ? null : matchCell(packages, flag.language, snapshot)

    totals[classifyOccurrence(openFeature, weak, cell, admission)] += 1
    allNames.add(flag.name)

    let row = rows.get(key)
    if (!row) {
      row = {
        key,
        definition,
        openFeature,
        languages: new Set(),
        names: new Set(),
        callSites: 0,
        needsReview: 0,
        cell: null,
      }
      rows.set(key, row)
    }
    row.languages.add(flag.language)
    row.names.add(flag.name)
    row.callSites += 1
    if (weak) row.needsReview += 1
    if (cell !== null && (row.cell === null || cell.version > row.cell.version)) row.cell = cell
  }

  const providerSummaries: LockInProviderSummary[] = [...rows.values()].map((row) => ({
    provider: row.definition?.name ?? row.key,
    packages: row.definition?.packages ?? [],
    languages: [...row.languages].sort(),
    callSites: row.callSites,
    uniqueFlags: row.names.size,
    cell: row.cell === null ? null : { id: row.cell.id, version: row.cell.version, highestStage: row.cell.highestStage },
    classification: classifyOccurrence(row.openFeature, row.needsReview === row.callSites, row.cell, admission),
    needsReview: row.needsReview,
  }))

  providerSummaries.sort((a, b) => b.callSites - a.callSites || a.provider.localeCompare(b.provider))

  return {
    schemaVersion: 1,
    registry: { sourceRevision: snapshot.sourceRevision, generatedAt: snapshot.generatedAt },
    callSites: flags.length,
    uniqueFlags: allNames.size,
    totals,
    providers: providerSummaries,
    hostedAdmission: admission.entries,
  }
}
