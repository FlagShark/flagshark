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
  LockInHostedAdmission,
} from './migration/lock-in.js'
// Local hosted-admission preflight (pure; no account, no network)
export {
  preflightNodeServerAdmission,
  HOSTED_ADMISSION_PREFLIGHTS,
  HOSTED_ADMISSION_LIMITS,
  HOSTED_SANDBOX_RUNTIME,
  NODE_SERVER_CELL_ID,
} from './migration/hosted-admission.js'
export type {
  AdmissionGate,
  AdmissionGateId,
  AdmissionGateStatus,
  AdmissionTreeEntry,
  AdmissionTreeView,
  HostedAdmissionPreflight,
} from './migration/hosted-admission.js'
export { collectAdmissionTree } from './migration/admission-tree.js'
export type { CollectAdmissionTreeOptions, CollectedAdmissionTree } from './migration/admission-tree.js'
export { SUPPORT_SNAPSHOT, loadSupportSnapshot } from './migration/support-snapshot.js'
export type { SupportSnapshot, SupportCell, SupportStage } from './migration/support-snapshot.js'

// Config module
export * from './config/index.js'

// Output formatters
export * from './output/index.js'

// Platform integration providers
export * from './providers/index.js'

// Wrapper-mediated evaluations + detection coverage (local; no account, no network)
export {
  analyzeWrapperEvaluations,
  callerCount,
  rewriteRefusalFor,
  wrapperLabel,
  EVALUATION_GAP_DETAILS,
} from './detection/wrapper-evaluations.js'
export {
  isLaunchDarklyNodePackage,
  launchDarklyNodeMethod,
  LAUNCHDARKLY_DETAIL_METHOD_NAMES,
  LAUNCHDARKLY_NODE_CLIENT_METHODS,
  LAUNCHDARKLY_NODE_EVALUATION_METHODS,
  LAUNCHDARKLY_NODE_LIFECYCLE_METHODS,
  LAUNCHDARKLY_NODE_PACKAGES,
  LAUNCHDARKLY_UNTYPED_METHOD_NAMES,
} from './detection/launchdarkly-node-methods.js'
export type {
  LaunchDarklyEvaluationMethod,
  LaunchDarklyValueType,
} from './detection/launchdarkly-node-methods.js'
export type {
  WrapperDeclaration,
  WrapperEvaluationOptions,
  WrapperEvaluationResult,
  WrapperKind,
  WrapperRewriteBlocker,
  WrapperRewriteBlockerReason,
  EvaluationGapReason,
  EvaluationSite,
  EvaluationSiteStatus,
  EvaluationSurfaceCoverage,
  EvaluationPosition,
} from './detection/wrapper-evaluations.js'
export { summarizeDetectionCoverage } from './detection/detection-coverage.js'
export type {
  DetectionCoverage,
  DetectionCoverageGap,
  DetectionCoverageRewriteRefusal,
  DetectionCoverageWrapper,
  SummarizeDetectionCoverageOptions,
} from './detection/detection-coverage.js'
