# Iris Answer Question Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the answer-draft question length budget at the orchestrator boundary.

**Architecture:** Mirror the internal API's `4000` character question budget inside
`AnswerDraftOrchestrator` before retrieval context construction.

**Tech Stack:** TypeScript, Vitest, existing answer draft orchestrator tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`

- [x] **Step 1: Add oversized question test**

Call the orchestrator directly with an oversized question and assert it rejects before context
building or model calls.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: the new test fails because the orchestrator currently only rejects blank questions.

Observed: the focused test failed after reaching the mocked context builder, proving the direct
boundary was missing.

### Task 2: Implement Orchestrator Question Budget

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`

- [x] **Step 1: Add question length constant**

Set the direct orchestrator budget to `4000` characters, matching the internal API parser.

- [x] **Step 2: Reject oversized questions before retrieval**

Validate after trimming and before fragment/live-chat limit handling.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: answer draft orchestrator tests pass.

Observed: focused answer draft orchestrator tests passed with `11` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-answer-question-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-answer-question-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `790` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the answer question budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.
