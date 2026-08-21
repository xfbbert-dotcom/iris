# Iris Managed Knowledge Publication Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a controlled end-to-end action that updates the exact single plain-text body block of a newly tracked Iris-managed Feishu Wiki page, then keeps the source unavailable until exact resynchronization succeeds.

**Architecture:** Add a focused managed-page repository beside the existing action-proposal repository, register exact block identity after new-page publication, bind eligible conflict draft revisions to one managed target, and route them to a new action type. A dedicated updater/executor activates a retrieval barrier before exact-revision Feishu mutation, classifies uncertain outcomes through readback, and reopens retrieval only after a managed-block snapshot observation matches the expected result.

**Tech Stack:** TypeScript 5.5, Node.js 24, Fastify 5, PostgreSQL, Redis document-sync queue, Vitest 2, Feishu Wiki/Docx APIs.

**Spec:** `docs/superpowers/specs/2026-08-19-iris-managed-knowledge-publication-update-design.md`

## Global Constraints

- The implementation baseline is `master@36aca0ab1080c41b1a70f4b7a2ce102954e52de7` plus design commit `b795e84f`.
- Only active Iris-created pages with one exact managed plain-text block are update eligible.
- Legacy pages are never auto-adopted and arbitrary document blocks are never inferred from text.
- Confirmation and approval bind exact draft, conflict candidate, page, source, snapshot, block, revision, policy, and before/after hashes.
- Mutation uses an exact positive Feishu document revision and deterministic client token; wildcard revision `-1` is rejected.
- No remote call occurs while a PostgreSQL transaction or row lock is held.
- A source is excluded before ranking and at send time whenever its managed page is not `active`.
- Unknown external outcomes are read back before any retry; a human edit is never overwritten automatically.
- Logs, readiness, metrics, list APIs, and agent observations contain identifiers, versions, states, and reason codes but no document bodies.
- `updateManagedKnowledge` and the deployment feature flag default to `false`; execution also requires `writeKnowledgeBase`.
- Existing publication behavior remains supported and unbound drafts retain publish-new behavior.
- Every production behavior starts with a failing test and each task ends with a focused commit.

---

## File Structure

### New files

- `apps/core/migrations/0052_managed_knowledge_publication_updates.sql` — managed pages, immutable events, update targets, update executions, success facts, snapshot observations, action-type constraints, and review fingerprints.
- `apps/core/src/action-approvals/managed-knowledge-page.ts` — states, canonical body normalization/hash, and validation-only domain types.
- `apps/core/src/action-approvals/managed-knowledge-page-repository.ts` — focused persistence interfaces for page registration/linking, target lookup, barrier transitions, observations, execution, reconciliation, and status counts.
- `apps/core/src/action-approvals/postgres-managed-knowledge-page-repository.ts` — PostgreSQL implementation with short transactions and canonical lock order.
- `apps/core/src/action-approvals/feishu-managed-knowledge-updater.ts` — exact-block read, exact-revision batch update, typed outcome classification, and deterministic client-token contract.
- `apps/core/src/action-approvals/managed-knowledge-update-executor.ts` — capability gating, claim/preflight/mutate/classify/persist orchestration.
- `apps/core/src/action-approvals/managed-knowledge-update-executor-loop.ts` — bounded polling loop consistent with the publication executor loop.
- `apps/core/src/action-approvals/managed-knowledge-update-reconciler.ts` — outcome-unknown readback and safe retry decision logic.
- `apps/core/src/action-approvals/managed-knowledge-sync-observer.ts` — exact source linking, managed-block snapshot observation, and post-resync reactivation.
- `apps/core/tests/managed-knowledge-page.test.ts` — canonical normalization and domain validation.
- `apps/core/tests/postgres-managed-knowledge-page-repository.test.ts` — schema, registration, binding, claims, transition, append-only, and concurrency integration tests.
- `apps/core/tests/feishu-managed-knowledge-updater.test.ts` — Feishu boundary contract and error classification.
- `apps/core/tests/managed-knowledge-update-executor.test.ts` — executor red/green behavior.
- `apps/core/tests/managed-knowledge-update-reconciler.test.ts` — outcome-unknown readback branches.
- `apps/core/tests/managed-knowledge-sync-observer.test.ts` — exact observation and reactivation behavior.
- `apps/core/tests/answer-source-permission-verifier.test.ts` — send-time managed-source freshness rejection.

### Existing files changed

- `apps/core/src/action-approvals/feishu-knowledge-publication-publisher.ts` — return exact created body-block identity.
- `apps/core/src/action-approvals/knowledge-publication-executor.ts` — register eligible managed pages after durable publication success.
- `apps/core/src/action-approvals/action-proposal.ts` — support both action-type literals.
- `apps/core/src/action-approvals/action-proposal-repository.ts` — expose action type and target fingerprint in shared proposal/review contracts.
- `apps/core/src/action-approvals/postgres-action-proposal-repository.ts` — route proposal creation and review binding without adding update execution persistence.
- `apps/core/src/action-approvals/action-proposal-planner.ts` — choose update exclusively when the exact binding exists.
- `apps/core/src/action-approvals/action-approval-card-renderer.ts` — identify update actions and their target.
- `apps/core/src/knowledge-governance/knowledge-draft-repository.ts` — accept an optional exact managed-update binding during conflict-draft creation.
- `apps/core/src/knowledge-governance/postgres-knowledge-draft-repository.ts` — insert the target binding in the draft transaction.
- `apps/core/src/knowledge-conflicts/knowledge-conflict-interaction-worker.ts` — resolve eligible managed target before creating the governed draft.
- `apps/core/src/documents/document-sync-pipeline.ts` — invoke managed sync observation after snapshot insertion.
- `apps/core/src/documents/document-fragment-repository.ts` — exclude barred managed sources before ranking and missing-profile indexing.
- `apps/core/src/answer-replies/answer-source-permission-verifier.ts` — fail send-time verification for barred managed sources.
- `apps/core/src/config/runtime-config.ts` — add default-off `updateManagedKnowledge`.
- `apps/core/src/admin/runtime-control-state-repository.ts` — persist and validate the new capability.
- `apps/core/src/runtime/action-approval-runtime.ts` — wire updater, executor, reconciler, loop, and managed-page repository.
- `apps/core/src/runtime/document-sync-runtime.ts` — wire the managed sync observer.
- `apps/core/src/admin/internal-rollout-readiness.ts` — report update-loop dependency and unresolved-execution health.
- `apps/core/src/action-approvals/action-proposal-api.ts` — metadata-only managed target and update execution status.
- `apps/core/src/admin-console/admin-console-assets.ts` — render action type, page state, revision, resync, and reconciliation metadata.
- `apps/core/src/app.ts` — recognize the new capability and register metadata endpoints/runtime state.
- `deploy/pilot/ci.env`, `deploy/pilot/docker-compose.yml`, `.env.example` — default-off feature and allowlist configuration.
- `README.md`, `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md` — record the tested capability and controlled-pilot gate without claiming deployment early.

