# Task 2 Execution Report

## Status

DONE_WITH_CONCERNS

Task 2 is implemented and committed. Focused tests, the full Core regression suite, Core typecheck, and the production build pass. The concern is limited to environment evidence: `IRIS_TEST_DATABASE_URL` was not configured and Docker was unavailable, so the repository's conditional live-Postgres cases were skipped locally rather than executed.

## Commits

- Implementation: `d4790365ef2711f88cc2ec25188049f2fb089fe2` (`feat(core): persist knowledge conflict lifecycle`)
- This report is committed separately so it can record the immutable implementation commit SHA.

## Scope delivered

- Added durable scan discovery from eligible current group memories, deduplication by corrected `(group_memory_id, memory_updated_at)` identity, `FOR UPDATE SKIP LOCKED` claiming, expired-lease recovery, owner-only completion/failure, retry/dead-letter behavior, replay, deletion, and status counts.
- Added atomic conflict detection persistence: the claimed scan, candidate, exact evidence set, initial append-only event, and terminal scan result are committed in one transaction.
- Added strict persistence validation for the approved conflict plan and exact evidence identities, including source message, group memory, document source timestamp, target snapshot/hash/version, fragments, and duplicate identities.
- Added idempotent candidate creation and operation replay/conflict handling, current-state revalidation with fresh permission attestation, deterministic supersession, governed dismiss/approval transitions, append-only events, and competing-candidate supersession.
- Added one-delivery-per-candidate outbox creation and lifecycle: claim, lease, external-attempt boundary, sent completion, retryable/permanent failure, outcome-unknown quarantine, reconciliation, and delivery counts. Unresolved external attempts block unsafe competing-candidate supersession.
- Added durable interaction identity and atomic interaction application for dismissal and draft creation, including replay semantics and interaction counts.
- Added exact current overlap reads constrained by current evidence and live permission attestation.
- Extended the repository contracts and domain evidence/candidate models required by the Task 2 lifecycle.
- Corrected forward migration `0046` only for approved Task 1 prerequisites: scan outcomes `superseded`/`permission_blocked`, exact target source timestamp and optional version, required `document_source.source_updated_at`, and outbox retry/reconciliation state. Migrations `0001` through `0045` were not touched.

## Files

- `apps/core/migrations/0046_knowledge_conflict_candidates.sql`
- `apps/core/src/knowledge-conflicts/knowledge-conflict-repository.ts`
- `apps/core/src/knowledge-conflicts/knowledge-conflict.ts`
- `apps/core/src/knowledge-conflicts/postgres-knowledge-conflict-repository.ts`
- `apps/core/tests/migration-runner.test.ts`
- `apps/core/tests/postgres-answer-reply-repository.test.ts`
- `apps/core/tests/postgres-knowledge-conflict-repository.test.ts`
- `.superpowers/sdd/2026-08-13-iris-knowledge-conflict-candidate/task-2-report.md`

## TDD RED evidence

Behavior was introduced in failing increments before implementation:

1. Initial adapter test import failed because `postgres-knowledge-conflict-repository.ts` did not exist (exit 1).
2. Candidate/governance tests then failed on ten missing repository methods (exit 1).
3. Self-review tests exposed three behavioral gaps at once: scan/candidate identity mismatch acceptance, permanent delivery failure being reclaimable, and stale target snapshot hash acceptance (three failures, exit 1).
4. A competing-candidate test showed that unresolved `external_attempting`/`outcome_unknown` delivery state did not block supersession (one failure, exit 1).
5. An interaction test showed that candidate transition and interaction recording were not atomic (one failure, exit 1).
6. An evidence test showed current-state validation checked only the target source rather than every persisted `document_source` reference (one failure, exit 1).

Each RED was followed by the smallest repository or migration change needed to make that behavior pass. Real database assertions remain conditional on `IRIS_TEST_DATABASE_URL`; no SQL source-text assertion was substituted for repository behavior.

## GREEN and verification evidence

### Focused Task 2 and adjacent suites

