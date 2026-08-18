# Iris Cross-Group Document Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the first bounded slice of IRIS-CORE-004 by allowing an administrator to grant one
group answer-only access to one group-visible document from another evidenced group, with
pre-ranking enforcement, prompt-time validation, receipt binding, final-send revalidation, audit,
revocation, and live acceptance.

**Architecture:** PostgreSQL owns a versioned grant projection plus append-only events. Retrieval
returns an exact grant binding only for cross-group answer candidates; TypeScript validates it
before prompt assembly, answer receipts persist it, and `beginAnswerSend` locks and revalidates it
before external I/O. Internal APIs and Admin Console expose bounded metadata-only governance while
all existing source policy, live permission, runtime, and Caddy boundaries remain authoritative.

**Tech Stack:** TypeScript 5, Fastify, PostgreSQL/pgvector, Vitest, Node test runner, Docker Compose,
Feishu OpenAPI, existing static Admin Console HTML/CSS/JS.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-18-iris-cross-group-document-grants-design.md` exactly.
- No grant may be inferred from enabled groups, common source URIs, bot membership, model output, or
  missing fields.
- Only `group_visible_document` and `usage='answering'` may use the grant; knowledge drafts, chat
  memory, proactive speech, actions, and Wiki writes remain same-group/default-off.
- Preserve the SQL pre-ranking scope check and repeat it in TypeScript before prompt assembly.
- Persist grant ID, positive version, grantor group, and grantee group as one all-or-none answer
  trace binding.
- Lock sorted grants before the optional knowledge-conflict candidate and answer delivery.
- Never hold a PostgreSQL lock across Feishu network I/O.
- Grant events are append-only and reject UPDATE, DELETE, and TRUNCATE.
- Internal status, APIs, logs, tests, docs, and committed evidence must never contain source body,
  fragment text, answer text, callback payloads, credentials, or authorization secrets.
- Add no dependency and keep public Caddy `/internal/*` behavior at 404.
- Do not mark IRIS-CORE-004 complete until exact-SHA CI and the three-group live acceptance pass.

---

### Task 1: Grant Facts, Migration, And PostgreSQL Repository

**Files:**
- Create: `apps/core/migrations/0051_document_source_group_grants.sql`
- Create: `apps/core/src/documents/document-source-group-grant.ts`
- Create: `apps/core/src/documents/postgres-document-source-group-grant-repository.ts`
- Create: `apps/core/tests/postgres-document-source-group-grant-repository.test.ts`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Consumes: `document_sources`, `document_source_evidence`,
  `answer_reply_source_traces`, `answer_reply_deliveries`, and
  `knowledge_draft_append_only_guard()`.
- Produces: `DocumentSourceGroupGrant`, `DocumentSourceGroupGrantRepository`,
  `DocumentSourceGroupGrantConflictError`, `DocumentSourceGroupGrantNotFoundError`, and
  `createPostgresDocumentSourceGroupGrantRepository({ dataSource })`.

- [ ] **Step 1: Write migration and repository RED tests**

Add tests that require migration 0051 after 0050 and, when `IRIS_TEST_DATABASE_URL` is set, apply it
to real PostgreSQL and assert:

```ts
expect(columns).toEqual(expect.arrayContaining([
  "document_source_id", "grantor_group_id", "grantee_group_id",
  "state", "version", "created_by", "updated_by",
]));
expect(await rejectsSql("update document_source_group_grant_events set actor_ref='x'"))
  .toMatch(/append-only/u);
expect(await rejectsSql("truncate document_source_group_grant_events"))
  .toMatch(/append-only/u);
```

Repository unit oracles must fail on the missing module and require source-before-grant locking,
exact grantor evidence, distinct groups, version conflicts, operation-key fingerprint conflicts,
exact replay, regrant, revoke, and active answer protection.

- [ ] **Step 2: Run Task 1 tests and capture RED**

Run:

```powershell
npm --workspace apps/core test -- postgres-document-source-group-grant-repository.test.ts migration-runner.test.ts
```

Expected: failure because migration 0051 and the repository do not exist.

- [ ] **Step 3: Add migration 0051**

Create the projection and events using the exact design columns. Add:

```sql
UNIQUE (document_source_id, grantee_group_id),
CHECK (grantor_group_id <> grantee_group_id),
CHECK (version >= 1)
```

Extend `answer_reply_source_traces` with the four nullable grant columns, a restricted foreign key,
and one all-or-none content-shape check. Install row and TRUNCATE append-only triggers on the event
table without dropping any existing guard.

- [ ] **Step 4: Implement the domain contract and normalization**

Export:

```ts
export type DocumentSourceGroupGrantState = "active" | "revoked";
export type DocumentSourceGroupGrant = {
  id: string;
  documentSourceId: string;
  grantorGroupId: string;
  granteeGroupId: string;
  state: DocumentSourceGroupGrantState;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};
```

Normalize references to nonblank 1..512 characters, require integer versions, clone dates, and
hash normalized operation intent with SHA-256.

- [ ] **Step 5: Implement transactional grant/revoke/replay**

For `grant`, lock `document_sources` first, prove `source_type='group_visible_document'` and exact
grantor origin/evidence, then lock the unique source/grantee projection. Insert version 1 only for
`expectedVersion=0`; regrant a revoked row with `version+1`. For `revoke`, lock the grant, then:

```sql
SELECT delivery.id
FROM answer_reply_source_traces trace
JOIN answer_reply_deliveries delivery ON delivery.id = trace.delivery_id
WHERE trace.cross_group_grant_id = $1
  AND delivery.state IN ('sending', 'reconciliation_required')
FOR UPDATE OF delivery
```

Reject if any row exists. Append exactly one event per applied transition. Exact operation replay
returns the historical result; a changed fingerprint throws the conflict error.

- [ ] **Step 6: Run Task 1 GREEN and typecheck**

Run:

```powershell
npm --workspace apps/core test -- postgres-document-source-group-grant-repository.test.ts migration-runner.test.ts
npm --workspace apps/core run typecheck
```

Expected: all non-environment-gated tests pass; real PostgreSQL tests pass when configured or report
only the explicit environment skip.

- [ ] **Step 7: Commit Task 1**

```powershell
git add apps/core/migrations/0051_document_source_group_grants.sql `
  apps/core/src/documents/document-source-group-grant.ts `
  apps/core/src/documents/postgres-document-source-group-grant-repository.ts `
  apps/core/tests/postgres-document-source-group-grant-repository.test.ts `
  apps/core/tests/migration-runner.test.ts
git commit -m "feat(core): add cross-group document grant facts"
```

---

### Task 2: Pre-Ranking Retrieval And Exact Grant Metadata

**Files:**
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/src/memory/retrieval-candidate-fusion.ts`
- Modify: `apps/core/tests/retrieval-candidate-fusion.test.ts`
- Modify: `apps/core/src/memory/source-aware-fragment-selector.ts`
- Modify: `apps/core/tests/source-aware-fragment-selector.test.ts`

**Interfaces:**
- Consumes: migration 0051 grant projection.
- Produces: optional exact cross-group grant fields on `RetrievedDocumentFragment` and
  `RetrievedDocumentFragmentCandidate`.

- [ ] **Step 1: Write retrieval RED tests**

Require both search paths to:

```ts
expect(sql).toMatch(/document_source_group_grants/iu);
expect(sql.indexOf("document_source_group_grants"))
  .toBeLessThan(sql.indexOf("order by e.embedding"));
expect(values).toContain("group-b");
```

Add real-PostgreSQL conditional cases with a closer unauthorized group-A fragment, a farther
granted fragment, and a control group. Group B must retrieve the granted fragment; the control must
not. `usage='knowledge_drafts'` must still deny the grant.

Add fusion/neighbor tests that preserve one exact binding and reject conflicting bindings for the
same fragment.

- [ ] **Step 2: Run Task 2 tests and capture RED**

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts retrieval-candidate-fusion.test.ts source-aware-fragment-selector.test.ts
```

Expected: grant retrieval and metadata assertions fail.

- [ ] **Step 3: Extend retrieved fragment types**

Add the all-or-none optional fields:

```ts
crossGroupGrantId?: string;
crossGroupGrantVersion?: number;
crossGroupGrantorGroupId?: string;
crossGroupGranteeGroupId?: string;
```

Map database values only when all four are valid; otherwise throw. Local-scope rows must map with
all fields absent.

- [ ] **Step 4: Add deterministic grant join before ranking**

For answer usage and a current group, join the unique active source/grantee grant, require its
grantor still appears in source origin/evidence, and allow `same_group OR exact_grant`. Select grant
columns with `CASE WHEN same_group THEN NULL ELSE grant.column END`. Keep knowledge-draft query
generation unchanged and grant-free.

- [ ] **Step 5: Preserve and compare bindings through selection**

When fusion sees the same fragment twice, require equal grant metadata. When neighbor expansion
copies source metadata, also copy the four grant fields from the seed. A mismatch throws before
prompt construction.

- [ ] **Step 6: Run Task 2 GREEN and commit**

```powershell
npm --workspace apps/core test -- document-fragment-repository.test.ts retrieval-candidate-fusion.test.ts source-aware-fragment-selector.test.ts
npm --workspace apps/core run typecheck
git add apps/core/src/documents/document-fragment-repository.ts `
  apps/core/tests/document-fragment-repository.test.ts `
  apps/core/src/memory/retrieval-candidate-fusion.ts `
  apps/core/tests/retrieval-candidate-fusion.test.ts `
  apps/core/src/memory/source-aware-fragment-selector.ts `
  apps/core/tests/source-aware-fragment-selector.test.ts
git commit -m "feat(core): retrieve explicitly granted group documents"
```

---

### Task 3: Prompt-Time Source-Policy Validation

**Files:**
- Modify: `apps/core/src/memory/document-retrieval-context.ts`
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

**Interfaces:**
- Consumes: `DocumentSourceGroupGrantRepository.findActiveForSourceAndGrantee`, `validateExact`,
  and fragment grant metadata.
- Produces: `validateCrossGroupDocumentAccess(fragment, currentGroupId)` and grant-aware
  `canReadBySourcePolicy` behavior.

- [ ] **Step 1: Write prompt-boundary RED tests**

Cover active exact grant, revoked grant, changed version, wrong source, wrong grantor, wrong grantee,
grantor no longer evidenced, missing current group, mixed local/granted fragments for one source,
and repository failure. Every invalid case must produce zero allowed fragments and zero source text
in `promptContext`.

- [ ] **Step 2: Run Task 3 tests and capture RED**

```powershell
npm --workspace apps/core test -- document-retrieval-context.test.ts answer-draft-runtime.test.ts
```

Expected: cross-group active grant remains denied and stale binding cases are not recognized.

- [ ] **Step 3: Compose the grant repository only for source-policy**

Extend answer runtime dependencies with:

```ts
createDocumentSourceGroupGrantRepository?: (queryable: Queryable) => Pick<
  DocumentSourceGroupGrantRepository,
  "findActiveForSourceAndGrantee" | "validateExact"
>;
```

Do not create or consult it in `allow-indexed` mode. Repository failure is denial, never fallback.

- [ ] **Step 4: Add local-or-exact-grant policy**

Keep same-group source evidence authoritative. If it does not contain `currentGroupId`, require one
active repository grant for that exact source/grantee and require the grantor still appears in
source evidence. Existing runtime and live permission gates run afterward.

- [ ] **Step 5: Validate exact fragment bindings before live permission**

Group fragments by source. Require every fragment to be either local with no binding or cross-group
with one identical binding. Call `validateExact` once per cross-group source and deny the entire
source on false/error. Pass only validated fragments to the existing permission guard.

- [ ] **Step 6: Run Task 3 GREEN and commit**

```powershell
npm --workspace apps/core test -- document-retrieval-context.test.ts answer-draft-runtime.test.ts permission-guard.test.ts
npm --workspace apps/core run typecheck
git add apps/core/src/memory/document-retrieval-context.ts `
  apps/core/tests/document-retrieval-context.test.ts `
  apps/core/src/runtime/answer-draft-runtime.ts `
  apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat(core): validate cross-group grants before prompts"
```

---

### Task 4: Receipt Binding And Atomic Final-Send Gate

**Files:**
- Modify: `apps/core/src/answer-replies/answer-source-citation-renderer.ts`
- Modify: `apps/core/tests/answer-source-citation-renderer.test.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-repository.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-receipt-validator.ts`
- Modify: `apps/core/tests/answer-reply-receipt-validator.test.ts`
- Modify: `apps/core/src/answer-replies/postgres-answer-reply-repository.ts`
- Modify: `apps/core/tests/postgres-answer-reply-repository.test.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-delivery-service.ts`
- Modify: `apps/core/tests/answer-reply-delivery-service.test.ts`
- Modify: `apps/core/src/answer-replies/answer-reply-api.ts`
- Modify: `apps/core/tests/answer-reply-api.test.ts`

**Interfaces:**
- Consumes: exact fragment grant metadata and migration 0051 trace columns.
- Produces: grant-bound `AnswerReplySourceTraceInput`, typed
  `AnswerReplyGrantStaleError`, and atomic grant-before-delivery send validation.

- [ ] **Step 1: Write receipt and final-send RED tests**

Require renderer all-or-none bindings, stable fingerprints, database round-trip, API metadata,
prepare-time exact validation, sorted multi-grant locks, and begin-send rejection for revoked or
version-changed grants. Add a conditional real-PostgreSQL race:

```ts
const [send, revoke] = await Promise.allSettled([
  answers.beginAnswerSend(...),
  grants.revoke(...),
]);
expect(safeSerialOutcome(send, revoke)).toBe(true);
```

Safe outcomes are: send enters `sending` and revoke conflicts, or revoke applies and send becomes
permission-blocked without calling Feishu.

- [ ] **Step 2: Run Task 4 tests and capture RED**

```powershell
npm --workspace apps/core test -- answer-source-citation-renderer.test.ts answer-reply-receipt-validator.test.ts postgres-answer-reply-repository.test.ts answer-reply-delivery-service.test.ts answer-reply-api.test.ts
```

Expected: trace binding, lock order, and stale-grant tests fail.

- [ ] **Step 3: Thread grant fields through renderer and receipt contracts**

Copy all four fields from `RetrievedDocumentFragment`. Require every fragment for one document to
agree. Include them in trace semantic equality, persistence fingerprint, replay comparison,
validation, database mapping, and internal API serialization.

- [ ] **Step 4: Validate and lock grants in prepare and begin-send**

Collect unique non-null grant IDs, sort lexicographically, and lock each current projection. Verify
ID/version/source/grantor/grantee/state plus current source evidence. Do this before candidate and
delivery locks. A stale binding throws `AnswerReplyGrantStaleError` before state changes.

- [ ] **Step 5: Map stale grant to the existing permission-blocked path**

In delivery service, catch only `AnswerReplyGrantStaleError`, call `blockForPermission` with the
bound authoritative document source IDs, and return without invoking `replyText`. Preserve all
other transition and reconciliation behavior.

- [ ] **Step 6: Prove revoke/send serialization and mutation resistance**

Temporarily remove the `sending|reconciliation_required` revoke guard and confirm the focused race
test fails. Restore it and confirm GREEN. Temporarily remove begin-send grant version validation and
confirm the stale-version test fails; restore it.

- [ ] **Step 7: Run Task 4 GREEN and commit**

```powershell
npm --workspace apps/core test -- answer-source-citation-renderer.test.ts answer-reply-receipt-validator.test.ts postgres-answer-reply-repository.test.ts answer-reply-delivery-service.test.ts answer-reply-api.test.ts
npm --workspace apps/core run typecheck
git add apps/core/src/answer-replies apps/core/tests/answer-source-citation-renderer.test.ts `
  apps/core/tests/answer-reply-receipt-validator.test.ts `
  apps/core/tests/postgres-answer-reply-repository.test.ts `
  apps/core/tests/answer-reply-delivery-service.test.ts `
  apps/core/tests/answer-reply-api.test.ts
git commit -m "feat(core): bind cross-group grants to answer delivery"
```

---

### Task 5: Authenticated Governance API And Runtime Composition

**Files:**
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/server.ts`
- Modify: `apps/core/tests/server-startup.test.ts`

**Interfaces:**
- Consumes: PostgreSQL grant repository.
- Produces: `documentSyncRuntime.sources.groupGrants.list|grant|revoke` and the three internal routes
  defined by the design.

- [ ] **Step 1: Write API/runtime RED tests**

Test authentication before parsing, missing operator header, invalid group/reference/version/body,
wrong source/grant, applied and replayed mutation, version conflict, active-answer conflict,
repository error, response content allowlist, and public absence. Assert no source URI/body, actor,
operation key, or authorization material appears in grant responses.

- [ ] **Step 2: Run Task 5 tests and capture RED**

```powershell
npm --workspace apps/core test -- document-sync-runtime.test.ts answer-draft-api.test.ts server-startup.test.ts
```

Expected: group-grant runtime and routes are missing.

- [ ] **Step 3: Add runtime grant surface**

Expose bounded `list`, `grant`, and `revoke` methods from the existing document-sync runtime. Create
the repository from the same Postgres pool; do not add a worker, loop, Redis queue, or external
client. Runtime close continues to close the shared pool exactly once.

- [ ] **Step 4: Add strict request parsers and routes**

Use exact known-field validation. Read actor from `x-iris-operator`, not request JSON. Map domain
errors to 400/404/409 and persistence unavailable to 503/500. Return only:

```ts
{ ok: true, outcome, grant: { id, documentSourceId, grantorGroupId,
  granteeGroupId, state, version, createdAt, updatedAt } }
```

- [ ] **Step 5: Verify server composition and shutdown**

Prove startup injects one repository, API-disabled test paths remain unchanged, listener failure
closes the pool, and normal shutdown closes once. No grant path may start when Postgres composition
fails.

- [ ] **Step 6: Run Task 5 GREEN and commit**

```powershell
npm --workspace apps/core test -- document-sync-runtime.test.ts answer-draft-api.test.ts server-startup.test.ts runtime-close.test.ts
npm --workspace apps/core run typecheck
git add apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/document-sync-runtime.test.ts `
  apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts `
  apps/core/src/server.ts apps/core/tests/server-startup.test.ts
git commit -m "feat(core): govern cross-group document grants"
```

---

### Task 6: Admin Console, Status, And Readiness

**Files:**
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Modify: `apps/core/tests/admin-console-assets.test.ts`
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/internal-readiness-api.test.ts`

**Interfaces:**
- Consumes: metadata-only grant API and count repository.
- Produces: document-source grant controls and content-free status counts.

- [ ] **Step 1: Write UI/status RED tests**

Require active/revoked counts, latest mutation timestamp, unavailable-on-read-error, grant list
rendering, exact source/grant/version confirmation, create/regrant/revoke requests, stale response
refresh, and a forbidden-text scan for source body, fragment text, answer text, actor, operation key,
and tokens.

- [ ] **Step 2: Run Task 6 tests and capture RED**

```powershell
npm --workspace apps/core test -- admin-console-assets.test.ts internal-rollout-readiness.test.ts internal-readiness-api.test.ts
```

Expected: grant status and console surfaces are absent.

- [ ] **Step 3: Add content-free status/readiness**

Expose `{ active, revoked, latestUpdatedAt? }`. If counts cannot be read, mark the component
unavailable and fail readiness closed. An empty table is healthy and means default deny.

- [ ] **Step 4: Add bounded console controls**

Place grants inside document-source detail. Require explicit grantor and grantee group IDs,
expected version, and a confirmation string containing exact source and both groups. Generate a
fresh opaque operation key client-side and never display it. Refresh server state after mutation.

- [ ] **Step 5: Run Task 6 GREEN and commit**

```powershell
npm --workspace apps/core test -- admin-console-assets.test.ts internal-rollout-readiness.test.ts internal-readiness-api.test.ts
npm --workspace apps/core run typecheck
git add apps/core/src/admin-console/admin-console-assets.ts apps/core/tests/admin-console-assets.test.ts `
  apps/core/src/admin/internal-rollout-readiness.ts apps/core/tests/internal-rollout-readiness.test.ts `
  apps/core/src/app.ts apps/core/tests/internal-readiness-api.test.ts
git commit -m "feat(core): expose cross-group grant governance"
```

---

### Task 7: Acceptance Controller And Honest Coverage Status

**Files:**
- Create: `docs/runbooks/iris-cross-group-document-grants-acceptance.md`
- Create: `docs/pull-requests/2026-08-18-iris-cross-group-document-grants.md`
- Modify: `scripts/pilot-operations.test.mjs`
- Modify: `scripts/pilot-compose.test.mjs`
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`

**Interfaces:**
- Consumes: all Tasks 1-6 behavior.
- Produces: executable default-deny three-group acceptance and metadata-only PR evidence template.

- [ ] **Step 1: Write acceptance-contract RED tests**

Require the runbook to prove pre-grant denial, exact grant/event, grantee answer trace binding,
control denial, prepared-answer revocation, regrant replay, begin-send/revoke serialization, final
drain, Caddy stop, all groups/global disable, empty active pilot grant set, stable mutable
fingerprints, and append-only preservation. Add invalid fixtures for each false-positive path.

- [ ] **Step 2: Run Task 7 tests and capture RED**

```powershell
node --test --test-name-pattern "cross-group document grant" scripts/pilot-operations.test.mjs scripts/pilot-compose.test.mjs
```

Expected: runbook and evidence template are missing.

- [ ] **Step 3: Write the bounded controller**

The controller remains attached, starts and ends fail-closed, accepts one source group, one grantee,
and one distinct control group, and writes only IDs/versions/hashes/counts/timestamps/pass-fail to a
private artifact. Every exit revokes the pilot grant, disables runtime/groups/capabilities, stops
Caddy, drains queues/outboxes, and rechecks stable fingerprints.

- [ ] **Step 4: Update coverage honestly**

Change IRIS-CORE-004 only to `首个跨群文档回答闭环代码完成，真实验收待执行`. State that
cross-group memory and knowledge drafts remain missing. Do not mark the requirement implemented
until Task 8 live acceptance passes.

- [ ] **Step 5: Run Task 7 GREEN and commit**

```powershell
node --test --test-name-pattern "cross-group document grant" scripts/pilot-operations.test.mjs scripts/pilot-compose.test.mjs
npm run pilot:config
git diff --check
git add docs/runbooks/iris-cross-group-document-grants-acceptance.md `
  docs/pull-requests/2026-08-18-iris-cross-group-document-grants.md `
  scripts/pilot-operations.test.mjs scripts/pilot-compose.test.mjs `
  docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md
git commit -m "docs(pilot): add cross-group grant acceptance gate"
```

---

### Task 8: Broad Review, Exact-SHA CI, And Live Acceptance

**Files:**
- Modify after evidence only: `docs/pull-requests/2026-08-18-iris-cross-group-document-grants.md`
- Modify after acceptance only: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify after evidence only: project SDD progress/report files created for this plan.

**Interfaces:**
- Consumes: Tasks 1-7 complete branch.
- Produces: reviewed exact SHA, passing CI, one three-group live result, default-deny rollback, and
  honest IRIS-CORE-004 status.

- [ ] **Step 1: Run focused and full local verification**

```powershell
npm --workspace apps/core test -- document-source-group-grant document-fragment-repository document-retrieval-context answer-draft-runtime answer-reply admin-console internal-rollout-readiness
npm run verify
git diff --check
```

Require exit 0. Record exact pass/skip counts and accurately identify environment-gated tests.

- [ ] **Step 2: Perform independent broad review**

Review migration upgrade safety, source/grant/delivery lock order, pre-ranking SQL, prompt-boundary
validation, receipt replay, revoke races, internal/public API boundaries, status content, console
escaping, shutdown, and runbook false positives. Fix only P0/P1 release blockers; record P2/P3 in a
follow-up backlog.

- [ ] **Step 3: Push the reviewed branch and require exact-SHA CI**

Push without force, open a Draft PR against `master`, and require Core/AI Worker checks plus real
PostgreSQL migration/concurrency tests. Do not enable live grants if the checked SHA differs from the
deployed SHA or any required check is incomplete.

- [ ] **Step 4: Build and deploy the exact reviewed image default-deny**

Record lowercase commit SHA, immutable image ID, reviewer role, and timestamp. Keep Caddy stopped,
active grant count zero, all groups/global disabled, and all queue/DLQ/outbox counts zero before the
controller starts.

- [ ] **Step 5: Execute the three-group live acceptance**

Run all eight acceptance gates from the design with one source group, one grantee, and one control.
Never paste group IDs or source/answer text into the public transcript. Any failure triggers the
same unconditional revoke/disable/stop/drain rollback and leaves IRIS-CORE-004 partial.

- [ ] **Step 6: Record metadata-only evidence and final status**

If and only if the controller reports pass with rollback pass, update the PR evidence and coverage
baseline to `首个跨群文档回答闭环已实现（默认拒绝）`. Explicitly retain cross-group memory,
knowledge drafts, proactive actions, wildcard grants, and broad rollout as incomplete. Commit and
push only the metadata-only evidence.

## Plan Self-Review

- Spec coverage: Tasks 1-7 cover durable facts, pre-ranking, prompt validation, receipt/final send,
  governance, status/UI, and acceptance; Task 8 covers broad review, CI, live proof, and rollback.
- Placeholder scan: the plan contains no TBD/TODO/"similar to" step and every task has exact files,
  interfaces, commands, failure expectation, implementation action, verification, and commit scope.
- Type consistency: the four grant binding fields use the same names from retrieved fragments
  through source traces and PostgreSQL; repository method names match every consuming task.
- Scope control: knowledge drafts and cross-group memory remain denied, so the first deliverable is
  one independently testable answer-only product loop.
