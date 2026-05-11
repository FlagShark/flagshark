// Re-export the entire detection module
export * from './detection/index.js'

// Re-export staleness analysis
export { analyzeStaleness } from './staleness.js'
export type { StaleFlag, StalenessOptions, StalenessSignal } from './staleness.js'

// Re-export scanner (low-level file collection)
export { collectFiles } from './scanner.js'
export type { ScanOptions } from './scanner.js'

// Re-export scanRepo orchestrator
export { scanRepo } from './scan-repo.js'
export type { ScanRepoOptions, ScanRepoResult, ScanLogger } from './scan-repo.js'

// Config module
export * from './config/index.js'

// Output formatters
export * from './output/index.js'
