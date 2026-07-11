# Iris Answer Language Style Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Iris answer drafts consistently follow the user's language, with Chinese as the default for ambiguous internal chat.

**Architecture:** Add one language-style sentence to the existing OpenAI-compatible model provider system prompt. Verify the prompt still includes safety instructions and sends the new language guidance to the model.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Write Failing Prompt Contract Test

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`

- [x] **Step 1: Add language-style prompt assertion**

Add a test that calls `generateAnswerDraft()` with a Chinese question and asserts the outgoing
system prompt contains guidance to answer in the user's language and default to concise Chinese.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts -t "asks the model to answer in the user language"
```

Expected: the test fails because the current system prompt does not include the language-style
guidance.

Observed RED: the focused test failed because the system prompt did not contain the same-language
answer guidance.

### Task 2: Add Prompt Guidance

**Files:**
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

- [x] **Step 1: Extend the system prompt**

Add one concise sentence to `ANSWER_DRAFT_SYSTEM_PROMPT` telling Iris to answer in the user's
language and default to concise, natural Chinese when unclear.

- [x] **Step 2: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts -t "asks the model to answer in the user language"
```

Expected: the focused prompt contract test passes.

Observed GREEN: the focused prompt contract test passed with 1 test and 12 skipped.

### Task 3: Verify and Publish

- [x] **Step 1: Run model provider tests**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts
```

Expected: all model provider tests pass.

Observed: `openai-compatible-model-provider.test.ts` passed with 13 tests.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: all repository verification passes.

Observed: `npm run verify` passed. Core reported 65 test files passed with 1013 tests passed
and 4 skipped; Python worker reported 7 tests passed; Docker Compose config rendered
successfully.

- [x] **Step 3: Commit, push, update PR, and verify checks**

Commit the prompt hardening, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions `Core` and `AI Worker` checks pass.

Observed: committed as `5517021`, pushed to PR #3, updated the PR body, and confirmed GitHub
Actions `Core` and `AI Worker` checks passed.
