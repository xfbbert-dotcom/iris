# Iris Dead Letter Batch Replay API Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate repeated DLQ IDs at the shared internal API parser before calling runtimes.

**Architecture:** Keep queue-level dedupe, and add API-boundary normalization in
`parseDeadLetterBatchReplayRequest()`.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing API Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add duplicate-ID batch replay expectations**

Send repeated IDs to event, document sync, and reindex batch replay endpoints and expect runtime
calls to receive unique first-seen IDs.

- [x] **Step 2: Verify RED**

Run the focused API test and confirm duplicate IDs are still passed through.

### Task 2: Parser Dedupe

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Deduplicate parsed IDs**

Return `Array.from(new Set(ids))` after validation while preserving the existing raw request size
limit.

- [x] **Step 2: Verify GREEN**

Run the focused API test and typecheck.

### Task 3: Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-iris-dead-letter-batch-replay-dedupe-design.md`

- [x] **Step 1: Update existing dedupe design**

Record that API-boundary normalization now complements queue-level dedupe.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
