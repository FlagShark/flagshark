/**
 * SARIF v2.1.0 output for FlagShark scan results.
 *
 * Consumable directly by `github/codeql-action/upload-sarif` so stale flags
 * appear in the repo's Security → Code Scanning tab — same UX as CodeQL,
 * ESLint with SARIF output, etc.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import type { ScanRepoResult } from '../scan-repo.js'
import type { StaleFlag } from '../staleness.js'

export interface SarifFormatOptions {
  /** Tool driver version (the FlagShark release version). */
  version: string
}

interface SarifResult {
  ruleId: string
  level: 'note' | 'warning' | 'error'
  message: { text: string }
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string }
      region: { startLine: number }
    }
  }>
  properties: Record<string, string | number | undefined>
}

const RULE_DEFS: Record<string, { id: string; name: string; shortDescription: { text: string }; helpUri: string }> = {
  'stale-age': {
    id: 'stale-age',
    name: 'Stale by age',
    shortDescription: { text: 'Flag reference older than the configured threshold' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  'stale-low-usage': {
    id: 'stale-low-usage',
    name: 'Stale by usage',
    shortDescription: { text: 'Flag appears in only one file across the repo' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  'stale-hardcoded': {
    id: 'stale-hardcoded',
    name: 'Stale by hardcoded variation',
    shortDescription: { text: 'Flag call uses a constant default — the flag may be permanently removed upstream' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  'flagshark/missing-in-platform': {
    id: 'flagshark/missing-in-platform',
    name: 'Missing in platform',
    shortDescription: { text: 'Flag is referenced in code but does not exist in the feature flag platform' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  'flagshark/archived-in-platform': {
    id: 'flagshark/archived-in-platform',
    name: 'Archived in platform',
    shortDescription: { text: 'Flag is referenced in code but has been archived in the feature flag platform' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
}

function signalTypeToRuleId(signalType: string): string {
  if (signalType === 'age') return 'stale-age'
  if (signalType === 'low-usage') return 'stale-low-usage'
  if (signalType === 'missing-in-platform') return 'flagshark/missing-in-platform'
  if (signalType === 'archived-in-platform') return 'flagshark/archived-in-platform'
  return 'stale-hardcoded'
}

export function formatSarif(result: ScanRepoResult, options: SarifFormatOptions): string {
  const results: SarifResult[] = result.staleFlags.map((flag) => toSarifResult(flag))

  // Collect only the rule IDs that appear in results
  const usedRuleIds = new Set(results.map((r) => r.ruleId))
  const rules = [...usedRuleIds]
    .filter((id) => id in RULE_DEFS)
    .map((id) => RULE_DEFS[id])

  const envelope = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'FlagShark',
            version: options.version,
            informationUri: 'https://github.com/FlagShark/flagshark',
            rules,
          },
        },
        results,
      },
    ],
  }

  return JSON.stringify(envelope, null, 2)
}

function toSarifResult(flag: StaleFlag): SarifResult {
  const firstSignal = flag.signals[0]
  const ruleId = signalTypeToRuleId(firstSignal ? firstSignal.type : '')

  // Level is based on max severity across all signals
  const level: 'error' | 'warning' = flag.signals.some((s) => s.severity === 'error') ? 'error' : 'warning'

  return {
    ruleId,
    level,
    message: {
      text: `Flag "${flag.name}" appears stale. ${flag.signals.map((s) => s.description).join('; ')}`,
    },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: flag.filePath.replace(/^\.\//, '') },
        region: { startLine: flag.lineNumber },
      },
    }],
    properties: {
      flag: flag.name,
      provider: flag.provider,
      language: flag.language,
      age: flag.age ?? '',
    },
  }
}