Command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/migration-runner.test.ts tests/postgres-answer-reply-repository.test.ts
```

Result: exit 0; 4 files passed; 100 tests passed and 50 conditional tests skipped.

The new repository suite alone finishes with 23 tests: 20 passed and 3 live-Postgres tests skipped without `IRIS_TEST_DATABASE_URL`.

### Full Core regression

Command:

```text
npm --workspace apps/core test
```

Result: exit 0; 172 files passed and 2 files skipped; 2,985 tests passed and 235 tests skipped (3,220 total).

### Typecheck

Command:

```text
npm --workspace apps/core run typecheck
```

Result: exit 0 (`tsc --noEmit`).

### Production build

Command:

```text
npm --workspace apps/core run build
```

Result: exit 0 (`tsc --project tsconfig.build.json`).

### Diff validation

`git diff --cached --check` exited 0 before the implementation commit. Git emitted only the repository's Windows line-ending conversion warnings.

## Self-review

- Confirmed scan conflict completion cannot bypass atomic candidate/evidence/event persistence: `completeScan` excludes the `conflict` outcome and `recordDetectionResult` owns that transaction.
- Confirmed candidate identity is bound to the claimed scan's group memory and exact updated timestamp.
- Confirmed all evidence kinds are validated at persistence and current-state boundaries, including all document-source references rather than only the target.
- Confirmed stale memory/message/source/snapshot/hash/version/fragment/permission facts supersede instead of allowing governance or overlap results to proceed.
- Confirmed terminal permanent delivery failures cannot be reclaimed and unresolved external outcomes remain quarantined for reconciliation.
- Confirmed idempotency operation keys replay identical writes and reject payload conflicts.
- Confirmed counters distinguish retryable and terminal failures and retain the approved lifecycle states.
- Confirmed no Task 3 runtime/orchestration, API, worker loop, card, or UI behavior was added.

## Concerns and follow-up

- Live Postgres could not be started in this environment. Before integration or deployment, run the conditional migration/catalog and repository integration tests with `IRIS_TEST_DATABASE_URL` pointing at an isolated PostgreSQL database. The tests create an isolated schema and exercise discovery, claiming/lease recovery, candidate persistence/governance, delivery, interaction, overlap, and supersession against the real schema.
- The repository implementation is deliberately broad because Task 2 defines the complete durable lifecycle. Non-blocking refactoring should wait until the live database suite is exercised; no further hardening is required to proceed to that acceptance gate.

## Fix Round 1

### Status and commit

DONE_WITH_CONCERNS

- Code and test commit: `d0ec85bae8d483e05e684d0b42c14a056c8b6cd4` (`fix(core): harden knowledge conflict persistence`)
- Base reviewed: `ec88521fee55805beb6cb88c8684aa48828ed7eb`
- The remaining concern is unchanged: `IRIS_TEST_DATABASE_URL` is not configured and Docker is unavailable, so the new real-Postgres cases are present but were skipped locally.

### Review findings resolved

1. Discovery now selects ungrouped eligible memory identities with an `EXISTS` evidence predicate. The anti-join is composed inside the `WHERE` clause, and `FOR UPDATE OF gm SKIP LOCKED` applies to lockable memory rows.
2. Current-state validation locks the delivery outbox before superseding stale candidates and rejects supersession while delivery is `external_attempting` or `outcome_unknown`, preserving truthful sent reconciliation.
3. Detection persistence now requires every cited message to belong to the claimed memory's `group_memory_message_evidence`, requires exact source/snapshot/fragment fact chains for every document reference, revalidates every latest snapshot, and requires a currently enabled publication policy whose space is authorized for the source group.
4. `findCurrentOverlap` now locks candidate projections, loads evidence, and revalidates all memory/message/source-policy/source-timestamp/snapshot/version/fragment facts through one database transaction.
5. Delivery reconciliation is append-only per external attempt. A new `knowledge_conflict_delivery_reconciliations` fact table retains all operation identities; starting a later external attempt clears only the outbox's latest-reconciliation projection. Repeated outcome-unknown cycles can therefore each be reconciled and old operation keys remain replayable.
6. Stale scan cleanup now leaves a processing scan untouched until its lease has expired. Pending/retry rows remain cleanup-eligible, and expired processing rows remain recoverable.
7. Candidate transitions, approvals, interaction recording, atomic callback application, and reconciliation serialize identical operation keys with transaction-scoped advisory locks before replay checks. This converts concurrent exact duplicates into deterministic `already_applied` results instead of version or uniqueness errors.
8. The public repository no longer exposes `createCandidate` or generic `transitionCandidate`; candidate creation remains coupled to claimed-scan completion and governance remains constrained to the dedicated methods.
9. Migration changes remain limited to forward migration `0046`; migrations `0001` through `0045` were not modified. No Task 3 runtime, API, worker, card, or UI behavior was added.

### RED evidence

Command:

```text
npm --workspace apps/core exec vitest run -- tests/postgres-knowledge-conflict-repository.test.ts
```

Initial result: exit 1; 6 focused failures, 20 passes, and 3 conditional skips.

The six observed failures reproduced:

- unsafe `createCandidate`/`transitionCandidate` public methods;
- acceptance of a same-group message not bound to the claimed memory;
- acceptance of a document snapshot without an exact source fact;
- inability to reconcile a second unknown external attempt;
- overlap evidence loading outside the transaction;
- stale-candidate supersession while delivery outcome was unresolved.

The real-Postgres regressions for malformed discovery SQL, a genuinely held competing row lock, live-lease cleanup, current policy enforcement, concurrent replay, repeated reconciliation, and stale non-target overlap were added under the repository's conditional isolated-schema convention. They could not produce local RED output because the database URL is absent; unlike the earlier scripted cases, they execute migrations and actual PostgreSQL locking/transaction behavior whenever `IRIS_TEST_DATABASE_URL` is provided.

### GREEN and full verification evidence

Focused Task 2 and adjacent command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/migration-runner.test.ts tests/postgres-answer-reply-repository.test.ts
```

