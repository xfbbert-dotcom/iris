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
