# Task 8 Report: Authenticated Member Actions And One Governed Draft

## Status

DONE_WITH_CONCERNS

Task 8 is implemented and committed. The focused Task 8 suites, relevant conflict/card/draft
regressions, full Core suite, typecheck, build, and diff hygiene pass. The remaining concern is
environmental: `IRIS_TEST_DATABASE_URL` was absent, so the repository's conditional PostgreSQL
cases were skipped locally. No live Feishu callback, card, or Wiki workflow was exercised or claimed.

## Implementation Commit

- `d1c840ed6196129b02b09a0ea22254eeb53ef361` — `feat(core): convert conflicts into governed drafts`
- This report is committed separately so it can record the immutable implementation SHA.

## Delivered Behavior

- Extended the approval interaction union and Redis validator with the content-free
  `knowledge_conflict_confirmation` job and actions `create_update_draft` / `not_a_conflict`.
- Accepts only the six external callback-value fields `kind`, `action`, `candidateId`,
  `candidateVersion`, `groupId`, and `nonce`. It rejects unknown fields, fake actor/reason fields,
  form reasons, noncanonical version strings, invalid or oversized nonces, unrecognized actions, and
  callback group/context mismatches.
- Preserved the authenticated public callback route. Actor, chat, and message identity come from the
  verified Feishu envelope/context; the gateway derives the internal `presentationId` from the
  candidate ID and never uses the sensitive intent store for conflict actions.
- Added content-free callback diagnostics, queue serialization, replay, and dead-letter support.
- Delegates conflict jobs from the existing approval interaction worker, acknowledges stable outcomes,
  and sends retryable validation/presentation failures through the existing finite Redis queue.
- Added a fail-closed knowledge-card runtime bridge that can be bound once, before runtime start, to
  the later composed conflict interaction worker.
- Added `KnowledgeConflictInteractionWorker` checks for the exact candidate/group/version,
  one sent delivery, exact Feishu message ID, deterministic delivery nonce, non-bot actor, current
  group membership, live runtime gate, current target policy, current evidence, and current source
  permission. Target policy is loaded before the final evidence/permission validation so that
  validation remains directly adjacent to the final gate and mutation boundary.
- `not_a_conflict` applies only the exact candidate dismissal interaction and creates no draft or
  presentation.
- `create_update_draft` derives stable draft, draft-creation operation, callback-interaction, and
  presentation operation identities from the candidate/callback identities. It creates one
  `knowledge_conflict`, medium-risk draft with the confirming member as reviewer, the one current
  publication target suggestion, exact conversation-message/group-memory/document-source evidence,
  and explicitly separated current knowledge, newer group conclusion, material difference, and
  proposed update sections.
- The candidate interaction and `draft_created` transition occur only after `createDraft` returns
  applied/already-applied. Presentation uses the existing knowledge-card service. A presentation
  failure is retryable; the exact replay loads the stable existing draft and retries the same
  presentation identity without calling `createDraft` again.
- Exact duplicate callbacks return the committed result. A changed action under the same callback
  operation key is rejected as an immutable intent conflict. Returned errors and queue failure codes
  contain no draft/evidence body or raw exception content.
- No Task 9 answer-time conflict behavior was implemented. No migration was added or modified;
  migrations `0001` through `0045` are untouched.

## TDD Evidence

### Initial RED

Command:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts
```

Result: exit 1. Six files failed; 7 tests failed, 168 passed, and 3 conditional Redis tests skipped.
The worker suite could not load the missing module, while the other failures showed the missing job
kind, callback parser/gateway, approval-worker delegation, and Redis normalization.

### Runtime Bridge RED

Command:

```powershell
npm --workspace apps/core test -- knowledge-card-runtime.test.ts
```

Result: exit 1; 1 failed and 18 passed. The interaction dependencies had no fail-closed conflict
worker bridge.

### Final Validation-Order RED

Command:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts
```

Result: exit 1; 1 failed and 22 passed. The trace was `validation, target, draft`, proving that the
awaited target lookup preceded neither the final evidence/permission validation nor the mutation.
The implementation was reordered to `target, validation, draft`.

### Focused GREEN

Required Task 8 command after the implementation commit:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts
```

Result: exit 0; 6 files passed; 198 tests passed and 3 conditional Redis tests skipped.

Runtime bridge command:

```powershell
npm --workspace apps/core test -- knowledge-card-runtime.test.ts
```

Result: exit 0; 1 file and 19 tests passed.

## Relevant Regression Evidence

Command:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts knowledge-card-runtime.test.ts knowledge-card-api.test.ts action-approval-runtime.test.ts runtime-close.test.ts server-startup.test.ts knowledge-conflict-current-validator.test.ts postgres-knowledge-conflict-repository.test.ts knowledge-draft-state-machine.test.ts postgres-knowledge-draft-repository.test.ts knowledge-draft-presentation-service.test.ts knowledge-conflict-card-renderer.test.ts
```

Result: exit 0; 17 files passed; 397 tests passed and 29 conditional tests skipped.

## Final Repository Gates

```powershell
npm --workspace apps/core test
```

Exit 0: 182 test files passed and 3 conditional files skipped; 3,258 tests passed and 249 skipped
(3,507 total).

```powershell
npm --workspace apps/core run typecheck
npm --workspace apps/core run build
git diff --check
git diff --cached --check
```

All exited 0. Diff checks emitted only the repository's existing LF-to-CRLF checkout warnings and no
whitespace errors.

## Self-Review

- Verified the external callback value contains exactly six fields and never trusts actor or reason
  data from the card.
