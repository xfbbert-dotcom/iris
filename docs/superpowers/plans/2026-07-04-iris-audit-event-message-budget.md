# Iris Audit Event Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound audit event messages before permission and audit paths store or expose oversized
diagnostics.

**Architecture:** Add `normalizeAuditEventMessage`, use it in permission guard audit writes and
inside `InMemoryAuditLog.record`.

**Tech Stack:** TypeScript, Vitest, existing permission guard and audit log tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/permission-guard.test.ts`
- Modify: `apps/core/tests/audit-log.test.ts`

- [x] **Step 1: Add permission guard audit test**

Throw an oversized permission check error and assert the audit event passed to `auditLog.record`
has a bounded message with `[truncated]`.

- [x] **Step 2: Add audit log storage test**

Record an audit event with an oversized `message` and assert the stored event is bounded.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/permission-guard.test.ts tests/audit-log.test.ts
```

Expected: tests fail because audit messages are currently stored unchanged.

Observed: both new tests failed with `1227` character messages.

### Task 2: Implement Audit Message Budget

**Files:**
- Create: `apps/core/src/audit/audit-event-message.ts`
- Modify: `apps/core/src/permissions/permission-guard.ts`
- Modify: `apps/core/src/audit/audit-log.ts`

- [x] **Step 1: Add helper**

Implement a `1000` character audit event message budget with ` ... [truncated]`.

- [x] **Step 2: Apply before permission guard audit writes**

Normalize permission guard error messages before passing events to injected audit logs.

- [x] **Step 3: Apply at in-memory audit storage**

Normalize event messages in `InMemoryAuditLog.record` before retention storage.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/permission-guard.test.ts tests/audit-log.test.ts
```

Expected: permission guard and audit log tests pass.

Observed: focused tests passed with `20` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-audit-event-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-audit-event-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `782` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the audit event message budget helper, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `77e58d9`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
