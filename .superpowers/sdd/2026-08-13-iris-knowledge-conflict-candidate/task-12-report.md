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

## Exact-SHA CI Follow-Up: Post-Restore Knowledge-Card Readiness

- Failed CI evidence: PR #32 run `31957347139`, Core job `95189870218`, exact head
  `82b44005809f43bf81f62ec4cc097e30bd8c7bb4`. The paired backup/restore drill reached
  `npm run pilot:smoke -- --post-restore` and rejected the live readiness detail.
- Root cause: the live smoke still required the legacy detail
  `Knowledge cards are safely disabled.` while the restored application correctly returned the
  stronger durable-state proof
  `Knowledge cards are safely disabled with empty durable work.` after reading zero unresolved
  PostgreSQL and Redis counts.
- Implementation/tests commit: `f3014fa542f948e2e000a458e9d279c8e5934b0c`.
- Scope stayed limited to the live smoke contract and its test fixture. Core product code and the
  readiness implementation were not changed.

### TDD And Verification

- RED:
  `node --test --test-name-pattern "default-off knowledge-card readiness|legacy weak knowledge-card" scripts/pilot-smoke-lib.test.mjs`
  exited `1`: 2 tests failed. The strong detail was rejected and the legacy weak detail was
  accepted.
- GREEN: the same focused command passed 2/2, and
  `node --test scripts/pilot-smoke-lib.test.mjs` passed 43/43.
- Independent `npm run test:pilot`: exit `0`; 157 tests, 156 passed, 0 failed, 1 skipped. The only
  skip was the executable pinned-Caddy boundary probe because the Docker daemon was unavailable.
- Fresh `npm run verify`: exit `0`, including diff check, typecheck, build, Core tests, Python
  tests, pilot tests, Compose config, readiness, and pilot config. Core passed 188 files and 3,395
  tests with 3 files and 255 environment-conditional tests skipped because
  `IRIS_TEST_DATABASE_URL` was unset; Python passed 181/181; pilot again passed 156/157 with the
  same single Docker-daemon skip.
- Final diff inspection found exactly the two intended smoke files, no Core product-code change,
  no whitespace error, and zero bounded `.tmp-iris-*-test-*` fixture directories.
- No push, PR mutation, or live pilot was performed in this follow-up.

## Exact-SHA Live Acceptance

- Accepted build: commit `dd7461459e476aa6843c5c34ea775855832c8a27`, image digest
  `sha256:403366a17bd8baded6a561c38d35b873ae646709d6705af3e16173ec8424499b`.
- The first live attempt correctly failed closed at Step 7. Its ordinary answer contained model
  instruction leakage instead of the bounded deterministic conflict answer. The controller stopped
  public ingress and completed the same default-off rollback before any retry.
- A focused TDD regression proved the renderer defect. Commit
  `dd7461459e476aa6843c5c34ea775855832c8a27` now returns the validated conflict plan's bounded
  proposed answer without another model call; non-conflict rendering remains unchanged.
- Pre-deployment `npm run verify` exited `0`: Core 3,417 passed / 258 environment-gated skipped,
  Python 181 passed, pilot contracts 159 passed / 1 accurate local-Docker skip, plus typecheck,
  build, Compose, readiness, pilot config, and diff checks.
- The final controller run passed all twelve gates. It verified the exact source/snapshot/message
  chronology, one current candidate, one card delivery, an ordinary two-sided/no-winner answer,
  duplicate no-effect, one governed medium-risk draft, six stage/cause revocation cases, nonpilot
  controls, zero unresolved delivery/presentation/action state, and append-only preservation.
- The real member created the draft from the Feishu card and rejected it through the governed card
  path. PostgreSQL ended with one applied draft interaction, one distinct draft, a terminal rejected
  draft, a closed presentation, and zero unresolved answer or card delivery state.
- Final rollback proof: all three feature flags false, all three allowlists empty, five sensitive
  runtime capabilities false, global and desired-global runtime false, Caddy stopped, Core healthy,
  conflict runtime stopped, card queue/presentation/outbox residual counts zero, and 14 known groups
  durably disabled.
- Controller summary: `result=pass`, `failedStep=null`, `rollbackPass=true`, recorded at
  `2026-08-17T17:22:55.6594565Z`. Private evidence SHA-256 is
  `3fd5f17401c49f50de25b6be76fbc28e46553d0f2f221daa1505e50632c9402d`; summary SHA-256 is
  `f6ffa487b131179f7a38295cd4ff694524cd52bae96a0a1acf329586291e7f0e`.
- The evidence committed here is metadata-only. Group IDs, source text, prompts, callback payloads,
  credentials, and authorization material remain outside the repository. The capability stays
  default-off; this result closes the first one-group acceptance, not a broad rollout.
