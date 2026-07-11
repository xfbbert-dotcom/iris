# Iris Document Snapshot Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Reject invalid document snapshot timestamps before database writes.

**Architecture:** Add a small date guard inside `document-snapshot-repository.ts` and apply it to succeeded and failed snapshot insert inputs.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/document-snapshot-repository.test.ts`

- [x] **Step 1: Add invalid fetchedAt tests**

Assert succeeded and failed snapshot inserts reject invalid `fetchedAt` values before calling the query layer.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core run test -- tests/document-snapshot-repository.test.ts -t "invalid .* snapshot fetchedAt"`

Expected: fails because invalid dates reach the insert path.

### Task 2: Normalize Snapshot Dates

**Files:**
- Modify: `apps/core/src/documents/document-snapshot-repository.ts`

- [x] **Step 1: Add snapshot date guard**

Throw `fetchedAt must be a valid date` when the insert timestamp is invalid.

- [x] **Step 2: Reuse guard in both insert paths**

Apply the guard before building succeeded and failed snapshot insert payloads.

- [x] **Step 3: Confirm focused green**

Run the same focused test command.

- [x] **Step 4: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
