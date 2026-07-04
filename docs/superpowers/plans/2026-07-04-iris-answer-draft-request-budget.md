# Iris Answer Draft Request Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject oversized internal answer draft requests before they reach retrieval, embedding,
or model generation.

**Architecture:** Extend `parseAnswerDraftRequest` with a `4000` character budget for `question`
and a `50` item budget for request-supplied `liveChatMessages`.

**Tech Stack:** TypeScript, Vitest, existing internal answer draft API tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add oversized question test**

Send a `/internal/answer-drafts` request with `question: "q".repeat(4001)` and expect:

```ts
expect(response.statusCode).toBe(400);
expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
```

- [x] **Step 2: Add oversized live chat array test**

Send a request with `51` live chat messages and expect `400 invalid_request` before the
orchestrator is called.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts -t "oversized|too many live chat"
```

Expected: the new tests fail because both requests are currently accepted.

Observed: focused tests failed with `expected 200 to be 400` for both oversized request cases.

### Task 2: Implement Request Budgets

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add constants**

Add:

```ts
const maxAnswerDraftQuestionLength = 4000;
const maxAnswerDraftLiveChatMessageInputCount = 50;
```

- [x] **Step 2: Bound question**

Read `question` with `readNonBlankBoundedString(value.question, maxAnswerDraftQuestionLength)`.

- [x] **Step 3: Bound live chat array size**

Reject requests where `value.liveChatMessages.length` exceeds
`maxAnswerDraftLiveChatMessageInputCount` before mapping messages.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts -t "oversized|too many live chat"
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: focused tests and the full answer draft API test file pass.

Observed: focused budget tests passed, and the full `answer-draft-api.test.ts` file passed with
`141` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-answer-draft-request-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-answer-draft-request-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `762` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the answer draft request budget update, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
