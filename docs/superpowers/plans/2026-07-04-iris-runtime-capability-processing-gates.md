# Iris Runtime Capability Processing Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make runtime capability toggles affect Feishu message processing side effects.

**Architecture:** Keep gating inside `FeishuMessageEventProcessor`, where parsed `chatId` and document-link discovery decisions are both available. Thread the same controller through existing runtime wiring.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Processor Capability Tests

**Files:**
- Modify: `apps/core/tests/feishu-message-event-processor.test.ts`

- [x] **Step 1: Write failing tests**

Add tests for:

- `canReadGroupContext(chatId) === false` skipping message persistence and document discovery
- `canReadDocuments() === false` persisting the message but skipping document discovery

- [x] **Step 2: Run focused processor test to verify failure**

Run:

```bash
npm --workspace apps/core test -- tests/feishu-message-event-processor.test.ts
```

Expected: new tests fail because the processor does not consult capability gates.

### Task 2: Implement Processor Capability Gates

**Files:**
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/tests/event-worker-runtime.test.ts`

- [x] **Step 1: Extend runtime gate type**

Require `canReadGroupContext(groupId)` and `canReadDocuments()` where the message processor runtime gate is used.

- [x] **Step 2: Gate message persistence**

After parsing and incoming-event gate, return early when `canReadGroupContext(parsed.chatId)` is false.

- [x] **Step 3: Gate document discovery**

After persisting the message, return before extraction when `canReadDocuments()` is false.

- [x] **Step 4: Run focused tests to verify pass**

Run processor and event worker runtime tests.

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
git add apps/core/src/conversation/feishu-message-event-processor.ts apps/core/src/runtime/event-worker-runtime.ts apps/core/tests/feishu-message-event-processor.test.ts apps/core/tests/event-worker-runtime.test.ts docs/superpowers/specs/2026-07-04-iris-runtime-capability-processing-gates-design.md docs/superpowers/plans/2026-07-04-iris-runtime-capability-processing-gates.md
git commit -m "fix: enforce runtime capability gates in message processing"
git push --force-with-lease origin codex/iris-document-source-registry
```
