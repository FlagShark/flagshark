# Source / Truth Index

## Scope and limits

- This benchmark is public-only and reproducible without customer data.
- Public provider truth is limited.
- Internal FlagShark fixtures are development/regression only and are not held-out truth.
- The current bundle is `protocol-ready-but-no-comparable-task`.
- Held-out tasks are reference/component tasks only; they are not scored as a FlagShark-vs-AI end-to-end feature-flag transformation comparison.
- If a source cannot be independently downloaded or pinned, it is excluded and must be listed as excluded rather than inferred.

## Source matrix

| Source | Pin | Truth role | Task types | Held-out eligible |
|---|---|---|---|---|
| FlagShark internal fixtures | `flagshark` commit `b6ec21d` | regression / dev only | detection, transformation smoke | no |
| MSR / Strudel 2020 dataset | DOI `10.5281/zenodo.3712227` | OSS feature-flag presence and lifetime truth | detection | no in this bundle; excluded with reason |
| Uber Piranha corpus | commit `2c173203e61febd43ab75df277b978927f061f93` | transformation expectations | transformation reference only | no, because the selected task is generic Java cleanup rather than feature-flag removal |
| OpenFeature playground | commit `6ddba35e86678bf5150211c53e973f43ae47e706` | checked-in provider-config truth | provider-config reference only | no, because the files are provider-state truth rather than code-removal evidence |

## Task-level truth rules

### Detection tasks

- Truth comes from labeled fixtures or corpus annotations.
- Development may inspect these labels to tune extraction rules.
- Held-out projects/commits are never inspected for tuning after freeze.
- Scoring is one pass only over the frozen held-out set.

### Provider-config tasks

- Truth comes from checked-in OpenFeature playground config, or from a separately authorized LaunchDarkly snapshot if one exists.
- Development may inspect the checked-in config to tune config parsing and normalization.
- Held-out provider-config tasks in this bundle are reference tasks only.
- Absence of public provider truth is recorded as `unknown`, not inferred.

### Transformation tasks

- Truth comes from the pinned Uber Piranha corpus expected rewrite, or a frozen synthetic spec.
- Development may inspect a separate tuning split to refine Piranha/DIY rewrite rules and scoring heuristics.
- Held-out transformations are reference tasks only in this bundle.
- The selected public task is a generic Java simplification task and is explicitly excluded from the feature-flag comparison.

## Exclusion record

- Customer repos: excluded because no customer-approved scope exists.
- MSR / Strudel task rows: excluded because task-level labels were not materialized from a pinned, independently downloadable corpus in this run.
- Any source that cannot be pinned independently: excluded rather than invented.
- Any source lacking frozen task-level truth: excluded from held-out comparison, may remain reference-only if useful for component verification.