---

### Task 1: Managed-Page Domain and Durable Schema

**Files:**
- Create: `apps/core/migrations/0052_managed_knowledge_publication_updates.sql`
- Create: `apps/core/src/action-approvals/managed-knowledge-page.ts`
- Create: `apps/core/src/action-approvals/managed-knowledge-page-repository.ts`
- Create: `apps/core/src/action-approvals/postgres-managed-knowledge-page-repository.ts`
- Create: `apps/core/tests/managed-knowledge-page.test.ts`
- Create: `apps/core/tests/postgres-managed-knowledge-page-repository.test.ts`
- Modify: `apps/core/tests/migration-runner.test.ts`

**Interfaces:**
- Consumes: `Queryable` transaction conventions from `postgres-action-proposal-repository.ts`; append-only guard from migration `0030_knowledge_draft_facts.sql`; publication facts from migration `0035_knowledge_publications.sql`.
- Produces: `canonicalManagedBodyHash(body: string): string`, `ManagedKnowledgePageRepository`, `ManagedKnowledgePage`, `ManagedKnowledgeUpdateTarget`, `ManagedKnowledgeUpdateExecution`, and all tables used by later tasks.

- [x] **Step 1: Write failing domain tests**

```ts
it("normalizes the managed body identically across CRLF and trailing outer whitespace", () => {
  expect(canonicalManagedBody("  Line one\r\nLine two  ")).toBe("Line one\nLine two");
  expect(canonicalManagedBodyHash("  Line one\r\nLine two  ")).toBe(
    "6991ce0a6fcde71f7e4c492b1746e1f04727fe3b124691803aab99fccdb4d8c6",
  );
});

it("rejects an active page without exact positive revision and block identity", () => {
  expect(() => normalizeManagedKnowledgePage({
    ...validPage,
    managedBodyBlockId: "",
  })).toThrow(/managedBodyBlockId/u);
});
```

- [x] **Step 2: Run the domain tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-page.test.ts`

Expected: FAIL because `managed-knowledge-page.ts` and its exports do not exist.

- [x] **Step 3: Implement canonical domain primitives**

```ts
export const MANAGED_KNOWLEDGE_PAGE_STATES = [
  "active", "updating", "resync_required", "reconciliation_required", "blocked", "retired",
] as const;

export function canonicalManagedBody(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if ([...normalized].length < 1 || [...normalized].length > 200_000) {
    throw new Error("managed body length is invalid");
  }
  return normalized;
}

export function canonicalManagedBodyHash(value: string): string {
  return createHash("sha256").update(canonicalManagedBody(value)).digest("hex");
}
```

Define explicit page, target, observation, execution, event, and status-count types with no body-text fields.

- [x] **Step 4: Write failing migration/repository tests**

```ts
it("installs exact managed-page and update invariants", async () => {
  const sql = await readFile(new URL("../migrations/0052_managed_knowledge_publication_updates.sql", import.meta.url), "utf8");
  expect(sql).toMatch(/CREATE TABLE managed_knowledge_pages/iu);
  expect(sql).toMatch(/CREATE TABLE knowledge_publication_update_targets/iu);
  expect(sql).toMatch(/CREATE UNIQUE INDEX managed_knowledge_updates_one_unresolved_page_idx/iu);
  expect(sql).toMatch(/managed_knowledge_page_events_append_only/iu);
  expect(sql).toMatch(/knowledge_publication_updates_append_only/iu);
});

it("registers one exact managed page idempotently and rejects a conflicting operation replay", async () => {
  const first = await repository.registerPublication(validRegistration);
  const replay = await repository.registerPublication(validRegistration);
  expect(first.outcome).toBe("applied");
  expect(replay).toEqual({ outcome: "already_applied", page: first.page });
  await expect(repository.registerPublication({
    ...validRegistration,
    remoteDocumentRevision: 13,
  })).rejects.toThrow(/operation conflict/iu);
});
```

- [x] **Step 5: Run repository tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/postgres-managed-knowledge-page-repository.test.ts tests/migration-runner.test.ts`

Expected: FAIL because migration 0052 and the repository are absent.

- [x] **Step 6: Implement migration 0052**

Create:

```sql
ALTER TABLE action_proposals DROP CONSTRAINT action_proposals_action_type_check;
ALTER TABLE action_proposals ADD CONSTRAINT action_proposals_action_type_check
  CHECK (action_type IN ('publish_knowledge_draft', 'update_knowledge_publication'));

CREATE TABLE managed_knowledge_pages (...);
CREATE TABLE managed_knowledge_page_events (...);
CREATE TABLE managed_knowledge_snapshot_observations (...);
CREATE TABLE knowledge_publication_update_targets (...);
CREATE TABLE knowledge_publication_update_executions (...);
CREATE TABLE knowledge_publication_update_execution_events (...);
CREATE TABLE knowledge_publication_updates (...);
```

Use composite foreign keys for source/snapshot/hash identity, `CHECK` constraints for state-dependent nullable columns, operation-key/fingerprint replay tables or columns, append-only triggers on fact/event tables, and a partial unique index over update execution states `('claimed','remote_request_dispatched','outcome_unknown','remote_applied','resync_required','reconciliation_required')` by managed page.

- [x] **Step 7: Implement the focused PostgreSQL repository**

```ts
export interface ManagedKnowledgePageRepository {
  registerPublication(input: RegisterManagedPublicationInput): Promise<ManagedPageMutationResult>;
  findEligiblePageForConflict(input: EligibleManagedPageForConflictInput): Promise<ManagedKnowledgePage | undefined>;
  linkSource(input: LinkManagedPageSourceInput): Promise<ManagedPageMutationResult>;
  recordSnapshotObservation(input: RecordManagedSnapshotObservationInput): Promise<ManagedSnapshotObservationResult>;
  bindConflictDraft(input: BindManagedUpdateTargetInput): Promise<ManagedTargetMutationResult>;
  getTargetForDraft(input: { draftId: string; revision: number }): Promise<ManagedKnowledgeUpdateTarget | undefined>;
  claimApprovedUpdate(input: ClaimManagedUpdateInput): Promise<ClaimedManagedKnowledgeUpdate>;
  recordRemoteOutcome(input: RecordManagedRemoteOutcomeInput): Promise<ManagedExecutionMutationResult>;
  completeResync(input: CompleteManagedResyncInput): Promise<ManagedExecutionMutationResult>;
  listReconciliationRequired(input: { limit: number }): Promise<ClaimedManagedKnowledgeUpdate[]>;
  getSourceAvailability(documentSourceId: string): Promise<"available" | "barred">;
}
```

