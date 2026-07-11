# Iris Prompt Context Text Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound per-item prompt text so oversized live chat messages or document fragments cannot
wash out the rest of Iris context.

**Architecture:** Add prompt assembly text budgets in `assemblePromptContext`: `1200` characters
for each background document and `2000` characters for each live chat message, preserving a visible
` ... [truncated]` marker inside the budget.

**Tech Stack:** TypeScript, Vitest, existing prompt context assembly tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/context-assembly.test.ts`

- [x] **Step 1: Add oversized live chat test**

Add a test where a single live chat message exceeds `2000` characters. Expect the formatted message
text to be at most `2000` characters, contain `[truncated]`, and omit the trailing content.

- [x] **Step 2: Add oversized background document test**

Add a test where a single background document exceeds `1200` characters. Expect the formatted
document text to be at most `1200` characters, contain `[truncated]`, and omit the trailing content.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- context-assembly.test.ts -t "truncates oversized"
```

Expected: the new tests fail because prompt assembly currently formats oversized text as-is.

Observed: focused tests failed with live message length `2122` and background document length
`1317`, confirming no per-item text budget existed.

### Task 2: Implement Prompt Text Budgets

**Files:**
- Modify: `apps/core/src/memory/context-assembly.ts`

- [x] **Step 1: Add constants**

Add:

```ts
const MAX_BACKGROUND_DOCUMENT_TEXT_CHARS = 1200;
const MAX_LIVE_CHAT_MESSAGE_TEXT_CHARS = 2000;
const TRUNCATION_MARKER = " ... [truncated]";
```

- [x] **Step 2: Truncate before formatting**

Add a local helper that keeps text unchanged within budget and otherwise returns the leading text
plus `TRUNCATION_MARKER`, keeping the marker inside the budget.

- [x] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- context-assembly.test.ts -t "truncates oversized"
npm --workspace apps/core test -- context-assembly.test.ts
```

Expected: focused and file-level prompt context tests pass.

Observed: focused oversized tests passed, and the full `context-assembly.test.ts` file passed with
`17` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-prompt-context-text-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-prompt-context-text-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `760` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the prompt text budget update, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `a273020`, pushed to `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed.
