# Iris Conversation Message Text Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound durable conversation message text so abnormal Feishu messages cannot bloat the fact
layer.

**Architecture:** Normalize text at the Postgres conversation-message repository boundary before
upsert parameters and again while mapping rows.

**Tech Stack:** TypeScript, Vitest, existing Postgres conversation-message repository tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/postgres-conversation-message-repository.test.ts`

- [x] **Step 1: Add upsert text budget test**

Upsert an oversized message and assert the SQL text parameter is bounded, marked truncated, and
excludes the tail.

- [x] **Step 2: Add legacy read budget test**

Return an oversized text value from a fake row and assert mapped messages are bounded, marked
truncated, and exclude the tail.

- [x] **Step 3: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/postgres-conversation-message-repository.test.ts
```

Expected: the new tests fail because message text currently passes through unbounded.

Observed: the focused test failed with `9024` upsert characters and `9023` legacy read characters.

### Task 2: Implement Conversation Message Text Budget

**Files:**
- Modify: `apps/core/src/conversation/postgres-conversation-message-repository.ts`

- [x] **Step 1: Add text normalization helper**

Add an `8000` character budget with ` ... [truncated]`.

- [x] **Step 2: Apply before writes and after reads**

Use the helper for upsert SQL parameters and row mapping.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/postgres-conversation-message-repository.test.ts
```

Expected: focused repository tests pass.

Observed: focused Postgres conversation-message repository tests passed with `6` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-conversation-message-text-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-conversation-message-text-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `788` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the conversation message text budget patch, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `c4838e4`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
