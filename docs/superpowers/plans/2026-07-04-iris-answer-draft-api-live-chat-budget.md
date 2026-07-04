# Iris Answer Draft API Live Chat Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize oversized live-chat context at the answer draft API boundary.

**Architecture:** Truncate manually supplied live-chat speaker and text fields before invoking the
answer draft orchestrator.

**Tech Stack:** TypeScript, Fastify app parser, Vitest API tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add oversized live-chat field API test**

Send an `/internal/answer-drafts` request with an oversized live-chat speaker and text, then assert
the injected orchestrator receives truncated fields.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: the new test fails because the API currently passes oversized fields through unchanged.

Observed: the focused test failed because the speaker field reached the orchestrator at `324`
characters.

### Task 2: Implement API Live Chat Budget

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add API live-chat field budgets**

Add `256` character speaker and `2000` character text budgets for answer draft API input.

- [x] **Step 2: Normalize live-chat message fields**

Trim and truncate live-chat speaker and text fields in `parseLiveChatMessage`, returning undefined
only for non-string or blank fields.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: answer draft API tests pass.

Observed: focused answer draft API tests passed with `143` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-answer-draft-api-live-chat-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-answer-draft-api-live-chat-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `810` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the answer draft API live-chat budget patch, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
