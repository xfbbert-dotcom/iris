# Task 4 Report: Strict Knowledge Conflict Detector

## Status

`DONE`

Task 4 is implemented and verified. No Task 5 scanner, retry/DLQ worker, persistence mutation,
governance, delivery, callback, answer-injection, or external-side-effect behavior was added.

## Commits

- `7b6a2d1f8bf172030ae581ffc230ce05af3d8019` — `feat(core): detect strict knowledge conflicts`
- `c0f42576c61c8d80d6bb607d362d9955177f11f6` — `fix(core): bound long conflict memory subjects`

## Implemented Behavior

- Added the `KnowledgeConflictDetector` port and an OpenAI-compatible implementation that uses the
  existing chat-completions client with strict JSON Schema response formatting.
- Sends only bounded model-relevant fields from Task 3's approved evidence. Internal group, memory,
  message, source, snapshot, fragment, version, space, and content-hash identities are excluded from
  the prompt; Task 3's exact fingerprint objects and reference assignments remain unchanged.
- Normalizes the full group-memory conclusion up to its existing 4,000-character contract and
  derives a deterministic 256-character exact subject with an explicit truncation marker when
  needed. Returned subjects must exactly match that supplied bounded subject.
- Requires contiguous exact `M1`, `C1..C10`, and `D1..D12` input references and builds per-request
  schema enums from that exact window.
- Reuses `parseKnowledgeConflictPlan` for exact fields, bounded output values, deterministic citation
  sorting, available-reference validation, outcome invariants, required conflict evidence, target
  membership, and confidence rules.
- Treats all memory/message/document fields as untrusted evidence and explicitly denies embedded
  instructions, role changes, publication, external actions, official-truth selection, and
  different-subject substitution.
- Retries exactly once only when local parsing or semantic validation throws
  `KnowledgeConflictValidationError`. The correction request is freshly constructed from the same
  bounded input and the local reason, without including the raw invalid response.
- A second invalid response throws the fixed content-free error
  `knowledge conflict detector response was invalid`; no fallback plan or candidate is guessed.
  Transport errors propagate immediately without spending the semantic correction budget.
- The detector does not log, persist, emit telemetry containing, or otherwise retain raw prompts or
  model output.

## TDD Evidence

### Initial RED

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict.test.ts
```

Exit 1 as expected: the new behavioral suite could not load the missing detector module. The
existing domain suite remained green with 14 tests passed.

### Initial GREEN

The same focused command exited 0 with 2 files and 40 tests passed after the minimal detector was
implemented.

### Review-Fix RED

After independent review identified the valid Task 3 memory range mismatch, a regression was added
for a greater-than-256-character but at-most-4,000-character memory conclusion. The focused command
exited 1 with two expected failures: the old request shape lacked the separate bounded subject/full
conclusion fields, and the valid long memory was rejected before the model call.

### Review-Fix GREEN

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict.test.ts
```

Exit 0: 2 files passed; 41 tests passed; 0 failed.

## Final Verification

Relevant detector, parser, evidence-builder, chat-client, planner, and renderer regression command:

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict.test.ts knowledge-conflict-evidence-builder.test.ts openai-compatible-chat-completions-client.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts
```

Exit 0: 6 files passed; 66 tests passed; 0 failed.

Full Core:

```powershell
npm --workspace apps/core test
```

Exit 0: 174 files passed and 3 conditional files skipped; 3,045 tests passed and 244 conditional
tests skipped; 0 failed.

Compile, build, and diff gates:

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check 74a901c93742306eb2e21ef13360cf4e92a8e727..c0f42576c61c8d80d6bb607d362d9955177f11f6
```

All exited 0.

## Self-Review

- Confirmed all three outcomes map through the Task 1 parser and no detector-specific fallback plan
  exists.
- Confirmed malformed JSON, unknown/missing fields, oversized output, duplicate/out-of-window refs,
  invalid targets, missing memory/message/document evidence, low-confidence conflicts, and mixed
  subjects fail local validation.
- Confirmed input arrays, text, metadata labels, dates, and references are bounded before the first
  model call; malformed input fails with one fixed content-free error.
- Confirmed the strict schema contains all eleven required properties, no additional properties, and
  exact per-request citation/target enums.
- Confirmed prompt-injection text remains data in the user JSON and cannot alter the system prompt,
  response schema, reference window, or action boundary.
- Confirmed the correction prompt contains only the local validation reason and bounded approved
  input, never the first raw response.
