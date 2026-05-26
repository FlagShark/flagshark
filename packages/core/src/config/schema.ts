import { z } from 'zod'

const PRESET_NAMES = [
  'test-files',
  'snapshots',
  'examples',
  'stories',
  'fixtures',
  'generated',
] as const

export const PresetNameSchema = z.enum(PRESET_NAMES)
export type PresetName = z.infer<typeof PresetNameSchema>

export const ExcludesSchema = z.object({
  paths: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  presets: z.array(PresetNameSchema).default([]),
}).default({})

export const SuppressSchema = z.object({
  flags: z.array(z.string()).default([]),
}).default({})

export const PathRuleSchema = z.object({
  match: z.string(),
  threshold: z.number().int().positive().optional(),
})

export const MethodConfigSchema = z.object({
  name: z.string(),
  flagKeyIndex: z.number().int(),
})

export const CustomProviderSchema = z.object({
  language: z.enum([
    'typescript', 'javascript', 'go', 'python', 'java',
    'kotlin', 'swift', 'ruby', 'csharp', 'php', 'rust',
    'cpp', 'objc',
  ]),
  name: z.string(),
  importPattern: z.string().optional(),
  enabled: z.boolean().default(true),
  methods: z.array(MethodConfigSchema),
})

/**
 * Escape hatch for typed config-struct flag systems (B3).
 *
 * Codebases like Mattermost don't use an SDK — flags are typed fields on a
 * configuration struct:
 *
 *   if (server.Config().FeatureFlags.EnableSharedChannelsMemberSync) { ... }
 *
 * There's no `import 'unleash-client'`, no `client.variation(...)`, no string
 * literal flag key. The standard import-gated detection model returns 0 on
 * these codebases because none of its preconditions hold (see the
 * design spec at docs/superpowers/specs/2026-05-24-static-config-flag-detection.md).
 *
 * Users opt in by declaring the access pattern in `.flagshark.yml`:
 *
 *   custom_detectors:
 *     - type: struct-field-access
 *       language: go
 *       access_pattern: '\.FeatureFlags\.([A-Z]\w+)'
 *
 * The capture group is the flag name. Files matching this regex are added
 * to detection results with `confidence: 'low'` so downstream tooling
 * surfaces them for manual review — false-positive risk on heuristic
 * matches is real and the user is the one who said "trust this pattern".
 *
 * We deliberately do NOT auto-discover the struct definition + enumerate
 * its fields (the more aggressive design path from the spec). Reasons:
 * each codebase invents its own pattern (Mattermost, Kubernetes, Grafana
 * each have different shapes) and chasing them is N customer-engagements
 * of work. The config-driven approach scales — users with bespoke
 * patterns can express them; we don't have to encode every variant.
 */
export const CustomDetectorSchema = z.object({
  /**
   * Detector kind. Today only `struct-field-access` is supported; future
   * kinds (e.g. `runtime-symbol`, `type-assertion`) would slot in here
   * without breaking the schema.
   */
  type: z.literal('struct-field-access'),
  /** Language whose file extensions this detector applies to. */
  language: z.enum([
    'typescript', 'javascript', 'go', 'python', 'java',
    'kotlin', 'swift', 'ruby', 'csharp', 'php', 'rust',
    'cpp', 'objc',
  ]),
  /**
   * Regex with exactly one capture group — the captured text becomes the
   * detected flag name. Run as a global regex over file content. Must be
   * a string (parsed at load time) so the YAML stays plain-data.
   */
  access_pattern: z.string().min(1),
  /**
   * Optional display name surfaced as the `provider` for matched flags.
   * Defaults to "Custom struct-field detector" so JSON consumers can
   * filter on a stable string.
   */
  name: z.string().optional(),
})

export const OutputConfigSchema = z.object({
  format: z.enum(['text', 'json', 'sarif', 'markdown', 'csv']).default('text'),
  groupBy: z.enum(['file', 'provider', 'signal', 'none']).default('file'),
  sortBy: z.enum(['age', 'name', 'count']).default('age'),
  color: z.enum(['auto', 'always', 'never']).default('auto'),
  maxDisplay: z.number().int().positive().default(10),
}).default({})

export const HealthScoreSchema = z.object({
  weights: z.object({
    age: z.number().nonnegative().default(1.0),
    lowUsage: z.number().nonnegative().default(0.5),
    hardcoded: z.number().nonnegative().default(2.0),
  }).default({}),
}).default({})

export const EngineSchema = z.record(
  z.string(),
  z.enum(['regex', 'tree-sitter']),
).default({})

export const FlagsharkConfigSchema = z.object({
  threshold: z.number().int().positive().default(30),
  excludes: ExcludesSchema,
  suppress: SuppressSchema,
  paths: z.array(PathRuleSchema).default([]),
  providers: z.array(CustomProviderSchema).default([]),
  /**
   * User-defined non-SDK detectors (B3). Today only `struct-field-access`.
   * See `CustomDetectorSchema` for the rationale + per-codebase examples.
   */
  custom_detectors: z.array(CustomDetectorSchema).default([]),
  output: OutputConfigSchema,
  healthScore: HealthScoreSchema,
  engine: EngineSchema,
  platforms: z.record(
    z.string(),
    z.object({ token_env: z.string().optional() }).passthrough(),
  ).optional(),
}).strict()

export type FlagsharkConfig = z.infer<typeof FlagsharkConfigSchema>
export type ExcludesConfig = z.infer<typeof ExcludesSchema>
export type SuppressConfig = z.infer<typeof SuppressSchema>
export type PathRuleConfig = z.infer<typeof PathRuleSchema>
export type OutputConfig = z.infer<typeof OutputConfigSchema>
