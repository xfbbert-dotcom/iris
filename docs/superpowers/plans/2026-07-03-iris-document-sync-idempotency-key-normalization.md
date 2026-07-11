# Iris Document Sync Idempotency Key Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize document source ids when creating document sync idempotency keys.

**Architecture:** Trim the source id in `createDocumentSyncIdempotencyKey` and cover it with a focused queue test.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Idempotency Key Normalization

**Files:**
- Modify: `apps/core/tests/document-sync-queue.test.ts`
- Modify: `apps/core/src/documents/document-sync-queue.ts`

- [x] **Step 1: Write failing idempotency key test**

Assert `createDocumentSyncIdempotencyKey({ documentSourceId: " source-1 " })` returns `document-sync:source-1`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-sync-queue.test.ts --reporter=dot`

Expected: FAIL because the raw id currently remains in the key.

- [x] **Step 3: Implement trimming**

Use `input.documentSourceId.trim()` when building the idempotency key.

- [x] **Step 4: Run queue test to verify it passes**

Run: `npm --workspace apps/core test -- tests/document-sync-queue.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-document-sync-idempotency-key-normalization.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Mark checklist complete**

Update this plan so completed steps are checked.

- [x] **Step 3: Commit and push**

Run:

```bash
git add apps/core/src/documents/document-sync-queue.ts apps/core/tests/document-sync-queue.test.ts docs/superpowers/specs/2026-07-03-iris-document-sync-idempotency-key-normalization-design.md docs/superpowers/plans/2026-07-03-iris-document-sync-idempotency-key-normalization.md
git commit -m "fix: normalize document sync idempotency keys"
git push --force-with-lease origin codex/iris-document-source-registry
```
