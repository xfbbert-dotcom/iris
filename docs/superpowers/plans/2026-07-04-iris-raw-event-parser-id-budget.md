# Iris Raw Event Parser ID Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound queued Redis raw event identifiers before worker processing.

**Architecture:** Reject oversized raw-event `idempotencyKey` and `eventType` values inside
`parseRawEvent`.

**Tech Stack:** TypeScript, Vitest, existing Redis raw event queue tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/redis-raw-event-queue.test.ts`

- [x] **Step 1: Add oversized queued identifier test**

Add a parser test that rejects a queued raw event with an oversized `idempotencyKey` and rejects one
with an oversized `eventType`.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- redis-raw-event-queue.test.ts
```

Expected: the new test fails because `parseRawEvent` currently only checks non-empty string values.

Observed: the focused test failed because the oversized `idempotencyKey` payload did not throw.

### Task 2: Implement Parser ID Budget

**Files:**
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`

- [x] **Step 1: Import raw event ID budget**

Import `MAX_RAW_EVENT_ID_LENGTH` from the raw event queue contract.

- [x] **Step 2: Validate parsed identifiers once**

Read `idempotencyKey` and `eventType` once, reject blank or oversized values, and reuse the validated
strings in the returned `RawEvent`.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- redis-raw-event-queue.test.ts
```

Expected: Redis raw event queue tests pass.

Observed: focused Redis raw event queue tests passed with `26` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-raw-event-parser-id-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-raw-event-parser-id-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `809` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the raw event parser ID budget patch, push `codex/iris-document-source-registry`, update PR
#3, and confirm GitHub Actions Core and AI Worker checks pass.
