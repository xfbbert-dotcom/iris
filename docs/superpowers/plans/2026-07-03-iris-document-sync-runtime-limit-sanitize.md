# Iris Document Sync Runtime Limit Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent non-finite and unsafe-magnitude document sync runtime list limits from producing surprising inventory results.

**Architecture:** Add a small finite-aware and safe-magnitude `sanitizeLimit()` helper in `document-sync-runtime.ts` and use it before array slicing. Cover both source inventory and source snapshot inventory through the existing runtime composition test.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Runtime List Limit Guard

**Files:**
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-document-sync-runtime-limit-sanitize.md`

- [x] **Step 1: Write the failing runtime assertions**

Add assertions that `runtime.sources.list({ limit: Number.POSITIVE_INFINITY })`, `runtime.sources.list({ limit: Number.NaN })`, `runtime.sources.listSnapshots({ id: "source-1", limit: Number.POSITIVE_INFINITY })`, and `runtime.sources.listSnapshots({ id: "source-1", limit: Number.NaN })` resolve to empty arrays.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-sync-runtime.test.ts --reporter=dot`

Expected: FAIL because runtime list methods still slice with the original non-finite limit.

- [x] **Step 3: Write minimal implementation**

Add `sanitizeLimit(value: number): number` in `document-sync-runtime.ts` and use it in both array slices.

- [x] **Step 4: Run focused verification**

Run: `npm --workspace apps/core test -- tests/document-sync-runtime.test.ts --reporter=dot`

Expected: PASS.

- [x] **Step 5: Run full verification**

Run:

```powershell
npm run typecheck
Push-Location workers\ai; python -m pytest; Pop-Location
docker compose config
npm test
```

Expected: all commands PASS.

- [x] **Step 6: Commit and update PR**

Run:

```powershell
git add apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/document-sync-runtime.test.ts docs/superpowers/specs/2026-07-03-iris-document-sync-runtime-limit-sanitize-design.md docs/superpowers/plans/2026-07-03-iris-document-sync-runtime-limit-sanitize.md
git commit -m "fix: sanitize document sync runtime limits"
git push --force-with-lease origin codex/iris-document-source-registry
```

- [x] **Step 7: Reject unsafe finite limits**
  - Add failing runtime assertions for `Number.MAX_SAFE_INTEGER + 1` on source inventory and snapshot inventory.
  - Reject unsafe finite limits before array slicing, while preserving `Infinity` and `NaN` to empty results.
