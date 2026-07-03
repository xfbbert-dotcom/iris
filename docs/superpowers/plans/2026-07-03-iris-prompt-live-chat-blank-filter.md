# Iris Prompt Live Chat Blank Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep blank live chat messages out of answer draft prompt context.

**Architecture:** Update `assemblePromptContext` so it filters blank live chat messages before applying `liveChatLimit`.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Prompt Context Blank Filtering

**Files:**
- Modify: `apps/core/tests/context-assembly.test.ts`
- Modify: `apps/core/src/memory/context-assembly.ts`

- [x] **Step 1: Write failing context assembly test**

Add a test with blank live chat messages around meaningful messages and assert only meaningful messages render.

- [x] **Step 2: Run test to verify it fails**

Run: `npm --workspace apps/core test -- tests/context-assembly.test.ts --reporter=dot`

Expected: FAIL because blank messages still render.

- [x] **Step 3: Implement blank filtering**

In `assemblePromptContext`, filter `input.liveChatMessages` with `message.text.trim().length > 0` before applying `.slice(-liveChatLimit)`.

- [x] **Step 4: Run context assembly test to verify it passes**

Run: `npm --workspace apps/core test -- tests/context-assembly.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-prompt-live-chat-blank-filter.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Mark checklist complete**

Update this plan so completed steps are checked.

- [x] **Step 3: Commit and push**

Run:

```bash
git add apps/core/src/memory/context-assembly.ts apps/core/tests/context-assembly.test.ts docs/superpowers/specs/2026-07-03-iris-prompt-live-chat-blank-filter-design.md docs/superpowers/plans/2026-07-03-iris-prompt-live-chat-blank-filter.md
git commit -m "feat: filter blank live chat prompt messages"
git push --force-with-lease origin codex/iris-document-source-registry
```
