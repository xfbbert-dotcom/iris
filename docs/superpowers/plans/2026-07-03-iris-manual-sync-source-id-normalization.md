# Iris Manual Sync Source ID Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize manual sync source ids before lookup and enqueue.

**Architecture:** Trim `documentSourceId` once at the start of `ManualDocumentSyncPlanner.enqueueSource` and use the normalized value throughout.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Source ID Normalization

**Files:**
- Modify: `apps/core/tests/manual-document-sync-planner.test.ts`
- Modify: `apps/core/src/documents/manual-document-sync-planner.ts`

- [x] **Step 1: Write failing planner test**

Add a test where `enqueueSource` receives `" source-1 "` and assert registry lookup, queue job, and response use `"source-1"`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/manual-document-sync-planner.test.ts --reporter=dot`

Expected: FAIL because the planner currently uses the raw id.

- [x] **Step 3: Implement source id normalization**

Add `const normalizedDocumentSourceId = documentSourceId.trim();` at the start of `enqueueSource` and use it for all downstream operations.

- [x] **Step 4: Run planner test to verify it passes**

Run: `npm --workspace apps/core test -- tests/manual-document-sync-planner.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-manual-sync-source-id-normalization.md`

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
git add apps/core/src/documents/manual-document-sync-planner.ts apps/core/tests/manual-document-sync-planner.test.ts docs/superpowers/specs/2026-07-03-iris-manual-sync-source-id-normalization-design.md docs/superpowers/plans/2026-07-03-iris-manual-sync-source-id-normalization.md
git commit -m "fix: normalize manual sync source ids"
git push --force-with-lease origin codex/iris-document-source-registry
```
