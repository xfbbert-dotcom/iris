# Iris Redis Document Sync Job ID Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize Redis document sync job ids during parsing so malformed-but-recoverable payloads do not fail downstream source lookup.

**Architecture:** Trim string values in `parseDocumentSyncJob` by updating its local `readString` helper.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Redis Job ID Normalization

**Files:**
- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`

- [x] **Step 1: Write failing parser test**

Assert a Redis job payload with whitespace-padded `idempotencyKey` and `documentSourceId` parses to the normalized job.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/redis-document-sync-queue.test.ts --reporter=dot`

Expected: FAIL because parser currently preserves whitespace.

- [x] **Step 3: Implement parser trimming**

Trim string values in the parser's `readString` helper.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/redis-document-sync-queue.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-redis-document-sync-job-id-normalization.md`

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
git add apps/core/src/documents/redis-document-sync-queue.ts apps/core/tests/redis-document-sync-queue.test.ts docs/superpowers/specs/2026-07-03-iris-redis-document-sync-job-id-normalization-design.md docs/superpowers/plans/2026-07-03-iris-redis-document-sync-job-id-normalization.md
git commit -m "fix: normalize redis document sync job ids"
git push --force-with-lease origin codex/iris-document-source-registry
```
