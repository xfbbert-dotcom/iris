# Task 8 — managed knowledge update execution and reconciliation

## Scope and outcome

Implemented the managed-knowledge update executor, reconciler, exact sync reactivation, and an explicitly injected/default-off runtime loop. The existing publication executor remains publication-only. No live Feishu call was made, and no Task 9 Admin/readiness/environment/deployment wiring was added.

Production changes:

- Added `managed-knowledge-update-executor.ts`, `managed-knowledge-update-reconciler.ts`, and `managed-knowledge-update-executor-loop.ts`.
- Extended the managed-page repository contract and PostgreSQL adapter with exact transactional claim, durable dispatch/retry/outcome transitions, reconciliation listing, exact resync lookup, and atomic resync completion.
- Added action-proposal query filtering for update proposals before `LIMIT`.
- Extended the sync observer to attempt reactivation only through the repository's exact ready lookup and atomic transition.
- Added optional managed-update construction/lifecycle to the action-approval runtime and the stronger sync-observer repository dependency to document sync.

## Producer-contract rulings

The pre-existing producer contracts could not safely close the Task 8 loop, so the following minimal durable extensions were made:

1. `claimApprovedUpdate` now locks and revalidates the exact proposal, attestation target fingerprint, approval requirements, draft revision/version/content, candidate, target, page, source/snapshot, policy, group, permission, and runtime gates. It returns the claimed draft content from that transaction. The executor does not perform a later drifting body read. Body/token/raw remote responses are excluded from observations and status.
2. `recordRemoteOutcome` accepts a typed `pageDisposition`. Returning to `active` is restricted to a claimed/preflight-failed request plus an exact `verifiedUnchangedRemote` tuple matching token, block, old revision, and old hash. Stale/human-edit/invalid responses remain barred for reconciliation; forbidden becomes blocked; missing becomes retired.
3. `findResyncReadyExecution` and `completeResync` validate a new successful snapshot, exact source/body block/result revision/after hash, usable permission, current page/execution versions, remote-applied proposal state, and absence of later unresolved work. Completion atomically inserts the immutable `knowledge_publication_updates` success fact, marks proposal/action execution succeeded, and appends execution/page/proposal/action events.
4. Claim uses the same source-scoped advisory lock as answer-send before taking the page row lock. A partial unique index remains the durable final guard against two unresolved executions for one page.

## Safety properties verified in implementation

- New claims are listed and claimed only when deployment/global/group/write/update gates all pass. The action type and group allowlist are applied before `LIMIT`. Reconciliation of already uncertain work does not depend on the live capability gate.
- Claim is a short database transaction. Token acquisition, block preflight, Feishu mutation/readback, and sync enqueue happen after it commits.
- Preflight requires exact bound document token, block ID, positive revision, text block type, and before hash. Claim data is also checked as a self-consistent durable tuple before any remote read.
- Client tokens are deterministic UUID-format values derived inside the repository from durable execution operation identity. Dispatch is durably marked before mutation. One exact-old readback can acquire one durable same-token retry; there is no blind retry.
- Applied writes record result revision and expected proposed hash before the exact source is enqueued. Queue failure and commit/outcome uncertainty retain a reconciliation barrier.
- Outcome-unknown and stale `remote_request_dispatched` executions are discovered durably. Proposed-hash plus compatible advanced revision proceeds to resync; exact old hash plus exact old revision permits the one durable retry; human edits, unexpected revision/hash, missing, and unreadable states remain barred.
- A sync callback that arrives before the outcome commit records its observation but cannot reactivate. A later reconciler pass retries the exact observation after the remote-applied fact exists.
- Runtime construction is default-off and requires the explicit deployment config and sync queue. Start order is planner, dispatcher, publication executor, managed updater; stop is the reverse. The loop always runs the reconciler after the executor attempt, including when new-work capabilities are disabled.
- Agent observations use `iris.knowledge.updateManagedPublication` and carry IDs, versions, state, and reason code only.

## TDD record

The implementation was developed in three RED/GREEN slices:

