# Task 6 Report: Operator Governance API And Admin Console

## Status

DONE_WITH_CONCERNS

The Task 6 group-scoped operator API and bounded Admin Console governance surface are implemented and verified. The only local verification concern is environmental: tests that require `IRIS_TEST_DATABASE_URL` were skipped because the variable was not configured. No Critical or Important issue remains after independent re-review.

## Commits

- `c2024b55c1e6727c03bf458866bbbdbb2f654cf7` — `feat(core): govern knowledge conflicts`
- `bee52a331bfabf997ea56a64399302748874a2cc` — `fix(core): harden conflict governance boundaries`
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
- Binds reconciliation operation keys to delivery ID, attempt count, outcome, and message intent, preventing a later attempt from replaying an earlier reconciliation decision.
- Keeps global status and DLQ visibility usable before an operator selects a group, while candidate access remains group-scoped.
- Reports non-superseded detail as `requires_revalidation` and uses honest UI copy: the view does not claim that it performed live permission validation; delivery performs the live permission check.
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

- Independent review found no Critical issue. Its Task 6 findings drove the exact 128-character reason bound, exact source lookup, attempt-sensitive reconciliation key, blank-group global recovery visibility, and non-misleading current-validation copy.
- Independent re-review was CLEAN with no remaining Critical or Important findings; it separately ran 56 focused tests, typecheck, and `git diff --check` successfully.
- Authorization, scope, optimistic version, idempotency, and safe-projection checks are enforced in the server route layer; the UI is not trusted for these controls.
- Mutation confirmations return a cancellation result, so declining a confirmation neither calls the API nor writes a success event.
- The diff was reviewed against Task 6 scope. It contains no Task 7+ card delivery, callback, answer injection, runtime composition, migration, plan, spec, ledger, or brief change.

## Concerns And Follow-Up

- Run the conditional live-Postgres knowledge-conflict tests in CI or another environment with `IRIS_TEST_DATABASE_URL` configured. This is a verification-environment concern, not an identified Task 6 defect.
- A legitimate live current-state permission attestation requires the permission checker and runtime composition owned by later tasks. Task 6 therefore returns `requires_revalidation` instead of synthesizing an attestation from the API clock.
- The Task 2 reconciliation repository contract records the generic `delivery_reconciler` actor and has no human actor input. Durable per-operator reconciliation attribution would require an explicit repository/schema design change; Task 6 still authenticates and requires the operator header before allowing reconciliation.
