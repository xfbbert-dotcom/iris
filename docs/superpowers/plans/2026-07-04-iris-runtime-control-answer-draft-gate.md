# Iris Runtime Control Answer Draft Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent answer draft generation from bypassing Iris runtime enable/disable controls.

**Architecture:** Reuse the shared `RuntimeController` already owned by `buildApp()`. Gate the answer draft route after request parsing so invalid requests still return validation errors.

**Tech Stack:** TypeScript, Fastify, Vitest.

---

### Task 1: Add API Regression Tests

**Files:**
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Write failing tests**

Add tests that disable Iris globally and per group, call `POST /internal/answer-drafts`,
and assert the orchestrator is not invoked.

- [x] **Step 2: Run focused test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/runtime-control-api.test.ts
```

Expected: new tests fail because answer drafts currently bypass runtime control.

### Task 2: Gate Answer Draft Route

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Check runtime control before draft generation**

After parsing `AnswerDraftRequest`, call `runtimeController.canProcessIncomingEvent()`
with the optional `chatId` as `groupId`.

- [x] **Step 2: Return 403 when disabled**

Return:

```json
{ "ok": false, "error": "iris_runtime_disabled" }
```

- [x] **Step 3: Run focused test to verify pass**

Run the focused runtime-control API test and expect it to pass.

### Task 3: Verify and Publish

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
git add apps/core/src/app.ts apps/core/tests/runtime-control-api.test.ts docs/superpowers/specs/2026-07-04-iris-runtime-control-answer-draft-gate-design.md docs/superpowers/plans/2026-07-04-iris-runtime-control-answer-draft-gate.md
git commit -m "fix: gate answer drafts by runtime control"
git push --force-with-lease origin codex/iris-document-source-registry
```