Every replay compares an SHA-256 operation fingerprint. Transactions lock `managed_knowledge_pages` before update targets, proposals, and executions and commit before returning data used for external calls.

- [x] **Step 8: Run Task 1 tests and verify GREEN**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-page.test.ts tests/postgres-managed-knowledge-page-repository.test.ts tests/migration-runner.test.ts`

Expected: PASS, including append-only trigger and concurrent-claim tests.

- [x] **Step 9: Commit Task 1**

```powershell
git add apps/core/migrations/0052_managed_knowledge_publication_updates.sql apps/core/src/action-approvals/managed-knowledge-page.ts apps/core/src/action-approvals/managed-knowledge-page-repository.ts apps/core/src/action-approvals/postgres-managed-knowledge-page-repository.ts apps/core/tests/managed-knowledge-page.test.ts apps/core/tests/postgres-managed-knowledge-page-repository.test.ts apps/core/tests/migration-runner.test.ts
git commit -m "feat: add managed knowledge page ledger"
```

### Task 2: Capture Exact Managed Identity During Publication

**Files:**
- Modify: `apps/core/src/action-approvals/feishu-knowledge-publication-publisher.ts`
- Modify: `apps/core/src/action-approvals/knowledge-publication-executor.ts`
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Modify: `apps/core/tests/feishu-knowledge-publication-publisher.test.ts`
- Modify: `apps/core/tests/knowledge-publication-executor.test.ts`
- Modify: `apps/core/tests/postgres-knowledge-publication-repository.test.ts`

**Interfaces:**
- Consumes: `ManagedKnowledgePageRepository.registerPublication` and `canonicalManagedBodyHash` from Task 1.
- Produces: `KnowledgePublicationPublisherResult.managedBodyBlockId?: string`; successful, exact publications are registered without making registration failure alter the existing publication success fact.

- [x] **Step 1: Write failing publisher tests**

```ts
it("returns the exact created text block and revision for managed eligibility", async () => {
  fetchMock
    .mockResolvedValueOnce(feishuJson({ code: 0, data: { node: { node_token: "wikcn_1", obj_token: "docx_1", obj_type: "docx" } } }))
    .mockResolvedValueOnce(feishuJson({ code: 0, data: { revision_id: 12, children: [{ block_id: "blk_body", block_type: 2 }] } }));
  await expect(publisher.publish(input)).resolves.toMatchObject({
    managedBodyBlockId: "blk_body",
    remoteDocumentVersion: 12,
  });
});

it("publishes successfully but omits managed identity when Feishu omits the created block", async () => {
  // Return revision_id without children.
  await expect(publisher.publish(input)).resolves.not.toHaveProperty("managedBodyBlockId");
});
```

- [x] **Step 2: Run publisher tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/feishu-knowledge-publication-publisher.test.ts`

Expected: FAIL because the publisher does not parse or return the created block ID.

- [x] **Step 3: Parse exact created-block identity**

Change `appendDocxContent` to return:

```ts
type AppendedManagedBody = {
  revision?: number;
  blockId?: string;
};
```

Accept a block only when the response contains exactly one created `block_type: 2` item with a non-blank `block_id`. Do not infer the document root token as the body block.

- [x] **Step 4: Write failing executor registration tests**

```ts
it("registers an exact publication as a managed page after durable completion", async () => {
  await executor.processBatch({ limit: 1 });
  expect(managedPages.registerPublication).toHaveBeenCalledWith(expect.objectContaining({
    originKnowledgePublicationId: "publication-1",
    remoteDocumentToken: "docx_remote",
    managedBodyBlockId: "blk_body",
    currentRemoteRevisionId: 12,
    currentBodyContentHash: "d".repeat(64),
  }));
});

it("does not register an inexact publication", async () => {
  publisher.publish.mockResolvedValue({ ...published, managedBodyBlockId: undefined });
  await executor.processBatch({ limit: 1 });
  expect(managedPages.registerPublication).not.toHaveBeenCalled();
});
```

- [x] **Step 5: Run executor tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/knowledge-publication-executor.test.ts tests/postgres-knowledge-publication-repository.test.ts`

Expected: FAIL because the executor has no managed-page dependency or registration call.

- [x] **Step 6: Register eligible publication results**

Extend dependencies with:

```ts
managedPages?: Pick<ManagedKnowledgePageRepository, "registerPublication">;
```

After `completePublicationExecution` returns its durable `publication`, call `registerPublication` only when block ID and positive revision exist. Use operation key `managed-publication-register:<sha256(publication.id)>`. Catch registration failure, emit only `managed_registration_failed`, and preserve the already-confirmed publication result.

- [x] **Step 7: Run Task 2 tests and regress the publication path**

Run: `npm exec --workspace apps/core -- vitest run tests/feishu-knowledge-publication-publisher.test.ts tests/knowledge-publication-executor.test.ts tests/postgres-knowledge-publication-repository.test.ts`

Expected: PASS; publication remains successful with incomplete identity and only exact results become managed.

- [x] **Step 8: Commit Task 2**

```powershell
git add apps/core/src/action-approvals/feishu-knowledge-publication-publisher.ts apps/core/src/action-approvals/knowledge-publication-executor.ts apps/core/src/action-approvals/action-proposal-repository.ts apps/core/tests/feishu-knowledge-publication-publisher.test.ts apps/core/tests/knowledge-publication-executor.test.ts apps/core/tests/postgres-knowledge-publication-repository.test.ts
git commit -m "feat: capture managed publication block identity"
```

### Task 3: Link Sources and Record Canonical Snapshot Observations

**Files:**
- Create: `apps/core/src/action-approvals/managed-knowledge-sync-observer.ts`
- Create: `apps/core/tests/managed-knowledge-sync-observer.test.ts`
- Modify: `apps/core/src/documents/document-sync-pipeline.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/tests/document-sync-pipeline.test.ts`
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

**Interfaces:**
- Consumes: exact token parsers in `feishu-document-body-fetcher.ts`, page lookup/linking/observation from Task 1, and `DocumentSnapshot` from the existing snapshot repository.
- Produces: `ManagedKnowledgeSyncObserver.observe({ source, snapshot }): Promise<void>` and `ManagedBlockReader.readManagedBlock(...)` for exact block/revision observation.

- [x] **Step 1: Write failing observer tests**

```ts
it("links a source only by exact wiki or docx token and records the exact block observation", async () => {
  await observer.observe({ source: wikiSource, snapshot });
  expect(repository.linkSource).toHaveBeenCalledWith(expect.objectContaining({
    managedPageId: "managed-1",
    documentSourceId: "source-1",
  }));
  expect(repository.recordSnapshotObservation).toHaveBeenCalledWith(expect.objectContaining({
    documentSnapshotId: "snapshot-1",
    managedBodyBlockId: "blk_body",
    remoteDocumentRevision: 12,
    canonicalBodyHash: canonicalManagedBodyHash("Approved body"),
  }));
});

