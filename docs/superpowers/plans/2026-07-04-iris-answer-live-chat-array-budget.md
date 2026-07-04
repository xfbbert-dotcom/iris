# Iris Answer Live Chat Array Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the request live-chat array budget at the answer-draft orchestrator boundary.

**Architecture:** Mirror the internal API's `50` item request live-chat array limit inside
`AnswerDraftOrchestrator` before any stored context load or retrieval work.

**Tech Stack:** TypeScript, Vitest, existing answer draft orchestrator tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`

- [x] **Step 1: Add oversized live-chat array test**

Call the orchestrator directly with `51` request live-chat messages and assert it rejects before
stored context loading, retrieval, or model calls.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: the new test fails because the orchestrator currently does not cap request array length.

Observed: the focused test failed after reaching the mocked context builder, proving the direct
boundary was missing.

### Task 2: Implement Live Chat Array Budget

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`

- [x] **Step 1: Add request array limit constant**

Set the direct orchestrator budget to `50` request messages, matching the internal API parser.

- [x] **Step 2: Reject before stored context loading**

Validate `input.liveChatMessages.length` before loading stored messages or building context.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: answer draft orchestrator tests pass.

Observed: focused answer draft orchestrator tests passed with `12` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-answer-live-chat-array-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-answer-live-chat-array-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `791` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the answer live-chat array budget patch, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `1cf0ead`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
