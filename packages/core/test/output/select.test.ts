import { describe, it, expect } from 'vitest'

import { selectFormatter, type FormatName } from '../../src/output/select.js'
import type { ScanRepoResult } from '../../src/scan-repo.js'

const empty: ScanRepoResult = {
  totalFlags: 0,
  filesScanned: 0,
  staleFlags: [],
  detectedProviders: [],
  languageBreakdown: {},
  healthScore: 100,
  scanDuration: 0,
} as ScanRepoResult

describe('selectFormatter', () => {
  it.each([
    ['text', /Scanned/],
    ['json', /"totalFlags"/],
    ['markdown', /🦈 FlagShark/],
    ['csv', /^flag,file,line/],
    ['sarif', /"version": "2.1.0"/],
  ] as const)('returns a function for format=%s', (name: FormatName, marker) => {
    const fn = selectFormatter(name)
    const output = fn(empty, { version: '1.4.0', scanMode: 'full' })
    expect(output).toMatch(marker)
  })

  it('throws for unknown format name', () => {
    expect(() => selectFormatter('xml' as FormatName)).toThrow(/Unknown format/)
  })
})
