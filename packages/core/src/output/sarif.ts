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

import { sarifLevel } from './shared.js'

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

const RULES = [
  {
    id: 'stale-age',
    name: 'Stale by age',
    shortDescription: { text: 'Flag reference older than the configured threshold' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  {
    id: 'stale-low-usage',
    name: 'Stale by usage',
    shortDescription: { text: 'Flag appears in only one file across the repo' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
  {
    id: 'stale-hardcoded',
    name: 'Stale by hardcoded variation',
    shortDescription: { text: 'Flag call uses a constant default — the flag may be permanently removed upstream' },
    helpUri: 'https://github.com/FlagShark/flagshark#how-staleness-works',
  },
] as const

export function formatSarif(result: ScanRepoResult, options: SarifFormatOptions): string {
  const results: SarifResult[] = result.staleFlags.map((flag) => toSarifResult(flag))

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
            rules: RULES,
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
  const ruleId = firstSignal?.type === 'age'
    ? 'stale-age'
    : firstSignal?.type === 'low-usage'
      ? 'stale-low-usage'
      : 'stale-hardcoded'

  return {
    ruleId,
    level: sarifLevel(flag.signals.length),
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
