# Iris Reply Capability Answer Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `replyWhenMentioned` runtime capability gate internal answer draft generation.

**Architecture:** Add a small semantic helper on `RuntimeController` and use it at the answer draft route boundary before invoking the orchestrator.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

### Task 1: Add Controller Reply Gate Test

**Files:**
- Modify: `apps/core/tests/runtime-controller.test.ts`

- [x] **Step 1: Write failing test**

Add a test that disables `replyWhenMentioned` and asserts answer draft generation is not allowed.

- [x] **Step 2: Run focused controller test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-controller.test.ts
```

Expected: test fails because `canGenerateAnswerDraft()` does not exist.

### Task 2: Add API Reply Gate Test

**Files:**
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing test**

Patch `replyWhenMentioned` to false, call `POST /internal/answer-drafts`, and assert
HTTP 403 with no orchestrator call.

- [x] **Step 2: Run focused API test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-control-api.test.ts
```

Expected: test fails because the route does not check `replyWhenMentioned`.

### Task 3: Implement Reply Capability Gate

**Files:**
- Modify: `apps/core/src/admin/runtime-controller.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add `canGenerateAnswerDraft()`**

Check global enabled, `replyWhenMentioned`, and optional group disable state.

- [x] **Step 2: Use helper in answer draft route**

Replace the generic incoming-event check with the answer-draft-specific helper.

- [x] **Step 3: Run focused tests to verify pass**

Run both focused tests.

### Task 4: Verify and Publish

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

- [x] **Step 2: Commit and push**

Commit with:

```bash
git add apps/core/src/admin/runtime-controller.ts apps/core/src/app.ts apps/core/tests/runtime-controller.test.ts apps/core/tests/runtime-control-api.test.ts docs/superpowers/specs/2026-07-04-iris-runtime-reply-capability-answer-gate-design.md docs/superpowers/plans/2026-07-04-iris-runtime-reply-capability-answer-gate.md
git commit -m "fix: gate answer drafts by reply capability"
git push --force-with-lease origin codex/iris-document-source-registry
```
