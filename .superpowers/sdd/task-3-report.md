# Task 3 Report

## Status

Completed. The implementation commit is `2263cced3b8286176f4d8db7712d528b2384fc93` (`feat: add conversation state lifecycle repository`).

## Changes

- Added a pure thread/action lifecycle state machine with exhaustive transition maps and deterministic merge-target selection.
- Added the Core-owned PostgreSQL repository with normalized bounded inputs, transactions, row locks, same-group SQL evidence validation, append-only event inserts, operation-key replay handling, optimistic version checks, merge-chain cycle rejection, and privileged projection-repair methods.
- Kept candidate threads out of relevant-thread results and projection repairs.
- Added unit tests for lifecycle transitions, immutable merges, completion evidence, deterministic target selection, same-group writes, replay, stale versions, terminal merge resolution, cycles, and rollback.
- Added service-gated PostgreSQL coverage for same-group writes, cross-group rejection, replay, stale versions, merge-chain canonicalization, cycle rejection, and atomic rollback.

## Commands And Results

| Command | Result |
| --- | --- |
| `Get-Content ...test-driven-development/SKILL.md` | Read; followed red-green TDD workflow. |
| `Get-Content .superpowers\\sdd\\task-3-brief.md` | Read as the authoritative task requirements. |
| `Get-Content apps/core/src/conversation-state/conversation-state-repository.ts` | Read the create/mutation union contract. |
| `rg --files apps/core | rg "(0024|...|conversation-state)"` | Located migration `apps/core/migrations/0024_semantic_thread_action_memory.sql`. |
| `Get-Content apps/core/migrations/0024_semantic_thread_action_memory.sql` | Read composite FKs and append-only trigger rules. |
| `Get-Content apps/core/src/memory/postgres-group-memory-repository.ts` | Read transaction/repository conventions. |
| `Get-Content apps/core/tests/postgres-group-memory-repository.test.ts` | Read scripted-client and service-gated test conventions. |
| `npm exec --workspace apps/core -- vitest run tests/conversation-state-machine.test.ts tests/postgres-conversation-state-repository.test.ts` (initial) | RED: both modules were absent, as expected. |
| Same focused command (after first implementation) | Found two ordering failures; moved stale-version and cycle validation ahead of evidence SQL. |
| `npm run typecheck` (during implementation) | Found union narrowing errors; fixed by constructing create/mutation event branches explicitly. |
| `npm exec --workspace apps/core -- vitest run tests/postgres-conversation-state-repository.test.ts` (valid mutation regression) | RED: valid mutation incorrectly raised `ConversationStateVersionConflictError`. |
| Same repository test (after fix) | GREEN: 8 passed, 1 PostgreSQL case skipped. |
| `Get-ChildItem Env:IRIS_TEST_DATABASE_URL,Env:TEST_DATABASE_URL ...` | No test database URL configured. |
| `docker compose ps --format json` | Succeeded with no running Compose services. |
| Final focused test command | PASS: 32 passed, 1 service-gated PostgreSQL test skipped. |
| `npm --workspace apps/core test` | PASS: 87 files; 1675 passed, 34 skipped. |
| Final `npm run typecheck` | PASS. |
| `git diff --check` and `git diff --cached --check` | PASS; no whitespace errors. |
| `git commit -m "feat: add conversation state lifecycle repository"` | Created implementation commit `2263cced3b8286176f4d8db7712d528b2384fc93`. |

## Self-Review

- All mutation paths require `expectedVersion`; normalized event and entity versions are constrained to exactly one increment, and SQL repeats the version predicate.
- Thread rows for the group and referenced action rows are locked with `FOR UPDATE`; evidence is rechecked against `conversation_messages.chat_id` in the transaction before state writes.
- Events and event-evidence are only inserted, never updated or deleted. Operation replays return `already_applied` only when the full batch already exists; partial replays fail closed.
- Merge chains resolve to their terminal non-merged target under the group lock and reject cycles.
- Each non-candidate entity version change inserts one pending repair. Candidate threads are excluded from answer-facing relevant-thread reads and do not enqueue repairs.
- Projection claim/complete/fail/status methods remain repository-internal privileged boundaries; this task adds no answering-path exposure or proactive speaking behavior.

## Concerns

- The real PostgreSQL integration case is present but was not executed locally: neither `IRIS_TEST_DATABASE_URL` nor `TEST_DATABASE_URL` was set, and `docker compose ps` found no running services. It will run automatically when either database URL is supplied.
- Git emitted LF-to-CRLF conversion warnings while staging the four new TypeScript files; `git diff --cached --check` still passed and no content issue was detected.

