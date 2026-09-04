# FlagShark Growth and Activation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn FlagShark from a low-visibility, partially broken product funnel into a measurable developer-tool acquisition loop, then validate and productize the highest-urgency customer use case before expanding the platform.

**Architecture:** First repair the hosted dashboard route and make the free Action, hosted cleanup product, and migration product distinct. Then instrument the funnel from marketing visit through first scan, cleanup PR, merge, return, and payment. Expose the existing repository scanner, onboarding, cleanup preview, and migration-assessment capabilities as short paths to first value; do not add large new product surfaces until qualified teams complete the flow.

**Tech Stack:** Next.js marketing and dashboard apps, TypeScript, Bun/Turborepo, Playwright E2E, Vitest, GitHub App/Actions, Cloudflare Pages, AWS App Runner/CDK/Lambda, PostHog/GA-compatible event tracking, DynamoDB-backed workspaces and scans.

**Spec:** `flag-shark/PRODUCT.md`, `flag-shark/docs/migration-assessment-spec.md`, `flag-shark/docs/migration-autopilot-plan.md`, `flagshark/README.md`, and the live-funnel findings recorded in the business diagnosis.

## Global Constraints

- Restore and test `https://app.flagshark.com` before buying traffic or expanding SEO.
- Treat npm downloads as package-fetch telemetry, never as user or installation counts.
- Preserve the free OSS CLI and GitHub Action; do not require an account for basic local scanning.
- Keep the Action, hosted cleanup product, and migration product as separate promises and entrypoints.
- Do not claim that the free Action creates cleanup PRs unless the Action actually does so.
- Retain human review and merge authority for every generated cleanup PR.
- Reuse existing URL builders, analytics hooks, onboarding state machine, scan APIs, cleanup preview APIs, and migration services before creating abstractions.
- Every marketing assertion about providers, languages, cleanup support, security, pricing, or migration must match implemented behavior.
- Each programmatic change requires a focused behavioral test or browser smoke path; no project-wide validation during individual tasks.
- Human validation is required before committing to large new platform scope or paid acquisition.

## Customer evidence gate: prove FlagShark beats AI-assisted DIY on safe feature-flag transformation

**Owner:** Founder — Joseph Daniel McGrath

**Reassessment deadline:** 2026-09-24

**Decision:** Go / no-go on substantial hosted-product expansion

Before any substantial SaaS rebuild, product expansion, or “AI can do this now” repositioning, FlagShark must clear a customer-approved evidence gate.

### What this gate is for

- Determine whether FlagShark is actually better than an AI-assisted DIY workflow on **safe feature-flag transformation**.
- Treat the synthetic benchmark and the hand-written enumerator benchmark as **tool-behavior smoke only**. They prove the implementation runs; they do **not** establish market validation.
- Require evidence from **customer-approved repos** with independently verifiable flag/provider ground truth.
- Customer-approved pilot-repository selection remains blocked until written consent, named owners, provider access/ground truth, and permissions are obtained. Public, demo, and synthetic repos cannot substitute.

### Required experimental design

- Use the **same repo revisions/snapshots** for every compared workflow.
- Define a specific **AI-agent baseline** up front, such as a repo-reading coding agent plus the same human review rules a customer would actually use.
- Include **blinded human safety review** of proposed removals and rewrites.
- Measure end-to-end **time, cost, effort, unsafe changes, and verification outcomes**.
- Let the signed pilot/customer define success thresholds from repo complexity and risk tolerance; do **not** hardcode fixed percentage or speed targets into the gate.
- Compare FlagShark’s implemented system against the baseline on the same work, not against a strawman.

### Decision rules

- This gate must end in a **commercial commitment** before FlagShark expands the hosted product materially.
- The reassessment deadline is hard: unless customer-approved evidence exists by 2026-09-24, the gate remains **no-go** for substantial hosted-product expansion.
- At the reassessment deadline, the decision must be one of: **Continue**, **Extend once with a documented reason**, or **Stop**.
- If FlagShark does **not** beat the AI-assisted DIY baseline on safe transformation, customer trust, or operational burden, do **not** proceed as if the platform has a durable advantage.
- If the result is only “good scanner” parity, that is not enough.

### Reject criteria

- Reject a positioning that is only a **generic scanner**.
- Reject a positioning that is only a **hosted provider dashboard** without a durable transformation advantage.
- Reject any plan to make a **substantial SaaS rebuild** before this gate passes.

### Current evidence status

- Implemented code shows real detection, provider evidence, transformation planning, and workflow primitives.
- Planned future gates in this document remain **future work** until customer evidence exists.
- No customer-approved comparative evidence exists yet.

### Scope note

This gate is the pre-rebuild decision gate. It must be passed before the plan proceeds to larger platform investments.

### Reproducible non-customer validation track

This track is for **non-customer evidence only**. It is adjacent to, but does not replace, the customer evidence gate.

**What this track can use**

- FlagShark internal labeled fixtures and corpora.
- The CMU Strudel / MSR 2020 dataset for OSS feature-flag presence and lifetimes only.
- Uber Piranha public regression corpus for transformation expectations only.
- OpenFeature playground checked-in provider config for controlled provider truth only.
- Optionally, an authorized test LaunchDarkly project if credentials are available.

