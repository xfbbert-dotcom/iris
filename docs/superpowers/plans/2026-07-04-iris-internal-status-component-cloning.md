# Iris Internal Status Component Cloning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make internal status snapshots independent from nested component input objects.

**Architecture:** Keep the status builder pure and local. Add recursive cloning for dates, arrays, and plain objects before component details are attached to the returned snapshot.

**Tech Stack:** TypeScript, Vitest, existing internal status snapshot builder.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`

- [x] **Step 1: Write the failing test**

Add a test that builds a status snapshot with nested `retention` and `latestBatch` objects, mutates the returned nested objects, then verifies the original input objects remain unchanged.

- [x] **Step 2: Run focused test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts
```

Expected: the new test fails because nested objects are currently shared by reference.

### Task 2: Clone Component Values

**Files:**
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`

- [x] **Step 1: Add clone helpers**

Add helpers for cloning `Date`, arrays, and plain objects recursively.

- [x] **Step 2: Clone component details in `addComponentStatuses()`**

Use the clone helper before spreading component fields into the returned snapshot component.

- [x] **Step 3: Run focused test to verify pass**

Run the focused internal status snapshot test and expect all tests in that file to pass.

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
git add apps/core/src/admin/internal-status-snapshot.ts apps/core/tests/internal-status-snapshot.test.ts docs/superpowers/specs/2026-07-04-iris-internal-status-component-cloning-design.md docs/superpowers/plans/2026-07-04-iris-internal-status-component-cloning.md
git commit -m "fix: clone internal status components"
git push --force-with-lease origin codex/iris-document-source-registry
```
