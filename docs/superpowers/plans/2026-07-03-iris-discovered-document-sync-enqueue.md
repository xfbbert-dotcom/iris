# Iris Discovered Document Sync Enqueue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enqueue eligible group-visible document sources for later synchronization immediately after Iris discovers and registers them from Feishu group messages.

**Architecture:** Add a source-level document sync queue and in-memory implementation, add a planner that filters registered sources through `isSyncCandidate`, call the planner from `GroupVisibleDocumentRegistrar`, and wire the planner into the event worker runtime. The event worker remains a producer only; body fetching and queue consumption stay out of scope.

**Tech Stack:** TypeScript, Vitest, existing document source registry, existing event worker runtime.

---

## File Structure

- Create `apps/core/src/documents/document-sync-queue.ts`
  - Defines `DocumentSyncJob`, `DocumentSyncQueue`, reason type, and idempotency helper.
- Create `apps/core/src/documents/in-memory-document-sync-queue.ts`
  - Provides deduplicating in-memory queue for local runtime wiring and tests.
- Create `apps/core/tests/document-sync-queue.test.ts`
  - Covers idempotency key format and in-memory dedupe.
- Create `apps/core/src/documents/discovered-document-sync-planner.ts`
  - Enqueues eligible registered sources.
- Create `apps/core/tests/discovered-document-sync-planner.test.ts`
  - Covers enqueue, skip, and queue idempotency metadata.
- Modify `apps/core/src/documents/group-visible-document-registrar.ts`
  - Optionally calls the planner after each registration.
- Modify `apps/core/tests/group-visible-document-registrar.test.ts`
  - Covers planner call and failure propagation.
- Modify `apps/core/src/runtime/event-worker-runtime.ts`
  - Creates sync queue and planner, passes planner to registrar.
- Modify `apps/core/tests/event-worker-runtime.test.ts`
  - Asserts runtime composition.

## Task 1: Document Sync Queue Contract

**Files:**
- Create: `apps/core/src/documents/document-sync-queue.ts`
- Create: `apps/core/src/documents/in-memory-document-sync-queue.ts`
- Test: `apps/core/tests/document-sync-queue.test.ts`

- [ ] **Step 1: Write failing queue tests**

Create tests for `createDocumentSyncIdempotencyKey({ documentSourceId: "source-1" })` returning `document-sync:source-1`, enqueue/dequeue order, and duplicate idempotency key dedupe.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- document-sync-queue.test.ts`

Expected: FAIL because queue files do not exist.

- [ ] **Step 3: Implement queue contract and in-memory queue**

Implement:

```ts
export type DocumentSyncReason = "discovered_group_document";
export type DocumentSyncJob = {
  idempotencyKey: string;
  documentSourceId: string;
  reason: DocumentSyncReason;
  enqueuedAt: Date;
  attempts: number;
};
export interface DocumentSyncQueue {
  enqueue(job: DocumentSyncJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentSyncJob[]>;
  getPendingCount(): Promise<number>;
}
export function createDocumentSyncIdempotencyKey(input: { documentSourceId: string }): string;
```

The in-memory queue uses a `Map<string, DocumentSyncJob>` and deletes dequeued jobs.

- [ ] **Step 4: Run queue tests**

Run: `npm test -- document-sync-queue.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/document-sync-queue.ts apps/core/src/documents/in-memory-document-sync-queue.ts apps/core/tests/document-sync-queue.test.ts
git commit -m "feat: add document sync queue contract"
```

## Task 2: Discovered Document Sync Planner

**Files:**
- Create: `apps/core/src/documents/discovered-document-sync-planner.ts`
- Test: `apps/core/tests/discovered-document-sync-planner.test.ts`

- [ ] **Step 1: Write failing planner tests**

Tests should assert that pending eligible sources are enqueued with `reason: "discovered_group_document"`, ineligible sources are skipped, and counts are returned as `{ enqueuedCount, skippedCount }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- discovered-document-sync-planner.test.ts`

Expected: FAIL because planner file does not exist.

- [ ] **Step 3: Implement planner**

Use `isSyncCandidate(source)`. For each eligible source, enqueue a job with `createDocumentSyncIdempotencyKey`, `documentSourceId`, `reason`, `enqueuedAt: now()`, and `attempts: 0`.

- [ ] **Step 4: Run planner tests**

Run: `npm test -- discovered-document-sync-planner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/discovered-document-sync-planner.ts apps/core/tests/discovered-document-sync-planner.test.ts
git commit -m "feat: plan sync for discovered documents"
```

## Task 3: Registrar Planner Integration

**Files:**
- Modify: `apps/core/src/documents/group-visible-document-registrar.ts`
- Modify: `apps/core/tests/group-visible-document-registrar.test.ts`

- [ ] **Step 1: Write failing registrar tests**

Add tests that registered source results are passed to `syncPlanner.planRegisteredSources`, and that planner failure rejects `registerDiscoveredLinks`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- group-visible-document-registrar.test.ts`

Expected: FAIL because registrar does not accept or call a planner yet.

- [ ] **Step 3: Implement planner integration**

Accept optional `syncPlanner`. For each registered link, await registry registration, then call `syncPlanner.planRegisteredSources([source])`. If no planner exists, preserve current behavior.

- [ ] **Step 4: Run registrar tests**

Run: `npm test -- group-visible-document-registrar.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/group-visible-document-registrar.ts apps/core/tests/group-visible-document-registrar.test.ts
git commit -m "feat: enqueue discovered documents after registration"
```

## Task 4: Event Worker Runtime Wiring

**Files:**
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/tests/event-worker-runtime.test.ts`

- [ ] **Step 1: Write failing runtime test**

Assert the runtime creates `createDocumentSyncQueue`, creates `createDiscoveredDocumentSyncPlanner({ queue })`, and passes the planner into `createGroupVisibleDocumentRegistrar`.

- [ ] **Step 2: Run runtime test to verify it fails**

Run: `npm test -- event-worker-runtime.test.ts`

Expected: FAIL because runtime does not wire the sync queue/planner yet.

- [ ] **Step 3: Implement runtime wiring**

Default to `createInMemoryDocumentSyncQueue()` and `createDiscoveredDocumentSyncPlanner({ queue })`. Extend dependency injection for tests.

- [ ] **Step 4: Run runtime tests**

Run: `npm test -- event-worker-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/event-worker-runtime.ts apps/core/tests/event-worker-runtime.test.ts
git commit -m "feat: wire discovered document sync enqueue runtime"
```

## Task 5: Full Verification And PR Update

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run TypeScript tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run Python worker tests**

Run: `python -m pytest` from `workers/ai`

Expected: all tests pass.

- [ ] **Step 4: Run Docker Compose validation**

Run: `docker compose config`

Expected: exit 0.

- [ ] **Step 5: Push and update PR**

```bash
git push origin codex/iris-document-source-registry
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<updated body with Phase 2X summary>"
```

Expected: PR #3 contains Phase 2X summary and checked test plan.

## Self-Review

- Spec coverage: queue contract, eligibility, registrar integration, runtime wiring, idempotency, and deferred worker scope are covered.
- Placeholder scan: no incomplete placeholder markers are present.
- Type consistency: `DocumentSyncQueue`, `DocumentSyncJob`, `createDocumentSyncIdempotencyKey`, `planRegisteredSources`, and `syncPlanner` names are consistent across tasks.
