# Iris Blank Limit Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make blank `limit` query parameters fail clearly instead of behaving like `limit=0`.

**Architecture:** Tighten the existing `parseDeadLetterLimit()` helper so it rejects blank strings before numeric coercion. Keep the change centralized so audit, document sync, reindex, and inventory endpoints share the same behavior.

**Tech Stack:** TypeScript, Fastify injection tests, Vitest.

---

### Task 1: Reject Blank Limit Values

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/app.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-blank-limit-query.md`

- [x] **Step 1: Write the failing API test**

Add a test under the source inventory API suite that injects `GET /internal/document-sync/sources?limit=` and expects `400` with `{ ok: false, error: "invalid_request" }`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: FAIL because blank `limit` is treated as zero.

- [x] **Step 3: Write minimal implementation**

In `parseDeadLetterLimit()`, return `undefined` when `value` is a string whose trimmed length is zero.

- [x] **Step 4: Run focused verification**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

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
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-03-iris-blank-limit-query-design.md docs/superpowers/plans/2026-07-03-iris-blank-limit-query.md
git commit -m "fix: reject blank limit queries"
git push --force-with-lease origin codex/iris-document-source-registry
```
