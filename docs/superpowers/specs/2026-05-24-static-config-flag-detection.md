# Static-config flag system detection — design

**Status:** Design draft (no code yet)
**Tracking:** B3 from the post-launch bug inventory
**Trigger case:** Mattermost (Go) — `server.Config().FeatureFlags.EnableSharedChannelsMemberSync` returns 0 detections, despite the repo containing a literal `app/featureflag/feature_flags.go` directory

## The problem

Some codebases don't use a flag SDK at all. Flags are typed fields on a
configuration struct, populated from JSON/YAML/env at boot, and accessed
as plain field-reads at runtime.

Mattermost is the canonical example (Go):

```go
// Definition: server/public/model/feature_flags.go
type FeatureFlags struct {
    EnableSharedChannelsMemberSync bool
    EnableNewUploadFlow            bool
    // ...250+ fields
}

// Call site: anywhere in the codebase
if server.Config().FeatureFlags.EnableSharedChannelsMemberSync {
    // ...
}
```

There is:
- **No SDK import** (the import-gated detector returns 0)
- **No method call shape** (the call-pattern detector returns 0)
- **No string-literal flag key** (the flag NAME is a struct field, not a
  string passed as an argument)

This is a fundamentally different detection problem than the SDK case —
the seed isn't an import, it's a struct definition. Mattermost is the
shakedown trigger but the pattern is broader: any internal flag system
that prioritizes type safety over SDK-style discovery hits the same
gap. Linkerd, Kubernetes, and Grafana all have similar shapes in some
of their code.

## Why this isn't the SDK case

Our existing detection model has four moving parts:

| Concept | SDK case | Config-struct case |
|---|---|---|
| **Seed** | `import 'unleash-client'` | `type FeatureFlags struct {...}` |
| **Flag name** | String literal arg in a call | Field name in the struct |
| **Call shape** | `client.isEnabled("foo")` | `config.FeatureFlags.Foo` |
| **Detection signal** | "this file imports + calls" | "this file field-accesses on a known FeatureFlags type" |

None of the four maps cleanly between the two models. This isn't a
small extension of what we have — it's a parallel detection path.

## Design space

### A. Type-name + field-access pattern matcher
Find every Go struct whose type name matches a pattern like
`FeatureFlags`, `*Flags`, `Toggles`, `FeatureToggles`. For each matched
struct, enumerate field names. Then scan the codebase for field-access
expressions where the LHS chain ends at the struct (e.g.
`.FeatureFlags.SomeField`).

- **Cost:** Multi-day. Needs Go-specific AST analysis (the existing
  flagshark Go tree-sitter integration handles import detection but not
  type-resolution / field-access tracing). Workflow:
  1. Pre-pass: tree-sitter every `.go` file, collect every
     `type_declaration` whose name matches the pattern. Record the field
     list per match.
  2. Detection pass: for each file, find every
     `selector_expression` of shape `<chain>.<knownStructField>` where
     the field name matches one from the registry.
  3. Validate the chain: the LHS chain has to plausibly resolve to the
     known struct. Without full type inference we can't be sure, so we
     use heuristics: chain ends in `.FeatureFlags.<name>` where
     `<name>` matches a registered field, AND `FeatureFlags` appears
     somewhere in the file's imports or `package`-local scope.
- **Recall:** Catches Mattermost-shape directly.
- **Precision risk:** Field-name collisions with unrelated structs.
  Mitigate by requiring the multi-segment chain (`.FeatureFlags.<X>`
  rather than just `.X`) and refusing to match bare-`X` field accesses.

### B. Pattern-config approach
Let users declare the detection pattern via `.flagshark.yml`:

```yaml
custom_detectors:
  - type: struct-field-access
    language: go
    type_pattern: "^FeatureFlags$"
    access_pattern: "FeatureFlags\\.([A-Z]\\w+)"
```

The capture group is the flag name; the type pattern gates which
struct's fields qualify as flags.

- **Cost:** Lower than A — no automatic struct discovery. Users opt
  in by writing the config.
- **Recall:** Only catches what users configure. The auto-discovery
  benefit of A is gone.
- **Precision:** High — users tell us exactly what to match.
- **Doesn't catch:** Mattermost out of the box. Users have to write
  config first.

### C. Hybrid: A's auto-discovery + B's escape hatch
Auto-discover for Go (where the struct pattern is unambiguous and the
field count finite). Offer B's config knob for languages where
auto-discovery is harder or the pattern varies (TypeScript's interface
shape can encode flags but the syntactic indicators are weaker).

