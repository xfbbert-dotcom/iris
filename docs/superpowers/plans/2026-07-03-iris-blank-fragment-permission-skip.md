# Iris Blank Fragment Permission Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid unnecessary live permission checks for blank retrieved document fragments.

**Architecture:** Filter blank retrieved fragments before invoking the permission guard, while keeping raw retrieval diagnostics unchanged.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Pre-Permission Blank Fragment Filter

**Files:**
- Modify: `apps/core/tests/document-retrieval-context.test.ts`
- Modify: `apps/core/src/memory/document-retrieval-context.ts`

- [x] **Step 1: Write failing retrieval context test**

Assert blank fragments do not call `canReadDocument`, while nonblank fragments still do.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-retrieval-context.test.ts --reporter=dot`

Expected: FAIL because blank fragments currently reach the permission guard.

- [x] **Step 3: Implement pre-permission filtering**

Create a `meaningfulFragments` list before permission filtering and use it for permission guard and allowed-fragment selection.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/document-retrieval-context.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-blank-fragment-permission-skip.md`

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
git add apps/core/src/memory/document-retrieval-context.ts apps/core/tests/document-retrieval-context.test.ts docs/superpowers/specs/2026-07-03-iris-blank-fragment-permission-skip-design.md docs/superpowers/plans/2026-07-03-iris-blank-fragment-permission-skip.md
git commit -m "fix: skip permission checks for blank fragments"
git push --force-with-lease origin codex/iris-document-source-registry
```
