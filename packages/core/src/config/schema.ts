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
  threshold: z.number().int().positive().default(6),
  excludes: ExcludesSchema,
  suppress: SuppressSchema,
  paths: z.array(PathRuleSchema).default([]),
  providers: z.array(CustomProviderSchema).default([]),
  output: OutputConfigSchema,
  healthScore: HealthScoreSchema,
  engine: EngineSchema,
}).strict()

export type FlagsharkConfig = z.infer<typeof FlagsharkConfigSchema>
export type ExcludesConfig = z.infer<typeof ExcludesSchema>
export type SuppressConfig = z.infer<typeof SuppressSchema>
export type PathRuleConfig = z.infer<typeof PathRuleSchema>
export type OutputConfig = z.infer<typeof OutputConfigSchema>
