# Iris Audit Summary Limit Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent non-finite and unsafe-magnitude audit summary limits from summarizing all retained audit events.

**Architecture:** Add a finite-aware and safe-magnitude `sanitizeLimit()` helper inside `audit-log.ts` and use it before the recent event window is built. Keep retention, grouping, filters, and sort behavior unchanged.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Audit Summary Limit Guard

**Files:**
- Modify: `apps/core/tests/audit-log.test.ts`
- Modify: `apps/core/src/audit/audit-log.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-audit-summary-limit-sanitize.md`

- [x] **Step 1: Write the failing audit-log test**

Add a test that records one permission guard audit event and asserts `summarizeRecent({ limit: Number.POSITIVE_INFINITY })` and `summarizeRecent({ limit: Number.NaN })` both return `[]`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/audit-log.test.ts --reporter=dot`

Expected: FAIL because non-finite limits currently summarize retained events.

- [x] **Step 3: Write minimal implementation**

Add a `sanitizeLimit(value: number): number` helper and use it at the start of `summarizeRecent()`.

- [x] **Step 4: Run focused verification**

Run: `npm --workspace apps/core test -- tests/audit-log.test.ts --reporter=dot`

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
git add apps/core/src/audit/audit-log.ts apps/core/tests/audit-log.test.ts docs/superpowers/specs/2026-07-03-iris-audit-summary-limit-sanitize-design.md docs/superpowers/plans/2026-07-03-iris-audit-summary-limit-sanitize.md
git commit -m "fix: sanitize audit summary limits"
git push --force-with-lease origin codex/iris-document-source-registry
```

- [x] **Step 7: Reject unsafe finite limits**
  - Add a failing audit log test for `Number.MAX_SAFE_INTEGER + 1`.
  - Reject unsafe finite limits before summarizing retained events, while preserving `Infinity` and `NaN` to `[]`.
