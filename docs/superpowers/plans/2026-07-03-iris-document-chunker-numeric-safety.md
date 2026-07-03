# Iris Document Chunker Numeric Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject invalid document chunker size options before they can corrupt document chunks and embeddings.

**Architecture:** Add constructor-level validation for chunk size options. Keep all existing chunk merge/split behavior intact after validation.

**Tech Stack:** TypeScript, Vitest, Iris document semantic indexing pipeline.

---

## File Map

- Modify: `apps/core/tests/document-chunker.test.ts`
  - Adds RED coverage for non-finite, fractional, and unsafe chunk size values.
- Modify: `apps/core/src/documents/document-chunker.ts`
  - Adds shared positive safe integer validation for `maxChunkChars` and `minChunkChars`.
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
  - Adds the document chunker numeric safety pressure test.

### Task 1: RED Coverage

**Files:**
- Modify: `apps/core/tests/document-chunker.test.ts`

- [x] **Step 1: Add invalid size tests**

Assert that `createDocumentChunker` rejects `NaN`, `Infinity`, fractional, and unsafe integer values with explicit field-specific errors.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-chunker.test.ts
```

Expected before implementation: FAIL because `maxChunkChars: Number.NaN` is accepted.

### Task 2: Constructor Validation

**Files:**
- Modify: `apps/core/src/documents/document-chunker.ts`

- [x] **Step 1: Add shared validator**

Create a `sanitizePositiveSafeInteger(fieldName, value)` helper that rejects non-integers, unsafe integers, and values below 1.

- [x] **Step 2: Apply validator**

Use the validator for both `maxChunkChars` and `minChunkChars` before comparing their relative sizes.

- [x] **Step 3: Verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/document-chunker.test.ts
```

Expected after implementation: 5 tests pass.

### Task 3: Full Verification And Commit

**Files:**
- Create: `docs/superpowers/specs/2026-07-03-iris-document-chunker-numeric-safety-design.md`
- Create: `docs/superpowers/plans/2026-07-03-iris-document-chunker-numeric-safety.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src/documents/document-chunker.ts apps/core/tests/document-chunker.test.ts docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md docs/superpowers/specs/2026-07-03-iris-document-chunker-numeric-safety-design.md docs/superpowers/plans/2026-07-03-iris-document-chunker-numeric-safety.md
git commit -m "fix: validate document chunker sizes"
git push origin codex/iris-document-source-registry
```
