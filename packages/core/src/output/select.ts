/**
 * Format-name dispatcher. Returns a unified callable that all formatters
 * conform to, so CLI/Action callers don't switch on format name themselves.
 */

import type { ScanRepoResult } from '../scan-repo.js'

import { formatCsv } from './csv.js'
import { formatJson } from './json.js'
import { formatMarkdown } from './markdown.js'
import { formatSarif } from './sarif.js'
import { formatText } from './text.js'

export type FormatName = 'text' | 'json' | 'markdown' | 'csv' | 'sarif'

export interface UnifiedFormatOptions {
  /** Tool version (used by JSON + SARIF envelopes). */
  version: string
  /** Scan mode label (used by markdown). */
  scanMode: 'full' | 'changed'
  /** Verbose flag (used by text). Default false. */
  verbose?: boolean
  /** Max stale flags rendered in text/markdown. Default: 10 (text), 20 (markdown). */
  maxDisplay?: number
  /** Link prefix for markdown (Action-context absolute URLs). */
  linkPrefix?: string
  /** Comment marker (Action only). */
  commentMarker?: string
}

export type Formatter = (result: ScanRepoResult, options: UnifiedFormatOptions) => string

const TEXT_DEFAULT_MAX = 10
const MARKDOWN_DEFAULT_MAX = 20

export function selectFormatter(name: FormatName): Formatter {
  switch (name) {
    case 'text':
      return (result, opts) => formatText(result, {
        verbose: opts.verbose ?? false,
        maxDisplay: opts.maxDisplay ?? TEXT_DEFAULT_MAX,
      })
    case 'json':
      return (result, opts) => formatJson(result, { version: opts.version })
    case 'markdown':
      return (result, opts) => formatMarkdown(result, {
        scanMode: opts.scanMode,
        linkPrefix: opts.linkPrefix,
        commentMarker: opts.commentMarker,
        maxStaleFlags: opts.maxDisplay ?? MARKDOWN_DEFAULT_MAX,
      })
    case 'csv':
      return (result) => formatCsv(result)
    case 'sarif':
      return (result, opts) => formatSarif(result, { version: opts.version })
    default:
      throw new Error(`Unknown format: ${name as string}`)
  }
}
