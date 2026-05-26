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

  const flags = result.staleFlags.map((sf) => {
    const flagSeverity: 'error' | 'warning' = sf.signals.some((s) => s.severity === 'error') ? 'error' : 'warning'
    return {
      name: sf.name,
      file: sf.filePath,
      line: sf.lineNumber,
      language: sf.language,
      provider: sf.provider,
      stale: true,
      severity: flagSeverity,
      // `confidence` is a detection-tier hint (high | medium | low). The
      // legacy `severity` field above is about staleness signal severity
      // — different axis entirely. Routing logic: an auto-merge cleanup
      // PR pipeline should gate on (severity === 'error' OR confidence
      // !== 'high') to surface anything that isn't a rock-solid match.
      // Emitted as 'high' explicitly here (vs the detection-side omission)
      // so downstream JSON consumers can branch on the field without
      // needing to know about the "absent = high" convention.
      confidence: sf.confidence ?? 'high',
      signals: sf.signals.map((s) => ({ type: s.type, severity: s.severity, description: s.description })),
      age: sf.age ?? null,
    }
  })

  const errorCount = result.staleFlags.filter((sf) => sf.signals.some((s) => s.severity === 'error')).length

  const output = {
    version: options.version,
    totalFlags: result.totalFlags,
    staleFlags: new Set(result.staleFlags.map((f) => f.name)).size,
    // NB: `errorCount` here counts stale flags carrying an error-severity
    // signal (e.g. missing-in-platform). It is NOT the parse-error count.
    // The new `parseErrorCount` field below is the per-file parse failure
    // count. Don't conflate them.
    errorCount,
    parseErrorCount: result.parseErrorCount ?? 0,
    // Per-platform record of flag names that were detected in code AND
    // exist in the platform but were marked permanent (LD's
    // `temporary: false`). Excluded from staleFlags above; surfaced here
    // so machine consumers (CI scripts, dashboards) can show "we know
    // about these, we just don't think they're stale".
    excludedPermanent: result.excludedPermanent ?? [],
    permanentByPlatform: result.permanentByPlatform ?? {},
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