- Verified candidate, group, message, delivery status, delivered version, and deterministic nonce
  are all checked before membership or mutation.
- Verified member/runtime checks occur before validation and again before mutation; target selection
  occurs before the final permission/evidence revalidation.
- Verified the mutation order is draft creation, atomic conflict interaction/candidate transition,
  then existing knowledge-card presentation.
- Verified presentation retry loads the stable existing draft and cannot invoke a second draft create.
- Verified dismissal and draft conversion use the repository's immutable callback operation key, so
  exact replay is idempotent and conflicting intent is rejected.
- Verified draft title/body, medium risk, reviewer, publication suggestion, and exact evidence are
  asserted as hand-derived literals in the focused worker suite.
- Verified no callback URL/authentication change, no Task 9 behavior, and no migration change.

## Concerns

- `IRIS_TEST_DATABASE_URL` was absent. Conditional real-PostgreSQL migration/repository cases were
  skipped locally and should run in a database-enabled CI or isolated test environment.
- No live Feishu callback/card delivery or Wiki publication flow was attempted. This task proves the
  authenticated parser/gateway/queue/worker contracts with automated tests only; live pilot acceptance
  remains a later explicit gate.

---

## Fix Round 1/5 — Callback Identity and Mutation Freshness

Status: `DONE_WITH_CONCERNS`

Implementation commit:

- `9a6f2f706d6dc698c5598881a3c08a1ede8af390` — `fix(core): harden conflict callback governance`

### Findings and decisions

All three independent findings were confirmed.

1. A locally `unknown` document permission could pass the conflict worker's live Feishu check but
   fail the general draft repository's local-readable rule. The fix adds a conflict-only governance
   attestation carried into the draft transaction. The repository verifies the exact draft source
   set, attestation freshness, medium-risk/group scope, and selected publication policy identity and
   version while preserving the original fail-closed rule for all general draft origins.
2. Membership, live permission, and publication policy could change across awaited work. The worker
   now propagates the permission check's actual timestamp, rechecks membership and live permission
   immediately before draft creation and again after draft creation before candidate commit, reads
   the exact selected policy/version before draft creation, and binds that policy to both the draft
   transaction and final conflict-interaction transaction. The repository locks and validates the
   current policy row before the `draft_created` transition.
3. Redis jobs and replayable dead letters contained `actorOpenId`. Migration `0047` adds an
   append-only PostgreSQL callback-identity fact. The authenticated gateway persists verified Feishu
   actor/message context there and queues only an opaque `callbackIdentityId`; the approval worker
   resolves and verifies the exact immutable job binding before delegation. Redis jobs and dead
   letters now contain neither actor identity fields nor actor values.

Migration `0047` is forward-only. No migration at or below `0045` was modified. Callback identities
do not require the candidate to exist, allowing authenticated stale/unknown candidate callbacks to
reach the worker's stable denial path rather than failing callback ingress.

### RED evidence

Initial review regressions:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-conflict-current-validator.test.ts postgres-knowledge-draft-repository.test.ts postgres-knowledge-conflict-repository.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts postgres-knowledge-conflict-callback-identity-store.test.ts
```

Exit 1: 8 files failed and 1 passed; 14 tests failed, 208 passed, and 30 conditional tests skipped.
The failures covered the missing opaque identity store/migration, actor-bearing queue shape, missing
permission timestamp, absent conflict governance proof, stale membership/permission/policy races,
and missing transaction-time target-policy rejection.

An additional exact-evidence regression was then captured:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts
```

Exit 1: 1 failed and 29 passed. It proved contextual candidate document sources were incorrectly
included in the attestation even though the generated draft contains only the exact target source.

### GREEN and regression evidence

Focused Task 8 command:

```powershell
npm --workspace apps/core test -- knowledge-conflict-interaction-worker.test.ts knowledge-conflict-current-validator.test.ts postgres-knowledge-draft-repository.test.ts postgres-knowledge-conflict-repository.test.ts knowledge-card.test.ts approval-interaction-worker.test.ts feishu-card-action-gateway.test.ts redis-approval-interaction-queue.test.ts postgres-knowledge-conflict-callback-identity-store.test.ts
```

Exit 0: 9 files passed; 226 tests passed and 30 conditional tests skipped.

Relevant dispatcher/migration/presentation/runtime regressions:

```powershell
npm --workspace apps/core test -- knowledge-conflict-dispatcher.test.ts knowledge-conflict-callback-parser.test.ts migration-runner.test.ts knowledge-draft-presentation-service.test.ts knowledge-card-runtime.test.ts
```

Exit 0: 4 discovered files passed; 83 tests passed and 6 conditional tests skipped. The requested
`knowledge-conflict-callback-parser.test.ts` filename does not exist; callback parser coverage remains
in `feishu-card-action.test.ts` and the focused gateway/card suites.

Full Core suite:

```powershell
npm --workspace apps/core test
```

Exit 0: 183 test files passed and 3 conditional files skipped; 3,269 tests passed and 250 skipped
(3,519 total).

The following also exited 0:

```powershell
npm --workspace apps/core run typecheck
npm run build
git diff --check
```

### Remaining concerns

- `IRIS_TEST_DATABASE_URL` was absent, so the new real-PostgreSQL unknown-permission/live-attestation
  integration case and other conditional PostgreSQL cases were skipped locally. Static migration,
  repository-oracle, and transaction-routing tests passed, but this is not a live database claim.
- No live Feishu callback, membership, card, or Wiki workflow was exercised or claimed.
