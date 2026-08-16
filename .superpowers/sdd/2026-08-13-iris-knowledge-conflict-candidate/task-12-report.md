# Task 12 Report: Final Broad-Review Release Fixes

## Result

- Reviewed base: `d65da8a9b87f584f9333898bfd04c3110a359da5`.
- Implementation/tests commit: `c6927fa2999a2849981cae248030e857598f6fc6`.
- Scope was limited to the two confirmed P1 findings from the final broad review:
  authoritative conflict chronology and the candidate-bound answer send race.
- Live PostgreSQL, CI, push, PR, Feishu, Wiki, and pilot actions were not run or claimed.
  Task 12 remains open for exact-SHA CI and the approved live pilot procedure.

## P1-A: Authoritative Chronology

- Candidate persistence and current-state validation now re-read every cited
  `conversation_messages.sent_at` inside their existing transactions and lock the exact message
  rows with `FOR UPDATE OF message`.
- A candidate is current only when every cited message is strictly later than every bound current
  snapshot `fetched_at`; equality is rejected. Builder-provided timing is not trusted or persisted
  as evidence.
- Build-to-persistence and post-persistence message timestamp mutations are covered by unit
  oracles and conditional real-PostgreSQL tests. The latter proves rejection before insert and
  `chronology_stale` supersession after insert.

## P1-B: Candidate-Bound Answer Send

- Migration `0049_answer_reply_knowledge_conflict_candidate_version.sql` adds an exact immutable
  candidate-version binding. It adds the column nullable, temporarily removes only the row-level
  append-only trigger, backfills from the exact candidate foreign key and actual
  `knowledge_conflict_candidates.version`, sets `NOT NULL` plus `>= 1`, and recreates the same
  trigger. It never supplies a synthetic default; the TRUNCATE guard is never removed.
- `beginAnswerSend` uses its initial binding read only to identify the candidate lock path. It then
  follows the existing memory-before-candidate order, validates the exact bound candidate
  ID/version/status/evidence/currentness, locks the answer delivery, rechecks the receipt binding
  and group, and only then changes the delivery to `sending`.
- Dismissal and both supersession paths lock candidate before answer delivery and reject when a
  bound answer is `sending` or `reconciliation_required`. Existing conflict-card
  `external_attempting` and `outcome_unknown` protection and reconciliation semantics are
  unchanged.
- Conditional real-PostgreSQL concurrency tests cover begin-send versus dismissal and begin-send
  versus chronology-stale supersession. Unit SQL/order oracles cover candidate-before-delivery,
  both protected answer states, direct dismissal, current validation, and competing-candidate
  supersession.

## TDD RED

- Chronology command:
  `npm --workspace apps/core test -- postgres-knowledge-conflict-repository.test.ts`
  initially produced 2 expected failures, 40 passes, and 13 environment-gated skips. The
  build-to-persistence mutation was incorrectly applied, and the post-persistence mutation was
  incorrectly reported current.
- Send-boundary command:
  `npm --workspace apps/core test -- postgres-answer-reply-repository.test.ts`
  initially produced 1 expected failure, 38 passes, and 41 environment-gated skips. The fake
  lock-order oracle rejected the old delivery-before-candidate behavior with
  `AnswerReplyPersistenceError`.
- Mutation checks independently removed the competing-supersession and current-validation answer
  guards. Their focused two-state tests failed 2/2 in each mutation and returned to green after the
  guards were restored.

## GREEN Verification

- Focused repository/migration command:
  `npm --workspace apps/core test -- postgres-knowledge-conflict-repository.test.ts postgres-answer-reply-repository.test.ts migration-runner.test.ts`
  passed 117 tests, skipped 65, and failed 0 across 3 files.
- Fresh full Core: 188 files passed, 3 files skipped; 3,395 tests passed, 255 skipped, 0 failed.
- `npm --workspace apps/core run typecheck`: exit `0`.
- `npm run verify`: exit `0`, including diff check, typecheck, build, the full Core suite,
  181 Python tests, pilot tests, Compose config, 17/17 readiness checks, and pilot config.
- Pilot tests within verify: 155 passed, 1 skipped, 0 failed. The one skip accurately reports that
  the Docker daemon was unavailable for the executable pinned-Caddy boundary probe.
- `git diff --cached --check`: exit `0` before the implementation commit; line-ending notices only.

## Environment-Gated Coverage

- `IRIS_TEST_DATABASE_URL` was unset. The new real-PostgreSQL chronology, answer concurrency, and
  migration catalog/backfill/append-only tests were therefore collected but skipped.
- Docker CLI was present, but `docker version` could not reach the Docker Desktop Linux daemon
  pipe. No local database container was started and no real-PostgreSQL result is claimed.
- The migration's non-database contract still passed locally and proves no default version,
  exact-FK backfill SQL, retained TRUNCATE guard, restored row trigger, `NOT NULL`, and the positive
  version check. The conditional database test additionally inspects the trigger catalog and
  exercises UPDATE, DELETE, and TRUNCATE rejection when PostgreSQL is available.

## Explicit Non-Scope And Residual Risk

- Reviewer backlog concerning migration 0047 TRUNCATE handling and Markdown presentation was not
  changed in this release-fix wave.
- The real-PostgreSQL conditional tests must pass in exact-SHA CI or another approved PostgreSQL
  environment before the live pilot. Exact-SHA CI, approved credentials, and every live runbook
  outcome remain mandatory; local verification does not close the capability.
- The product continues to create only a governed update draft and never edits the existing Wiki
  page in place.