**What this track cannot assume**

- No broad public production-provider ground truth was found.
- Internal cleanup-corpus tests, including 215/270, are regression evidence only; they are not independent ground truth.
- The hand-written enumerator and any synthetic smoke checks may validate implementation behavior, but they are not AI-comparison evidence and are not safety proof.

**Required evidence shape**

- Prefer a **held-out public corpus** for independent evaluation where possible.
- When no held-out public corpus is available, use a **versioned synthetic specification** that is committed before implementation and frozen for the evaluation run.
- Use the same repo snapshots / fixture revisions for every compared workflow.
- Require blinded human adjudication of proposed removals, rewrites, and extracted provider state.
- Compare **safe transformation outcomes** only: detection correctness, provider-adapter correctness, transform correctness, and reproducibility.

**Exact limits**

- This track can validate implementation behavior, detection correctness, provider-adapter correctness, transformation correctness, and reproducibility.
- This track cannot validate customer safety in production, ROI, willingness to pay, adoption, market fit, or commercial demand.
- This track cannot substitute for customer consent or for the eventual market/safety gate.

**AI baseline run manifest v1**

- Model identifier: `openai-codex/gpt-5.4-mini:low`
- Verification note: the exact selected model must be verified and recorded before the run.
- Prompt: `Using only the frozen repo snapshot and the allowed provider/config files, independently perform the same feature-flag transformation task without using FlagShark internals or any FlagShark-specific outputs. Identify candidate flag locations and names, classify each candidate as stale, safe, unsafe, or unknown, cite the evidence for each classification, propose a patch/diff for safe candidates, report the validation commands and results you would run or ran, and explicitly abstain where the evidence is insufficient. Use the same output schema and evaluation criteria as FlagShark, and do not use network access or provider credentials on the public track.`
- Inputs: frozen repo snapshot plus the allowed provider/config files for the benchmark corpus.
- Outputs: structured candidate flag locations/names; stale/safe/unsafe/unknown classification; evidence citations; proposed patch/diff for safe candidates; validation commands/results; explicit abstentions.
- Tooling: read/write/test only in a temporary checkout; no FlagShark internals; no network; no provider credentials for the public track.
- Runs: one fresh run, no retries.
- Budget: 30 minutes and 100,000 tokens maximum; record actual time/token usage.
- Snapshot: frozen repo snapshot and frozen output schema for the run.
- Record: model identifier, date, tool versions, snapshot ID, prompt text/template, and output schema before executing the benchmark.
- Status: this is an initial benchmark configuration, not a success threshold.

**Current status**

No head-to-head FlagShark-versus-AI comparison has been run; therefore there is no comparative result and no technical go/no-go decision.

**Source-backed inputs**

- FlagShark internal labeled fixtures: `flagshark/packages/core/test/fixtures/**`
- CMU Strudel/MSR 2020 dataset: https://doi.org/10.5281/zenodo.3712227
- Uber Piranha public regression corpus: https://github.com/uber/piranha
- OpenFeature playground: https://github.com/open-feature/playground
- Authorized test LaunchDarkly project: only if credentials exist; otherwise omit.


---

## Prioritization


| Priority | Workstream | Owner | Purpose | Gate |
|---|---|---|---|---|
| P0 | Production availability and CTA repair | Self | Remove the proven 404 acquisition blocker | Every primary CTA reaches a healthy destination |
| P0 | Promise/version consistency | Self | Restore developer trust and prevent wrong setup | Action docs, README, Marketplace, and metadata agree |
| P0 | Funnel instrumentation | Self | Separate reach, conversion, activation, and retention | Events visible for one complete test journey |
| P1 | First-value onboarding | Self | Get a qualified team from install to scan to cleanup PR | At least three real repositories complete the path |
| P1 | Founder-led design partners | Human | Test willingness to use and pay | 10 interviews, 5 assessments, 3 cleanup PRs |
| P1 | Public proof and demo conversion | Self + human | Turn product capability into credible evidence | Three real case studies or quantified outcomes |
| P2 | Migration assessment wedge | Self + human | Test the higher-urgency enterprise use case | Three qualified migration conversations |
| P2 | Retention and governance | Self | Make the product recur after first cleanup | Workspaces return for scheduled health/cleanup workflows |
| P3 | Larger platform additions | Self | Expand only after evidence supports them | Activation and paid retention gates pass |

Do not start P1/P2/P3 hosted-product engineering until the customer evidence gate is satisfied or a documented product decision says the hosted expansion is no-go.

P0 reliability, security, deployment-health, and trust-repair work may continue regardless of the evidence gate. P1 onboarding/design-partner work may also continue only when it is part of the minimum path needed to restore and validate the funnel, not as a step toward hosted expansion.

---

## File Structure


### Existing files to modify

