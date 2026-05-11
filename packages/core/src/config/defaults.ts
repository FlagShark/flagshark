import { FlagsharkConfigSchema, type FlagsharkConfig } from './schema.js'

export function buildDefaultConfig(): FlagsharkConfig {
  // Parse an empty object — schema fills in all defaults.
  return FlagsharkConfigSchema.parse({})
}
