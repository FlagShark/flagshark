# Source / Truth Index

## Scope and limits

- This benchmark is public-only and reproducible without customer data.
- Public provider truth is limited.
- Internal FlagShark fixtures are development/regression only and are not held-out truth.
- Post-hoc synthetic cases created after the scanner exists are regression-only and cannot count as held-out evidence.
- The current bundle is `failed-positive-detection-smoke`.
- FlagShark CLI 2.8.0 executed on the three pinned MSR tasks but detected 0 flags on each externally annotated positive task, so this is a failed known-positive compatibility smoke, not a valid positive-detection bundle.
- Supported detection semantics have not been demonstrated for these annotations.
- Held-out tasks here are positive-detection compatibility/reference tasks only; provider-config tasks are reference-only and transformation is excluded.
- A valid detection comparison still requires an independent exhaustive candidate/negative set and more projects, or external blinded labeling before seeing FlagShark outputs.

## Detector semantics check

- `held-out-detection-msr-strudel-cloudfoundry-user_org_creation` is outside current supported detector semantics: the annotated construct is `FeatureFlag.enabled?` / `FeatureFlag.raise_unless_enabled!` in `held-out/detection/sources/held-out-detection-msr-strudel-cloudfoundry-user_org_creation/app/models/runtime/feature_flag.rb:23-39`, while supported Ruby semantics cover SDK/provider calls such as `variation`, `is_enabled?`, `enabled?`, `feature_enabled?`, `is_feature_enabled`, `feature_value`, `has_feature`, `check_feature` in `packages/core/src/detection/detectors/ruby.ts:52-263` and the generic helper only extracts call arguments after a provider match in `packages/core/src/detection/helpers.ts:185-230`.
- `held-out-detection-msr-strudel-digitalmarketplace-edit-service-page` is outside current supported detector semantics: the annotated construct is `enabled_since('2016-01-25')` in `held-out/detection/sources/held-out-detection-msr-strudel-digitalmarketplace-edit-service-page/config.py:96-120`, while supported Python semantics enumerate SDK/provider calls such as `variation`, `bool_variation`, `is_enabled`, `flag_enabled`, `has_feature`, etc., gated by provider import patterns in `packages/core/src/detection/detectors/python.ts:57-348` and `packages/core/src/detection/helpers.ts:185-230`.
- `held-out-detection-msr-strudel-opengever-activity` is outside current supported detector semantics: the annotated construct is `api.portal.get_registry_record('is_feature_enabled', interface=IActivitySettings)` and related registry reads in `held-out/detection/sources/held-out-detection-msr-strudel-opengever-activity/opengever/base/configuration.py:48-69`, while supported Python semantics remain SDK/provider call extraction with import gates in `packages/core/src/detection/detectors/python.ts:57-348` and `packages/core/src/detection/helpers.ts:185-230`.

## Status interpretation

- These annotations are supported as benchmark references only; they are not within the detector/provider semantics currently implemented for automatic callsite extraction.
- Supported detection semantics have not been demonstrated for these annotations.
- If a source cannot be independently downloaded or pinned, it is excluded and must be listed as excluded rather than inferred.
