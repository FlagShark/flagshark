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
5. A `draft-pr` occurrence whose cell has a local admission preflight
   (`HOSTED_ADMISSION_PREFLIGHTS`, keyed by cell id) and whose preflight
   refuses → `draft-pr-refused`. Without a tree view, or for a cell with no
   local preflight, nothing is checked and the occurrence stays `draft-pr`.

The wording in `LOCK_IN_LABELS` describes what the hosted product can prove
(draft PR, preview, assessment). It never promises automation or speed, and it
never says "available": a draft PR is decided by the hosted planner, so the
scanner says "may qualify" at best.

## Hosted-admission preflight (`hosted-admission.ts`)

`preflightNodeServerAdmission(tree)` is a pure function over an in-memory tree
view (`{ entries, files }`) that returns `{ admissible, gates }`. It mirrors the
hosted planner's snapshot collector, package selection and analyzer scope for
the LaunchDarkly Node server cell, as of the registry revision recorded in
`support-snapshot.json`, and it is local only: no account, no token, no
network, no filesystem, no subprocess (the test suite pins the invariant).

Every gate is `pass`, `refuse` or `unknown`. Anything that cannot be checked
locally — the analyzer's token and work budgets, transformation blockers such
as provider setup, unmapped client APIs and dynamic keys, the certified
dependency closure, the sandbox's `npm ci` / typecheck / test run — is
`unknown`, never `pass`. So are the cases this preflight deliberately does not
model: a missing lockfile (the planner can supply a certified generated lock
when `packageManager` is declared), the legacy `launchdarkly-node-server-sdk`
package (listed by the cell, not modelled here), and any member call outside
the catalogued client surface (`variation*`, `init`,
`waitForInitialization`, `flush`, `close`) in a file importing the SDK, since
the receiver cannot be resolved without the hosted analyzer. `admissible`
therefore means "no locally checkable gate refuses", not "the hosted planner
will admit". If the hosted rules drift, the worst case is a withheld "may
qualify", never a false one.

`admission-tree.ts` builds the tree view for `scanRepo`. The hosted planner
reads the whole repository, so the view is enumerated from the git toplevel
(`git rev-parse --show-toplevel`), not the scan directory: a workspace package
scanned from its own folder still sees the root manifest, its `workspaces`
and the yarn/pnpm markers. The index is the closest local analogue of the
committed tree and names symlinks and submodules by mode; merge-conflict stages
are passed through and collapsed by the preflight. Outside git (or with
nothing tracked yet) a filesystem walk of the scan directory skips `.git` and
`node_modules`; an unreadable subdirectory marks the view `incomplete`, which
turns every whole-tree gate `unknown` instead of aborting the scan, and a
collector failure of any kind is caught in `scanRepo` and reported the same
way. Only the preflight's inputs are read by content — every `package.json`,
npm lockfiles, `tsconfig*.json`, `.nvmrc` — plus the scanned sources, keyed
relative to the enumerated root, which the SDK-surface gate inspects.

The text and Markdown renderers print the refusing gates by name with one line
each on what would change the answer (text caps the list at five and points at
`--format json`), then the gates that are not checkable locally. The JSON output
carries every gate under `lockIn.hostedAdmission`.
