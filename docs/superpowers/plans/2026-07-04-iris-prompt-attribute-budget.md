# Iris Prompt Attribute Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound prompt XML attribute text for live-chat speakers and background document sources.

**Architecture:** Add explicit escaped-output budgets in `assemblePromptContext` so metadata cannot
inflate the context window after XML escaping.

**Tech Stack:** TypeScript, Vitest, existing context assembly tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/context-assembly.test.ts`

- [x] **Step 1: Add live chat speaker attribute budget test**

Add a live chat message with an oversized XML-sensitive speaker and assert the formatted
`speaker` attribute is capped, includes the truncation marker, and excludes the tail.

- [x] **Step 2: Add background document source attribute budget test**

Add a background document with an oversized XML-sensitive source and assert the formatted `source`
attribute is capped, includes the truncation marker, and excludes the tail.

- [x] **Step 3: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/context-assembly.test.ts
```

Expected: the new tests fail because attributes currently use the trimmed full value.

Observed: the focused test failed with unbounded attribute lengths of `426` and `825` before the
XML-sensitive cases were tightened.

### Task 2: Implement Prompt Attribute Budgets

**Files:**
- Modify: `apps/core/src/memory/context-assembly.ts`

- [x] **Step 1: Add escaped attribute formatter**

Add a helper that truncates raw metadata by measuring the escaped XML output, preserving valid XML
entities while fitting the configured budget.

- [x] **Step 2: Apply to speaker and source attributes**

Use the helper for live chat `speaker` and background document `source` attributes.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/context-assembly.test.ts
```

Expected: the context assembly tests pass.

Observed: focused context assembly tests passed with `19` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-prompt-attribute-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-prompt-attribute-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `785` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the prompt attribute budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.