- `flag-shark/.github/workflows/deploy.yml` — fail deployment or alert when the production dashboard custom domain is not healthy; preserve environment-specific host wiring.
- `flag-shark/.github/workflows/smoke.yml` — include the public marketing-to-dashboard smoke path in the existing product smoke job.
- `flag-shark/packages/shared/lib/navigation.ts` — centralize and validate the dashboard route contract.
- `flag-shark/packages/shared/lib/__tests__/navigation.test.ts` — test environment-specific route construction and canonical paths.
- `flag-shark/apps/marketing/app/home-client.tsx` — separate free Action, public demo, and hosted dashboard CTAs; instrument their transitions.
- `flag-shark/apps/marketing/app/layout.tsx` — correct structured metadata and product claims that currently imply the free Action creates cleanup PRs.
- `flag-shark/apps/marketing/app/pricing/page.tsx` — make free Action versus hosted dashboard capabilities explicit and route each CTA correctly.
- `flag-shark/apps/marketing/app/platform/page.tsx` and `flag-shark/apps/marketing/app/platform/analytics/page.tsx` — align platform claims with the validated hosted workflow.
- `flag-shark/apps/marketing/lib/analytics.ts` — add typed funnel-event helpers while preserving consent gating.
- `flag-shark/apps/marketing/app/thank-you/page.tsx` and `flag-shark/apps/marketing/app/contact/page.tsx` — preserve attribution through demo, enterprise, and migration requests.
- `flag-shark/apps/marketing/content/docs/getting-started/github-action.mdx` — canonical `@v2` instructions and exact Action capability boundary.
- `flag-shark/apps/marketing/content/docs/getting-started/quickstart.mdx` — make the actual prerequisites and first-value path truthful and shorter.
- `flag-shark/apps/marketing/content/docs/getting-started/installation.mdx` — point to the working dashboard route and document failure recovery.
- `flag-shark/apps/marketing/content/docs/features/cleanup-prs.mdx` — distinguish hosted cleanup PR automation from Action detection.
- `flag-shark/apps/marketing/content/docs/features/how-the-engine-works.mdx` — keep the lifecycle description consistent with the public Action and SaaS backend.
- `flag-shark/apps/dashboard/components/onboarding/onboarding-autopilot.tsx` — reduce onboarding time-to-first-scan and expose the first safe next action.
- `flag-shark/apps/dashboard/components/onboarding/onboarding-results.tsx` — show an actionable result state and direct cleanup-preview path.
- `flag-shark/apps/dashboard/app/dashboard/page.tsx` — preserve routing while making empty/error states useful to a newly connected workspace.
- `flag-shark/apps/dashboard/app/api/health/route.ts` — expose a deployment-safe health contract if the existing route is insufficient for external smoke checks.
- `flag-shark/e2e/tests/product-smoke.spec.ts` — test the public CTA, auth boundary, demo fallback, and dashboard health.
- `flag-shark/e2e/tests/dashboard-smoke.spec.ts` — test first scan/result/cleanup-preview entrypoints.
- `flag-shark/e2e/playwright.config.ts` — configure production-safe smoke targets without using customer data.
- `flagshark/README.md` — update Action examples, product boundary, repository description copy, and proof links.
- `flagshark/packages/cli/README.md` — keep CLI behavior and assessment boundary current.
- `flagshark/action.yml` — update descriptions only where they match the actual published bundle.
- `flagshark/CHANGELOG.md` — record the Action-version and public-contract correction when shipped.

### New files to create only when a task requires them

- `flag-shark/e2e/tests/marketing-dashboard-availability.spec.ts` — focused external CTA availability smoke test if the existing smoke suites cannot own this contract.
- `flag-shark/apps/marketing/lib/funnel-events.ts` — typed event constants and payload schemas if `lib/analytics.ts` is too broad to maintain safely.
- `flag-shark/apps/marketing/app/oss/[org]/[name]/components/scan-cta.tsx` — public scan result CTA only if the existing OSS page cannot host it cleanly.
- `flag-shark/apps/marketing/app/migration/page.tsx` — focused migration-assessment landing page only after the migration design-partner gate.
- `flag-shark/apps/dashboard/components/onboarding/first-value-card.tsx` — reusable first-value panel only if existing onboarding components cannot express the state without duplication.

- Production analytics destination provisioning and access for the FlagShark property is an external prerequisite for production funnel measurement; do not invent credentials, IDs, or hosts in this plan.
- Verify consented end-to-end production analytics only after the destination exists and the deployment workflow has been updated with the real public key/host.


---

## Phase 0 — Restore a reachable, trustworthy funnel

### Task 1: Make the production dashboard domain a deployment invariant [P0, SELF]

**Files:**
- Modify: `flag-shark/.github/workflows/deploy.yml`
- Modify: `flag-shark/.github/workflows/smoke.yml`
- Modify: `flag-shark/packages/shared/lib/navigation.ts`
- Test: `flag-shark/packages/shared/lib/__tests__/navigation.test.ts`
- Test: `flag-shark/e2e/tests/product-smoke.spec.ts`

**Interfaces:**
- Consumes: `getDashboardRouteUrl()`, deployment environment outputs, existing `/api/health` route.
- Produces: a failing deployment/smoke signal when `app.flagshark.com` does not return a healthy dashboard or redirect.

- [ ] **Step 1.1: Add route contract tests**

  Assert that production resolves `dashboard` to `https://app.flagshark.com/dashboard`, testing resolves to `https://app.testing.flagshark.com/dashboard`, and local resolves to the local dashboard port. Assert that no route builder produces a double slash or an empty host.

