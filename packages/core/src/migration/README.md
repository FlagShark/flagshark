# Migration lock-in summary

`lock-in.ts` turns detected flag occurrences into the "Lock-in" block that
`flagshark scan` prints: call sites per provider SDK, and how much of that falls
inside a migration cell the hosted product actually admits.

## `support-snapshot.json` and `support-snapshot.data.ts` are generated

Both files are copied from the private FlagShark capability registry by

```bash
bun scripts/sync-support-snapshot.ts <path/to/adoption-support-snapshot.json>
```

Do not hand-edit them. The scanner classifies strictly from this snapshot so it
cannot claim a migration path the hosted product does not offer; if the
registry changes, re-run the sync and commit both files together
(`test/migration/support-snapshot.test.ts` pins them to each other).

- `support-snapshot.json` is the verbatim copy, kept for review and diffing.
- `support-snapshot.data.ts` is the same object as a TypeScript module. It
  exists because `@flagshark/core` ships plain `tsc` output that Node loads
  directly; a runtime JSON import there would need import attributes (Node
  >= 18.20 / 20.10). The repository already inlines tree-sitter queries for the
  same reason.

## Classification rules

Per occurrence, in order:

1. OpenFeature SDK usage (`@openfeature/*`, `dev.openfeature`, `openfeature`)
   is `already-openfeature` — not lock-in.
2. No matching cell → `detection-only`. A cell matches when one of its
   `source.sdk.packages[].name` equals the provider's `importPattern` or an
   `importAliases` entry and its `source.language.dialects` includes the
   occurrence language. The highest `version` wins when several match.
3. Medium or low detection confidence inside a cell → `needs-review`; weaker
   detections are never classified as migratable.
4. Otherwise the cell's `highestStage`: `verification` / `draft-pr` →
   `draft-pr`, `preview` → `preview`, `assessment` / `inventory` →
   `assessment`.

The wording in `LOCK_IN_LABELS` describes what the hosted product can prove
(draft PR, preview, assessment). It never promises automation or speed.
