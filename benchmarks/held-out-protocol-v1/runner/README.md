# Held-out protocol runner

Run the benchmark-local dev detection runner from the repository root:

```bash
bun benchmarks/held-out-protocol-v1/runner/run.ts
```

Scope:

- enumerates only `partition=dev`, `task_type=detection`, `source=msr-strudel-2020` tasks from `benchmarks/held-out-protocol-v1/manifest.json`
- intentionally excludes the internal fixture task, because it is not backed by a source-manifest / checksum-shaped source tree

Prerequisites:

- `bun install` has been run at the repository root
- the workspace has been built so `packages/cli/bin/flagshark.mjs` can load the compiled CLI
- the checked-in source snapshots under `benchmarks/held-out-protocol-v1/tasks/dev/detection/sources/` are present and match their recorded SHA-256 values

What it does:

- resolves each task's checked-in source tree from its `source-manifest.json`
- fails if any declared source file is missing or has the wrong checksum
- invokes the offline CLI command exactly as shipped:

```bash
bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file
```

- writes one JSON result per task to `benchmarks/held-out-protocol-v1/runner/results/`

- `comparison.json` is generated with `status: "invalid"` and a `status_reason` because the checked-in AI artifacts are audit-only harness captures, not valid benchmark evidence
- `ai-results/normalized.json` and the per-task raw JSON files are retained for audit, but comparison tooling must treat them as invalid provenance