it("does not use title or body similarity when no exact token matches", async () => {
  await observer.observe({ source: sameTitleDifferentTokenSource, snapshot });
  expect(blockReader.readManagedBlock).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run observer tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-sync-observer.test.ts`

Expected: FAIL because the observer does not exist.

- [x] **Step 3: Implement exact observer behavior**

```ts
export interface ManagedKnowledgeSyncObserver {
  observe(input: { source: DocumentSource; snapshot: DocumentSnapshot }): Promise<void>;
}

export interface ManagedBlockReader {
  readManagedBlock(input: {
    remoteDocumentToken: string;
    managedBodyBlockId: string;
  }): Promise<{ revision: number; blockType: "text"; body: string }>;
}
```

Resolve by parsed Wiki node token or Docx document token only. The observer may record/link after snapshot insertion; failure does not erase an ordinary successful snapshot and cannot reactivate a page.

- [x] **Step 4: Write failing pipeline/runtime tests**

```ts
it("observes a successful snapshot before marking the source synced", async () => {
  await runner.run(source.id);
  expect(callOrder).toEqual(["snapshot", "managed-observation", "reindex", "mark-synced"]);
});
```

- [x] **Step 5: Run pipeline/runtime tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/document-sync-pipeline.test.ts tests/document-sync-runtime.test.ts tests/feishu-document-body-fetcher.test.ts`

Expected: FAIL because the pipeline has no managed observation hook.

- [x] **Step 6: Add the optional sync hook and runtime wiring**

Extend `createDocumentSyncRunner` with optional `managedKnowledgeObserver`. Invoke it after snapshot insertion and before reindex/mark-synced. Use the existing bounded Feishu JSON helper to implement exact block reads; reject missing block, unsupported type, invalid revision, oversized response, and non-HTTPS base URL.

- [x] **Step 7: Run Task 3 tests and verify GREEN**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-sync-observer.test.ts tests/document-sync-pipeline.test.ts tests/document-sync-runtime.test.ts tests/feishu-document-body-fetcher.test.ts`

Expected: PASS with no similarity-based linking.

- [x] **Step 8: Commit Task 3**

```powershell
git add apps/core/src/action-approvals/managed-knowledge-sync-observer.ts apps/core/src/documents/document-sync-pipeline.ts apps/core/src/documents/feishu-document-body-fetcher.ts apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/managed-knowledge-sync-observer.test.ts apps/core/tests/document-sync-pipeline.test.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/feishu-document-body-fetcher.test.ts
git commit -m "feat: observe managed pages during document sync"
```

### Task 4: Bind Conflict Drafts and Route the Exact Action Type

**Files:**
- Modify: `apps/core/src/knowledge-governance/knowledge-draft-repository.ts`
- Modify: `apps/core/src/knowledge-governance/postgres-knowledge-draft-repository.ts`
- Modify: `apps/core/src/knowledge-conflicts/knowledge-conflict-interaction-worker.ts`
- Modify: `apps/core/src/knowledge-conflicts/knowledge-conflict-card-renderer.ts`
- Modify: `apps/core/src/action-approvals/action-proposal.ts`
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/postgres-action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/action-proposal-planner.ts`
- Modify: `apps/core/tests/knowledge-conflict-interaction-worker.test.ts`
- Modify: `apps/core/tests/knowledge-conflict-card-renderer.test.ts`
- Modify: `apps/core/tests/action-proposal.test.ts`
- Modify: `apps/core/tests/action-proposal-planner.test.ts`
- Modify: `apps/core/tests/postgres-action-proposal-repository.test.ts`

**Interfaces:**
- Consumes: exact eligible page lookup and update-target table from Task 1.
- Produces: `ActionProposalActionType`, `CreateKnowledgeDraftInput.managedUpdateTarget?`, candidate `actionType`, exclusive planner routing, and update-aware conflict card metadata.

- [x] **Step 1: Write failing conflict-binding tests**

```ts
it("creates an immutable update target in the same transaction as an eligible conflict draft", async () => {
  const result = await repository.createDraft({
    ...conflictDraftInput,
    managedUpdateTarget: exactManagedTarget,
  });
  expect(await managedPages.getTargetForDraft({
    draftId: result.draft.id,
    revision: result.draft.currentRevision,
  })).toMatchObject({
    managedPageId: "managed-1",
    expectedRemoteRevision: 12,
    proposedBodyContentHash: canonicalManagedBodyHash(conflictDraftInput.content),
  });
});

it("renders publication wording when no exact managed target exists", () => {
  expect(renderConflictCard(unboundInput).text).not.toMatch(/replace existing/iu);
});
```

- [x] **Step 2: Run conflict tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/knowledge-conflict-interaction-worker.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/postgres-knowledge-draft-repository.test.ts`

Expected: FAIL because draft creation cannot accept or persist a managed target.

- [x] **Step 3: Persist exact target binding during draft creation**

Add:

```ts
managedUpdateTarget?: {
  candidateId: string;
  candidateVersion: number;
  managedPageId: string;
  managedPageVersion: number;
  documentSourceId: string;
  targetSnapshotId: string;
  targetSnapshotHash: string;
  expectedRemoteRevision: number;
  managedBodyBlockId: string;
  currentBodyContentHash: string;
};
```

The Postgres draft transaction inserts `knowledge_publication_update_targets` with the newly created revision and proposed canonical hash. The interaction worker resolves eligibility before draft creation. If resolution returns none or throws, it creates an unbound publication draft and the card uses publication wording.

- [x] **Step 4: Write failing proposal-routing tests**

```ts
it("creates only an update proposal for a confirmed update-bound revision", async () => {
  repository.listEligibleDrafts.mockResolvedValue([{ ...candidate, actionType: "update_knowledge_publication" }]);
  await planner.planBatch({ limit: 10 });
  expect(repository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
    actionType: "update_knowledge_publication",
  }));
});

it("retains publish-new routing for an unbound draft", async () => {
  repository.listEligibleDrafts.mockResolvedValue([{ ...candidate, actionType: "publish_knowledge_draft" }]);
  await planner.planBatch({ limit: 10 });
  expect(repository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
    actionType: "publish_knowledge_draft",
  }));
});
```

- [x] **Step 5: Run action tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/action-proposal.test.ts tests/action-proposal-planner.test.ts tests/postgres-action-proposal-repository.test.ts`

Expected: FAIL because the domain and SQL accept only publication actions.

- [x] **Step 6: Generalize proposal action type and planner**

```ts
export const ACTION_PROPOSAL_ACTION_TYPES = [
  "publish_knowledge_draft",
  "update_knowledge_publication",
] as const;
export type ActionProposalActionType = typeof ACTION_PROPOSAL_ACTION_TYPES[number];
```