### Executor and repository contract

- RED: executor module missing; GREEN: initial executor suite 14/14.
- RED: update-proposal SQL applied group filtering after selection; GREEN: action type and allowlist are bound before `LIMIT`.
- RED: claim lacked exact transaction-bound body/fingerprint/gate validations; GREEN: exact-claim repository tests 2/2, followed by configured PostgreSQL race coverage.
- RED: old outcome transition reopened `active` for all preflight/failed outcomes; GREEN: typed disposition tests 4/4 and exact unchanged-remote proof.
- RED: update claim lacked the answer-send source lock; GREEN: source advisory-lock ordering test.
- RED: executor accepted an inconsistent claimed durable tuple; GREEN: executor suite 15/15 with no preflight/update on binding mismatch.

### Reconciler and sync

- RED: reconciler module missing; GREEN: initial reconciler suite 7/7.
- RED: observer recorded snapshots without exact ready lookup; GREEN: observer/reconciler suite 21/21.
- RED: repository had no exact new-snapshot resync transition; GREEN: lookup/completion SQL contract tests and configured-PostgreSQL success-fact fixture.
- RED: enqueue failure after applied was reported as applied; GREEN: durable reconciliation-required outcome.
- RED: stale dispatched work had no cutoff-bound retry claim; GREEN: reconciler 9/9 plus repository cutoff contract.
- Race fixtures cover duplicate executor, two proposals for one page, human edit, and sync-before-outcome-commit. Real transaction races are in configured-PostgreSQL tests, not SQL-substring simulations.

### Runtime

- RED: managed update runtime was not constructed; GREEN: explicit/default-off construction and lifecycle suite 6/6.
- RED: missing sync queue still constructed network dependencies; GREEN: runtime omits the managed update path unless deployment and queue dependencies are present.
- RED: loop module missing; GREEN: loop suite 2/2, including recovery despite executor gate/error behavior.

## Verification

- Focused Task 8 suite: **8 files passed; 81 passed, 23 skipped (104 total)**.
  - `managed-knowledge-update-executor.test.ts`: 15/15
  - `managed-knowledge-update-reconciler.test.ts`: 9/9
  - `managed-knowledge-sync-observer.test.ts`: 14/14
  - `action-approval-runtime.test.ts`: 6/6
  - `managed-knowledge-update-executor-loop.test.ts`: 2/2
  - repository/document-runtime suites included in the merged run