Result: exit 0; 4 files passed; 106 tests passed and 51 conditional tests skipped.

The repository suite now contains 30 tests: 26 deterministic tests passed and 4 isolated-schema PostgreSQL tests skipped locally. The database cases now include an actual held lock rather than sequential claims and exercise concurrent duplicate calls with separate pool connections.

Full Core command:

```text
npm --workspace apps/core test
```

Result: exit 0; 172 files passed and 2 files skipped; 2,991 tests passed and 236 tests skipped (3,227 total).

Typecheck:

```text
npm --workspace apps/core run typecheck
```

Result: exit 0 (`tsc --noEmit`).

Production build:

```text
npm --workspace apps/core run build
```

Result: exit 0 (`tsc --project tsconfig.build.json`).

Diff validation:

- `git diff --check`: exit 0 before staging.
- `git diff --cached --check`: exit 0 before commit.
- Only Windows line-ending conversion warnings were emitted.

### Fix-round self-review

- Re-read every review finding against the resulting transaction and lock order.
- Confirmed discovery no longer uses an aggregate query and its anti-join is syntactically inside `WHERE`.
- Confirmed candidate and callback operation-key locks are acquired before replay checks; same-key operations serialize even when they target different candidate rows.
- Confirmed current validation and competing detection use the same unresolved-external-outcome quarantine rule.
- Confirmed the second reconciliation does not overwrite or delete the first reconciliation fact.
- Confirmed overlap uses the same full exact-evidence validator as approval/callback current-state checks and does not perform a second top-level data-source read.
- Confirmed the conditional integration fixture has an enabled group-scoped publication policy and two document sources, allowing stale non-target evidence to be exercised.
- Confirmed the migration catalog test checks reconciliation append-only triggers and behavior against PostgreSQL when configured.
- Confirmed the work did not alter migrations `0001` through `0045` or expand into Task 3.

## Fix Round 2

### Status and commit

DONE_WITH_CONCERNS

- Code and test commit: `ae04f51785641209cd49ec56678d8f69a40ad7b1` (`fix(core): serialize conflict policy and overlap locks`)
- Base reviewed: `b8847d8a5dda9056e3993ede9e45290e229308f0`
- The only concern is environmental: `IRIS_TEST_DATABASE_URL` is not configured, so the isolated-schema PostgreSQL cases—including the two new concurrency regressions—were skipped locally.

### Review blockers resolved

