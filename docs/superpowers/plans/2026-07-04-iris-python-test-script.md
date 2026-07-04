# Iris Python Test Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-level Python worker test command that cannot be run from the wrong directory.

**Architecture:** Add `npm run test:python` at the repository root to enter `workers/ai` before
running pytest. Update operator/developer docs to use that command.

**Tech Stack:** npm scripts, Python pytest, Markdown docs.

---

### Task 1: Failing Root Script Check

**Files:**
- Modify: `package.json`

- [x] **Step 1: Verify missing script**

Run:

```powershell
npm run test:python
```

Expected: npm fails with `Missing script: "test:python"`.

- [x] **Step 2: Add root npm script**

Add:

```json
"test:python": "cd workers/ai && python -m pytest"
```

### Task 2: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/plans/2026-07-04-iris-internal-api-token-query-path.md`

- [x] **Step 1: Use canonical command**

Replace multi-step Python pytest directory changes with:

```powershell
npm run test:python
```

### Task 3: Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Verify new script**

Run:

```powershell
npm run test:python
```

Expected: pytest collects 7 worker tests and all pass.

- [x] **Step 2: Run full verification**

Run:

```powershell
git diff --check
npm run typecheck
npm test
npm run test:python
docker compose config
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the script and docs, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
