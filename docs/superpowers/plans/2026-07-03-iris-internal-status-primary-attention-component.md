# Iris Internal Status Primary Attention Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one backend-owned primary attention component for compact admin health surfaces.

**Architecture:** Extend the existing internal status snapshot builder. Reuse `attentionComponents[0]` as the source of truth and return `null` when the list is empty.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Snapshot Primary Attention Component

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`

- [x] **Step 1: Write failing snapshot assertion**

Add this expected summary field:

```ts
primaryAttentionComponent: { name: "eventWorker", status: "degraded" },
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: FAIL because `summary.primaryAttentionComponent` is missing.

- [x] **Step 3: Implement the field**

In `buildInternalStatusSnapshot`, after `attentionComponents` is computed, add:

```ts
const primaryAttentionComponent = attentionComponents[0] ?? null;
```

Return it under `summary`.

- [x] **Step 4: Run snapshot test to verify it passes**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Healthy Empty State Coverage

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`

- [x] **Step 1: Add healthy-state test**

Add a test where all components are healthy and assert:

```ts
expect(snapshot.summary.attentionComponents).toEqual([]);
expect(snapshot.summary.primaryAttentionComponent).toBeNull();
```

- [x] **Step 2: Run snapshot test**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: PASS.

### Task 3: API Expectations

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Update API expected summaries**

Add `primaryAttentionComponent` to each `/internal/status` expected summary.

- [x] **Step 2: Run API tests**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: PASS.

### Task 4: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-internal-status-primary-attention-component.md`

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
git add apps/core/src/admin/internal-status-snapshot.ts apps/core/tests/internal-status-snapshot.test.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-03-iris-internal-status-primary-attention-component-design.md docs/superpowers/plans/2026-07-03-iris-internal-status-primary-attention-component.md
git commit -m "feat: surface primary internal status attention"
git push --force-with-lease origin codex/iris-document-source-registry
```