## BIGINT Driver Compatibility Update

Status: completed. Fix commit: `4c403074ea87771128dd7fb42f50fce9eda4b07d` (`fix: map conversation state bigint rows`).

- Root cause: node-postgres returns PostgreSQL `BIGINT` values as strings. The repository passed persisted `discussion_threads.version`, `action_items.version`, and `conversation_state_projection_repairs.entity_version` straight to the number-only `requireVersion` input validator.
- TDD red: converted scripted persisted versions to strings and added a mapping regression for thread, action, and repair rows. With `TEST_DATABASE_URL` enabled, the focused command failed 6 tests, including the real idempotent create replay, with `version must be a positive safe integer` from `mapThreadRow`.
- Green: added `requirePersistedVersion(value)`, which applies `Number(value)` before the unchanged `requireVersion` validator, at every persisted BIGINT version boundary, including the repair row returned by `completeProjectionRepair`.
- Verification command: `$env:TEST_DATABASE_URL='postgresql://iris:iris@127.0.0.1:5432/iris'; npm exec --workspace apps/core -- vitest run tests/conversation-state-machine.test.ts tests/postgres-conversation-state-repository.test.ts`.
  Result: 35 passed, 0 failed; the PostgreSQL integration case executed rather than skipping.
- `npm run typecheck`: passed.

Updated concern: the previously unavailable PostgreSQL service gate is no longer a concern for this fix; it was exercised successfully. The only non-functional notice remains Git's LF-to-CRLF staging warning, while `git diff --cached --check` passed.

## Review Blocker Remediation

Status: completed. Implementation commit: `1395472605f5ca81ee880946d7784355f21ffec4` (`fix: harden conversation state transactions`).

### Changes

- Enforced thread/action event entity references before opening a transaction and prohibited creating a thread in `merged` state.
- Added a group-scoped transaction advisory lock and exact cross-table operation replay checks. Only a same-type replay with matching event, entity, and evidence payload returns `already_applied`; partial, cross-type, and changed-payload replays raise `ConversationStateIdempotencyConflictError`.
- Loaded thread evidence counts under the group row lock, followed existing target merge chains, invoked `selectCanonicalMergeTarget`, and rejected intermediate or non-canonical targets.
- Made projection completion monotonic with an upsert version predicate.
- Allowed due `failed` repairs to be reclaimed, capped claims at five attempts, and kept `retryAt` effective through `next_attempt_at`.
- Excluded candidate-linked actions from answer-relevant reads while allowing candidate threads and actions in extraction context; added runtime thread-status validation.
- Extended scripted tests to verify advisory-lock, operation-key, and evidence binding parameters.
- Extended the real PostgreSQL suite with action writes, event/entity mismatch rejection, partial and cross-type conflicts, evidence-count canonical merges, candidate action visibility, retry limits, and out-of-order projection completion.

### TDD And Verification

| Command | Result |
| --- | --- |
| `npm exec --workspace apps/core -- vitest run tests/postgres-conversation-state-repository.test.ts` before implementation | RED: 11 expected failures, covering the review blockers; 10 existing tests passed and 1 PostgreSQL case was skipped. |
| Same scripted test after implementation | PASS: 21 passed, 1 PostgreSQL case skipped. |
| `$env:TEST_DATABASE_URL='postgresql://iris:iris@127.0.0.1:5432/iris'; npm exec --workspace apps/core -- vitest run tests/conversation-state-machine.test.ts tests/postgres-conversation-state-repository.test.ts` | Initial infrastructure attempt failed with `ECONNREFUSED`; Docker Desktop and the repository `postgres` Compose service were restored. Final result: 51 passed, 0 failed, 0 skipped. |
| `npm run typecheck` | PASS. |
| `npm --workspace apps/core test` | PASS: 87 files; 1688 passed, 38 service-gated tests skipped. |
| `git diff --cached --check` | PASS; no whitespace errors. |

### Self-Review And Concerns

- Every accepted state operation has exactly one matching event; operation-key replay decisions are serialized and checked against both event tables in the same transaction.
- Canonical merge selection is based on the locked source and terminal target rows plus persisted evidence counts; the repository no longer rewrites a non-canonical request.
- Failed repair retry timing, attempt exhaustion, and projection downgrade protection were exercised against real PostgreSQL.
- Scope remained limited to Task 3. No Task 4 answering or proactive-speaking path was added.
- No functional concern remains. Docker Desktop had stopped during verification but was restarted, and the final real PostgreSQL gate passed. Git continued to emit the existing LF-to-CRLF staging notice.