`listEligibleDrafts` uses an exact left join to the current draft revision’s target. It reports update only when page, source, snapshot, policy, group, and target versions are current and the page is `active`; a stale bound target is omitted entirely, not returned as publication. `createProposal` stores the supplied action type and includes it in the operation fingerprint.

- [x] **Step 7: Run Task 4 tests and regress publication planning**

Run: `npm exec --workspace apps/core -- vitest run tests/knowledge-conflict-interaction-worker.test.ts tests/knowledge-conflict-card-renderer.test.ts tests/action-proposal.test.ts tests/action-proposal-planner.test.ts tests/postgres-action-proposal-repository.test.ts`

Expected: PASS; one draft revision cannot have concurrent live publish and update proposals.

- [x] **Step 8: Commit Task 4**

```powershell
git add apps/core/src/knowledge-governance/knowledge-draft-repository.ts apps/core/src/knowledge-governance/postgres-knowledge-draft-repository.ts apps/core/src/knowledge-conflicts/knowledge-conflict-interaction-worker.ts apps/core/src/knowledge-conflicts/knowledge-conflict-card-renderer.ts apps/core/src/action-approvals/action-proposal.ts apps/core/src/action-approvals/action-proposal-repository.ts apps/core/src/action-approvals/postgres-action-proposal-repository.ts apps/core/src/action-approvals/action-proposal-planner.ts apps/core/tests/knowledge-conflict-interaction-worker.test.ts apps/core/tests/knowledge-conflict-card-renderer.test.ts apps/core/tests/action-proposal.test.ts apps/core/tests/action-proposal-planner.test.ts apps/core/tests/postgres-action-proposal-repository.test.ts
git commit -m "feat: route governed managed knowledge updates"
```

### Task 5: Bind Review and Approval to the Managed Target

**Files:**
- Modify: `apps/core/src/action-approvals/action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/postgres-action-proposal-repository.ts`
- Modify: `apps/core/src/action-approvals/action-approval-card-renderer.ts`
- Modify: `apps/core/src/action-reviews/action-review-renderer.ts`
- Modify: `apps/core/src/action-reviews/action-review-api.ts`
- Modify: `apps/core/tests/action-approval-card-renderer.test.ts`
- Modify: `apps/core/tests/action-review-renderer.test.ts`
- Modify: `apps/core/tests/action-review-api.test.ts`
- Modify: `apps/core/tests/postgres-action-review-repository.test.ts`

**Interfaces:**
- Consumes: update target and `ActionProposal.actionType` from Task 4.
- Produces: `ActionReviewContext.actionTargetFingerprint`, metadata-only target summary, and review attestations that become stale when any execution-critical target field changes.

- [x] **Step 1: Write failing review-binding tests**

```ts
it("includes exact managed target metadata and fingerprint in update review context", async () => {
  await expect(repository.getAuthorizedReviewContext({ proposalId, actorOpenId })).resolves.toMatchObject({
    actionType: "update_knowledge_publication",
    managedTarget: {
      managedPageId: "managed-1",
      expectedRemoteRevision: 12,
      managedBodyBlockId: "blk_body",
    },
    actionTargetFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
});

it("invalidates an attestation after managed page version changes", async () => {
  await repository.recordReviewAttestation(attestation);
  await pool.query("UPDATE managed_knowledge_pages SET version = version + 1 WHERE id = $1", ["managed-1"]);
  await expect(repository.hasCurrentReviewAttestation(attestation)).resolves.toBe(false);
});
```

- [x] **Step 2: Run review tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/postgres-action-review-repository.test.ts tests/action-review-api.test.ts tests/action-review-renderer.test.ts tests/action-approval-card-renderer.test.ts`

Expected: FAIL because review context has no action-specific target fingerprint.

- [x] **Step 3: Implement target-bound review context and attestation**

Compute the fingerprint from the exact ordered fields in design section 10. Store it in `action_review_attestations.action_target_fingerprint`. Publication actions use a fingerprint over their existing target policy/draft identity so the field is always non-null after migration.

Update cards and HTML review to state either “Publish new Wiki page” or “Replace the single managed body block on existing Wiki page.” Render only safe target links/IDs outside the full-text OAuth review.

- [x] **Step 4: Run Task 5 tests and verify GREEN**

Run: `npm exec --workspace apps/core -- vitest run tests/postgres-action-review-repository.test.ts tests/action-review-api.test.ts tests/action-review-renderer.test.ts tests/action-approval-card-renderer.test.ts tests/action-approval-worker.test.ts`

Expected: PASS with changed target identity invalidating review approval.

- [x] **Step 5: Commit Task 5**

```powershell
git add apps/core/src/action-approvals/action-proposal-repository.ts apps/core/src/action-approvals/postgres-action-proposal-repository.ts apps/core/src/action-approvals/action-approval-card-renderer.ts apps/core/src/action-reviews/action-review-renderer.ts apps/core/src/action-reviews/action-review-api.ts apps/core/tests/action-approval-card-renderer.test.ts apps/core/tests/action-review-renderer.test.ts apps/core/tests/action-review-api.test.ts apps/core/tests/postgres-action-review-repository.test.ts
git commit -m "feat: bind update approval to exact managed target"
```

### Task 6: Add Default-Off Capability and Retrieval Freshness Barrier

**Files:**
- Modify: `apps/core/src/config/runtime-config.ts`
- Modify: `apps/core/src/admin/runtime-control-state-repository.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `apps/core/src/answer-replies/answer-source-permission-verifier.ts`
- Modify: `apps/core/src/answer-replies/postgres-answer-reply-repository.ts`
- Modify: `apps/core/tests/runtime-config.test.ts`
- Modify: `apps/core/tests/postgres-runtime-control-state-repository.test.ts`
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Create: `apps/core/tests/answer-source-permission-verifier.test.ts`
- Modify: `apps/core/tests/postgres-answer-reply-repository.test.ts`

**Interfaces:**
- Consumes: managed page state/source binding from Task 1.
- Produces: `IrisCapability.updateManagedKnowledge`, SQL search exclusion, and send-time `managed_source_unavailable` decision.

- [x] **Step 1: Write failing capability tests**

```ts
it("defaults managed knowledge updates off", () => {
  expect(createDefaultRuntimeConfig({}).capabilities.updateManagedKnowledge).toBe(false);
});

it("requires updateManagedKnowledge in durable capability snapshots", () => {
  expect(() => decodeDurableRuntimeControlSnapshot(oldShape)).toThrow(/capabilities/iu);
});
```

