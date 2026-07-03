# Iris Worker Loop Snapshot Cloning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make worker loop status snapshots immutable from the caller's point of view by returning defensive copies.

**Architecture:** Keep the current in-memory loop design. Add narrow clone helpers inside each loop module so `getSnapshot()` exposes a read model instead of the stored `latestBatch` object.

**Tech Stack:** TypeScript, Vitest, existing worker loop modules.

---

### Task 1: Add Snapshot Mutation Regression Tests

**Files:**
- Modify: `apps/core/tests/raw-event-worker-loop.test.ts`
- Modify: `apps/core/tests/document-sync-worker-loop.test.ts`
- Modify: `apps/core/tests/document-reindex-worker-loop.test.ts`

- [x] **Step 1: Write failing tests**

Add one test per loop that runs a successful batch, mutates `latestBatch` from the first `getSnapshot()` call, then verifies a second `getSnapshot()` still contains the original dates and counters.

- [x] **Step 2: Run focused tests to verify failure**

Run:

```bash
npm test -- --run apps/core/tests/raw-event-worker-loop.test.ts apps/core/tests/document-sync-worker-loop.test.ts apps/core/tests/document-reindex-worker-loop.test.ts
```

Expected: the new tests fail because `getSnapshot()` currently returns the stored `latestBatch` object.

### Task 2: Clone Latest Batch Snapshots

**Files:**
- Modify: `apps/core/src/events/raw-event-worker-loop.ts`
- Modify: `apps/core/src/documents/document-sync-worker-loop.ts`
- Modify: `apps/core/src/reindex/document-reindex-worker-loop.ts`

- [x] **Step 1: Add clone helpers**

For each loop module, add a helper that returns:

```ts
{
  ...snapshot,
  startedAt: new Date(snapshot.startedAt),
  finishedAt: new Date(snapshot.finishedAt),
}
```

- [x] **Step 2: Use helpers in `getSnapshot()`**

Replace direct `latestBatch` exposure with the cloned snapshot.

- [x] **Step 3: Run focused tests to verify pass**

Run the focused Vitest command again and expect all three loop suites to pass.

### Task 3: Verify and Publish

**Files:**
- Update PR body only after verification.

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

- [x] **Step 2: Commit and push**

Commit with:

```bash
git add apps/core/src/events/raw-event-worker-loop.ts apps/core/src/documents/document-sync-worker-loop.ts apps/core/src/reindex/document-reindex-worker-loop.ts apps/core/tests/raw-event-worker-loop.test.ts apps/core/tests/document-sync-worker-loop.test.ts apps/core/tests/document-reindex-worker-loop.test.ts docs/superpowers/specs/2026-07-03-iris-worker-loop-snapshot-cloning-design.md docs/superpowers/plans/2026-07-03-iris-worker-loop-snapshot-cloning.md
git commit -m "fix: clone worker loop snapshots"
git push --force-with-lease origin codex/iris-document-source-registry
```
