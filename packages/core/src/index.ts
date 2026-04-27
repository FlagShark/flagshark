// Re-export the entire detection module
export * from './detection/index.js'

// Re-export staleness analysis
export { analyzeStaleness } from './staleness.js'
export type { StaleFlag, StalenessOptions } from './staleness.js'

// Re-export scanner (low-level file collection)
export { collectFiles } from './scanner.js'
export type { ScanOptions } from './scanner.js'
