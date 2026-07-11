# Iris Reindex Job ID Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize reindex job ids at key creation and Redis parsing boundaries.

**Architecture:** Trim reindex ids in `createDocumentReindexIdempotencyKey` and in the Redis reindex queue parser's `readString` helper.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Reindex ID Normalization

**Files:**
- Modify: `apps/core/tests/document-reindex-queue.test.ts`
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`
- Modify: `apps/core/src/reindex/document-reindex-queue.ts`
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`

- [x] **Step 1: Write failing idempotency key test**

Assert whitespace-padded reindex key inputs produce `reindex:profile-1:snapshot-1`.

- [x] **Step 2: Write failing Redis parser test**

Assert whitespace-padded Redis reindex payload ids parse to the normalized job.

- [x] **Step 3: Run focused tests to verify they fail**

Run:

```bash
npm --workspace apps/core test -- tests/document-reindex-queue.test.ts --reporter=dot
npm --workspace apps/core test -- tests/redis-document-reindex-queue.test.ts --reporter=dot
```

Expected: both fail on preserved whitespace.

- [x] **Step 4: Implement trimming**

Trim key helper inputs and Redis parser string values.

- [x] **Step 5: Run focused tests to verify they pass**

Run the same focused tests.

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-reindex-job-id-normalization.md`

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
git add apps/core/src/reindex/document-reindex-queue.ts apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/document-reindex-queue.test.ts apps/core/tests/redis-document-reindex-queue.test.ts docs/superpowers/specs/2026-07-03-iris-reindex-job-id-normalization-design.md docs/superpowers/plans/2026-07-03-iris-reindex-job-id-normalization.md
git commit -m "fix: normalize reindex job ids"
git push --force-with-lease origin codex/iris-document-source-registry
```
