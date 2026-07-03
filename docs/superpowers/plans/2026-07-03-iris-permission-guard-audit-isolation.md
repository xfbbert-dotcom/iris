# Iris Permission Guard Audit Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep answer-time permission filtering reliable when audit logging fails.

**Architecture:** Preserve the existing live permission guard decisions and wrap audit event recording in a local best-effort `try/catch`. Audit failures must not alter allowed or denied fragment results.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: RED Test

**Files:**
- Modify: `apps/core/tests/permission-guard.test.ts`

- [x] **Step 1: Write the failing test**

Add a permission guard test where one document is denied, another is allowed, and `auditLog.record()` throws. Assert the denied fragment is excluded, the allowed fragment is returned, and the audit write is attempted with the denied document event.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/permission-guard.test.ts
```

Expected: the new test fails with `audit store unavailable`.

### Task 2: Implementation

**Files:**
- Modify: `apps/core/src/permissions/permission-guard.ts`

- [x] **Step 1: Isolate audit writes**

Wrap `auditLog.record()` in `try/catch` and swallow audit write failures while leaving permission filtering unchanged.

- [x] **Step 2: Verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/permission-guard.test.ts
```

Expected: all permission guard tests pass.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update whitepaper**

Add a permission audit isolation pressure test so future audit backends cannot become answer-time critical dependencies.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit successfully.

- [x] **Step 3: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src/permissions/permission-guard.ts apps/core/tests/permission-guard.test.ts docs/superpowers
git commit -m "fix: isolate permission audit failures"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and its summary mentions permission audit isolation.
