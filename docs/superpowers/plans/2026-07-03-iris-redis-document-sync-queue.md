# Iris Redis Document Sync Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Redis-backed `DocumentSyncQueue` and wire both producer and consumer runtimes to use it.

**Architecture:** Implement a focused Redis queue module that mirrors the raw event and reindex queue patterns: atomic SADD/RPUSH enqueue, FIFO LPOP dequeue, and LLEN status. Then replace the default in-memory document sync queue in event and document sync runtimes with Redis-backed shared queues.

**Tech Stack:** TypeScript, Vitest, Redis client interface, existing Iris runtime composition.

---

## File Structure

- Create `apps/core/src/documents/redis-document-sync-queue.ts`: Redis implementation, serializer, parser, and minimal client type.
- Create `apps/core/tests/redis-document-sync-queue.test.ts`: queue behavior tests.
- Modify `apps/core/src/runtime/event-worker-runtime.ts`: default document sync producer queue should use Redis client through a lazy wrapper.
- Modify `apps/core/tests/event-worker-runtime.test.ts`: assert document sync queue is created from a Redis-backed factory with the same Redis client.
- Modify `apps/core/src/runtime/document-sync-runtime.ts`: create Redis client and Redis-backed document sync queue by default, connect/quit it in lifecycle.
- Modify `apps/core/tests/document-sync-runtime.test.ts`: assert Redis client composition and shutdown.
- Modify PR body after verification.

---

### Task 1: Redis Document Sync Queue

**Files:**
- Create: `apps/core/src/documents/redis-document-sync-queue.ts`
- Test: `apps/core/tests/redis-document-sync-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create tests that cover atomic enqueue, FIFO dequeue, batch limits, pending count, JSON round trip, legacy missing attempts, and malformed payload rejection.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- redis-document-sync-queue.test.ts`

Expected: FAIL because `redis-document-sync-queue.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement:

- `RedisDocumentSyncQueueClient`
- `createRedisDocumentSyncQueue`
- `serializeDocumentSyncJob`
- `parseDocumentSyncJob`

Default keys:

- `iris:documents:sync:seen`
- `iris:documents:sync:queue`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- redis-document-sync-queue.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/redis-document-sync-queue.ts apps/core/tests/redis-document-sync-queue.test.ts
git commit -m "feat: add Redis document sync queue"
```

---

### Task 2: Event Runtime Producer Wiring

**Files:**
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/tests/event-worker-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Update the event runtime composition test so the default document sync queue dependency receives a Redis-compatible lazy client, and no longer defaults to the in-memory queue in production composition.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- event-worker-runtime.test.ts`

Expected: FAIL because the runtime still uses `createInMemoryDocumentSyncQueue` by default.

- [ ] **Step 3: Write minimal implementation**

Import `createRedisDocumentSyncQueue` and return it from the default `createDocumentSyncQueue` factory using the same Redis connection as raw events.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- event-worker-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/event-worker-runtime.ts apps/core/tests/event-worker-runtime.test.ts
git commit -m "feat: wire event runtime document sync queue to Redis"
```

---

### Task 3: Document Sync Runtime Consumer Wiring

**Files:**
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Update the runtime composition test to require a Redis client, connect it lazily, pass a Redis-backed document sync queue to the worker, report pending count from Redis, and quit Redis on close.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- document-sync-runtime.test.ts`

Expected: FAIL because the runtime still creates an in-memory queue and does not own a Redis lifecycle.

- [ ] **Step 3: Write minimal implementation**

Import `createClient`, add `createRedisClient` and `createDocumentSyncQueue` runtime dependencies, create the Redis connection from `REDIS_URL`, wrap it in a lazy queue client, and quit Redis in `close()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- document-sync-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/document-sync-runtime.test.ts
git commit -m "feat: wire document sync runtime queue to Redis"
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
- Add Phase 3B Redis document sync queue: durable shared document sync queue for event producers and document sync consumers.
```

- [ ] **Step 4: Verify PR state**

Run:

```bash
gh pr view 3 --repo xfbbert-dotcom/iris --json state,isDraft,mergeable,headRefOid,url
```

Expected: PR is open, non-draft, and mergeable or pending mergeability calculation.

---

## Self-Review

- Spec coverage: Redis queue implementation, producer wiring, consumer wiring, verification, and PR update are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: `DocumentSyncJob`, `DocumentSyncQueue`, and runtime dependency names match existing code patterns.
