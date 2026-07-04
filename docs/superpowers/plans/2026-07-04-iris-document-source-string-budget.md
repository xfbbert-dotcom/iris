# Iris Document Source String Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce direct registry string budgets for document source registrations.

**Architecture:** Share source URI and metadata string guards across the in-memory and Postgres
document source registries.

**Tech Stack:** TypeScript, Vitest, existing document source registry tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/document-source-registry.test.ts`
- Modify: `apps/core/tests/postgres-document-source-registry.test.ts`

- [x] **Step 1: Add in-memory registry string budget test**

Register a group-visible document with a `2049` character `sourceUri` and a separate oversized
`title`; assert both are rejected and no source is stored.

- [x] **Step 2: Add Postgres registry string budget test**

Register a group-visible document with a `2049` character `sourceUri`; assert it is rejected before
any transaction query or client release happens.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm -w apps/core test -- document-source-registry.test.ts postgres-document-source-registry.test.ts
```

Expected: the new tests fail because both registries currently accept oversized direct strings.

Observed: the in-memory test did not throw, and the Postgres test resolved after opening the fake
transaction path, proving the direct registry boundary was missing.

### Task 2: Implement Registry String Budgets

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/src/documents/postgres-document-source-registry.ts`

- [x] **Step 1: Add shared budget constants and normalizers**

Export `2048` character source URI and `512` character metadata budgets from the in-memory registry
module alongside shared required/optional string normalizers.

- [x] **Step 2: Apply shared validation to both registries**

Use the shared validators for group-visible, authorized wiki, and user-submitted document
registrations in both in-memory and Postgres implementations.

- [x] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
npm -w apps/core test -- document-source-registry.test.ts postgres-document-source-registry.test.ts
```

Expected: focused registry tests pass.

Observed: focused document source registry tests passed with `44` passed / `2` skipped.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-document-source-string-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-source-string-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `799` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the document source string budget patch, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: pending.
