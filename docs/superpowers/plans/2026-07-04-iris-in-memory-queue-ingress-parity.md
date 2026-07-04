# Iris In-Memory Queue Ingress Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align in-memory queue ingress validation with Redis-backed queue parser behavior.

**Architecture:** Validate, trim, and clone raw event, document sync, and document reindex payloads
before storing them in memory.

**Tech Stack:** TypeScript, Vitest, existing in-memory queue tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/raw-event-queue.test.ts`
- Modify: `apps/core/tests/document-sync-queue.test.ts`
- Modify: `apps/core/tests/document-reindex-queue.test.ts`

- [x] **Step 1: Add raw event in-memory ingress test**

Assert oversized raw event `idempotencyKey` and `eventType` values reject before enqueue.

- [x] **Step 2: Add document sync in-memory ingress test**

Assert an oversized document sync job rejects before enqueue.

- [x] **Step 3: Add document reindex in-memory ingress test**

Assert an oversized document reindex job rejects before enqueue.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- raw-event-queue.test.ts document-sync-queue.test.ts document-reindex-queue.test.ts
```

Expected: new tests fail because in-memory queues currently accept these oversized payloads.

Observed: focused tests failed because all three oversized payloads resolved instead of rejecting.

### Task 2: Implement In-Memory Queue Validation

**Files:**
- Modify: `apps/core/src/events/raw-event-queue.ts`
- Modify: `apps/core/src/events/in-memory-raw-event-queue.ts`
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`
- Modify: `apps/core/src/documents/in-memory-document-sync-queue.ts`
- Modify: `apps/core/src/reindex/in-memory-document-reindex-queue.ts`

- [x] **Step 1: Share raw event idempotency budget**

Export `MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH` from the raw event queue contract and reuse it in
Redis and in-memory raw event queues.

- [x] **Step 2: Validate raw events before in-memory storage**

Reject blank/oversized raw event IDs, unsupported providers, blank/oversized event types, invalid
bodies, invalid dates, and invalid attempts before storing.

- [x] **Step 3: Validate document sync jobs before in-memory storage**

Reject blank/oversized/mismatched document sync job IDs before storing.

- [x] **Step 4: Validate document reindex jobs before in-memory storage**

Reject blank/oversized/mismatched document reindex job IDs before storing.

- [x] **Step 5: Store normalized clones before deduplication**

Use trimmed, validated ID fields for in-memory dedupe keys.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- raw-event-queue.test.ts document-sync-queue.test.ts document-reindex-queue.test.ts
```

Expected: focused raw event, document sync, and document reindex queue tests pass.

Observed: focused queue tests passed with `154` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-in-memory-queue-ingress-parity-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-in-memory-queue-ingress-parity.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `820` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the in-memory queue ingress parity patch, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
