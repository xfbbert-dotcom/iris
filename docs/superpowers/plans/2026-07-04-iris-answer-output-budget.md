# Iris Answer Output Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound final answer draft text before it leaves the orchestrator.

**Architecture:** Apply a provider-independent output budget in `AnswerDraftOrchestrator` so
oversized model completions cannot flood internal API responses or downstream Feishu replies.

**Tech Stack:** TypeScript, Vitest, existing answer draft orchestrator tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`

- [x] **Step 1: Add oversized model output test**

Return an oversized model answer and assert the orchestrator caps `answerText`, includes the
truncation marker, and excludes the tail.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: the new test fails because model output currently returns unbounded.

Observed: the focused test failed with `9022` returned answer characters.

### Task 2: Implement Answer Output Budget

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`

- [x] **Step 1: Add answer truncation helper**

Add an `8000` character output budget with a visible ` ... [truncated]` marker.

- [x] **Step 2: Apply before result construction**

Trim and truncate model output before blank-output validation and result construction.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts
```

Expected: answer draft orchestrator tests pass.

Observed: focused answer draft orchestrator tests passed with `10` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-answer-output-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-answer-output-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `786` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the answer output budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.
