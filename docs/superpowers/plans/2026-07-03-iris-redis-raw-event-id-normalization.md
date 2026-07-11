# Iris Redis Raw Event ID Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize Redis raw event string ids while parsing queued payloads.

**Architecture:** Trim Redis raw event parser string values through its local `readString` helper.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Redis Raw Event Parser Normalization

**Files:**
- Modify: `apps/core/tests/redis-raw-event-queue.test.ts`
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`

- [x] **Step 1: Write failing parser test**

Assert a Redis raw event payload with whitespace-padded `idempotencyKey` and `eventType` parses to the normalized event.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts --reporter=dot`

Expected: FAIL because parser currently preserves whitespace.

- [x] **Step 3: Implement parser trimming**

Trim string values in the parser's `readString` helper.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/redis-raw-event-queue.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-redis-raw-event-id-normalization.md`

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
git add apps/core/src/events/redis-raw-event-queue.ts apps/core/tests/redis-raw-event-queue.test.ts docs/superpowers/specs/2026-07-03-iris-redis-raw-event-id-normalization-design.md docs/superpowers/plans/2026-07-03-iris-redis-raw-event-id-normalization.md
git commit -m "fix: normalize redis raw event ids"
git push --force-with-lease origin codex/iris-document-source-registry
```
