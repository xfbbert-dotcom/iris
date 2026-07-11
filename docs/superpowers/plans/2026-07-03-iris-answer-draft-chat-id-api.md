# Iris Answer Draft Chat ID API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let internal answer draft API callers provide `chatId` so Iris can load stored group chat context through the orchestrator.

**Architecture:** Extend `parseAnswerDraftRequest` with optional normalized `chatId`.

**Tech Stack:** TypeScript, Vitest, Fastify test injection, existing Iris core app.

---

### Task 1: Answer Draft Request Parsing

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Write failing API tests**

Assert optional padded `chatId` is passed to the orchestrator as trimmed, and blank provided `chatId` returns `400`.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: FAIL because `chatId` is currently ignored.

- [x] **Step 3: Implement chatId parsing**

Add optional `chatId` to the request type, normalize via `readNonBlankId`, reject blank provided values, and include it in the orchestrator input.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-answer-draft-chat-id-api.md`

- [x] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Run:

```bash
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-07-03-iris-answer-draft-chat-id-api-design.md docs/superpowers/plans/2026-07-03-iris-answer-draft-chat-id-api.md
git commit -m "fix: pass chat id through answer draft api"
git push --force-with-lease origin codex/iris-document-source-registry
```
