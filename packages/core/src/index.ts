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

// Migration lock-in summary
export { summarizeLockIn, LOCK_IN_LABELS, LOCK_IN_CLASSIFICATIONS } from './migration/lock-in.js'
export type {
  LockInSummary,
  LockInProviderSummary,
  LockInClassification,
  LockInCellRef,
} from './migration/lock-in.js'
export { SUPPORT_SNAPSHOT, loadSupportSnapshot } from './migration/support-snapshot.js'
export type { SupportSnapshot, SupportCell, SupportStage } from './migration/support-snapshot.js'

// Config module
export * from './config/index.js'

// Output formatters
export * from './output/index.js'

// Platform integration providers
export * from './providers/index.js'
