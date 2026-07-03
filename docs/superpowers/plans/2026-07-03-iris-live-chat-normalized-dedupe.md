# Iris Live Chat Normalized Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate live chat prompt context when stored and request messages differ only by surrounding whitespace.

**Architecture:** Normalize live chat messages inside `dedupeLiveChatMessages` before dedupe.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Normalized Live Chat Dedupe

**Files:**
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`

- [x] **Step 1: Write failing orchestrator test**

Assert stored and request live chat messages that differ only by surrounding whitespace dedupe to one trimmed message before context building.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts --reporter=dot`

Expected: FAIL because raw `speaker` and `text` values are currently used as the dedupe key.

- [x] **Step 3: Implement normalized dedupe**

Trim `speaker` and `text`, filter blank normalized messages, and dedupe by the normalized values.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/answer-draft-orchestrator.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-live-chat-normalized-dedupe.md`

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
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/tests/answer-draft-orchestrator.test.ts docs/superpowers/specs/2026-07-03-iris-live-chat-normalized-dedupe-design.md docs/superpowers/plans/2026-07-03-iris-live-chat-normalized-dedupe.md
git commit -m "fix: normalize live chat dedupe"
git push --force-with-lease origin codex/iris-document-source-registry
```