- [ ] **Step 1.2: Add the external dashboard smoke**

  Add a Playwright test that requests the configured dashboard origin, follows the expected anonymous redirect or login response, and fails on 404/5xx. The test must not require a real user or GitHub installation.

- [ ] **Step 1.3: Make deployment report domain failure**

  In `deploy.yml`, retain the existing App Runner association logic but add an explicit post-association verification for the expected production hostname. If DNS/custom-domain verification is pending, fail the production deployment job rather than printing a warning and succeeding. Testing deployments may retain a non-blocking diagnostic.

- [ ] **Step 1.4: Run focused verification**

  Run:

  ```bash
  cd /Users/joe/projects/flagshark/flag-shark
  bun run test:frontend -- navigation.test.ts
  cd e2e && bunx playwright test product-smoke.spec.ts --grep "dashboard|marketing"
  ```

  Expected: route tests pass; the external production smoke fails until the custom domain is restored, then passes with a non-error response.

- [ ] **Step 1.5: Complete the external DNS action**

  Associate `app.flagshark.com` with the deployed App Runner service and add the AWS validation/CNAME records at the DNS provider. Re-run the smoke against the final public hostname.

### Task 2: Split the three product entrypoints in copy and navigation [P0, SELF]

**Files:**
- Modify: `flag-shark/apps/marketing/app/home-client.tsx`
- Modify: `flag-shark/apps/marketing/app/layout.tsx`
- Modify: `flag-shark/apps/marketing/app/pricing/page.tsx`
- Modify: `flag-shark/apps/marketing/app/platform/page.tsx`
- Modify: `flag-shark/apps/marketing/content/docs/getting-started/github-action.mdx`
- Modify: `flag-shark/apps/marketing/content/docs/getting-started/quickstart.mdx`
- Modify: `flag-shark/apps/marketing/content/docs/features/cleanup-prs.mdx`
- Modify: `flagshark/README.md`
- Modify: `flagshark/packages/cli/README.md`
- Modify: `flagshark/action.yml`
- Test: `flag-shark/e2e/tests/marketing-migration-autopilot-positioning.spec.ts` or an existing marketing smoke test

**Interfaces:**
- Consumes: existing `getDashboardRouteUrl('dashboard')`, `NEXT_PUBLIC_DEMO_URL`, install-doc routes, Action inputs.
- Produces: three unambiguous paths:
  - `Install free Action` → Action quickstart.
  - `Try public scan/demo` → public demo or OSS scan.
  - `Use hosted cleanup` → working dashboard.

- [ ] **Step 2.1: Replace ambiguous headline/supporting copy**

  Use a single claim: “Find stale feature flags and open safe cleanup PRs across your repositories.” Follow it with exact capability language: “The free Action detects and comments. The hosted product tracks lifecycle, checks provider state, and generates cleanup PRs.”

- [ ] **Step 2.2: Correct every Action version example**

  Replace legacy `FlagShark/flagshark@v1` examples in public README and Marketplace-facing copy with `@v2`. Keep one explicit migration note stating that v1 thresholds were months and v2 thresholds are days.

- [ ] **Step 2.3: Remove unsupported claims**

  Remove or qualify any metadata, comparison, FAQ, or structured-data sentence that says the free Action itself opens cleanup PRs. Keep cleanup-PR claims only on hosted-product surfaces and document the actual Action behavior.

- [ ] **Step 2.4: Verify link destinations**

  Use a browser smoke to enumerate primary CTA hrefs and assert that each expected destination is one of the three supported entrypoints. Assert no production CTA points to an unavailable host.

- [ ] **Step 2.5: Run focused verification**

  Run the marketing smoke and inspect the rendered homepage, pricing page, Action docs, and cleanup docs in a browser at desktop and mobile widths. Expected: a new visitor can explain which product they are installing without reading the full documentation.

### Task 3: Repair public developer trust surfaces [P0, SELF + EXTERNAL]

**Files:**
- Modify: `flagshark/README.md`
- Modify: `flagshark/packages/cli/README.md`
- Modify: `flagshark/CHANGELOG.md`
- Modify: `flag-shark/apps/marketing/content/docs/getting-started/github-action.mdx`

**Interfaces:**
- Consumes: actual published CLI/Action contracts and the current Marketplace listing.
- Produces: consistent copy-paste setup instructions and a credible first-run path.

- [ ] **Step 3.1: Add a repository description and topics manually**

  Set the public GitHub repository description to `Find stale feature flags in code and PRs with a free CLI and GitHub Action.` Add topics: `feature-flags`, `stale-flags`, `technical-debt`, `launchdarkly`, `github-action`, `static-analysis`, and `tree-sitter`.

- [ ] **Step 3.2: Add a short README evaluation path**

  Put the following three commands before the long feature explanation:

  ```bash
  npx flagshark scan
  npx flagshark scan --json
  npx flagshark scan --threshold 30
  ```

  Add a link to one verified sample output and one real Action workflow.

- [ ] **Step 3.3: Add support and trust links**

  Add visible links for issues, Discussions or support contact, security policy, and the hosted dashboard. Do not imply customer adoption numbers that are not measured.

- [ ] **Step 3.4: Verify the published bundle**

  Run the existing public-repo build and package tests. Confirm `@v2` Action examples match `action.yml` and the built entrypoint. Do not use npm download totals as the test.

