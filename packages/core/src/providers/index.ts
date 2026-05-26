export type {
  PlatformFlag,
  PlatformClient,
  PlatformDefinition,
  PlatformSignal,
} from './interface.js'
export { platformRegistry, findPlatform } from './registry.js'
export { crossReference, mergePlatformSignals } from './cross-reference.js'
export type { PerEnvFlags } from './cross-reference.js'
export type { PerFlagEnvironmentData } from './orchestrate.js'
export {
  computeCacheKey,
  readCache,
  writeCache,
  loadPlatformFlagsCached,
  type CacheOptions,
} from './cache.js'
