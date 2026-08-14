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
