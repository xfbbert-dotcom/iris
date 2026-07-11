# Iris Internal Status Attention Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a backend-owned list of internal status components that need admin attention.

**Architecture:** Extend the existing internal status snapshot builder. Derive `summary.attentionComponents` from the component-level `status` values so the API and tests share one source of truth.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Snapshot Attention Components

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`

- [x] **Step 1: Write the failing snapshot test**

Add `attentionComponents` to the expected `summary`:

```ts
attentionComponents: [
  { name: "eventWorker", status: "degraded" },
  { name: "reindex", status: "stopped" },
  { name: "answerDraft", status: "disabled" },
],
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: FAIL because `summary.attentionComponents` is missing.

- [x] **Step 3: Implement attention derivation**

Add a helper in `apps/core/src/admin/internal-status-snapshot.ts` that:

```ts
function buildAttentionComponents(
  components: Record<string, { status: InternalComponentStatus }>,
) {
  const priority: Record<InternalComponentStatus, number> = {
    degraded: 0,
    stopped: 1,
    disabled: 2,
    healthy: 3,
  };

  return Object.entries(components)
    .filter(([, component]) => component.status !== "healthy")
    .map(([name, component], index) => ({ name, status: component.status, index }))
    .sort((left, right) => priority[left.status] - priority[right.status] || left.index - right.index)
    .map(({ name, status }) => ({ name, status }));
}
```

Then assign `const attentionComponents = buildAttentionComponents(components);` and return it under `summary`.

- [x] **Step 4: Run snapshot test to verify it passes**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: PASS.

### Task 2: API Expectations

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Update API expected summaries**

Add `attentionComponents` to each `/internal/status` expected summary in `answer-draft-api.test.ts`.

- [x] **Step 2: Run API tests**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: PASS.

### Task 3: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-internal-status-attention-components.md`

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
git add apps/core/src/admin/internal-status-snapshot.ts apps/core/tests/internal-status-snapshot.test.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-03-iris-internal-status-attention-components-design.md docs/superpowers/plans/2026-07-03-iris-internal-status-attention-components.md
git commit -m "feat: surface internal status attention components"
git push --force-with-lease origin codex/iris-document-source-registry
```
