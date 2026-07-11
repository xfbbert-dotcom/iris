# Iris Live Chat Context Scan Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Iris answer quality by backfilling recent text context when the newest Feishu group messages are non-text or blank.

**Architecture:** Keep the prompt live-chat output cap unchanged at 20 messages. Expand only the repository scan window to three times the output limit, capped at 100 raw messages, then filter and slice the latest useful text messages.

**Tech Stack:** TypeScript, Vitest, existing Core live-chat context provider and conversation repository interfaces.

---

### Task 1: Live Chat Scan Backfill

**Files:**
- Modify: `apps/core/tests/live-chat-context-provider.test.ts`
- Modify: `apps/core/src/memory/live-chat-context-provider.ts`

- [x] **Step 1: Write the failing test**

Add a Vitest case where the newest rows include non-text and blank messages before useful text rows.
The provider should query `limit: 15` for a requested output limit of `5`, then return the five useful
text messages in chronological order.

- [x] **Step 2: Run the focused test and verify red**

Run:

```bash
npm --workspace apps/core run test -- tests/live-chat-context-provider.test.ts
```

Expected red result before implementation: the provider queries `limit: 5` instead of `limit: 15`.

- [x] **Step 3: Implement scan-window separation**

In `createLiveChatContextProvider`, sanitize the output limit first. Return `[]` without a repository
query when the output limit is zero. Query with `Math.min(100, outputLimit * 3)`, filter non-blank
text rows, map them into `LiveChatMessage`, and finally `.slice(-outputLimit)`.

- [x] **Step 4: Update existing expectations**

Update existing tests so default output limit `20` scans `60`, custom output limit `5` scans `15`,
and oversized limits still scan only `60`.

- [x] **Step 5: Verify focused suite**

Run:

```bash
npm --workspace apps/core run test -- tests/live-chat-context-provider.test.ts
```

Expected green result: all live-chat context provider tests pass.

- [x] **Step 6: Verify full suite**

Run:

```bash
npm run verify
```

Expected green result: Core, Python worker, and Docker Compose config checks pass.
