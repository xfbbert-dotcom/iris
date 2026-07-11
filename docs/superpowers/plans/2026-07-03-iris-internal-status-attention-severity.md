# Iris Internal Status Attention Severity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a backend-owned operational severity for compact admin health surfaces.

**Architecture:** Extend the existing internal status snapshot builder. Derive `summary.attentionSeverity` from `primaryAttentionComponent.status` so the severity stays aligned with attention ordering.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Snapshot Attention Severity

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`

- [x] **Step 1: Write failing snapshot assertions**

Add `attentionSeverity: "critical"` to the mixed-status expected summary and assert `attentionSeverity` is `"none"` in the healthy-state test.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: FAIL because `summary.attentionSeverity` is missing.

- [x] **Step 3: Implement severity derivation**

Add an exported type and helper in `apps/core/src/admin/internal-status-snapshot.ts`:

```ts
export type InternalAttentionSeverity = "none" | "info" | "warning" | "critical";
```

```ts
function getAttentionSeverity(
  primaryAttentionComponent: { status: InternalComponentStatus } | null,
): InternalAttentionSeverity {
  if (!primaryAttentionComponent) {
    return "none";
  }
  if (primaryAttentionComponent.status === "degraded") {
    return "critical";
  }
  if (primaryAttentionComponent.status === "stopped") {
    return "warning";
  }
  return "info";
}
```

Return `attentionSeverity` under `summary`.

- [x] **Step 4: Run snapshot test to verify it passes**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts --reporter=dot`

Expected: PASS.

### Task 2: API Expectations

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Update API expected summaries**

Add `attentionSeverity` to each `/internal/status` expected summary.

- [x] **Step 2: Run API tests**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: PASS.

### Task 3: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-internal-status-attention-severity.md`

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
git add apps/core/src/admin/internal-status-snapshot.ts apps/core/tests/internal-status-snapshot.test.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-03-iris-internal-status-attention-severity-design.md docs/superpowers/plans/2026-07-03-iris-internal-status-attention-severity.md
git commit -m "feat: classify internal status attention severity"
git push --force-with-lease origin codex/iris-document-source-registry
```
