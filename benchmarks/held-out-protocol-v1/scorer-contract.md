# Scorer Contract

This benchmark is runnable only after the manifest and schemas are frozen and verified.

## Inputs

- `manifest.json`
- `source-truth-index.md`
- `input-schema.json`
- `output-schema.json`
- `ai-run-config.json`
- per-runner outputs in a separate results directory

## Non-overlap rule

- A project or commit may belong to development or held-out, never both.
- Shared snapshots leak wrappers, conventions, and goldens.
- If a source or task cannot be independently pinned, it is excluded rather than inferred.

## Scoring by task type

### Detection

- Measure precision, recall, and F1 over flag-location matches and provider labels.
- Use only held-out tasks for final scores.
- Development tasks may be used to tune heuristics, then are ignored for the final score.
- Any unmatched truth item counts as a false negative.
- Any unmatched prediction counts as a false positive.

### Provider-config

- Measure exact-match accuracy for the fields available in the truth source.
- If the public source does not provide a field, the runner must abstain and the score records abstention.
- Do not infer hidden provider state from repo wrappers, conventions, or comments.

### Transformation

- Measure exact-match on the expected safe rewrite.
- Record unsafe edits separately.
- If the task is ambiguous or truth is unavailable, score abstention rather than guessing.
- When a Piranha baseline is available, compare the same pinned input and expected diff against the same review rules.

## Human adjudication

- Judges are blinded to runner identity during first-pass scoring.
- The scorer must randomize ordering and strip timestamps, prompts, and tool metadata.
- Disagreements are resolved in a second pass after unblinding.

## Final report

The scorer emits one row per task with:

- `task_id`
- `source`
- `task_type`
- `runner`
- `score`
- `precision`
- `recall`
- `f1`
- `abstention`
- `unsafe_edits`
- `runtime_seconds`
- `token_usage`
- `notes`

## Limitations

- Public provider truth is limited.
- No customer, market, adoption, or willingness-to-pay conclusion follows from this protocol.
- The AI comparison must not run until the manifest and schemas are frozen and verified.
