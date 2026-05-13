import { z } from 'zod'

const EnvironmentSchema = z.object({
  lastModified: z.number().optional(),
}).passthrough()

const FlagItemSchema = z.object({
  key: z.string(),
  archived: z.boolean(),
  environments: z.record(z.string(), EnvironmentSchema).optional(),
}).passthrough()

export const FlagsResponseSchema = z.object({
  items: z.array(FlagItemSchema),
  totalCount: z.number(),
  _links: z.object({
    next: z.object({ href: z.string() }).optional(),
  }).optional(),
}).passthrough()

export type FlagsResponse = z.infer<typeof FlagsResponseSchema>
