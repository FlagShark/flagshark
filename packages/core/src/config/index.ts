export { buildDefaultConfig } from './defaults.js'
export { loadConfigFile, type LoadedConfig } from './loader.js'
export { loadIgnoreFile, type LoadedIgnore } from './ignore-file.js'
export { buildExcluder, type Excluder, type EffectiveRules, type BuildExcluderInput } from './excluder.js'
export { expandPresets, PRESETS } from './presets.js'
export {
  FlagsharkConfigSchema,
  type FlagsharkConfig,
  type ExcludesConfig,
  type SuppressConfig,
  type PathRuleConfig,
  type OutputConfig,
  type PresetName,
} from './schema.js'
