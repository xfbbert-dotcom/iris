# Task 6 Report: Operator Governance API And Admin Console

## Status

DONE_WITH_CONCERNS

The Task 6 group-scoped operator API and bounded Admin Console governance surface are implemented and verified. A later formal review identified reconciliation, live-validation, audit-generation, and stale-response gaps; all were addressed in Fix Round 1 below. The only remaining local verification concern is environmental: tests that require `IRIS_TEST_DATABASE_URL` were skipped because the variable was not configured.

## Commits

- `c2024b55c1e6727c03bf458866bbbdbb2f654cf7` — `feat(core): govern knowledge conflicts`
- `bee52a331bfabf997ea56a64399302748874a2cc` — `fix(core): harden conflict governance boundaries`
- `dc1c12ac84d661d3b6587575727da7493bb78b81` — `fix(core): harden conflict governance invariants`
- This report is committed separately after verification.

## Delivered Behavior

- Adds authenticated internal routes for content-free status counts; bounded group candidate list, detail, and events; exact-version dismiss and one-delivery approval; bounded scan dead-letter list, replay, and delete; and outcome-unknown delivery reconciliation.
- Enforces group scope server-side by loading the candidate and comparing its exact group before detail, event, dismiss, or approval access. Cross-group access returns the same 404 envelope as an absent candidate.
- Reuses the existing internal bearer authentication boundary and requires `x-iris-operator` for every mutation. Mutation bodies cannot supply an actor Open ID.
- Passes exact candidate versions, stable operation keys, authenticated operator identity, and reasons into repository governance methods. Stable repository validation, not-found, version-race, operation-conflict, stale-evidence, lease, and delivery-conflict errors map to bounded HTTP envelopes.
- Matches the repository's 128-character governance-reason limit and covers the exact 128/129 boundary.
- Projects only bounded review fields and evidence identities. Candidate idempotency keys, operation keys, actor references, sent message IDs, denied content, source bodies, prompts, secrets, and raw provider errors are not exposed.
- Normalizes unknown stale reasons and dead-letter error codes to safe allowlisted values.
- Adds an Admin Console panel for global status, scoped candidate filtering, complete bounded review detail, exact target source metadata, confirmations, dismiss/approve actions, outcome reconciliation, and dead-letter recovery.
- Uses the exact document-source endpoint for target title/URI lookup, so metadata is not limited by a paginated source list.
- Binds reconciliation requests and durable facts to the exact delivery attempt, outcome, message intent, operation key, and authenticated operator. The repository compares the current attempt under the delivery lock and returns a stable 409 for stale attempts.
- Keeps global status and DLQ visibility usable before an operator selects a group, while candidate access remains group-scoped.
- Computes detail validation through an injectable live validator that reloads exact sources, checks current permission for each source, and asks the repository to validate the exact evidence/current candidate version with a fresh attestation. Approval is server-gated and UI-enabled only for `current`; stale, denied, and unavailable outcomes fail closed with bounded copy.
- Binds dead-letter replay/delete to the viewed attempt count and update generation plus a stable operation key. Append-only recovery facts retain the authenticated operator and mutation result even after the scan row is deleted.
- Uses refresh/detail/source request generations and exact group/candidate checks so older responses cannot overwrite a newer operator context. Approval confirmations name the exact group, candidate, subject, and version.
- Registers only the injected API runtime in `app.ts`; it does not compose, start, or deliver the later Task 7+ card/callback/answer/runtime work.

## TDD Evidence

### RED

- Initial API run: all 8 new API tests failed with 404 responses because the routes did not exist.
- Initial Admin Console run: all 5 new governance-panel tests failed because the panel, bounded data requests, detail view, and actions did not exist.
- Added detail-delivery coverage failed until outcome-unknown delivery state was exposed without message or failure content.
- Safety regressions failed until unknown stale/DLQ reasons were normalized and declined confirmations stopped recording success.
- Review regressions failed at the 129-character reason boundary, exact-source lookup, attempt-bound reconciliation key, and blank-group status/DLQ refresh before the follow-up implementation.
- Typecheck initially failed because a test mock narrowed `dismissCandidate` to the `applied` outcome; typing it with `KnowledgeConflictRepository["dismissCandidate"]` restored both repository outcomes.

### GREEN

