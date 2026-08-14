# Task 5 Report: Knowledge Conflict Scanner, Retry Loop, And DLQ

## Status

DONE_WITH_CONCERNS

The Task 5 scanner and polling loop are implemented and verified. The only remaining concern is environmental: the conditional live-Postgres tests were skipped because `IRIS_TEST_DATABASE_URL` was not set. The repository SQL boundary tests, including group-scoped claims, retry exhaustion, replay, and delete behavior, passed.

## Commits

- `a4b65f22a0368512b169cc6c340398edf627a1c2` — `feat(core): run knowledge conflict scanner`
- `27847a9626ffc0f4611f9cba032210a4955a08da` — `fix(core): harden knowledge conflict scanner`
- `fd4eae9f27288e1feb43f1f9ba6fa23d576cbfc9` — `fix(core): scope scanner provider failures`
- This report is committed separately after verification.

## Delivered Behavior

- Runs bounded discovery before bounded claims and scopes both discovery and claims to groups whose live application gate is open.
- Rechecks `canUseKnowledgeConflict(groupId)` for every claim, before evidence retrieval/model use, and immediately before detection-result persistence.
- Connects the Task 3 evidence builder, Task 4 detector, and Task 2 repository record flow without adding a second model retry.
- Records `conflict`, `no_conflict`, `insufficient_evidence`, `permission_blocked`, and stale `superseded` outcomes while preserving Task 2 lease, stale-fingerprint, idempotency, and operation-conflict contracts.
- Uses stable content-free failure codes with provider classification scoped to detector failures. Malformed persisted facts and impossible identities are permanent failures; capacity, transport, invalid-twice, and infrastructure failures use bounded retries.
- Computes capped deterministic exponential backoff from attempt count only and respects repository retry-exhaustion/dead-letter behavior.
- Preserves bounded DLQ list, replay, and delete operations from Task 2 and adds scanner coverage at the repository boundary.
- Exposes content-free batch counters and a serialized polling loop with idempotent lifecycle, safe startup/scheduled error reporting, non-overlapping runs, and no restart after close.
- Preserves Task 4's long-subject `insufficient_evidence/subject_unbounded` result by consuming the detector outcome unchanged.

## TDD Evidence

### RED

- Initial focused scanner command failed because the scanner and loop modules did not exist.
- Behavioral regressions were added before fixes for malformed persisted attempt counts, detector-input rejection, enabled-group claim scoping, repository SQL claim scoping, permanent operation conflicts, non-provider `TypeError` classification, and startup/scheduled clock failures. The review regression run failed six assertions and exposed the scheduled clock rejection before implementation was changed.
- Final review regression `dead-letters a malformed persisted scan date instead of treating it as provider transport` failed because malformed `memoryUpdatedAt` was classified as `provider_transport`.

### GREEN

- Focused scanner/repository: 3 files passed; 56 tests passed, 8 conditional Postgres tests skipped.
- Relevant knowledge-conflict suite: 6 files passed, 1 conditional file skipped; 113 tests passed, 9 skipped.
- Full Core: 176 files passed, 3 conditional files skipped; 3,074 tests passed, 244 skipped.
- `npm --workspace apps/core run typecheck`: passed.
- `npm --workspace apps/core run build`: passed.
- `git diff --check`: passed.

## Self-Review

- Independent review found and drove fixes for globally unscoped claims, retrying operation conflicts, phase-insensitive provider classification, and unsafe clock reads.
- The final independent re-review was CLEAN with no remaining Critical or Important findings.
- Scanner errors, loop snapshots, and test telemetry contain stable identifiers/counters only; denied or raw knowledge content is not included.
- Work remained within Task 5: no Task 6 API, UI, card, or runtime-composition surface was added.

## Concerns And Follow-Up

- Run the conditional live-Postgres knowledge-conflict tests in CI or an environment with `IRIS_TEST_DATABASE_URL` configured. This is a verification-environment concern, not an identified scanner defect.
