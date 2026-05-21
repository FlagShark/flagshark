# Changelog

## v2.0.0 — Staleness threshold in days (BREAKING)

- **BREAKING:** Staleness threshold is now measured in DAYS (was months). Default changed from 6 months to 30 days.
- **BREAKING:** `StalenessOptions.thresholdMonths` renamed to `thresholdDays`.
- The `--threshold` CLI flag, the `threshold` Action input, and the `threshold` / per-path `threshold` config values now all mean **days**.
- The internal age formula dropped the `30.44` days-per-month conversion; thresholds are now an exact `days * 24h` window.
- **Migration:** existing `.flagshark.yml` `threshold:` values now mean days — multiply your old month value by ~30 to keep the same behavior (e.g. `threshold: 6` → `threshold: 180`). Likewise update `--threshold` and the Action `threshold` input, and rename any `analyzeStaleness({ thresholdMonths })` calls to `thresholdDays`.

## v1.4.0 — Platform integration (LaunchDarkly)

- New: cross-reference detected flag keys against LaunchDarkly's API
- New: signals `missing-in-platform` (error) and `archived-in-platform` (warning)
- New: `severity` field on `StalenessSignal` (additive — existing JSON consumers unaffected)
- New: `--no-cache` and `--fail-on-error` CLI flags
- New: `no-cache` and `fail-on-error` Action inputs
- New: `errorCount` field on JSON output; `error-count` Action output
- Pluggable: `platforms:` block in `.flagshark.yml` supports a registry of platform providers; adding Unleash / Statsig / etc. is a 3-file PR
