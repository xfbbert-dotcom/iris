# Iris Feishu Post Message Document Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Iris discover Feishu document links embedded in rich text/post group messages.

**Architecture:** Extend `FeishuMessageEventProcessor` content parsing so `message_type: "post"` produces readable text from `title`, `text`, `href`, and `url` fields. Keep document extraction in the existing link extractor.

**Tech Stack:** TypeScript, Vitest, existing Iris core app.

---

### Task 1: Post Message Text Extraction

**Files:**
- Modify: `apps/core/tests/feishu-message-event-processor.test.ts`
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`

- [x] **Step 1: Write failing processor test**

Assert a Feishu `post` message with a document `href` persists readable text and calls the group-visible document registrar.

- [x] **Step 2: Run focused test to verify it fails**

Run: `npm --workspace apps/core test -- tests/feishu-message-event-processor.test.ts --reporter=dot`

Expected: FAIL because `post` messages currently have `text: undefined`.

- [x] **Step 3: Implement post text extraction**

Parse post content JSON and recursively collect `title`, `text`, `href`, and `url` string values into a compact text string.

- [x] **Step 4: Run focused test to verify it passes**

Run: `npm --workspace apps/core test -- tests/feishu-message-event-processor.test.ts --reporter=dot`

Expected: PASS.

### Task 2: Verification and Publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-07-03-iris-feishu-post-message-document-link.md`

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
git add apps/core/src/conversation/feishu-message-event-processor.ts apps/core/tests/feishu-message-event-processor.test.ts docs/superpowers/specs/2026-07-03-iris-feishu-post-message-document-link-design.md docs/superpowers/plans/2026-07-03-iris-feishu-post-message-document-link.md
git commit -m "feat: discover links in feishu post messages"
git push --force-with-lease origin codex/iris-document-source-registry
```