- Focused API/Admin/repository regressions: 5 files passed; 95 tests passed, 10 conditional Postgres tests skipped.
- Full Core: 177 files passed, 3 conditional files skipped; 3,101 tests passed, 246 skipped.
- `npm --workspace apps/core run typecheck`: passed.
- `npm --workspace apps/core run build`: passed.
- `git diff --check`: passed.
- Final Task 6 diff from the Task 5 base changes only the five planned code/test files: 2,164 insertions and 5 deletions.

## Self-Review

- The initial independent review drove the exact 128-character reason bound, exact source lookup, blank-group global recovery visibility, and safe projections. A later formal review correctly found that client-key-only attempt binding, deferred current validation, generic reconciliation actors, unversioned DLQ recovery, and unguarded response races were insufficient; Fix Round 1 closes those gaps.
- Authorization, scope, optimistic version, idempotency, and safe-projection checks are enforced in the server route layer; the UI is not trusted for these controls.
- Mutation confirmations return a cancellation result, so declining a confirmation neither calls the API nor writes a success event.
- The diff was reviewed against Task 6 scope. It contains no Task 7+ card delivery, callback, answer injection, runtime composition, plan, spec, ledger, or brief change. Schema changes are confined to the forward `0046` migration.

## Concerns And Follow-Up

- Run the conditional live-Postgres knowledge-conflict tests in CI or another environment with `IRIS_TEST_DATABASE_URL` configured. This is a verification-environment concern, not an identified Task 6 defect.
- The live current validator is implemented and injectable now. Its later production composition remains outside Task 6; the API fails closed when the runtime is absent and never synthesizes permission from its clock.
- Reconciliation and scan-recovery mutations now persist the authenticated operator in append-only facts; no generic reconciliation actor remains.

## Fix Round 1

### Outcome

DONE_WITH_CONCERNS

Formal review round 1 is implemented in `dc1c12ac84d661d3b6587575727da7493bb78b81`. Reconciliation is attempt-bound under lock; detail and approval use real live permission reattestation plus repository current-state validation; scan recovery is generation-bound, idempotent, and attributable; reconciliation is attributable; and Admin Console responses are generation-guarded. No Task 7+ behavior was added.

### RED

- Migration/repository tests failed before implementation because the append-only scan-operation fact did not exist, recovery methods returned the old unversioned shape, and a stale attempt-1 reconciliation could mutate delivery attempt 2.
- Current-validator/API tests failed because the validator module did not exist, detail returned `requires_revalidation`, approval was not current-state gated, and strict attempt/generation mutation bodies were rejected.
- Admin tests failed because reconciliation omitted the expected attempt, approval remained enabled without `current`, DLQ mutations sent no generation body, and older refresh/source responses overwrote newer group context.
- The final changed-source regression failed because timestamp mismatch returned before live permission and durable repository supersession. The stale reviewed-version regression returned 503 instead of the required stable 409.

### GREEN And Verification

- Focused API/Admin/repository/migration regressions: 8 files passed; 162 tests passed and 17 conditional PostgreSQL tests skipped.
- Final validator/scanner/API regression pass: 3 files passed; 41 tests passed.
- Full Core after the final implementation change: 178 files passed, 3 conditional files skipped; 3,115 tests passed and 247 skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed before the code commit and after the final full test run.
- Conditional real-PostgreSQL coverage now includes catalog/append-only guards, concurrent exact replay, durable audit survival after delete, and stale attempt-1 versus current attempt-2 reconciliation. It did not execute locally because `IRIS_TEST_DATABASE_URL` is unavailable.

### Self-Review

- HTTP and repository contracts require positive expected attempt counts for reconciliation and expected attempt/update generation for DLQ recovery; neither trusts an opaque client key as the concurrency check.
- Exact idempotent replay compares all persisted operation identity, including actor and reviewed generation. Changed identity is a 409; mutations and audit facts are atomic.
- The shared permission reattestation path reloads exact source identities and runs the same live checks for scanning and operator validation. Detail failures are content-free, and approval is independently gated server-side with an exact version precheck.
- Read projections do not expose actor references, operation keys, raw evidence, denied content, sent message IDs, provider errors, or secrets.
- The UI generation guards cover global/list refresh, candidate detail, and exact source lookup; confirmation text carries the exact group, candidate, subject, and version.

### Remaining Concern

- The only concern is verification environment coverage: PostgreSQL-gated tests are present but skipped locally without `IRIS_TEST_DATABASE_URL`. No known Critical or Important implementation issue remains in this round.
