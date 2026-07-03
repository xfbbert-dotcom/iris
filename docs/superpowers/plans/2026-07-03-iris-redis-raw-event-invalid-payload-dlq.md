# Iris Redis Raw Event Invalid Payload DLQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Redis raw event processing moving when a malformed queue payload is encountered.

**Architecture:** Catch `parseRawEvent` errors inside `RedisRawEventQueue.dequeueBatch`, push an invalid-payload record to the raw event DLQ, and continue with the rest of the batch.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Invalid Payload DLQ

**Files:**
- Modify: `apps/core/tests/redis-raw-event-queue.test.ts`
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`

- [x] **Step 1: Write failing Redis queue test**

Assert a malformed queued payload is pushed to the raw event DLQ and a following valid event is still returned.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts --reporter=dot`

Expected: FAIL because the current dequeue path throws on malformed payloads.

- [x] **Step 3: Implement invalid payload DLQ handling**

Wrap `parseRawEvent(payload)` in `try/catch`; on error, `rPush` a DLQ record with `rawPayload`, `errorMessage`, and `failedAt`, then continue.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-redis-raw-event-invalid-payload-dlq.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Run:

```bash
git add apps/core/src/events/redis-raw-event-queue.ts apps/core/tests/redis-raw-event-queue.test.ts docs/superpowers/specs/2026-07-03-iris-redis-raw-event-invalid-payload-dlq-design.md docs/superpowers/plans/2026-07-03-iris-redis-raw-event-invalid-payload-dlq.md
git commit -m "fix: dead-letter invalid redis raw event payloads"
git push --force-with-lease origin codex/iris-document-source-registry
```
