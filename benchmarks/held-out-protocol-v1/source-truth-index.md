# Source / Truth Index

## Scope and limits

- This benchmark is public-only and reproducible without customer data.
- Public provider truth is limited.
- Internal FlagShark fixtures are development/regression only and are not held-out truth.
- Post-hoc synthetic cases created after the scanner exists are regression-only and cannot count as held-out evidence.
- The current bundle is `development-regression-only`.
- FlagShark CLI 2.8.0 now detects the annotated config-style positives in the three pinned MSR tasks via the new conservative medium-confidence config regression path, so they are suitable as development/regression fixtures rather than held-out evaluation evidence.
- The three MSR annotations are supported by the new conservative config path at medium confidence, but they remain development-only and are not held-out evidence.
- `dev-detection-msr-strudel-cloudfoundry-user_org_creation` is covered by conservative Ruby config detection: the annotated construct is the static `DEFAULT_FLAGS` hash in `tasks/dev/detection/sources/dev-detection-msr-strudel-cloudfoundry-user_org_creation/app/models/runtime/feature_flag.rb:23-39`, and the detector emits the symbol keys `user_org_creation` and `private_domain_creation` at medium confidence.
- `dev-detection-msr-strudel-digitalmarketplace-edit-service-page` is covered by conservative Python config detection: the annotated construct is `enabled_since('2016-01-25')` in `tasks/dev/detection/sources/dev-detection-msr-strudel-digitalmarketplace-edit-service-page/config.py:96-120`, and the detector emits the uppercase assignment identifiers at medium confidence.
- `dev-detection-msr-strudel-opengever-activity` is covered by conservative Python config detection: the annotated construct is `api.portal.get_registry_record('is_feature_enabled', interface=IActivitySettings)` and related registry reads in `tasks/dev/detection/sources/dev-detection-msr-strudel-opengever-activity/opengever/base/configuration.py:48-69`, and the detector emits the registry key names at medium confidence.

## Status interpretation

- These annotations are supported by the conservative config regression path at medium confidence, but they are development-only and are not held-out evidence.
- If a source cannot be independently downloaded or pinned, it is excluded and must be listed as excluded rather than inferred.