---

## Phase 1 — Measure the funnel before building more

### Task 4: Create a typed acquisition-to-revenue event contract [P0, SELF]

**Files:**
- Modify: `flag-shark/apps/marketing/lib/analytics.ts`
- Modify: `flag-shark/packages/shared/analytics/hooks.ts`
- Modify: `flag-shark/apps/marketing/app/home-client.tsx`
- Modify: `flag-shark/apps/marketing/app/contact/page.tsx`
- Modify: `flag-shark/apps/marketing/app/thank-you/page.tsx`
- Modify: `flag-shark/apps/dashboard/components/onboarding/onboarding-autopilot.tsx`
- Modify: `flag-shark/apps/dashboard/app/api/health/route.ts` only if a server-side health event is required
- Test: corresponding marketing/dashboard unit tests

**Interfaces:**
- Produces event names and payloads for:
  `marketing_cta_clicked`, `public_demo_started`, `public_demo_completed`, `github_app_install_started`, `github_app_install_completed`, `repository_connected`, `first_scan_started`, `first_scan_completed`, `first_cleanup_preview`, `cleanup_pr_created`, `cleanup_pr_merged`, `pricing_viewed`, `trial_started`, `contact_form_submitted`, and `migration_assessment_requested`.
- Payloads must include `source`, `page`, `environment`, and non-secret anonymous/session identifiers. Never include repository source, tokens, flag contents, or customer decision values.

- [ ] **Step 4.1: Define typed event constants**

  Add a single event-name union and payload map. Reject unknown event names at compile time. Keep existing consent gating and PostHog/GA adapters.

- [ ] **Step 4.2: Instrument public CTAs**

  Track the exact CTA label, page, destination, and source placement for homepage, pricing, docs, demo, contact, and migration links.

- [ ] **Step 4.3: Instrument hosted activation**

  Emit events at GitHub callback completion, workspace creation, repository selection, scan completion, result display, cleanup preview, PR creation, and merge verification. Use durable backend events for transitions that can occur after the browser closes.

- [ ] **Step 4.4: Add a funnel report query or admin view**

  Expose counts by environment and time window without exposing repository source. The first report must answer: visitors → CTA clicks → install starts → connected workspaces → first scans → cleanup PRs → paid trials.

- [ ] **Step 4.5: Verify with a local smoke journey**

  Run the existing local/demo onboarding test and assert the ordered event names. Then run the browser flow and inspect the analytics payloads in the test adapter.

### Task 5: Provision the production analytics destination and verify consented production `marketing_cta_clicked` tracking [P0, SELF + EXTERNAL]

**Files:**
- Modify: `flag-shark/apps/marketing/lib/analytics.ts` only if the deployment-config checks need a stronger production guard
- Modify: `flag-shark/.github/workflows/deploy.yml` only to consume the existing production public analytics host/key workflow inputs

- Modify: the existing deployment secrets/workflow configuration outside this repository as required to set the production public key and host
- Test: `flag-shark/apps/marketing/lib/__tests__/analytics.test.ts` or the nearest existing analytics unit test
- Test: `flag-shark/e2e/tests/product-smoke.spec.ts`

**Interfaces:**
- Consumes: the typed `marketing_cta_clicked` event from Task 4, the existing consent gate, and the production deployment workflow/secrets.
- Produces: a verified production analytics destination for FlagShark and a consented end-to-end `marketing_cta_clicked` event in production; until that exists, funnel measurement remains blocked.

- [ ] **Step 5.1: Confirm the external blocker before wiring anything**

  Record that the currently available analytics account list contains no FlagShark property. This task cannot be completed until the owner provisions or grants access to the production analytics destination.

- [ ] **Step 5.2: Select the real production analytics destination**

  Once the owner provisions access, choose the FlagShark production property/destination that will receive public marketing events. Use the existing deployment workflow and secrets path to supply the real public key and host; do not invent or guess values.

- [ ] **Step 5.3: Update deployment configuration to read the production analytics inputs**

  Wire the existing deployment workflow so production builds consume the selected public analytics key and host from secrets or environment inputs already used by the deployment path. Keep non-production behavior unchanged.

- [ ] **Step 5.4: Verify consented production `marketing_cta_clicked` delivery**

  Click a public marketing CTA in the production environment with consent enabled, then confirm the `marketing_cta_clicked` event arrives in the selected analytics destination with the expected source/page/environment payload and no secrets. If the destination is still unavailable, stop and report the external blocker.

- [ ] **Step 5.5: Only then mark funnel measurement operational**

  Update the plan status for funnel measurement only after the production destination exists, the deployment workflow is configured, and the consented end-to-end event has been observed in production.

### Task 6: Add a production-link and analytics health check [P0, SELF]

**Files:**
- Modify: `flag-shark/.github/workflows/smoke.yml`
- Modify: `flag-shark/e2e/tests/product-smoke.spec.ts`
- Modify: `flag-shark/apps/marketing/app/robots.ts` and `sitemap.ts` only if health endpoints or canonical links are missing

**Interfaces:**
- Produces a CI-visible report for public CTA status, canonical URL status, demo availability, and analytics configuration presence.

