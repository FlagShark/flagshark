# Runtime-loaded SDK detection — design

**Status:** Design draft (no code yet)
**Tracking:** B2 from the post-launch bug inventory
**Trigger case:** n8n editor-ui (`packages/frontend/editor-ui/`) detects 0 flags despite having 100+ PostHog feature-flag callsites

## The problem

FlagShark's detection gate is "the file imports a known SDK". Wrapper-aware
transitive resolution (shipped earlier) extends that to "the file
transitively imports a wrapper that imports an SDK". This still requires
a static `import 'posthog-js'` somewhere in the reachable graph.

Some real codebases never `import` the SDK at all. The SDK is loaded at
runtime by:

1. **Inline `<script>` tag** that defines a global (PostHog's own snippet
   sets `window.posthog`; LaunchDarkly's snippet does similar).
2. **HTML template inlining** (Rails ERB, Django templates, Next.js
   `layout.html`) that injects the same kind of script.
3. **Dynamic `<script>` injection** in JS at app boot.
4. **Tag managers** (GTM, Segment) loading the SDK via a remote
   configuration.

Across the shakedown, n8n's `editor-ui` is the cleanest reproduction:
**0 detected flags**, dozens of `posthog.isFeatureEnabled('X')` and
`useFeatureFlag('X')` callsites. Same pattern would hit any React app
loading PostHog or LaunchDarkly via the canonical snippet.

## Design space

Four families of approach. Increasing cost, increasing recall.

### A. Symbol-presence detector
Statically detect specific runtime-global usage patterns. If the file
contains `window.posthog.X`, `globalThis.LDClient.X`, or
`useFeatureFlag(...)` (PostHog's React hook), treat it as SDK-positive
for the matching provider.

- **Cost:** A few hours. Add a per-language list of known
  runtime-global symbol patterns. Augment the gate so any match flips
  the file to "in scope" without an import requirement.
- **Recall:** Catches the canonical PostHog snippet (`window.posthog`),
  LaunchDarkly's `window.LDClient`, and the `useFeatureFlag` hook idiom.
- **Precision risk:** A file that mentions `window.posthog` in a comment
  or string would false-positive. Lower the risk by requiring the
  property access shape (`posthog.X(` for method calls or `useFeatureFlag(`
  for the hook).
- **Doesn't catch:** GTM-loaded SDKs, custom-wrapper-with-no-mention
  patterns.

### B. HTML/template scanning
Walk `.html`, `.ejs`, `.erb`, `.hbs`, `.vue`, and JS string literals for
`<script>` tags whose `src` matches known CDN paths (PostHog's
`array.js`, LaunchDarkly's `ld.js`). When found, mark every file under
the same project root as SDK-positive for that provider.

- **Cost:** ~1-2 days. Need template parsing (probably regex for the
  `<script src="...">` shape, no full HTML parser), CDN URL patterns
  per known SDK, and a "scope of effect" decision (mark whole repo? mark
  same-package files? something else?).
- **Recall:** Catches the official snippets used by virtually every
  React-app PostHog/LD deployment.
- **Precision risk:** Marking "whole repo" with one snippet match is
  coarse — would gate flag detection that's already gated on import in
  a SUBSET of files. Mitigate by emitting marker-comments only into
  files in the same directory tree as the script tag, or scoping by
  detected framework (Next.js: `app/`/`pages/`; Vite: `src/`).
- **Doesn't catch:** GTM-loaded SDKs (script tag is in the GTM config,
  not the repo).

### C. SDK-call shape detector (no SDK requirement at all)
Drop the import gate entirely when the call shape itself is
unambiguous. PostHog's `posthog.isFeatureEnabled('X')` and the
`useFeatureFlag('X')` hook are SDK-coupled by NAME — there's no
realistic non-PostHog code that uses those exact method names with a
string literal arg.

- **Cost:** ~3-4 hours plus careful selection of "unambiguous" methods.
- **Recall:** Highest of the three.
- **Precision risk:** Highest too. Any codebase that defines its own
  `useFeatureFlag` (the name is generic enough that one will exist) or
  attaches `isFeatureEnabled` to an unrelated object will false-positive.
- **Mitigation:** Curate a short list per SDK of "name is uniquely the
  SDK's" methods. PostHog's `isFeatureEnabled`/`getFeatureFlag` are
  reasonably unique; their `useFeatureFlag` is a riskier match. Flag the
  flag-key string with `low-confidence` so consumers can filter.

### D. Tag-manager / config-driven detection (deferred)
Read GTM container configs, Segment-via-Snippet, or `posthog.config.js`
files declaring the runtime-loaded SDKs. Way more surface area; needs
per-platform integrations. Park for a later milestone.

## Recommended path

**Ship A + a narrowly-scoped C, defer B and D.**

Concrete proposal:

1. **A — runtime-global symbol detector.** Add a per-provider
   `runtimeSymbols: string[]` field next to the existing `importPattern`.
   When a file's content matches one of those symbol patterns
   (`window.posthog`, `posthog.isFeatureEnabled(`, etc.), mark the file as
   SDK-positive for that provider — same import-gate-bypass mechanism
   the transitive wrapper uses today (appended marker comment).
2. **C, narrowly.** For each provider, also list `unambiguousMethodNames`
   — methods whose call shape is unique enough to skip the gate
   entirely. Start with `useFeatureFlag` for PostHog, `useFlags` from
   `launchdarkly-react-client-sdk`. Tag detected flags from these with
   `confidence: 'medium'` so downstream tooling can route them to
   "manual review" PRs rather than auto-merge.
3. **Document** the precision/recall trade in the README's "Known
   limitations" section. Set expectations honestly.

Both pieces are <1 day of implementation work and would close the n8n
case (and every other React-frontend PostHog deployment) without
changing the precision floor for the rest of the corpus.

**B (template scanning)** is the right next step once we know how A+C
land on real codebases. It's the only path that catches the "tag
manager loads SDK at runtime" case but the marker-scope decision needs
real-world data before we get it right.

**D (config-driven)** is a separate product line — flag-platform
integration, not source-code static analysis.

## Open design questions

1. **Where do provider symbol lists live?** New field on
   `FeatureFlagProvider`, or a separate registry? The TS detectors
   already carry provider configs (`packages/core/src/detection/detectors/`).
   Adding `runtimeSymbols: string[]` next to `importPattern` is the path
   of least churn.
2. **Confidence tiering — boolean or enum?** Existing detection has no
   confidence concept. Adding one means plumbing through the JSON output
   schema (`flags[].confidence`) and the staleness signals. Modest scope
   but a real API change.
3. **How does the SaaS Piranha cleanup respond to a `confidence: medium`
   detected flag?** Probably: emit the cleanup PR but mark the diff
   "manual-review-required" by default. Out of scope for the OSS
   detection change; tracked in the SaaS roadmap.

## Test strategy

For A and C, the test corpus is:

- **n8n editor-ui** — the original repro. Add a fixture that mimics its
  `usePostHog` Pinia store shape + a consumer file calling
  `posthog.isFeatureEnabled('flag-x')`. Expect: ≥1 detected flag with
  `confidence: medium`.
- **PostHog's own dashboard** — `useFeatureFlag('FLAG_NAME')` in TSX
  files. Same fixture pattern.
- **False-positive guard** — a file that defines a local function
  called `useFeatureFlag` for unrelated reasons. Expect: no detection,
  or at most `confidence: low`.

## Out of scope (deliberate)

- Reading flag platform APIs to enumerate every flag the SDK could
  return (B3-class problem).
- Dynamic import (`import('posthog-js')`) — already handled by the
  existing extractor.
- Service Worker / iframe-bound SDKs — vanishingly rare; revisit if
  a real customer surfaces them.

---

**Estimated effort to ship:** A: 4-6 hrs. C: 3-4 hrs (mostly the
confidence-field plumbing). Combined: ~1 day of focused work plus a half
day of shakedown verification on n8n + the PostHog frontend.
