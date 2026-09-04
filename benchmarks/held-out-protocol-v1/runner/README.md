# Held-out protocol runner

Run the benchmark-local dev detection runner from the repository root:

```bash
bun benchmarks/held-out-protocol-v1/runner/run.ts
```

Prerequisites:

- `bun install` has been run at the repository root
- the workspace has been built so `packages/cli/bin/flagshark.mjs` can load the compiled CLI
- the checked-in source snapshots under `benchmarks/held-out-protocol-v1/tasks/dev/detection/sources/` are present and match their recorded SHA-256 values

What it does:

- enumerates only `partition=dev` and `task_type=detection` entries from `benchmarks/held-out-protocol-v1/manifest.json`
- resolves each task's checked-in source tree from its `source-manifest.json`
- fails if any declared source file is missing or has the wrong checksum
- invokes the offline CLI command exactly as shipped:

```bash
bun packages/cli/bin/flagshark.mjs scan --json --no-config --no-ignore-file
```

- writes one JSON result per task to `benchmarks/held-out-protocol-v1/runner/results/`

Output shape highlights:

- `cli_summary` preserves the CLI's own `totalFlags` / `flags` semantics
- `detections` contains the full detector-level matches separately, including name, file path, line number, provider, and confidence
- the runner never mutates the benchmark manifest or source snapshots
