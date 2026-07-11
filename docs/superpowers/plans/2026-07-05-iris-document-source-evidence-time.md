# Iris Document Source Evidence Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Reject invalid document-source evidence timestamps before fact-layer writes.

**Architecture:** Add shared date normalization to `document-source-registry.ts` and reuse it in both in-memory and Postgres registration paths.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/document-source-registry.test.ts`
- Modify: `apps/core/tests/postgres-document-source-registry.test.ts`

- [x] **Step 1: Add invalid observedAt tests**

Assert in-memory registration throws and stores no source, and Postgres registration throws before
opening a transaction.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core run test -- tests/document-source-registry.test.ts tests/postgres-document-source-registry.test.ts -t "invalid evidence timestamps"`

Expected: fails because invalid dates are accepted.

### Task 2: Normalize Evidence Dates

**Files:**
- Modify: `apps/core/src/documents/document-source-registry.ts`
- Modify: `apps/core/src/documents/postgres-document-source-registry.ts`

- [x] **Step 1: Add shared date guard**

Export `normalizeDocumentSourceDate()` and throw `DocumentSourceValidationError` for invalid dates.

- [x] **Step 2: Reuse guard in registration paths**

Apply the guard to group-visible, authorized wiki, and user-submitted evidence timestamps.

- [x] **Step 3: Confirm focused green**

Run the same focused test command.

- [x] **Step 4: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
