# Task 9 Report: Current Conflicts In Grounded Answers And Receipts

## Status

DONE_WITH_CONCERNS

Task 9 is implemented and committed. Deterministic answer-time conflict injection, bounded conflict
rendering, candidate identity propagation, and append-only answer-receipt binding pass the focused,
relevant, and full Core gates. The remaining concern is environmental: `IRIS_TEST_DATABASE_URL` was
unset, so the conditional live-PostgreSQL cases were skipped locally. No live Feishu answer or
PostgreSQL integration is claimed.

## Implementation Commit

- `b8f0396675448ae66bc13734fdd54b15d4d3200e` — `feat(core): expose conflicts in grounded answers`
- This report is committed separately so it records the immutable implementation SHA.

## Delivered Behavior

- Added a deterministic `createConflictEvidencePlan` application builder. It requires the exact
  candidate ID, one `M*` group premise, one `D*` document premise, an explanation, no missing
  information, and medium/high confidence.
- Extended the application evidence state and renderer to accept `conflict`, while keeping the
  OpenAI-compatible evidence-planner schema and JSON parser restricted to `explicit`,
  `complete_inference`, `partial`, and `none`. The orchestrator also rejects a conflict state that
  does not come from the deterministic provider.
- Added `KnowledgeConflictAnswerProvider`. It considers only the first eight group memories and first
  twelve answer fragments, loads source metadata before any candidate text, requires a current
  authorized Wiki source and a fresh live permission check, and queries the repository only with
  exact group-memory and source/snapshot identities.
- The provider accepts only current, non-dismissed candidate states and defensively rechecks the exact
  group, memory, source, snapshot, conflict statements, and medium/high confidence before building the
  plan. Its explanation separates current synchronized knowledge, the newer group conclusion, and the
  material difference; it does not use the candidate's suggested update as a resolution.
- The answer orchestrator runs the conflict lookup after context assembly and permission filtering but
  before evidence-planner sampling. Exact overlap skips planner sampling, still uses the bounded
  renderer, exposes only `D*` document citations, and records the candidate ID in the result and
  content-free turn-completed metadata. Ordinary/direct/permission-blocked behavior is unchanged.
- The production answer runtime composes the provider only when source-policy metadata, a live Feishu
  permission checker, and a transactional PostgreSQL data source are available. Task 10 remains
  responsible for the complete feature runtime/config/status/readiness lifecycle.
- Threaded the optional candidate ID through Feishu answer preparation and the durable delivery
  service. Preparation validation includes it in the semantic fingerprint and preserves it during
  permission rechecks and state transitions.
- PostgreSQL preparation stores the candidate foreign key and inserts exactly one append-only
  `answer_reply_knowledge_conflicts` row in the same transaction. Exact replay returns the existing
  receipt; changed or removed candidate identity conflicts.
- The authenticated internal receipt API returns the content-free candidate ID and does not expose
  candidate statements, plans, prompts, or raw provider content.
- No Task 10 runtime-control/config/status behavior was implemented and no migration was modified.

## TDD Evidence

### Initial RED

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts knowledge-conflict-answer-provider.test.ts answer-draft-orchestrator.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts feishu-mention-answer-responder.test.ts answer-reply-delivery-service.test.ts postgres-answer-reply-repository.test.ts
```

Exit 1: 6 files failed and 2 passed; 11 tests failed, 272 passed, and 41 conditional PostgreSQL
tests skipped. Failures proved the missing deterministic builder/provider, missing orchestrator
override/result metadata, renderer rejection, and absent preparation identity propagation.

### Focused GREEN

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts knowledge-conflict-answer-provider.test.ts answer-draft-orchestrator.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts feishu-mention-answer-responder.test.ts answer-reply-delivery-service.test.ts postgres-answer-reply-repository.test.ts answer-reply-api.test.ts
```

Exit 0: 9 files passed; 296 tests passed and 41 conditional PostgreSQL tests skipped.

## Relevant Regression Evidence

```powershell
npm --workspace apps/core test -- evidence-plan.test.ts knowledge-conflict-answer-provider.test.ts answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts openai-compatible-evidence-planner.test.ts openai-compatible-grounded-answer-renderer.test.ts feishu-mention-answer-responder.test.ts answer-reply-delivery-service.test.ts answer-reply-receipt-validator.test.ts postgres-answer-reply-repository.test.ts answer-reply-api.test.ts postgres-knowledge-conflict-repository.test.ts knowledge-conflict-current-validator.test.ts knowledge-conflict-api.test.ts knowledge-conflict-interaction-worker.test.ts
```

Exit 0: 15 files passed; 447 tests passed and 54 conditional PostgreSQL tests skipped.

## Final Repository Gates

```powershell
npm --workspace apps/core test
```

Exit 0: 184 files passed and 3 conditional files skipped; 3,297 tests passed and 250 skipped
(3,547 total).

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

