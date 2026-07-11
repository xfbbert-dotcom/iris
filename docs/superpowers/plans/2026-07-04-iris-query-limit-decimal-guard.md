# Iris Query Limit Decimal Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject non-decimal internal API `limit` query values instead of coercing them with
JavaScript's `Number()`.

**Architecture:** Tighten the shared `parseDeadLetterLimit()` helper in `apps/core/src/app.ts`.
String query values must be blank-checked, then match decimal digits only before numeric parsing.
The existing default limit, zero handling, safe-integer check, and maximum cap stay unchanged.

**Tech Stack:** TypeScript, Vitest, Markdown.

---

### Task 1: Decimal Query Limit Parsing

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing non-decimal limit tests**

Add internal API tests that reject:

- `/internal/audit/events?limit=1e2`
- `/internal/reindex/dead-letters?limit=0x10`
- `/internal/document-sync/sources?limit=10.0`

Expected before implementation: these values are accepted by `Number()`.

- [x] **Step 2: Run focused API tests and confirm RED**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts
```

Expected: the new assertions fail because non-decimal strings are currently coerced.

- [x] **Step 3: Tighten the shared parser**

Update `parseDeadLetterLimit()` so string values:

- trim whitespace;
- reject blank strings;
- require `/^\d+$/u`;
- keep the existing integer, safe-integer, non-negative, and cap checks.

- [x] **Step 4: Run focused API tests and confirm GREEN**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts
```

Expected: the command exits 0.

### Task 2: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-iris-query-limit-safe-integer-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-query-limit-decimal-guard.md`

- [x] **Step 1: Document decimal-only limit parsing**

Document that internal API query limits reject non-decimal string forms.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the query-limit decimal guard update, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions returns Core and AI Worker success.