- `npm run typecheck`: **passed** (`tsc --noEmit`)
- `git diff --check`: **passed** (only the worktree's existing LF-to-CRLF notices)
- `npm test -- --reporter=dot` (single full run): **passed** — 199 files passed / 3 skipped; 3,647 tests passed / 286 skipped (3,933 total). npm emitted its known unknown-CLI-config warning for `--reporter`, but Vitest completed with exit code 0.

## PostgreSQL configured-test status

`IRIS_TEST_DATABASE_URL` / `DATABASE_URL` was not configured in this environment. Therefore 23 configured-PostgreSQL cases were skipped, including the real concurrent duplicate-claim, same-page/two-proposal convergence, and exact remote-applied-to-resync-success-fact transaction fixtures. The non-database suite checks SQL shape as a contract only and is not reported as real concurrency evidence.

## Self-review and follow-up concerns

- No Task 9 environment variables, Admin UI, readiness surface, or deployment enablement were added.
- The current document sync queue reason union has no managed-update-specific value, so the executor uses the existing `manual_source_sync` reason while preserving the exact linked source ID. A dedicated reason is a non-blocking follow-up if operational attribution requires it.
- The only unresolved local verification gap is execution against a configured PostgreSQL instance; the fixtures are present and intentionally skipped without a database URL.
- Independent completion review found no Critical or Important issue and assessed the change ready; its targeted review run passed 61 tests with 1 configured-PostgreSQL skip.

## Fix Round 1/5 — approval lifecycle, crash recovery, loser convergence, and success identity

Review found one Critical and three Important gaps. This round fixed all four without adding Task 9 Admin/readiness/environment/deployment behavior and without making live Feishu calls.

### RED / GREEN record

- Initial Fix Round 1 RED: **6 files, 22 failed / 46 passed / 23 skipped**. Failures demonstrated the mutable binding-version dead end, missing explicit update review, missing stale-claimed recovery, non-terminal competing claims, and missing durable approval/executor identity.
- F1 lifecycle GREEN:
  - `target.draftVersion` remains an immutable binding-time audit fact; list/review/claim no longer equate it to the later mutable draft header version.
  - `update_knowledge_publication` always has an explicit OAuth-reviewable requirement, including low-risk group-confirmed updates. Publication requirements are unchanged.
  - Listing validates current page/candidate/interaction/source/snapshot/policy/draft eligibility before `LIMIT`.
  - Claim proves the exact action approval, satisfied requirement source, active approval presentation, approval-time review attestation/content/target fingerprint, and the legal `approval_recorded` / `requirements_satisfied` / `review_approved` version chain.
  - The configured-PostgreSQL lifecycle fixture now uses production draft, managed target, knowledge-card confirmation, action-proposal, review-attestation, approval, list, and claim repository APIs. It no longer fabricates an approved proposal or attestation with direct inserts.
- F2 stale-claim GREEN: cutoff-bound `claimed` executions are recovered by exact preflight, durable dispatch, and the stable execution token. Mismatch/unavailable preflight remains barred; an uncertain result enters reconciliation rather than blind retry.
- F3 loser GREEN: claim atomically fails approved same-page losers and appends `execution_failed/competing_execution`. Typed terminal replay prevents approved-proposal starvation. The configured-PostgreSQL race performs two real concurrent claim transactions and asserts one applied winner, one durable failed loser, one unresolved execution, and no loser returned with `LIMIT 1`.
- F4 identity GREEN: migration `0055_managed_update_execution_identity.sql` adds exact `approval_id` and original mutation `executor_id`. Existing identity-less rows remain readable; a trigger rejects every new identity-less insert. Claim stores both identities, and exact resync writes them into the immutable success fact while the resync completer is only the event actor.

### Fix Round 1 verification

- The original Fix Round 1 artifact recorded only the three focused-suite file/test totals, not the
  exact command lines that produced them. Those command lines cannot be reconstructed faithfully
  from the report or commit history, so this report does not invent them. The pre-existing Task 8
  plan's final focused command was
  `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-update-executor.test.ts tests/managed-knowledge-update-reconciler.test.ts tests/managed-knowledge-sync-observer.test.ts tests/action-approval-runtime.test.ts`; it is retained as plan context, not claimed as the unrecorded Fix Round 1 command.
- Final merged focused suite before the configured race fixture: **10 files passed; 132 passed / 34 skipped**.
- Final repository-focused suite after adding the configured race fixture: **6 files passed; 105 passed / 34 skipped**.
- Final migration/repository check after making persisted identities immutable: **2 files passed; 55 passed / 12 skipped**.
- `npm run typecheck`: **passed**.
- `git diff --check`: **passed** (only LF-to-CRLF notices).
- A second full run was warranted because this round changed approval lifecycle and migration behavior: **199 files passed / 3 skipped; 3,654 passed / 287 skipped (3,941 total)**. The known npm `--reporter` warning remained non-fatal.
- The configured race fixture was added after the full run; only tests changed afterward, so the requested focused/typecheck/diff gates were rerun instead of a third full run.

### PostgreSQL gate and remaining concerns

- No `IRIS_TEST_DATABASE_URL` or `DATABASE_URL` is configured locally. Therefore the production-API lifecycle, 0055 compatibility, and real same-page concurrent-claim fixtures are present but skipped here; they remain a configured-PostgreSQL CI gate rather than being represented by SQL-substring concurrency tests.
- Reviewer minors remain follow-up backlog per the project exit rule: explicit-transient retry has no bounded backoff, and request-fingerprint self-check does not recompute the stored fingerprint. Neither is a blocker for the four reviewed correctness gaps.
