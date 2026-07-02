# Iris Document Sync Reindex Enqueue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enqueue a semantic reindex job whenever document sync successfully records a snapshot.

**Architecture:** Add a small optional post-success hook to `DocumentSyncRunner`, then wire `DocumentSyncRuntime` to create a Redis-backed `DocumentReindexPlanner` when embedding config is present. Keep the reindex worker itself separate.

**Tech Stack:** TypeScript, Vitest, Redis queues, existing Iris document sync and reindex modules.

---

## File Structure

- Modify `apps/core/src/documents/document-sync-pipeline.ts`: add optional synced snapshot reindex hook.
- Modify `apps/core/tests/document-sync-pipeline.test.ts`: assert successful sync triggers reindex enqueue and failed/skipped paths do not.
- Create `apps/core/src/model/embedding-profile-id.ts`: shared helper for active embedding profile id and supported dimension validation.
- Modify `apps/core/src/runtime/reindex-worker-runtime.ts`: use shared helper instead of private duplicate helper.
- Modify `apps/core/src/runtime/document-sync-runtime.ts`: create Redis reindex queue/planner when embedding config is configured.
- Modify `apps/core/tests/document-sync-runtime.test.ts`: assert reindex planner composition when embedding config is present and absence when it is missing.

---

### Task 1: Document Sync Runner Reindex Hook

**Files:**
- Modify: `apps/core/src/documents/document-sync-pipeline.ts`
- Modify: `apps/core/tests/document-sync-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that creates a `syncedSnapshotReindexer`, performs a successful sync, and expects it to be called with `{ documentSnapshotId: "snapshot-success" }` after the source is marked `synced`.

Add a test that fetch failure does not call the reindexer.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- document-sync-pipeline.test.ts`

Expected: FAIL because `createDocumentSyncRunner` does not accept or invoke `syncedSnapshotReindexer`.

- [ ] **Step 3: Write minimal implementation**

Add:

```ts
export interface SyncedSnapshotReindexer {
  enqueueSyncedSnapshotReindex(input: { documentSnapshotId: string }): MaybePromise<void>;
}
```

Call it after `registry.markSyncState(source.id, "synced")`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- document-sync-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/document-sync-pipeline.ts apps/core/tests/document-sync-pipeline.test.ts
git commit -m "feat: enqueue reindex after document sync"
```

---

### Task 2: Shared Embedding Profile Id Helper

**Files:**
- Create: `apps/core/src/model/embedding-profile-id.ts`
- Modify: `apps/core/src/runtime/reindex-worker-runtime.ts`
- Modify: `apps/core/tests/reindex-worker-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add direct helper tests through existing runtime behavior only if needed. The existing reindex runtime tests should keep passing after extracting the helper.

- [ ] **Step 2: Run baseline test**

Run: `npm test -- reindex-worker-runtime.test.ts`

Expected: PASS before extraction.

- [ ] **Step 3: Extract helper**

Create:

```ts
export function createEmbeddingProfileId(input: {
  provider: "openai-compatible";
  model: string;
  dimensions: number;
}): string {
  return `${input.provider}:${input.model}:${input.dimensions}`;
}

export function assertSupportedRuntimeEmbeddingDimension(dimension: number): void {
  if (dimension !== 6 && dimension !== 1536) {
    throw new Error(`Unsupported embedding dimension: ${dimension}`);
  }
}
```

Use it from `reindex-worker-runtime.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- reindex-worker-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/model/embedding-profile-id.ts apps/core/src/runtime/reindex-worker-runtime.ts
git commit -m "refactor: share embedding profile id helper"
```

---

### Task 3: Document Sync Runtime Reindex Wiring

**Files:**
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Update the enabled runtime test with embedding config:

- `IRIS_EMBEDDING_PROVIDER=openai-compatible`
- `IRIS_EMBEDDING_MODEL=text-embedding-small`
- `IRIS_EMBEDDING_DIMENSIONS=1536`
- `IRIS_EMBEDDING_BASE_URL=https://api.example.com/v1`
- `IRIS_EMBEDDING_API_KEY=key`

Assert `createDocumentSyncRunner` receives `syncedSnapshotReindexer: { enqueueSyncedSnapshotReindex: expect.any(Function) }`.

Invoke the adapter and assert the Redis reindex queue receives a `document_synced` job through its factory or planner dependency.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- document-sync-runtime.test.ts`

Expected: FAIL because runtime does not create or pass a synced snapshot reindexer.

- [ ] **Step 3: Write minimal implementation**

Add runtime dependencies for creating a reindex queue and planner. If embedding config is undefined, pass no reindexer. If embedding config exists without dimensions, throw the same dimensions-required error style as reindex runtime.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- document-sync-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/document-sync-runtime.test.ts
git commit -m "feat: wire document sync reindex enqueue"
```

---

### Task 4: Verification And PR Update

**Files:**
- Modify PR #3 body only.

- [ ] **Step 1: Run full verification**

```bash
npm run typecheck
npm test
python -m pytest
docker compose config
```

Run Python from `workers/ai`.

- [ ] **Step 2: Push branch**

```bash
git push origin codex/iris-document-source-registry
```

- [ ] **Step 3: Update PR body**

Add:

```markdown
- Add Phase 3C document sync reindex enqueue: successful synced snapshots now enqueue semantic reindex jobs for the active embedding profile.
```

- [ ] **Step 4: Verify PR state**

Run:

```bash
gh pr view 3 --repo xfbbert-dotcom/iris --json state,isDraft,mergeable,headRefOid,url
```

Expected: PR is open, non-draft, and mergeable or pending mergeability calculation.

---

## Self-Review

- Spec coverage: successful sync hook, runtime profile wiring, Redis reindex queue enqueue, verification, and PR update are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: `syncedSnapshotReindexer`, `enqueueSyncedSnapshotReindex`, `createEmbeddingProfileId`, and `assertSupportedRuntimeEmbeddingDimension` are consistently named.
