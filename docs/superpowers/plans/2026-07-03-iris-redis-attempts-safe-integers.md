# Iris Redis Attempts Safe Integers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject unsafe integer retry attempts in Redis queue payloads.

**Architecture:** Extend each Redis queue parser's optional non-negative integer reader to require `Number.isSafeInteger`. Keep missing attempts backward-compatible and keep invalid payload handling on the existing DLQ path.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: RED Tests

**Files:**
- Modify: `apps/core/tests/redis-raw-event-queue.test.ts`
- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [x] **Step 1: Add unsafe attempts tests**

Add one parser test per Redis queue proving `attempts: 9007199254740992` is rejected.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts
```

Expected: all three new tests fail because unsafe integer attempts are currently accepted.

### Task 2: Implementation

**Files:**
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`

- [x] **Step 1: Reject unsafe attempts**

Add `Number.isSafeInteger(value)` to each Redis queue `readOptionalNonNegativeInteger` helper.

- [x] **Step 2: Verify GREEN**

Run the same focused Redis queue test command.

Expected: all three Redis queue test files pass.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update whitepaper**

Add a Redis retry-attempt numeric safety guardrail.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit successfully.

- [x] **Step 3: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src/events/redis-raw-event-queue.ts apps/core/src/documents/redis-document-sync-queue.ts apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/redis-raw-event-queue.test.ts apps/core/tests/redis-document-sync-queue.test.ts apps/core/tests/redis-document-reindex-queue.test.ts docs/superpowers
git commit -m "fix: reject unsafe Redis attempt counters"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and its summary mentions Redis attempt counter validation.