All exited 0. Diff checks emitted only the repository's LF-to-CRLF checkout warnings and no
whitespace errors.

## Self-Review

- Verified permission ordering is source metadata, local current-source policy, live permission,
  then candidate repository/text access.
- Verified candidate overlap is exact on group, group-memory ID, document-source ID, and snapshot ID,
  with currentness delegated to the durable repository transaction and defensively checked again.
- Verified the model planner cannot originate `conflict`; only the deterministic wrapper can attach
  the exact candidate ID.
- Verified the conflict renderer instruction requires a visible conflict label, separated premises,
  material difference, reviewed update-draft path, no winner, no merge, and no confidence increase.
- Verified only document premises become public citations and the candidate ID stays content-free
  metadata.
- Verified receipt replay identity includes the candidate, the append-only link is inserted in the
  preparation transaction, and the internal API exposes only the ID.
- Verified migrations `0001` through the current forward migrations are untouched and no Task 10+
  scope was added.

## Concerns

- `IRIS_TEST_DATABASE_URL` was unset. The real PostgreSQL insert/FK/append-only/replay tests were
  present but skipped, so SQL execution against PostgreSQL remains a Task 12/CI gate.
- No live Feishu mention answer, permission recheck, or receipt inspection flow was exercised.
- Task 10 must complete the feature-enabled/allowlisted runtime lifecycle and readiness wiring before
  this capability is pilot-ready.

## Fix Round 1/5: Final-Send Currentness And Permission Time

### Disposition

Both independent P1 review findings are fixed in implementation commit
`97896c8edfde0946d52e5dafd58593e3ac742bf1`.

- Conflict receipts now invoke a candidate-bound final gate after the ordinary source-permission
  verifier and directly before the existing append-only `send_started` / `beginAnswerSend`
  transition. The gate reloads the candidate, rejects dismissed/superseded or foreign group state,
  matches the receipt's exact source/snapshot/fragment/content-hash identity, rechecks live
  permission, and runs durable current-state validation for memory, message, source, latest snapshot,
  and fragment evidence. Version conflicts, validation errors, missing validators, and malformed
  results fail closed to the content-free safe-notice path; ordinary answers bypass this gate.
- Answer-time conflict selection now requires the exact target fragment, not only its source and
  snapshot. The final exact target is live-rechecked again before conflict text is injected into the
  draft, and multi-fragment documents retain the correct `D*` citation binding.
- Permission attestation is captured immediately after each successful live permission check.
  Multi-source operations carry the conservative earliest actual completion time, while repository
  freshness receives a separately captured validation/lookup time. An aged earlier check can no
  longer be represented as a fresh later timestamp.
- The final gate is threaded through the answer orchestrator, production answer runtime, event-worker
  composition, mention responder, and delivery request without adding Task 10 runtime-control or
  readiness behavior. No migration was added or modified.

### Review RED

```powershell
npm --workspace apps/core test -- knowledge-conflict-answer-provider.test.ts answer-reply-delivery-service.test.ts feishu-mention-answer-responder.test.ts answer-draft-orchestrator.test.ts
```

Exit 1: 2 files failed and 2 passed; 17 expected tests failed and 220 passed. The failures proved the
late shared permission timestamp, absent provider final-currentness API, and absent delivery gate and
ordering.

### Fix GREEN And Final Gates

```powershell
npm --workspace apps/core test -- knowledge-conflict-answer-provider.test.ts knowledge-conflict-current-validator.test.ts answer-reply-delivery-service.test.ts feishu-mention-answer-responder.test.ts answer-draft-orchestrator.test.ts answer-draft-runtime.test.ts event-worker-runtime.test.ts
```

Exit 0: 7 files passed; 294 tests passed. These include race oracles for dismissal, supersession,
memory/source/latest-snapshot/fragment change, permission revocation at the final boundary,
missing/throwing/malformed final validators, exact multi-fragment citation binding, ordinary-answer
bypass, and advancing-clock multi-document attestation.

```powershell
npm --workspace apps/core test
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

All exited 0. Full Core: 184 files passed and 3 conditional files skipped; 3,320 tests passed and 250
skipped (3,570 total). Diff checks reported only the repository's LF-to-CRLF checkout warnings and no
whitespace errors.

### Remaining Environmental Concerns

- `IRIS_TEST_DATABASE_URL` was unset. The 250 skipped tests include conditional PostgreSQL cases, so
  the final gate's durable repository validation and answer receipt state transitions were verified
  with unit/contract doubles but not a live PostgreSQL service in this round.
- No live Feishu permission or reply call was made. The ordering and fail-closed disclosure behavior
  are covered locally; no live integration claim is made.
- The last safe application boundary is intentionally immediately before the auditable send-start
  transition. It does not hold a database lock across the external Feishu request; outcome-unknown
  sends continue to use the existing `reconciliation_required` receipt semantics.
