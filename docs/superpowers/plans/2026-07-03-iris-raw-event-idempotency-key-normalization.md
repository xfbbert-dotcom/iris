# Iris Raw Event Idempotency Key Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize raw event ids when creating raw event idempotency keys.

**Architecture:** Trim the event id in `createRawEventIdempotencyKey` and cover it with a focused queue test.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Idempotency Key Normalization

**Files:**
- Modify: `apps/core/tests/raw-event-queue.test.ts`
- Modify: `apps/core/src/events/raw-event-queue.ts`

- [x] **Step 1: Write failing idempotency key test**

Assert `createRawEventIdempotencyKey({ provider: "feishu", eventId: " evt-1 " })` returns `raw-event:feishu:evt-1`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/raw-event-queue.test.ts --reporter=dot`

Expected: FAIL because the raw event id currently remains in the key.

- [x] **Step 3: Implement trimming**

Use `input.eventId.trim()` when building the idempotency key.

- [x] **Step 4: Run queue test to verify it passes**

Run: `npm --workspace apps/core test -- tests/raw-event-queue.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-raw-event-idempotency-key-normalization.md`

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
git add apps/core/src/events/raw-event-queue.ts apps/core/tests/raw-event-queue.test.ts docs/superpowers/specs/2026-07-03-iris-raw-event-idempotency-key-normalization-design.md docs/superpowers/plans/2026-07-03-iris-raw-event-idempotency-key-normalization.md
git commit -m "fix: normalize raw event idempotency keys"
git push --force-with-lease origin codex/iris-document-source-registry
```
