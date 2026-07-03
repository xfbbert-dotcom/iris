# Iris Internal Status Operator Attention Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose whether Iris currently needs operator attention as a stable backend contract.

**Architecture:** Extend the existing internal status snapshot builder. Derive `summary.requiresOperatorAttention` from `attentionComponentCount > 0`.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Snapshot Operator Attention Flag

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`

- [x] **Step 1: Write failing snapshot assertions**

Add `requiresOperatorAttention: true` to the mixed-status expected summary and assert `requiresOperatorAttention` is `false` in the healthy-state test.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: FAIL because `summary.requiresOperatorAttention` is missing.

- [x] **Step 3: Implement the field**

In `buildInternalStatusSnapshot`, after `attentionComponentCount` is computed, add:

```ts
const requiresOperatorAttention = attentionComponentCount > 0;
```

Return it under `summary`.

- [x] **Step 4: Run snapshot test to verify it passes**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: PASS.

### Task 2: API Expectations

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Update API expected summaries**

Add `requiresOperatorAttention` to each `/internal/status` expected summary.

- [x] **Step 2: Run API tests**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: PASS.

### Task 3: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-internal-status-operator-attention-flag.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Mark checklist complete**

Update this plan so completed steps are checked.

- [x] **Step 3: Commit and push**

Run:

```bash
git add apps/core/src/admin/internal-status-snapshot.ts apps/core/tests/internal-status-snapshot.test.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-03-iris-internal-status-operator-attention-flag-design.md docs/superpowers/plans/2026-07-03-iris-internal-status-operator-attention-flag.md
git commit -m "feat: flag internal status operator attention"
git push --force-with-lease origin codex/iris-document-source-registry
```