- [ ] **Step 6.1: Check all primary origins**

  Test `flagshark.com`, `demo.flagshark.com/dashboard`, `app.flagshark.com`, and `api.flagshark.com` health endpoints in the correct environment. Fail production for 404/5xx on required origins.

- [ ] **Step 6.2: Check canonical CTA hrefs**

  Extract all links matching the primary CTA labels and verify their final destinations. This prevents a future build from silently reverting to an unavailable host.

- [ ] **Step 6.3: Check analytics adapter configuration without leaking secrets**

  Assert that production builds have the expected public analytics host/key shape while never logging credentials. Treat missing analytics as a warning for local/demo and a failure for production marketing builds.

- [ ] **Step 6.4: Run the focused smoke**

  Run `bun run smoke:api` and the production-link Playwright test against a deployment candidate. Expected: the test fails on the current 404 and passes only after the host is healthy.

---

## Phase 2 — Make first value happen in one session

### Task 7: Shorten hosted onboarding to first scan and first actionable result [P1, SELF]

**Files:**
- Modify: `flag-shark/apps/dashboard/components/onboarding/onboarding-autopilot.tsx`
- Modify: `flag-shark/apps/dashboard/components/onboarding/onboarding-results.tsx`
- Modify: `flag-shark/apps/dashboard/components/onboarding/repo-select.tsx`
- Modify: `flag-shark/apps/dashboard/app/api/onboarding/setup/route.ts`
- Modify: `flag-shark/apps/dashboard/app/api/repositories/scan/route.ts`
- Modify: `flag-shark/apps/dashboard/app/api/scans/[scanId]/route.ts`
- Test: `flag-shark/apps/dashboard/components/onboarding/__tests__/onboarding-results.test.tsx`
- Test: relevant onboarding API route tests
- Test: `flag-shark/e2e/tests/dashboard-smoke.spec.ts`

**Interfaces:**
- Consumes: existing GitHub installation callback, setup endpoint, repository selection, scan polling, and flag result APIs.
- Produces: after connection, a selected repository scan with either actionable findings, a truthful empty state, or a recoverable error.

- [ ] **Step 7.1: Define activation states**

  Keep explicit states for `installation_pending`, `repository_selection`, `scanning`, `findings`, `empty`, and `recoverable_error`. Do not hide setup failures behind indefinite polling.

- [ ] **Step 7.2: Make the first repository choice explicit**

  Show why a repository is suggested, its scan scope, expected duration, and the next result. Do not silently scan a repository without communicating the choice.

- [ ] **Step 7.3: Add an actionable findings state**

  For a supported cleanup candidate, show the exact flag, repository, source location, confidence/safety state, and a button to open the existing cleanup preview. For unsupported or uncertain findings, show the reason and the next manual action.

- [ ] **Step 7.4: Make empty results useful**

  An empty scan must show the scan scope, supported languages/providers checked, excluded files, and a direct path to the Action or configuration docs. Never present “no flags” as “no value.”

- [ ] **Step 7.5: Add a browser activation test**

  In the demo environment, verify: connect/select → scan progress → result → cleanup preview or truthful empty state. Run the existing dashboard smoke suite focused on this path.

### Task 8: Convert the public scan into a qualified product handoff [P1, SELF]

**Files:**
- Modify: `flag-shark/apps/marketing/app/home-client.tsx`
- Modify: `flag-shark/apps/marketing/app/oss/[org]/[name]/page.tsx`
- Modify: `flag-shark/apps/marketing/functions/api/dispatch-scan.ts`
- Modify: `flag-shark/apps/marketing/functions/api/scoreboard/[org]/[name].ts`
- Modify: `flag-shark/apps/marketing/lib/oss-types.ts`
- Test: marketing component/API tests
- Test: `flag-shark/e2e/tests/product-smoke.spec.ts`

**Interfaces:**
- Consumes: existing public repository scan and scoreboard result shape.
- Produces: a result page that shows evidence and routes the visitor to either the free Action, hosted cleanup, or migration assessment based on the observed result.

- [ ] **Step 8.1: Add an explicit result classification**

  Classify public scan outcomes as `no_flags`, `flags_found`, `stale_candidates`, `unsupported_or_incomplete`, or `scan_failed`. Display the classification and evidence limits.

- [ ] **Step 8.2: Add result-specific CTAs**

  `stale_candidates` should offer “Install the free PR check” and “Get a cleanup assessment.” `unsupported_or_incomplete` should offer “Request provider/language support” rather than claiming the repository is clean. `no_flags` should offer the Action for future prevention.

- [ ] **Step 8.3: Add a privacy-safe lead capture option**

  Offer an email/contact handoff only after showing the result. Do not upload private source code or require an account for public scans. Record only the repository URL, result classification, and consented contact information.

- [ ] **Step 8.4: Verify public scan to CTA conversion**

  Run the scan on a known public fixture for each classification and assert the correct CTA and analytics event. Keep scan phases and evidence limitations truthful.

---

## Phase 3 — Validate the customer and willingness to pay

### Task 9: Run a founder-led design-partner program [P1, HUMAN]

**Files:**
- No repository changes required for the first pass.
- Optional: modify `flag-shark/apps/marketing/app/contact/page.tsx` only after the interview script is stable.