- [x] **Step 2: Run capability tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/runtime-config.test.ts tests/postgres-runtime-control-state-repository.test.ts tests/runtime-control-service.test.ts`

Expected: FAIL because the capability does not exist.

- [x] **Step 3: Add the default-off durable capability**

Add `updateManagedKnowledge: boolean` to `IrisCapability`, `runtimeCapabilityNames`, the app capability-name set, all test fixtures, and persisted JSON validation. Do not derive it from `writeKnowledgeBase`; both values remain independently controllable.

- [x] **Step 4: Write failing retrieval/send-time barrier tests**

```ts
it.each(["updating", "resync_required", "reconciliation_required", "blocked", "retired"])(
  "excludes a managed source in %s before vector ranking",
  async (state) => {
    await seedManagedSource({ state });
    await expect(repository.searchSimilarFragments(search)).resolves.toEqual([]);
  },
);

it("blocks a prepared reply when its source enters the managed freshness barrier", async () => {
  await expect(verifier.verify(trace)).resolves.toEqual({
    allowed: false,
    reason: "managed_source_unavailable",
  });
});
```

- [x] **Step 5: Run barrier tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/document-fragment-repository.test.ts tests/answer-source-permission-verifier.test.ts tests/postgres-answer-reply-repository.test.ts`

Expected: FAIL because active fragment SQL and send-time verification ignore managed-page state.

- [x] **Step 6: Implement barrier queries**

Add the following predicate to answer search, candidate search, draft evidence search, and missing-profile indexing:

```sql
AND NOT EXISTS (
  SELECT 1
  FROM managed_knowledge_pages managed
  WHERE managed.linked_document_source_id = ds.id
    AND managed.state <> 'active'
)
```

Extend the answer trace preflight query to return managed-page state and fail closed when a linked page is absent from `active`. Preserve existing permission/grant checks and safe-notice behavior.

- [x] **Step 7: Run Task 6 tests and verify GREEN**

Run: `npm exec --workspace apps/core -- vitest run tests/runtime-config.test.ts tests/postgres-runtime-control-state-repository.test.ts tests/document-fragment-repository.test.ts tests/answer-source-permission-verifier.test.ts tests/postgres-answer-reply-repository.test.ts`

Expected: PASS; active managed sources and unmanaged sources remain retrievable.

- [x] **Step 8: Commit Task 6**

```powershell
git add apps/core/src/config/runtime-config.ts apps/core/src/admin/runtime-control-state-repository.ts apps/core/src/app.ts apps/core/src/documents/document-fragment-repository.ts apps/core/src/answer-replies/answer-source-permission-verifier.ts apps/core/src/answer-replies/postgres-answer-reply-repository.ts apps/core/tests/runtime-config.test.ts apps/core/tests/postgres-runtime-control-state-repository.test.ts apps/core/tests/document-fragment-repository.test.ts apps/core/tests/answer-source-permission-verifier.test.ts apps/core/tests/postgres-answer-reply-repository.test.ts
git commit -m "feat: enforce managed knowledge freshness barrier"
```

### Task 7: Implement the Exact Feishu Managed-Block Updater

**Files:**
- Create: `apps/core/src/action-approvals/feishu-managed-knowledge-updater.ts`
- Create: `apps/core/tests/feishu-managed-knowledge-updater.test.ts`

**Interfaces:**
- Consumes: tenant token provider, bounded JSON reader, numeric guards, and canonical body functions.
- Produces: `ManagedKnowledgeUpdater.preflight`, `ManagedKnowledgeUpdater.update`, `ManagedKnowledgeUpdater.readBack`, and typed outcome results for the executor/reconciler.

- [x] **Step 1: Write failing boundary tests**

```ts
it("sends one exact text-element replacement at the bound revision", async () => {
  await updater.update({
    remoteDocumentToken: "docx_1",
    managedBodyBlockId: "blk_body",
    expectedRevision: 12,
    proposedBody: "New approved body",
    clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://open.feishu.cn/open-apis/docx/v1/documents/docx_1/blocks/batch_update?document_revision_id=12&client_token=9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
    expect.objectContaining({ method: "PATCH" }),
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).requests).toEqual([{
    block_id: "blk_body",
    update_text_elements: {
      elements: [{ text_run: { content: "New approved body", text_element_style: {} } }],
    },
  }]);
});

it("rejects wildcard or non-positive revisions before fetching", async () => {
  await expect(updater.update({ ...input, expectedRevision: -1 })).rejects.toThrow(/revision/iu);
  expect(fetchMock).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run updater tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/feishu-managed-knowledge-updater.test.ts`

Expected: FAIL because the updater does not exist.

- [x] **Step 3: Implement typed Feishu boundary**

```ts
export type ManagedUpdateOutcome =
  | { kind: "applied"; resultingRevision: number }
  | { kind: "not_applied_retryable"; code: "rate_limited" | "server_error" }
  | { kind: "rejected"; code: "stale_revision" | "forbidden" | "missing" | "invalid" }
  | { kind: "unknown"; code: "timeout" | "connection_lost" | "malformed_success" };
```

Preflight reads the exact block and document revision, requires text block type, and returns its canonical hash. Update constructs one request, bounded body/response, deterministic client token, exact positive revision, and redacted typed errors. Readback returns only revision, block type, and canonical hash to orchestration code.

- [x] **Step 4: Add classification/readback tests**

Cover explicit stale revision, permission denial, missing block, invalid request, 429, 5xx, abort timeout after dispatch, network loss, oversized response, invalid JSON, proposed-hash readback, old-hash readback, and unrelated human-edit hash.

- [x] **Step 5: Run Task 7 tests and verify GREEN**

Run: `npm exec --workspace apps/core -- vitest run tests/feishu-managed-knowledge-updater.test.ts`

Expected: PASS and serialized test observations contain neither body text nor access token.

- [x] **Step 6: Commit Task 7**

```powershell
git add apps/core/src/action-approvals/feishu-managed-knowledge-updater.ts apps/core/tests/feishu-managed-knowledge-updater.test.ts
git commit -m "feat: add exact Feishu managed block updater"
```

### Task 8: Execute, Reconcile, and Resynchronize Governed Updates

**Files:**
- Create: `apps/core/src/action-approvals/managed-knowledge-update-executor.ts`
- Create: `apps/core/src/action-approvals/managed-knowledge-update-executor-loop.ts`
- Create: `apps/core/src/action-approvals/managed-knowledge-update-reconciler.ts`
- Create: `apps/core/tests/managed-knowledge-update-executor.test.ts`
- Create: `apps/core/tests/managed-knowledge-update-reconciler.test.ts`
- Modify: `apps/core/src/action-approvals/managed-knowledge-sync-observer.ts`
- Modify: `apps/core/tests/managed-knowledge-sync-observer.test.ts`
- Modify: `apps/core/src/runtime/action-approval-runtime.ts`
- Modify: `apps/core/tests/action-approval-runtime.test.ts`

