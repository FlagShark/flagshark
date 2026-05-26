import { z } from 'zod'

const EnvironmentSchema = z.object({
  lastModified: z.number().optional(),
}).passthrough()

const FlagItemSchema = z.object({
  key: z.string(),
  archived: z.boolean(),
  // `temporary` is LD's user-set flag-lifecycle marker:
  //   true  → ephemeral feature toggle, expected to be removed someday
  //   false → permanent flag (kill switch, operational config, long-lived
  //           experiment that should never be cleaned up)
  // We invert to `permanent` in the PlatformFlag mapping. Defaulted to
  // true because LD's flag-creation UI defaults to "temporary"; existing
  // flags that predate the field send true implicitly.
  temporary: z.boolean().optional().default(true),
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