1. Publication authorization is now explicit and fail-closed. Candidate persistence and current-state/overlap validation first lock the exact document source, then select the enabled policy rows for the source's authorized space with `$groupId = ANY(allowed_group_ids)` and `FOR UPDATE`. An empty `allowed_group_ids` no longer authorizes any group. Locking every matching policy row prevents a concurrent disable or group removal from committing past the authorization check before the surrounding transaction completes.
2. `findCurrentOverlap` now acquires all requested group-memory row locks in deterministic `id` order before selecting and locking candidates. This matches detection's memory-before-candidate order, retains the single transaction and full freshness validation, and removes the candidate-to-memory versus memory-to-candidate blocking inversion.
3. The conditional PostgreSQL suite now verifies empty-policy denial during persistence and overlap, observes a concurrent policy mutation blocked on the held authorizing-policy row lock, and coordinates overlap with a competing detection to prove that overlap has not locked the candidate while it waits for the memory. The concurrent operations then complete with the newly persisted candidate as the current result and without `40P01`.
4. No migration changed in this round, migrations `0001` through `0045` remain untouched, and no Task 3 runtime/API/worker/card behavior was added.

### RED evidence

Command:

```text
npm --workspace apps/core exec vitest run -- tests/postgres-knowledge-conflict-repository.test.ts
```

Initial result: exit 1; 2 focused failures, 27 passes, and 4 conditional skips.

- `denies persistence when no enabled policy explicitly allows the source group` resolved with `outcome: applied` instead of rejecting `source_stale`, demonstrating the fail-open policy path.
- `locks overlap memories before candidate rows` rejected with `Error: candidate locked before memory`, demonstrating the inverse lock order.

The empty-policy overlap regression was also test-first but already returned `undefined` in the routed double because the old combined source/policy query matched its no-policy route. The real PostgreSQL cases were added to exercise the actual policy predicate and lock behavior; they could not produce local RED output without `IRIS_TEST_DATABASE_URL`.

### GREEN and verification evidence

Focused repository command:

```text
npm --workspace apps/core exec vitest run -- tests/postgres-knowledge-conflict-repository.test.ts
```

Result: exit 0; 29 deterministic tests passed and 6 conditional PostgreSQL tests skipped (35 total).

Focused Task 2 and adjacent command:

```text
npm --workspace apps/core exec vitest run -- tests/knowledge-conflict.test.ts tests/postgres-knowledge-conflict-repository.test.ts tests/migration-runner.test.ts tests/postgres-answer-reply-repository.test.ts
```

Result: exit 0; 4 files passed; 109 tests passed and 53 conditional tests skipped (162 total).

Full Core command:

```text
npm --workspace apps/core test
```

Result: exit 0; 172 files passed and 2 files skipped; 2,994 tests passed and 238 tests skipped (3,232 total).

Typecheck and production build:

```text
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
```

Result: both exit 0 (`tsc --noEmit`; `tsc --project tsconfig.build.json`).

Diff validation:

- `git diff --check`: exit 0 before staging.
- `git diff --cached --check`: exit 0 before the code/test commit.
- Git emitted only the repository's Windows line-ending conversion warnings.

### Fix-round self-review

- Compared authorization behavior with the existing action-proposal policy semantics: group-scoped work now requires explicit membership, including when `allowed_group_ids` is empty.
- Confirmed source then policy locking is identical in persistence and shared current-state validation; all matching policies are ordered and locked before snapshot/fragment or candidate mutation work continues.
- Confirmed overlap pre-locks memories in deterministic order and only then locks candidates; its later memory freshness query is a same-transaction re-lock, not an inversion.
- Confirmed the PostgreSQL policy test holds the repository transaction after its real `SELECT ... FOR UPDATE`, observes the separate mutation backend waiting on a row lock, and only then releases the repository transaction.
- Confirmed the PostgreSQL cross-operation test holds detection's memory lock, starts overlap, verifies the old candidate remains immediately lockable with `NOWAIT`, then releases detection and asserts both operations complete with the corrected candidate current.
- Confirmed exact evidence validation, unresolved-delivery quarantine, replay handling, scan lifecycle, and all other round-1 fixes were left unchanged except for the required shared policy and lock-order paths.