**Interfaces:**
- Consumes: repository transitions from Task 1, action routing/review binding from Tasks 4–5, capability from Task 6, updater from Task 7, document-sync queue, and snapshot observer from Task 3.
- Produces: complete claim/preflight/mutate/readback/resync loop and safe reconciliation worker.

- [x] **Step 1: Write failing executor gate/claim tests**

```ts
it("requires all runtime gates before listing or claiming update proposals", async () => {
  for (const snapshot of disabledGateSnapshots) {
    const executor = createManagedKnowledgeUpdateExecutor({ ...deps, runtimeSnapshot: () => snapshot });
    await expect(executor.processBatch({ limit: 10 })).resolves.toEqual([]);
  }
  expect(repository.claimApprovedUpdate).not.toHaveBeenCalled();
});

it("claims and activates the barrier before remote preflight", async () => {
  await executor.processBatch({ limit: 1 });
  expect(callOrder.slice(0, 2)).toEqual(["claim-and-barrier", "remote-preflight"]);
});
```

- [x] **Step 2: Run executor tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-update-executor.test.ts`

Expected: FAIL because the executor does not exist.

- [x] **Step 3: Implement claim and exact preflight**

The executor lists only approved `update_knowledge_publication` proposals. Claim transaction revalidates action, approval fingerprint, draft/target/page/source/snapshot/policy versions, group, permissions, gates, and one-unresolved-update constraint; then creates execution and sets page `updating`.

Outside the transaction, preflight must equal the bound revision, block type, and before hash. Any mismatch records a typed terminal stale result without calling update.

- [x] **Step 4: Write failing outcome tests**

```ts
it("records remote success as resync_required and enqueues the exact source", async () => {
  updater.update.mockResolvedValue({ kind: "applied", resultingRevision: 13 });
  await executor.processBatch({ limit: 1 });
  expect(repository.recordRemoteOutcome).toHaveBeenCalledWith(expect.objectContaining({
    outcome: "applied",
    resultingRevision: 13,
    expectedResyncContentHash: target.proposedBodyContentHash,
  }));
  expect(syncQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    documentSourceId: "source-1",
  }));
});

it("keeps the page barred when request delivery is unknown", async () => {
  updater.update.mockResolvedValue({ kind: "unknown", code: "timeout" });
  await executor.processBatch({ limit: 1 });
  expect(repository.recordRemoteOutcome).toHaveBeenCalledWith(expect.objectContaining({
    outcome: "outcome_unknown",
  }));
});
```

- [x] **Step 5: Implement remote outcome persistence**

Use deterministic UUID-format client token derived from the durable execution operation key. Explicit pre-dispatch failures may restore `active`; confirmed applied moves to `resync_required`; unknown or local completion failure moves to `reconciliation_required`; stale/forbidden/missing outcomes use the page state specified by the design. Agent observations use tool name `iris.knowledge.updateManagedPublication` and contain only IDs, versions, state, and reason code.

- [x] **Step 6: Write failing reconciler tests**

```ts
it.each([
  ["proposed", "applied"],
  ["old", "retry_same_token"],
  ["human-edit", "reconciliation_required"],
] as const)("maps %s readback to %s", async (fixture, expected) => {
  readBack.mockResolvedValue(readBackFixtures[fixture]);
  await expect(reconciler.reconcileOne(execution)).resolves.toMatchObject({ status: expected });
});
```

- [x] **Step 7: Run reconciler tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-update-reconciler.test.ts tests/managed-knowledge-sync-observer.test.ts`

Expected: FAIL because reconciliation and resync completion are absent.

- [x] **Step 8: Implement readback reconciliation and exact reactivation**

Proposed hash confirms applied. Old hash with the exact old revision permits one bounded retry with the same token. Any other state stays reconciliation-required. The sync observer calls `completeResync` only when its exact observation matches managed page, block ID, resulting revision, and expected canonical hash; the transaction writes immutable update success/event facts, marks proposal/execution succeeded, and changes the page to `active`.

- [x] **Step 9: Wire polling loops into action runtime**

Create updater/executor/reconciler only when database, token provider, sync queue, and feature configuration exist. Start/stop loops with existing runtime lifecycle helpers and expose content-free snapshots alongside publication executor status.

- [x] **Step 10: Run Task 8 tests and verify GREEN**

Run: `npm exec --workspace apps/core -- vitest run tests/managed-knowledge-update-executor.test.ts tests/managed-knowledge-update-reconciler.test.ts tests/managed-knowledge-sync-observer.test.ts tests/action-approval-runtime.test.ts`

Expected: PASS, including update-versus-answer, duplicate executor, human edit, and sync-before-commit races.

- [x] **Step 11: Commit Task 8**

```powershell
git add apps/core/src/action-approvals/managed-knowledge-update-executor.ts apps/core/src/action-approvals/managed-knowledge-update-executor-loop.ts apps/core/src/action-approvals/managed-knowledge-update-reconciler.ts apps/core/src/action-approvals/managed-knowledge-sync-observer.ts apps/core/src/runtime/action-approval-runtime.ts apps/core/tests/managed-knowledge-update-executor.test.ts apps/core/tests/managed-knowledge-update-reconciler.test.ts apps/core/tests/managed-knowledge-sync-observer.test.ts apps/core/tests/action-approval-runtime.test.ts
git commit -m "feat: execute and reconcile managed knowledge updates"
```

### Task 9: Metadata Admin, Readiness, and Default-Off Deployment Contract

**Files:**
- Modify: `apps/core/src/action-approvals/action-proposal-api.ts`
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/src/admin-console/admin-console-assets.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/action-proposal-api.test.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`
- Modify: `apps/core/tests/admin-console-assets.test.ts`
- Modify: `apps/core/tests/admin-console-api.test.ts`
- Modify: `apps/core/tests/internal-readiness-api.test.ts`
- Modify: `apps/core/tests/server-startup.test.ts`
- Modify: `.env.example`
- Modify: `deploy/pilot/ci.env`
- Modify: `deploy/pilot/docker-compose.yml`
- Modify: `scripts/pilot-compose.test.mjs`

**Interfaces:**
- Consumes: managed repository status methods and runtime loop snapshots.
- Produces: metadata-only page/update views, operator reconciliation action, readiness reasons, feature flag, and allowlist deployment contract.

- [x] **Step 1: Write failing API/privacy tests**

```ts
it("returns managed update metadata without draft or document bodies", async () => {
  const response = await app.inject({ method: "GET", url: "/internal/action-proposals/proposal-1" });
  expect(response.statusCode).toBe(200);
  expect(response.json().managedTarget).toMatchObject({ state: "resync_required", expectedRevision: 13 });
  expect(response.body).not.toMatch(/Approved body|Proposed body/iu);
});
```

- [x] **Step 2: Run API/readiness tests and verify RED**

Run: `npm exec --workspace apps/core -- vitest run tests/action-proposal-api.test.ts tests/internal-rollout-readiness.test.ts tests/admin-console-assets.test.ts tests/admin-console-api.test.ts tests/internal-readiness-api.test.ts tests/server-startup.test.ts`

Expected: FAIL because update metadata and readiness components are absent.

- [x] **Step 3: Add metadata-only APIs and Admin presentation**

Expose page state, internal page/source IDs, safe Wiki URL, revisions, hashes, proposal/execution states, timestamps, and reason codes. Reconciliation requires internal token plus operator header and accepts expected versions/operation key. Never return content fields or raw Feishu payloads.

- [x] **Step 4: Add readiness and deployment configuration tests**

```ts
it("keeps readiness healthy while managed updates are disabled", async () => {
  expect(report.components.managedKnowledgeUpdate).toMatchObject({ enabled: false, ready: true });
});

