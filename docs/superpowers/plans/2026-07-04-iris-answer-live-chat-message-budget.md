# Iris Answer Live Chat Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound live-chat speaker and text values before answer-draft dedupe and context building.

**Architecture:** Normalize live-chat messages in `AnswerDraftOrchestrator` using the same practical
budgets as prompt assembly: `256` speaker characters and `2000` text characters.

**Tech Stack:** TypeScript, Vitest, existing answer draft orchestrator tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`

- [x] **Step 1: Add oversized live-chat message test**

Call the orchestrator with oversized live-chat speaker/text values and assert the context builder
receives bounded values with truncation markers.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: the new test fails because dedupe currently passes oversized values through.

Observed: the focused test failed with an unbounded `424` character speaker.

### Task 2: Implement Live Chat Message Budgets

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`

- [x] **Step 1: Add live-chat message budget constants**

Add `256` speaker and `2000` text budgets.

- [x] **Step 2: Normalize before dedupe**

Trim and truncate speaker/text values before filtering blanks and building dedupe keys.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: answer draft orchestrator tests pass.

Observed: focused answer draft orchestrator tests passed with `13` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-answer-live-chat-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-answer-live-chat-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `792` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the answer live-chat message budget patch, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