**Interfaces:**
- Consumes: public scan, hosted onboarding, cleanup preview, and migration assessment.
- Produces: observed customer behavior, objections, willingness-to-pay evidence, and three real cleanup PR outcomes.

- [ ] **Step 9.1: Build a qualified prospect list**

  Identify 30 teams with public evidence of feature flags, multiple repositories, LaunchDarkly/OpenFeature/mixed providers, or an active migration/refactoring initiative. Record source, provider, repository count estimate, role, and trigger.

- [ ] **Step 9.2: Conduct ten problem interviews**

  Ask what happens after a flag rollout, who owns cleanup, how many flags are waiting, what they tried, and when the pain last blocked work. Do not lead with the product or ask whether they “like the idea.”

- [ ] **Step 9.3: Run five repository assessments**

  With permission, produce a real report or scan and review the evidence live. Record whether the customer accepts the findings, disputes them, or asks for a different workflow.

- [ ] **Step 9.4: Create three real cleanup PRs**

  Help customers generate, review, and merge cleanup PRs. Record time-to-first-value, blockers, CI outcome, merge outcome, and whether the customer returns without prompting.

- [ ] **Step 9.5: Test pricing behavior**

  Offer the existing Team plan only after a successful cleanup outcome. Test a paid pilot or annual commitment rather than asking abstractly whether $49/month sounds reasonable.

- [ ] **Step 9.6: Decide the wedge**

  Continue broad cleanup only if at least three qualified teams complete cleanup and at least one accepts payment. Otherwise prioritize the use case with the strongest trigger: migration assessment, multi-provider fleets, or platform-team governance.

### Task 10: Produce proof from real outcomes [P1, HUMAN + SELF]

**Files:**
- Modify: `flag-shark/apps/marketing/app/about/page.tsx` or create a focused case-study route only after consent.
- Modify: `flag-shark/apps/marketing/app/home-client.tsx`
- Modify: `flag-shark/apps/marketing/app/platform/page.tsx`
- Modify: `flag-shark/apps/marketing/app/compare/` pages only where claims need real evidence.

**Interfaces:**
- Consumes: anonymized or approved design-partner outcomes.
- Produces: proof of merged cleanup PRs, flags retired, time saved, and safety/CI outcomes.

- [ ] **Step 10.1: Define the proof schema**

  Each case study must include repository/team context, starting flag count, stale candidates, cleanup PR count, merged count, time-to-first-PR, review/CI outcome, and customer quote or explicit anonymization.

- [ ] **Step 10.2: Publish three small proof artifacts**

  Publish one short case study, one real cleanup diff, and one anonymized migration/assessment example. Remove unsupported savings claims and replace them with observed measurements.

- [ ] **Step 10.3: Verify claims against source records**

  Add a review checklist requiring the case-study numbers to trace to durable scan/PR evidence before publishing.

---

## Phase 4 — Test the higher-urgency migration wedge

### Task 11: Make migration assessment a focused enterprise entrypoint [P2, SELF + HUMAN]

**Files:**
- Create: `flag-shark/apps/marketing/app/migration/page.tsx` only if the existing platform/contact pages cannot express the offer.
- Modify: `flag-shark/apps/marketing/app/contact/page.tsx`
- Modify: `flag-shark/apps/marketing/content/docs/` migration-related pages
- Modify: `flag-shark/apps/dashboard/app/adopt-openfeature/` only after customer conversations identify missing activation steps.
- Test: `flag-shark/e2e/tests/marketing-migration-autopilot-positioning.spec.ts`

**Interfaces:**
- Consumes: private assessment API, OIDC/CLI contracts, OpenFeature adoption service, and fleet-autopilot pilot controls.
- Produces: a truthful “request an assessment/pilot” path for teams with a migration deadline.

- [ ] **Step 11.1: Define the offer around a paid trigger**

  Position the assessment as repository-specific migration scope and evidence, not as a generic feature page. State what it reads, what it does not change, what evidence is required, and the expected report output.

- [ ] **Step 11.2: Route qualified requests to a human**

  Capture repository count, languages, LaunchDarkly SDKs, target date, destination runtime/backend, and decision-maker role. Keep credentials and source contents out of ordinary contact records.

- [ ] **Step 11.3: Run three migration conversations**

  Do not build new Autopilot functionality until three teams describe a current migration project with a deadline and agree to review an assessment or pilot proposal.

- [ ] **Step 11.4: Verify positioning and access gates**

  Run the existing migration marketing smoke and confirm private-pilot gating, contact attribution, and no false claim that OpenFeature itself replaces the flag-management backend.

---

## Phase 5 — Add retention only after activation is proven

### Task 12: Strengthen recurring flag-health workflows [P2, SELF]

**Files:**
- Modify: `flag-shark/apps/dashboard/app/api/workspaces/[workspaceId]/stats/route.ts`
- Modify: `flag-shark/apps/dashboard/app/api/activity/route.ts`
- Modify: `flag-shark/apps/dashboard/app/api/cleanup-prs/route.ts`
- Modify: `flag-shark/apps/dashboard/components/dashboard/`
- Modify: `flag-shark/packages/backend-core/src/notification/`
- Modify: `flag-shark/packages/backend-core/src/domain/workspace.ts`
- Test: existing dashboard/backend notification tests
- Test: `flag-shark/e2e/tests/dashboard-smoke.spec.ts`