it("fails closed when enabled without allowlist or update worker", async () => {
  expect(report.components.managedKnowledgeUpdate).toMatchObject({ enabled: true, ready: false });
});
```

- [x] **Step 5: Implement default-off feature and allowlist parsing**

Use:

```text
IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED=false
IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST=
```

Reject invalid booleans, blank allowlist entries, duplicates, and enabled-with-empty-allowlist. Readiness reports unresolved outcome-unknown/reconciliation counts without identifiers or bodies.

- [x] **Step 6: Run Task 9 tests and pilot configuration validation**

Run: `npm exec --workspace apps/core -- vitest run tests/action-proposal-api.test.ts tests/internal-rollout-readiness.test.ts tests/admin-console-assets.test.ts tests/admin-console-api.test.ts tests/internal-readiness-api.test.ts tests/server-startup.test.ts`

Run: `npm run test:pilot`

Run: `npm run pilot:config`

Expected: all PASS and the rendered Compose config keeps the feature disabled by default.

- [x] **Step 7: Commit Task 9**

```powershell
git add apps/core/src/action-approvals/action-proposal-api.ts apps/core/src/admin/internal-rollout-readiness.ts apps/core/src/admin-console/admin-console-assets.ts apps/core/src/app.ts apps/core/tests/action-proposal-api.test.ts apps/core/tests/internal-rollout-readiness.test.ts apps/core/tests/admin-console-assets.test.ts apps/core/tests/admin-console-api.test.ts apps/core/tests/internal-readiness-api.test.ts apps/core/tests/server-startup.test.ts .env.example deploy/pilot/ci.env deploy/pilot/docker-compose.yml scripts/pilot-compose.test.mjs
git commit -m "feat: expose managed update rollout controls"
```

### Task 10: End-to-End Regression, Documentation, and Pilot Runbook

**Files:**
- Create: `docs/development/iris-managed-knowledge-update-pilot.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`
- Modify: `docs/superpowers/plans/2026-08-20-iris-managed-knowledge-publication-update.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified repository state, exact controlled-pilot commands/evidence fields, updated coverage truth, and completed plan checkboxes.

- [x] **Step 1: Run focused action and document suites**

Run:

```powershell
npm exec --workspace apps/core -- vitest run tests/managed-knowledge-page.test.ts tests/postgres-managed-knowledge-page-repository.test.ts tests/feishu-knowledge-publication-publisher.test.ts tests/knowledge-publication-executor.test.ts tests/managed-knowledge-sync-observer.test.ts tests/action-proposal-planner.test.ts tests/postgres-action-review-repository.test.ts tests/document-fragment-repository.test.ts tests/answer-source-permission-verifier.test.ts tests/feishu-managed-knowledge-updater.test.ts tests/managed-knowledge-update-executor.test.ts tests/managed-knowledge-update-reconciler.test.ts tests/action-approval-runtime.test.ts
```

Expected: all PASS with zero unhandled errors.

- [x] **Step 2: Run static and build gates**

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0.

- [x] **Step 3: Run the complete repository verification**

Run: `npm run verify`

Expected: TypeScript, build, all Node/Vitest tests, Python tests, pilot tests, Compose validation, readiness, and pilot configuration all exit 0.

- [x] **Step 4: Write the controlled Feishu pilot runbook**

Document exact prerequisites, environment flags, allowlisted group, fresh managed-page creation, source sync, conflict creation, group confirmation, OAuth review, approval, one-block mutation, revision advance, barrier observation, exact resync, retrieval proof, control-page proof, queue/DLQ zero check, rollback-by-disable, deployed image/tag/SHA fields, timestamps, and operator identities. Mark the live result `not yet run` until real evidence exists.

- [x] **Step 5: Correct repository documentation without overclaiming**

Update README and coverage baseline to distinguish:

- implemented and locally verified;
- controlled Feishu acceptance pending;
- controlled Feishu acceptance passed with exact evidence.

Do not mark the loop delivered merely because local tests pass.

- [x] **Step 6: Run documentation and status checks**

Run: `git diff --check`

Run: `rg -n "managed knowledge|update_knowledge_publication|not yet run|controlled Feishu" README.md docs/development/iris-managed-knowledge-update-pilot.md docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md`

Expected: no whitespace errors; documentation uses the correct acceptance state.

- [x] **Step 7: Commit Task 10**

```powershell
git add README.md docs/development/iris-managed-knowledge-update-pilot.md docs/superpowers/specs/2026-07-14-iris-core-requirement-coverage-baseline.md docs/superpowers/plans/2026-08-20-iris-managed-knowledge-publication-update.md
git commit -m "docs: add managed knowledge update pilot gate"
```

- [ ] **Step 8: Execute the live pilot only when credentials and the allowlisted group are available**

Follow `docs/development/iris-managed-knowledge-update-pilot.md`. Record exact image/tag/SHA and content-free evidence. If live external prerequisites are unavailable, stop at “locally verified, live pilot pending” and do not claim completion.

---

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 cover managed identity, source linking, canonical observation, and legacy exclusion; Tasks 4–5 cover draft routing and exact review binding; Task 6 covers capabilities and both freshness barriers; Tasks 7–8 cover exact Feishu mutation, durable execution, reconciliation, resync, and concurrency; Tasks 9–10 cover operations, readiness, privacy, deployment, full verification, documentation, and pilot evidence.
- **Type consistency:** `ManagedKnowledgePageRepository`, `canonicalManagedBodyHash`, `ManagedKnowledgeSyncObserver`, `ManagedKnowledgeUpdater`, `ActionProposalActionType`, and `actionTargetFingerprint` are introduced once and consumed under the same names in later tasks.
- **Scope:** Arbitrary documents, legacy adoption, multi-block editing, deletion, title editing, rich-content patches, task creation, and broad rollout remain excluded.
- **Execution mode:** The user explicitly requested uninterrupted continuation, so this plan proceeds through inline `superpowers:executing-plans` checkpoints without asking for another execution-mode decision.
