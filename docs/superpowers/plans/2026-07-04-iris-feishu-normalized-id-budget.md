# Iris Feishu Normalized ID Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Feishu normalized event identifiers before downstream processing.

**Architecture:** Treat Feishu identifier fields over `512` characters as absent while normalizing
group message events.

**Tech Stack:** TypeScript, Vitest, existing Feishu event normalizer tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/feishu-event-normalizer.test.ts`

- [x] **Step 1: Add oversized identifier test**

Create an otherwise valid group text event with a `513` character `message_id` and assert it returns
`unsupported` with `missing_required_fields`.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm -w apps/core test -- feishu-event-normalizer.test.ts
```

Expected: the new test fails because the normalizer currently accepts oversized identifiers.

Observed: the focused test failed because the normalizer returned `group_message` with the oversized
`messageId`.

### Task 2: Implement Normalized ID Budget

**Files:**
- Modify: `apps/core/src/feishu/feishu-event-normalizer.ts`

- [x] **Step 1: Add identifier budget constant**

Add a `512` character maximum for Feishu identifier fields.

- [x] **Step 2: Use bounded ID reads for normalized identifiers**

Apply bounded string reads to `event_id`, `message_id`, `chat_id`, and sender `open_id`.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm -w apps/core test -- feishu-event-normalizer.test.ts
```

Expected: Feishu event normalizer tests pass.

Observed: focused Feishu event normalizer tests passed with `14` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-feishu-normalized-id-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-normalized-id-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `800` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the Feishu normalized ID budget patch, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: pending.
