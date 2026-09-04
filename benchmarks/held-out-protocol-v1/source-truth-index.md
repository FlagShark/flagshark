# Source / Truth Index

## Scope and limits

- This benchmark is public-only and reproducible without customer data.
- Public provider truth is limited.
- Internal FlagShark fixtures are development/regression only and are not held-out truth.
- If a source cannot be independently downloaded or pinned, it is excluded and must be listed as excluded rather than inferred.

## Source matrix

| Source | Pin | Truth role | Task types | Held-out eligible |
|---|---|---|---|---|
| FlagShark internal fixtures | `flagshark` commit `b6ec21d` | regression / dev only | detection, transformation smoke | no |
| MSR / Strudel 2020 dataset | DOI `10.5281/zenodo.3712227` | OSS feature-flag presence and lifetime truth | detection | yes, if task-level annotations are available and frozen |
| Uber Piranha corpus | commit `2c173203e61febd43ab75df277b978927f061f93` | transformation expectations | transformation | yes, if the pinned corpus checkout is available and expected diffs are frozen |
| OpenFeature playground | commit `6ddba35e86678bf5150211c53e973f43ae47e706` | checked-in provider-config truth | provider-config | yes, if the pinned config tree is available and frozen |

## Task-level truth rules

### Detection tasks

- Truth comes from labeled fixtures or corpus annotations.
- Development may inspect these labels to tune extraction rules.
- Held-out projects/commits are never inspected for tuning after freeze.
- Scoring is one pass only over the frozen held-out set.

### Provider-config tasks

- Truth comes from checked-in OpenFeature playground config, or from a separately authorized LaunchDarkly snapshot if one exists.
- Development may inspect the checked-in config to tune config parsing and normalization.
- Held-out provider-config tasks are pinned revisions and are scored once.
- Absence of public provider truth is recorded as `unknown`, not inferred.

### Transformation tasks

- Truth comes from the pinned Uber Piranha corpus expected rewrite, or a frozen synthetic spec if the corpus task is not available.
- Development may inspect a separate tuning split to refine Piranha/DIY rewrite rules and scoring heuristics.
- Held-out transformations are evaluated against frozen expected diffs only.
- The held-out commit is not reused in development.

## Exclusion record

- Customer repos: excluded because no customer-approved scope exists.
- Any source that cannot be pinned independently: excluded rather than invented.
- Any source lacking frozen task-level truth: excluded from held-out, may remain dev-only if useful for tuning.