- **Cost:** Aggregate of both. ~1 week.
- **Recall:** Auto-discovery on Go, opt-in elsewhere.
- **Precision:** Good for Go (struct-name pattern is a strong signal),
  good for opt-in (user-declared).

## Recommended path — and the harder question

I want to push back on building this at all in the current quarter.

The detection categories we've shipped so far have a key property: they
match patterns the SDK ecosystem *already standardized*. There's one
`launchdarkly-node-server-sdk`, one `client.variation('flag', ctx,
default)` shape; we encode it once and recall is ~100% across customers.

Static-config flag systems are the *opposite*. Every codebase invents
its own:

- **Mattermost:** `Config().FeatureFlags.EnableX` (Go struct, BoolVariant)
- **Kubernetes:** `feature.DefaultFeatureGate.Enabled(features.X)` (different shape)
- **Vault:** `core.config.EnableX` (struct-ish but flatter)
- **Grafana:** `cfg.IsFeatureToggleEnabled("X")` (string-keyed!)

Auto-discovering ALL of these is the kind of problem where each new
codebase costs an engineer-week to write a custom matcher. Detection
quality degrades unpredictably across the long tail.

**The honest recommendation is:**

1. **Document this as out of scope** in the OSS README, alongside the
   path-alias and runtime-SDK limitations. Users with config-struct
   flag systems should know to expect 0 results.
2. **Ship B (config-driven `.flagshark.yml`)** as the escape hatch.
   Users with these patterns can opt in by declaring the shape. ~3 days
   of work for the config schema + Go matcher + tests. Documented;
   small, controlled API surface.
3. **Defer A (auto-discovery)** to a customer-pull moment. When a
   paying SaaS customer has a config-struct codebase and wants
   first-class support, build it for THEIR shape. Generalize only after
   N=3+ customers have asked.

This is a deliberate trade. We accept worse recall on a long-tail
detection class to keep precision high and the codebase small. The
escape hatch (B) prevents users from being stuck — they can always
configure their way to detection — but we don't try to auto-discover
every codebase's bespoke flag system.

## If you DO want to ship A — start here

If product priorities make auto-discovery a must-have, the smallest
useful slice is:

1. **Go only.** TypeScript's interface-shape variant is harder and lower
   ROI per the corpus. Ship Go.
2. **Type-name pattern is exactly `FeatureFlags`.** No regex, no
   variants. Hard-coded constant for v1.
3. **Field access must use the literal chain `.FeatureFlags.<Name>`.**
   No transitive resolution, no aliasing. The chain must literally
   appear in source.
4. **Detection result tagged `confidence: low`.** Users (and the SaaS
   cleanup PR builder) treat these as suggestions, not auto-mergeable.

That slice is ~3-4 days plus tests. It would close Mattermost. Future
extensions (other type names, other languages, transitive chains) gate
on real demand.

## Test strategy

For B (the escape hatch):

- **Fixture:** A small Go file with a `FeatureFlags` struct and three
  field-access call sites. `.flagshark.yml` declares the pattern.
  Expect: 3 detected flags.
- **Negative:** Same file, no config. Expect: 0 detections (current
  behavior preserved).
- **Precision guard:** File that accesses `.Something.EnableX` where
  `Something != FeatureFlags`. Expect: 0 detections.

For A (if shipped):

- **Mattermost fixture** copy: drop `app/featureflag/feature_flags.go`
  and a single consumer file into a temp repo. Expect: detection of the
  consumer's field-access.
- **Precision guard:** Add an unrelated struct also called `FeatureFlags`
  (different file, different package). Expect: no cross-package
  false-positive.
- **Recall ceiling:** Document that struct fields accessed via
  intermediate variables (`fp := c.FeatureFlags; fp.X`) WON'T be
  detected. Pin the limitation in a test so we don't pretend otherwise.

## Out of scope (deliberate)

- TypeScript interface-shape detection. Could be tackled later; punted
  for now because the Go case is more clearly bounded.
- Cross-package type resolution. We don't follow imports to validate
  that the struct accessed at site X is the same one declared at site
  Y. Heuristic only.
- Field-level staleness signals. Mattermost has 250+ flags; we'd
  surface them all on first scan. The user would need to manage
  threshold + suppression configs to use this productively.

---

**Recommended scope:** Document limitation + ship B (config-driven
escape hatch). ~3 days. Defer auto-discovery until real customer pull.
**Aggressive scope:** Add narrow A (`FeatureFlags` only, Go only) on
top of B. ~1 week total. Closes Mattermost out of the box.
**Don't ship without:** A clear product decision on how the SaaS
cleanup workflow handles `confidence: low` detections.
