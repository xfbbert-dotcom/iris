# Iris Conversation Message ID Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound direct conversation message identifiers before Postgres writes and recent-chat
queries.

**Architecture:** Apply a shared `512` character identifier budget inside the Postgres conversation
message repository, before SQL execution.

**Tech Stack:** TypeScript, Vitest, existing Postgres conversation message repository tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/postgres-conversation-message-repository.test.ts`

- [x] **Step 1: Add oversized upsert identifier tests**

Add table-driven tests for oversized `providerMessageId`, `chatId`, `senderId`, `messageType`, and
`rawEventIdempotencyKey`. Each oversized value should reject before `queryable.query` is called.

- [x] **Step 2: Add oversized recent-chat ID test**

Add a `listRecentByChat` test with a `513` character `chatId` and assert it rejects before querying
Postgres.

- [x] **Step 3: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- postgres-conversation-message-repository.test.ts
```

Expected: the new tests fail because direct repository inputs are not currently bounded.

Observed: the focused test failed with `6` failures. Oversized upsert identifiers reached
`queryable.query`, and oversized recent `chatId` resolved instead of rejecting.

### Task 2: Implement Repository ID Budget

**Files:**
- Modify: `apps/core/src/conversation/postgres-conversation-message-repository.ts`

- [x] **Step 1: Add identifier budget constant**

Add `MAX_CONVERSATION_MESSAGE_ID_CHARS = 512`.

- [x] **Step 2: Validate direct write identifiers before SQL**

Validate `providerMessageId`, `chatId`, `senderId`, `messageType`, and `rawEventIdempotencyKey`
before composing SQL params or the local row ID.

- [x] **Step 3: Validate recent-chat query ID before SQL**

Validate `listRecentByChat` `chatId` before sanitizing the limit and querying Postgres.

- [x] **Step 4: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- postgres-conversation-message-repository.test.ts
```

Expected: Postgres conversation message repository tests pass.

Observed: focused Postgres conversation message repository tests passed with `12` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-conversation-message-id-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-conversation-message-id-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `806` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the conversation message ID budget patch, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `5e53b9c`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.

### Follow-up: Reject Blank Conversation Identifiers

**Files:**
- Modify: `apps/core/tests/postgres-conversation-message-repository.test.ts`
- Modify: `apps/core/src/conversation/postgres-conversation-message-repository.ts`
- Modify: `docs/superpowers/specs/2026-07-04-iris-conversation-message-id-budget-design.md`

- [x] **Step 1: Add failing blank identifier tests**

Cover blank `providerMessageId`, `chatId`, `senderId`, `messageType`, and
`rawEventIdempotencyKey` before upsert, plus blank `listRecentByChat.chatId` before query.

Observed: focused tests failed because blank values reached `queryable.query`, or recent-chat reads
resolved instead of rejecting.

- [x] **Step 2: Reject blank identifiers before SQL**

Extend the shared identifier guard to reject values whose trimmed length is zero, without trimming
or otherwise rewriting non-blank provider IDs.

Observed: focused Postgres conversation message repository tests passed with `18` tests.
