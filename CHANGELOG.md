# Changelog

## v1.4.0 — Platform integration (LaunchDarkly)

- New: cross-reference detected flag keys against LaunchDarkly's API
- New: signals `missing-in-platform` (error) and `archived-in-platform` (warning)
- New: `severity` field on `StalenessSignal` (additive — existing JSON consumers unaffected)
- New: `--no-cache` and `--fail-on-error` CLI flags
- New: `no-cache` and `fail-on-error` Action inputs
- New: `errorCount` field on JSON output; `error-count` Action output
- Pluggable: `platforms:` block in `.flagshark.yml` supports a registry of platform providers; adding Unleash / Statsig / etc. is a 3-file PR
