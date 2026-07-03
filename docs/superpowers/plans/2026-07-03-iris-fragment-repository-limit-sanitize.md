# Iris Fragment Repository Limit Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent non-finite vector search limits from reaching SQL.

**Architecture:** Add the same finite-aware limit guard already used by queue, worker, and repository boundaries to `DocumentFragmentRepository.searchSimilarFragments()`. Keep the change local to the repository and prove it with a focused unit test.

**Tech Stack:** TypeScript, Vitest, pgvector SQL through `pg`.

---

### Task 1: Fragment Search Limit Guard

**Files:**
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `docs/superpowers/plans/2026-07-03-iris-fragment-repository-limit-sanitize.md`

- [x] **Step 1: Write the failing test**

Add a test named `sanitizes non-finite vector search limits to zero` that calls `searchSimilarFragments()` with `Number.POSITIVE_INFINITY` and `Number.NaN`, and asserts the SQL values are `["static-dev-6d", "[1,2,3,4,5,6]", 0]`.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/document-fragment-repository.test.ts --reporter=dot`

Expected: FAIL because `searchSimilarFragments()` still passes the original non-finite limit.

- [x] **Step 3: Write minimal implementation**

Add a local `sanitizeLimit(value: number): number` helper and pass `sanitizeLimit(input.limit)` as the third SQL parameter.

- [x] **Step 4: Run focused verification**

Run: `npm --workspace apps/core test -- tests/document-fragment-repository.test.ts --reporter=dot`

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

- [ ] **Step 6: Commit and update PR**

Run:

```powershell
git add apps/core/src/documents/document-fragment-repository.ts apps/core/tests/document-fragment-repository.test.ts docs/superpowers/specs/2026-07-03-iris-fragment-repository-limit-sanitize-design.md docs/superpowers/plans/2026-07-03-iris-fragment-repository-limit-sanitize.md
git commit -m "fix: sanitize fragment search limits"
git push --force-with-lease origin codex/iris-document-source-registry
```
