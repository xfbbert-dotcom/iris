# Iris Document Sync Worker Stale State Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Redis-recovered document sync jobs cannot be acknowledged while their document
source remains permanently stuck in `syncing` or prematurely `synced` without reindex work.

**Architecture:** Keep direct runner calls conservative, add explicit worker-owned stale-state
recovery authority, and use the existing normal sync pipeline for recovery under the documented
single-consumer v1 constraint.

**Tech Stack:** TypeScript, Vitest, Postgres-backed source state, Redis queue contracts.

## Global Constraints

- Preserve default `already_syncing` and `already_synced` runner behavior.
- Only queue workers may opt into stale-state recovery.
- Never bypass permission or capability checks.
- Do not add leases, schema changes, or multi-replica support in this patch.
- Preserve queue retry, ACK, and DLQ behavior.

---

### Task 1: Specify Queue-Owned Stale-State Recovery

**Files:**
- Add: `docs/superpowers/specs/2026-07-10-iris-document-sync-worker-stale-state-recovery-design.md`
- Add: `docs/superpowers/plans/2026-07-10-iris-document-sync-worker-stale-state-recovery.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Document the crash window and permanent-stuck failure mode**
- [x] **Step 2: Choose explicit worker recovery under the v1 single-consumer constraint**
- [x] **Step 3: Preserve direct-call and policy behavior**

### Task 2: Drive Recovery with Failing Tests

**Files:**
- Modify: `apps/core/tests/document-sync-pipeline.test.ts`
- Modify: `apps/core/tests/document-sync-worker.test.ts`

- [x] **Step 1: Prove default runner calls still skip syncing and synced sources**
- [x] **Step 2: Prove recovery authority completes syncing and synced sources**
- [x] **Step 3: Prove worker calls the runner with recovery authority**
- [x] **Step 4: Preserve denied and disabled source rejection**
- [x] **Step 5: Run focused tests and verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-pipeline.test.ts tests/document-sync-worker.test.ts --reporter=dot
```

Observed RED: both stale-state cases returned their existing skip results and the worker called the
runner without recovery authority. Three targeted assertions failed while all unrelated focused
tests remained green.

### Task 3: Implement Worker-Owned Recovery

**Files:**
- Modify: `apps/core/src/documents/document-sync-pipeline.ts`
- Modify: `apps/core/src/documents/document-sync-worker.ts`

- [x] **Step 1: Add the optional runner recovery input with a false default**
- [x] **Step 2: Reclaim eligible syncing and synced sources only when recovery is enabled**
- [x] **Step 3: Have the queue worker pass recovery authority**
- [x] **Step 4: Run focused tests and verify GREEN**

Observed GREEN: the focused pipeline and worker files passed all 36 tests; TypeScript type checking
also passed.

### Task 4: Verify, Review, and Publish

- [x] **Step 1: Run `npm run verify`**
- [x] **Step 2: Complete independent review and address findings**
- [x] **Step 3: Commit and push the branch**
- [x] **Step 4: Watch PR #3 checks and confirm a clean merge state**

Observed full verification: `git diff --check`, TypeScript type checking, all 65 Core test files
(`1063` passed and `4` skipped), all 7 Python tests, and `docker compose config` completed
successfully.

Independent review found no Critical or Important issues and assessed the change as ready to
merge. Its only Minor suggestion was adopted: the default `syncing` and `synced` skip tests now
also prove that the runner does not mutate source state. Focused tests passed `36/36`, followed by
the same successful full verification result.

Published as design commit `185cca2` and implementation commit `679db2f` on
`codex/iris-document-source-registry`. PR #3 then passed both required checks: AI Worker in 15
seconds and Core in 1 minute 15 seconds, with no failed or pending checks.
