# Iris Answer Retrieval Query Live Chat Implementation Plan

**Goal:** Improve document recall for follow-up group-chat questions by including bounded live-chat
context in the semantic retrieval query.

**Architecture:** Keep prompt assembly unchanged. Add a pure retrieval-query builder inside
`AnswerDraftOrchestrator` after live-chat normalization/windowing and before
`DocumentRetrievalContextBuilder.buildContext()`.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Capture The Regression

- [x] Add an orchestrator test where a short follow-up question depends on live-chat context.
- [x] Assert `queryText` contains the question and recent live-chat lines.
- [x] Assert `queryText` remains within the 4000-character retrieval budget.
- [x] Run the focused test and confirm RED.

Observed: `npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts -t "includes live chat context in retrieval query text" --reporter=dot`
failed because `queryText` was only the question.

### Task 2: Add Bounded Live-Chat Query Context

- [x] Build retrieval query text from the question plus selected live-chat messages.
- [x] Preserve the question when the live-chat suffix would exceed budget.
- [x] Keep newest live-chat messages highest priority inside the retrieval-query suffix.
- [x] Update existing orchestrator tests to keep ordering/dedup assertions while accepting enriched
  query text.
- [x] Update the architecture whitepaper.

### Task 3: Verify And Publish

- [x] Run focused orchestrator tests.
- [x] Run full verification.
- [ ] Commit, push, update PR #3, and confirm GitHub Actions checks.

Observed: `npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts --reporter=dot`
passed with 18 tests.

Observed:

- `npm run typecheck` passed.
- `npm test` passed with 1048 tests passed / 4 skipped.
- `npm run test:python` passed with 7 tests.
- `docker compose config` passed.
- `git diff --check` passed with Windows line-ending warnings only.
