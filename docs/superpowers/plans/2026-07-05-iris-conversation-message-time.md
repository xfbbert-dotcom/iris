# Iris Conversation Message Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Reject invalid conversation message timestamps before storing live-chat context.

**Architecture:** Add a small date guard to `postgres-conversation-message-repository.ts` and apply it to `sentAt` before the upsert query parameters are built.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/postgres-conversation-message-repository.test.ts`

- [x] **Step 1: Add invalid sentAt test**

Assert upsert rejects invalid `sentAt` and does not call the query layer.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core run test -- tests/postgres-conversation-message-repository.test.ts -t "invalid sentAt"`

Expected: fails because invalid dates reach the upsert path.

### Task 2: Normalize Conversation Dates

**Files:**
- Modify: `apps/core/src/conversation/postgres-conversation-message-repository.ts`

- [x] **Step 1: Add date guard**

Throw `sentAt must be a valid date` when the upsert timestamp is invalid.

- [x] **Step 2: Apply guard before query**

Use the normalized `sentAt` value in the query params.

- [x] **Step 3: Confirm focused green**

Run the same focused test command.

- [x] **Step 4: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