- Confirmed the change touches only the planned detector interface, implementation, and tests. Task
  3 evidence types/fingerprints are consumed without mutation and no Task 5+ surface was introduced.
- Independent review found one Important upstream range mismatch. Commit `c0f4257` fixed it under a
  new RED/GREEN cycle; re-review returned `ADDRESSED / CLEAN` with focused tests, typecheck, build,
  diff check, and a clean worktree.

## Concerns

None for Task 4. The skipped full-suite tests are existing conditional database suites; this detector
adds no database behavior and its complete focused/relevant coverage executed locally.

## Fix Round 1

### Status And Commit

`DONE`

- `c368c64323858a094741796ed3972afbb07ef4ff` — `fix(core): reject unbounded conflict subjects`

This section supersedes the earlier report's long-memory truncation behavior. No synthetic or lossy
candidate subject is now derived.

### Review Findings Addressed

- Removed the 245-UTF-16-code-unit prefix plus `[truncated]` derivation. The detector accepts the
  normalized memory content as the exact candidate subject only when it fits the existing
  256-character subject contract; otherwise it throws the fixed content-free input error before
  constructing or sending a model request.
- Restored one exact `subject.content` field in the bounded model input. Accepted content is
  NFC-normalized and must be echoed exactly by the validated output, so related-subject substitution
  still consumes the one semantic correction attempt and then fails closed.
- Added an evidence-builder boundary that returns
  `{ outcome: "insufficient_evidence", reasonCode: "subject_unbounded" }` before message lookup,
  target-policy lookup, embedding, retrieval, source/snapshot reads, permission checks, or fragment
  materialization. Unrepresentable memories therefore cannot become repeated scanner poison work.
- Added regressions for two distinct over-limit conclusions with the same 256-character prefix and
  for a supplementary character crossing the removed UTF-16 slice boundary. Every case fails before
  model serialization, so no colliding or unpaired-surrogate candidate subject can be produced.
- No migration, new subject field, semantic subject guess, Task 5 scanner/DLQ behavior, persistence
  mutation, or external side effect was added. Task 3 fingerprints and reference identities remain
  unchanged.

### RED Evidence

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict-evidence-builder.test.ts knowledge-conflict.test.ts
```

Exit 1 with seven expected failures: the detector still serialized `exactSubject` and
`groupConclusion`, called the model for both shared-prefix cases and the surrogate-boundary case,
accepted a 257-character subject into the semantic-retry path, and the evidence builder returned
`ready` after dependency work instead of stable `subject_unbounded`.

### GREEN Evidence

Focused:

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict-evidence-builder.test.ts knowledge-conflict.test.ts
```

Exit 0: 3 files passed; 57 tests passed; 0 failed.

Relevant Task 3/4 and structured-model regressions:

```powershell
npm --workspace apps/core test -- openai-compatible-knowledge-conflict-detector.test.ts knowledge-conflict.test.ts knowledge-conflict-evidence-builder.test.ts knowledge-conflict-evidence-builder-postgres.test.ts document-fragment-repository.test.ts document-snapshot-repository.test.ts openai-compatible-chat-completions-client.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts postgres-knowledge-conflict-repository.test.ts
```

Exit 0: 9 files passed and 1 conditional Postgres file skipped; 152 tests passed and 14 conditional
tests skipped; 0 failed.

Full Core:

```powershell
npm --workspace apps/core test
```

Exit 0: 174 files passed and 3 conditional files skipped; 3,049 tests passed and 244 conditional
tests skipped; 0 failed.

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
```

All exited 0.

### Fix-Round Self-Review

- Confirmed there is no remaining subject slicing, truncation marker, prefix derivation, hash-based
  label, category-based label, or ID-based label in the detector.
- Confirmed the detector rejects greater-than-256 normalized content before invoking the injected
  chat-completions client, including the old unpaired-surrogate boundary.
- Confirmed the builder checks the same exported subject limit immediately after memory eligibility
  and normalization, before every repository/provider dependency.
- Confirmed exactly-256-character content remains accepted; accepted input retains its full exact
  content and exact local output equality check.
- Confirmed one invalid-response correction, invalid-twice behavior, transport propagation, strict
  schema, citation-reference validation, approved-evidence-only prompting, content-free errors, and
  no raw prompt/output logging or persistence remain unchanged.

### Fix-Round Concerns

None. The skipped cases are existing conditional database suites; this correction adds no database
behavior and all new subject-boundary tests executed locally.
