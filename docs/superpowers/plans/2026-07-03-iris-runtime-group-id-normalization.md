# Iris Runtime Group ID Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Iris runtime group enable/disable controls robust to padded or blank group IDs.

**Architecture:** Normalize group IDs inside `RuntimeController` before mutation and access checks.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Runtime Controller Group ID Guard

**Files:**
- Modify: `apps/core/tests/runtime-controller.test.ts`
- Modify: `apps/core/src/admin/runtime-controller.ts`

- [x] **Step 1: Write failing runtime controller tests**

Assert padded group IDs are normalized for disable/enable/check flows, and blank group IDs are rejected.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/runtime-controller.test.ts --reporter=dot`

Expected: FAIL because group IDs are currently used exactly as provided.

- [x] **Step 3: Implement group ID normalization**

Add a small helper that trims group IDs, ignores blank mutation inputs, and rejects blank check inputs.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/runtime-controller.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-runtime-group-id-normalization.md`

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
git add apps/core/src/admin/runtime-controller.ts apps/core/tests/runtime-controller.test.ts docs/superpowers/specs/2026-07-03-iris-runtime-group-id-normalization-design.md docs/superpowers/plans/2026-07-03-iris-runtime-group-id-normalization.md
git commit -m "fix: normalize runtime group ids"
git push --force-with-lease origin codex/iris-document-source-registry
```