**Interfaces:**
- Consumes: scan results, cleanup PR lifecycle, workspace settings, Slack/email subscribers, and existing retention policies.
- Produces: recurring health review without requiring users to live in the dashboard.

- [ ] **Step 12.1: Define recurring value metrics**

  Show per workspace and repository: active flags, stale candidates, cleanup PRs opened, merged, verified, blocked, age distribution, and trend over time. Do not use vanity counts without an action or trend interpretation.

- [ ] **Step 12.2: Make weekly digest actionable**

  Include only changes since the previous digest, links to exact flags/PRs, blocked reasons, and one recommended next action. Honor existing notification preferences and unsubscribe paths.

- [ ] **Step 12.3: Add schedule health visibility**

  Show last scan, next scan, failed scan reason, stale data age, and provider-sync freshness. A workspace should know whether the automation is currently trustworthy.

- [ ] **Step 12.4: Verify return-path behavior**

  Use the demo scenario and notification tests to assert that a workspace with new stale flags receives a useful digest/link and that a healthy workspace does not receive misleading alerts.

Do not build additional dashboards, assistants, provider integrations, or enterprise admin features until recurring usage is demonstrated by design partners.

---

## Deferred platform additions

These are valuable only after the activation and paid-retention gates pass.

### D1: Multi-provider cleanup parity

Add provider-side state and safe cleanup support beyond LaunchDarkly only when a validated customer cohort requires it. Detection support alone must not be presented as transformation support.

### D2: Repository-fleet migration Autopilot

Continue the existing fleet work only after migration conversations produce real deadline-bound projects. Preserve immutable cohorts, bounded shards, draft-first publication, CI gates, and fail-closed exception routing.

### D3: Enterprise governance

SSO, SCIM, audit export, SIEM delivery, data residency, and custom webhooks should follow a paid customer requirement, not speculative packaging.

### D4: AI assistant and MCP expansion

Keep the dashboard assistant read-only by default and workspace-scoped. Expand tools only when customers repeatedly ask for a specific operational action that cannot be handled by existing UI/workflows.

### D5: Additional acquisition surfaces

After the funnel is healthy, add Marketplace reviews, provider-specific landing pages, OpenFeature/LaunchDarkly community posts, an `awesome-github-actions` entry, and a technically accurate third-party launch article. Do not add more generic blog posts until existing pages produce measurable qualified conversions.

---
### Note on Gates B/C

Gate B and Gate C are future measurement targets for the eventual customer validation track. They are not evidence of current adoption, and they are not an alternate authorization path around the customer evidence gate or the pre-rebuild blocker.

## Human validation scorecard

Use these gates to decide whether to continue, narrow, or stop.

### Gate A — Availability:

- 100% of production primary CTAs resolve to a healthy destination.
- Dashboard authentication and GitHub installation complete successfully.
- A new workspace can reach scan results without operator intervention.

### Gate B — Activation:

Working target for the first qualified cohort:

- 30 qualified prospects contacted.
- 10 problem interviews completed.
- 5 repository assessments completed.
- 3 cleanup PRs created.
- 2 cleanup PRs merged.
- 2 teams return for a second workflow.

### Gate C — Commercial evidence:

- At least one team pays for Team/Business or a migration assessment.
- At least one customer cites ongoing value beyond the first cleanup event.
- At least one customer chooses FlagShark despite an existing provider-native alternative.

### Gate D — Scale decision:

If Gate B passes but Gate C fails, revise packaging/pricing. If Gate B fails because prospects do not care after seeing their own evidence, narrow or stop the cleanup SaaS. If Gate B fails because the product path is unreliable, fix product reliability before drawing a demand conclusion.

---

## Explicit non-goals for the next cycle

- Do not spend on broad paid acquisition.
- Do not publish more generic SEO content before funnel measurement works.
- Do not add all remaining flag providers solely to increase a support-count headline.
- Do not build more migration-fleet complexity without deadline-bound prospects.
- Do not infer users from npm package fetches, page views, or social reactions.
- Do not claim customer savings, cleanup PR volume, or enterprise adoption without durable evidence.

---

## Execution order

1. Task 1 — production dashboard availability.
2. Task 2 — product-boundary copy and CTA repair.
3. Task 3 — public README/Marketplace/version consistency.
4. Task 4 — typed funnel events.
5. Task 5 — production analytics destination provisioning and consented production event verification.
6. Task 6 — production-link and analytics smoke checks.
7. Task 7 — first-scan and first-action onboarding.
8. Task 8 — public scan result handoff.
9. Task 9 — ten interviews and five assessments.
10. Task 10 — real proof artifacts.
11. Task 11 — migration wedge, only if interviews show deadline-bound demand.
12. Task 12 — recurring health workflows, only after activation evidence.
13. Deferred additions D1–D5, selected by observed customer demand.

The first implementation batch is Tasks 1–6. These are the P0 minimum reliability/trust work; first human validation can run in parallel with the minimum Tasks 7–8; no hosted P1/P2/P3 work is authorized until the customer evidence gate passes.

