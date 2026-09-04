# Source / Truth Index

## Scope and limits

- This benchmark is public-only and reproducible without customer data.
- Public provider truth is limited.
- Internal FlagShark fixtures are development/regression only and are not held-out truth.
- Post-hoc synthetic cases created after the scanner exists are regression-only and cannot count as held-out evidence.
- The current bundle is `positive-detection-smoke-only`.
- Held-out tasks here are positive-detection compatibility/reference tasks only; provider-config tasks are reference-only and transformation is excluded.
- A valid detection comparison still requires an independent exhaustive candidate/negative set and more projects, or external blinded labeling before seeing FlagShark outputs.
- If a source cannot be independently downloaded or pinned, it is excluded and must be listed as excluded rather than inferred.
