/**
 * JSON output for FlagShark scan results.
 *
 * This is the STABLE OUTPUT API — downstream tooling (the Action, custom CI
 * scripts, the hosted SaaS) can rely on the shape produced here.
 */

import type { ScanRepoResult } from '../scan-repo.js'

export interface JsonFormatOptions {
  /** Library version to embed in the output (`version` field). */
  version: string
}

export function formatJson(result: ScanRepoResult, options: JsonFormatOptions): string {
  const languages: Record<string, number> = { ...result.languageBreakdown }

  const flags = result.staleFlags.map((sf) => ({
    name: sf.name,
    file: sf.filePath,
    line: sf.lineNumber,
    language: sf.language,
    provider: sf.provider,
    stale: true,
    signals: sf.signals.map((s) => ({ type: s.type, description: s.description })),
    age: sf.age ?? null,
  }))

  const output = {
    version: options.version,
    totalFlags: result.totalFlags,
    staleFlags: new Set(result.staleFlags.map((f) => f.name)).size,
    healthScore: result.healthScore,
    detectedProviders: result.detectedProviders,
    languages,
    flags,
    excludedPaths: result.excludedPaths,
    scanDuration: result.scanDuration,
    links: {
      dashboard: 'https://flagshark.com',
      cli: 'https://github.com/FlagShark/flagshark',
      npm: 'https://www.npmjs.com/package/flagshark',
    },
  }

  return JSON.stringify(output, null, 2)
}
