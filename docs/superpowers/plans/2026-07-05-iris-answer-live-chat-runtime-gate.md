# Iris Answer Live Chat Runtime Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent answer drafts from automatically loading stored group chat history when
`readGroupContext` is disabled.

**Architecture:** Wrap the live chat context provider inside answer draft runtime with the shared
runtime controller. Keep explicit request-provided live chat messages available to the orchestrator.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Failing Runtime Test

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [x] **Step 1: Cover disabled group-context stored live chat**

Add a runtime test where `canReadGroupContext(chatId)` returns false and the stored live chat
provider would otherwise return historical group context.

Observed: focused answer-draft runtime tests failed because the runtime did not consult
`canReadGroupContext`.

### Task 2: Gate Stored Live Chat Retrieval

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/src/conversation/feishu-message-event-processor.ts`

- [x] **Step 1: Extend the runtime retrieval gate**

Allow answer draft runtime to consult optional `canReadGroupContext(groupId)`.

- [x] **Step 2: Wrap the live chat context provider**

Return no stored live chat messages, and do not call the delegate provider, when group-context
reading is disabled for the chat.

Observed: focused answer-draft runtime tests passed with `15` tests.

- [x] **Step 3: Preserve current-message mention handling**

Keep Feishu message persistence and document discovery disabled when group-context reading is off,
but still pass the current parsed message to the mention responder so explicit @Iris requests remain
available under `replyWhenMentioned`.

Observed: focused Feishu message processor and answer-draft runtime tests passed with `34` tests.

### Task 3: Document The Boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`
- Create: `docs/superpowers/specs/2026-07-05-iris-answer-live-chat-runtime-gate-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-answer-live-chat-runtime-gate.md`

- [x] **Step 1: Record runtime-context behavior**

Document that `readGroupContext=false` prevents both new message fact writes and answer-time stored
live chat retrieval.
