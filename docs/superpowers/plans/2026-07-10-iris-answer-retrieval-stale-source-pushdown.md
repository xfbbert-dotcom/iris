# Iris Answer Retrieval Stale Source Pushdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent locally stale document fragments from consuming answer-time semantic retrieval
candidate slots.

**Architecture:** Tighten the existing Postgres vector-search predicate so only answering-enabled
sources in `unknown` or `readable` permission state are ranked. Keep the local source-policy check
and Feishu real-time permission guard unchanged as later defense-in-depth layers.

**Tech Stack:** TypeScript, Vitest, Postgres, pgvector.

## Global Constraints

- Do not add a new configuration switch or repository interface field.
- Do not weaken local source policy or Feishu live permission checks.
- Preserve source-type pushdown and vector ranking order.

---

### Task 1: Exclude Stale Sources Before Vector Ranking

**Files:**
- Modify: `apps/core/tests/document-fragment-repository.test.ts`
- Modify: `apps/core/src/documents/document-fragment-repository.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

**Interfaces:**
- Consumes: `DocumentFragmentRepository.searchSimilarFragments(input)`.
- Produces: the same repository interface with a stricter SQL candidate predicate.

- [x] **Step 1: Write the failing repository test**

Require generated vector-search SQL to contain:

```sql
ds.permission_state in ('unknown', 'readable')
```

and to retain `ds.can_use_for_answering = true`.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-fragment-repository.test.ts --reporter=dot
```

Expected: FAIL because vector search currently uses `ds.permission_state <> 'denied'`.

Observed: FAIL because generated SQL still contained `ds.permission_state <> 'denied'` instead of
the required `unknown` / `readable` predicate.

- [x] **Step 3: Implement the minimal SQL predicate**

Replace the broad non-denied predicate with:

```sql
and ds.permission_state in ('unknown', 'readable')
```

- [x] **Step 4: Record the invariant in the architecture whitepaper**

State that stale and denied sources must be removed before vector ranking while local and live
permission guards continue to run after retrieval.

- [x] **Step 5: Run focused and full verification**

Run:

```powershell
npm --workspace apps/core test -- tests/document-fragment-repository.test.ts tests/document-retrieval-context.test.ts tests/answer-draft-runtime.test.ts --reporter=dot
npm run verify
```

Expected: all tests, type checking, Python tests, and Docker Compose validation pass.

Observed:

- Focused retrieval tests passed with 47 tests passed / 1 skipped.
- `npm run verify` passed with 65 Core test files, 1048 Core tests passed / 4 skipped,
  7 Python tests passed, type checking passed, and Docker Compose validation passed.
- The isolated Postgres integration assertion is included for GitHub Actions because the local
  Docker Desktop Linux engine is unavailable until WSL2 is enabled.

- [x] **Step 6: Commit and push**

```powershell
git add apps/core/src/documents/document-fragment-repository.ts apps/core/tests/document-fragment-repository.test.ts docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md docs/superpowers/specs/2026-07-10-iris-answer-retrieval-stale-source-pushdown-design.md docs/superpowers/plans/2026-07-10-iris-answer-retrieval-stale-source-pushdown.md
git commit -m "fix: exclude stale answer retrieval sources"
git push
```
