# Iris Audit Filter Before Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure filtered internal audit queries return the newest matching retained events instead
of accidentally dropping matches behind newer unrelated events.

**Architecture:** Add filter-before-limit selection to `InMemoryAuditLog.summarizeRecent` and to
the app-level audit event diagnostics. Preserve unfiltered latest-N behavior.

**Tech Stack:** TypeScript, Fastify injection tests, Vitest.

---

### Task 1: Write Failing Audit Tests

**Files:**
- Modify: `apps/core/tests/audit-log.test.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add summary unit test**

Add an `InMemoryAuditLog` test where an older `permission_guard_denied` event is followed by newer
unrelated events. Query:

```ts
auditLog.summarizeRecent({
  limit: 1,
  documentId: "source-1",
  type: "permission_guard_denied",
})
```

Expected: the older matching event is summarized.

- [x] **Step 2: Add audit events API test**

Add a `/internal/audit/events?limit=1&documentId=source-1&type=permission_guard_denied` test with
the same event shape. Expected: the response returns the matching event and meta reports all retained
events inspected with one matching event.

- [x] **Step 3: Add audit summary API test**

Add a `/internal/audit/events/summary?limit=1&documentId=source-1&type=permission_guard_denied`
test. Expected: the response summarizes the matching event and the meta matches the events endpoint.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- audit-log.test.ts answer-draft-api.test.ts -t "filtered audit"
```

Expected: the new tests fail because the code applies limit before filters.

Observed: all three filtered audit tests failed because the existing code inspected only the latest
unrelated event before applying filters.

### Task 2: Implement Filter Before Limit

**Files:**
- Modify: `apps/core/src/audit/audit-log.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add reusable filter predicate inside audit log**

Keep existing query fields and compare `documentId`, `type`, and `operatorHint`.

- [x] **Step 2: Change summary event window selection**

Use latest `limit` retained events when no filters are present. When filters are present, filter all
retained events first, then take the latest `limit` matching events.

- [x] **Step 3: Change app diagnostics selection**

Use the same filter-before-limit behavior for `/internal/audit/events` metadata and returned events.
Set `matchingEventCount` to the number of retained events matching before the final limit.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- audit-log.test.ts answer-draft-api.test.ts -t "filtered audit"
```

Expected: the focused filtered audit tests pass.

Observed: focused filtered audit tests passed.

### Task 3: Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-05-iris-audit-filter-before-limit-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-audit-filter-before-limit.md`

- [x] **Step 1: Run focused audit/API tests**

Run:

```powershell
npm --workspace apps/core test -- audit-log.test.ts answer-draft-api.test.ts
```

Expected: all audit log and answer draft API tests pass.

Observed: `audit-log.test.ts` and `answer-draft-api.test.ts` passed with 167 tests.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core 1005 passed / 4 skipped, Python 7 passed, and
`docker compose config` succeeded.

- [ ] **Step 3: Commit, push, update PR, and verify checks**

Commit the filtered audit query fix, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions Core and AI Worker checks pass.
