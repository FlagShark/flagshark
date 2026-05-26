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
  // Epoch milliseconds when the flag was first created in LD. Lets us
  // compute platform-side age independently of code age; a flag that's
  // 18 months old in LD AND still in code is a stronger stale signal
  // than either alone. Field has been on LD's API since v2 was
  // introduced, so it should be present on every flag.
  creationDate: z.number().optional(),
  // Free-form labels users apply in the LD UI (e.g. 'kill-switch',
  // 'experiment', 'auth'). Surfaced in FlagShark output so a reviewer
  // sees the LD-side classification next to the flag name.
  tags: z.array(z.string()).optional().default([]),
  // Opaque LD member ID of whoever owns the flag. Resolved to a human
  // name+email via a separate /api/v2/members lookup.
  maintainerId: z.string().optional(),
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

// ── Flag statuses (P2: LD's per-env staleness verdict) ──────────────────────

// LD's status values for a flag in a given environment:
//   - 'new': created in the last 7 days; no evaluation events yet
//   - 'active': serving evaluations as expected
//   - 'inactive': no evaluation events in 7+ days (and not 'new')
//   - 'launched': has been serving a single variation for the past 7 days,
//                 i.e. effectively rolled out
const FlagStatusItemSchema = z.object({
  name: z.enum(['new', 'active', 'inactive', 'launched']),
  // ISO timestamp string of the last evaluation event; null when none.
  lastRequested: z.string().nullable(),
  _links: z
    .object({
      // The parent link carries the flag key:
      //   /api/v2/flags/{project}/{flag-key}
      parent: z.object({ href: z.string() }).optional(),
    })
    .optional(),
}).passthrough()

export const FlagStatusesResponseSchema = z.object({
  items: z.array(FlagStatusItemSchema),
  _links: z.unknown().optional(),
}).passthrough()

export type FlagStatusesResponse = z.infer<typeof FlagStatusesResponseSchema>

// ── Evaluations (real runtime evaluation counts per flag per env) ──────────
//
// Endpoint: GET /api/v2/usage/evaluations/{project}/{env}/{flagKey}
// Returns a time-series. Each series point has a `time` (epoch ms) and one
// numeric field per variation, KEYED BY VARIATION INDEX AS A STRING
// (e.g. "0": 1234, "1": 567). The number of keys depends on the flag's
// variation count (boolean = 2; multivariate = N).
//
// We don't care about the per-variation split for the staleness signal —
// we only need the TOTAL across all variations. The schema below
// passthrough()s the variation keys and we sum them at the call site.

const EvaluationSeriesPointSchema = z
  .object({
    // ISO 8601 timestamp string per LD docs; we parse but don't typecheck
    // the format because LD has shipped it as both string and numeric in
    // the past — passthrough() keeps us tolerant.
    time: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()

export const EvaluationsResponseSchema = z
  .object({
    series: z.array(EvaluationSeriesPointSchema).optional().default([]),
    metadata: z.array(z.unknown()).optional(),
    _links: z.unknown().optional(),
  })
  .passthrough()

export type EvaluationsResponse = z.infer<typeof EvaluationsResponseSchema>

// ── Audit log (per-flag last-touched timestamp) ─────────────────────────────
//
// Endpoint: GET /api/v2/auditlog
//   ?spec=proj/{proj}:env/{env}:flag/*  → filter to flag events in a project+env
//   ?after=<epoch-ms>                   → window start
//   ?limit=20                           → max page size (per LD's docs)
//
// Response.items[].target.resources is an array of resource specifier
// strings shaped 'proj/{proj}:env/{env}:flag/{flagKey}' — we extract the
// flagKey from the trailing segment.
//
// .date is epoch milliseconds.

const AuditLogEntrySchema = z
  .object({
    date: z.number(),
    target: z
      .object({
        resources: z.array(z.string()).optional().default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const AuditLogResponseSchema = z
  .object({
    items: z.array(AuditLogEntrySchema).optional().default([]),
    _links: z
      .object({
        next: z.object({ href: z.string() }).optional(),
      })
      .optional(),
  })
  .passthrough()

export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>

// ── Members (P3: maintainer name resolution) ────────────────────────────────

const MemberItemSchema = z.object({
  _id: z.string(),
  email: z.string(),
  firstName: z.string().optional().default(''),
  lastName: z.string().optional().default(''),
}).passthrough()

export const MembersResponseSchema = z.object({
  items: z.array(MemberItemSchema),
  totalCount: z.number().optional(),
  _links: z.unknown().optional(),
}).passthrough()

export type MembersResponse = z.infer<typeof MembersResponseSchema>
