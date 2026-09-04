# AI results invalidation

The checked-in `runner/ai-results/` artifacts are audit-only captures from direct harness `completion(...)` calls.

They are not valid benchmark evidence for comparison because:

- the harness invocation did not expose a real benchmark runner binary for the AI baseline
- `normalized.json` uses placeholder provenance fields such as `benchmark-local-ai/default` and `model_version: default`
- `token_usage` is empty because the completion API did not expose counters in this environment
- the normalized rows and comparison artifacts are derived audit records, not a benchmark-approved AI submission

Use `normalized.json` and the raw per-task JSON files only for audit/history. Comparison tooling must treat them as invalid and must not present them as benchmark evidence.
