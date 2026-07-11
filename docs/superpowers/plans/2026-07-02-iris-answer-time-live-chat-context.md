# Iris Answer-Time Live Chat Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Iris answer drafts automatically include recent persisted messages from the current Feishu group when a `chatId` is supplied.

**Architecture:** Add a small live chat context provider over `ConversationMessageRepository.listRecentByChat`, then wire it into `AnswerDraftOrchestrator` and `AnswerDraftRuntime`. The provider normalizes message order and filters non-text facts; the existing prompt assembler remains responsible for XML layout and final limit trimming.

**Tech Stack:** TypeScript, Vitest, Postgres repository interfaces, existing answer draft runtime.

---

## File Structure

- Create `apps/core/src/memory/live-chat-context-provider.ts`
  - Converts persisted `ConversationMessage` rows into `LiveChatMessage[]`.
  - Reads by `chatId` with a default limit of 20.
  - Returns chronological messages.
- Create `apps/core/tests/live-chat-context-provider.test.ts`
  - Covers conversion, filtering, order, and default/custom limits.
- Modify `apps/core/src/agent/answer-draft-orchestrator.ts`
  - Adds optional `chatId`.
  - Adds optional `liveChatContextProvider`.
  - Combines stored messages before explicit caller messages.
- Modify `apps/core/tests/answer-draft-orchestrator.test.ts`
  - Covers provider loading and merge order.
- Modify `apps/core/src/runtime/answer-draft-runtime.ts`
  - Builds `PostgresConversationMessageRepository`.
  - Builds `LiveChatContextProvider`.
  - Injects it into the orchestrator.
- Modify `apps/core/tests/answer-draft-runtime.test.ts`
  - Verifies runtime wires the conversation repository and provider dependencies.

## Task 1: Live Chat Context Provider

**Files:**
- Create: `apps/core/src/memory/live-chat-context-provider.ts`
- Test: `apps/core/tests/live-chat-context-provider.test.ts`

- [ ] **Step 1: Write the failing provider tests**

```ts
import { describe, expect, it, vi } from "vitest";

import { createLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";

describe("LiveChatContextProvider", () => {
  it("loads recent text messages in chronological order", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        {
          id: "msg-3",
          provider: "feishu",
          providerMessageId: "om_3",
          chatId: "oc_1",
          senderId: "ou_b",
          messageType: "text",
          text: "Latest",
          sentAt: new Date("2026-07-02T10:02:00.000Z"),
          rawEventIdempotencyKey: "event-3",
          createdAt: new Date("2026-07-02T10:02:01.000Z"),
        },
        {
          id: "msg-2",
          provider: "feishu",
          providerMessageId: "om_2",
          chatId: "oc_1",
          senderId: null,
          messageType: "image",
          text: null,
          sentAt: new Date("2026-07-02T10:01:00.000Z"),
          rawEventIdempotencyKey: "event-2",
          createdAt: new Date("2026-07-02T10:01:01.000Z"),
        },
        {
          id: "msg-1",
          provider: "feishu",
          providerMessageId: "om_1",
          chatId: "oc_1",
          senderId: "ou_a",
          messageType: "text",
          text: "Earlier",
          sentAt: new Date("2026-07-02T10:00:00.000Z"),
          rawEventIdempotencyKey: "event-1",
          createdAt: new Date("2026-07-02T10:00:01.000Z"),
        },
      ]),
    };
    const provider = createLiveChatContextProvider({ repository });

    const messages = await provider.loadRecentMessages({ chatId: "oc_1" });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_1", limit: 20 });
    expect(messages).toEqual([
      { speaker: "ou_a", text: "Earlier" },
      { speaker: "ou_b", text: "Latest" },
    ]);
  });

  it("uses custom limits and fallback speaker labels", async () => {
    const repository = {
      listRecentByChat: vi.fn(async () => [
        {
          id: "msg-1",
          provider: "feishu",
          providerMessageId: "om_1",
          chatId: "oc_1",
          senderId: null,
          messageType: "text",
          text: "No sender",
          sentAt: new Date("2026-07-02T10:00:00.000Z"),
          rawEventIdempotencyKey: "event-1",
          createdAt: new Date("2026-07-02T10:00:01.000Z"),
        },
      ]),
    };
    const provider = createLiveChatContextProvider({ repository });

    const messages = await provider.loadRecentMessages({ chatId: "oc_1", limit: 5 });

    expect(repository.listRecentByChat).toHaveBeenCalledWith({ chatId: "oc_1", limit: 5 });
    expect(messages).toEqual([{ speaker: "unknown", text: "No sender" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- live-chat-context-provider.test.ts`

Expected: FAIL because `live-chat-context-provider.ts` does not exist.

- [ ] **Step 3: Implement provider**

```ts
import type { ConversationMessageRepository } from "../conversation/conversation-message-repository.js";
import type { LiveChatMessage } from "./context-assembly.js";

export type LiveChatContextProvider = {
  loadRecentMessages(input: { chatId: string; limit?: number }): Promise<LiveChatMessage[]>;
};

export function createLiveChatContextProvider({
  repository,
}: {
  repository: Pick<ConversationMessageRepository, "listRecentByChat">;
}): LiveChatContextProvider {
  return {
    async loadRecentMessages(input) {
      const messages = await repository.listRecentByChat({
        chatId: input.chatId,
        limit: sanitizeLimit(input.limit),
      });

      return messages
        .slice()
        .reverse()
        .filter((message) => message.text !== null && message.text.trim().length > 0)
        .map((message) => ({
          speaker: message.senderId ?? "unknown",
          text: message.text!.trim(),
        }));
    },
  };
}

function sanitizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.floor(value));
}
```

- [ ] **Step 4: Run provider tests**

Run: `npm test -- live-chat-context-provider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/memory/live-chat-context-provider.ts apps/core/tests/live-chat-context-provider.test.ts
git commit -m "feat: add live chat context provider"
```

## Task 2: Orchestrator Live Chat Loading

**Files:**
- Modify: `apps/core/src/agent/answer-draft-orchestrator.ts`
- Modify: `apps/core/tests/answer-draft-orchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator test**

Add this test to `apps/core/tests/answer-draft-orchestrator.test.ts`:

```ts
it("loads stored live chat context when chatId is supplied", async () => {
  const contextBuilder = {
    buildContext: vi.fn(async () => ({
      promptContext: "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
      allowedFragments: [],
      deniedDocumentIds: [],
      retrievedFragmentCount: 0,
    })),
  };
  const model: ModelProvider = {
    generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
  };
  const liveChatContextProvider = {
    loadRecentMessages: vi.fn(async () => [{ speaker: "ou_a", text: "Stored context" }]),
  };
  const orchestrator = createAnswerDraftOrchestrator({
    contextBuilder,
    model,
    liveChatContextProvider,
  });

  await orchestrator.generateDraft({
    question: "What changed?",
    chatId: "oc_1",
    liveChatMessages: [{ speaker: "ou_b", text: "Current question context" }],
    liveChatLimit: 8,
  });

  expect(liveChatContextProvider.loadRecentMessages).toHaveBeenCalledWith({
    chatId: "oc_1",
    limit: 8,
  });
  expect(contextBuilder.buildContext).toHaveBeenCalledWith({
    queryText: "What changed?",
    liveChatMessages: [
      { speaker: "ou_a", text: "Stored context" },
      { speaker: "ou_b", text: "Current question context" },
    ],
    fragmentLimit: undefined,
    liveChatLimit: 8,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- answer-draft-orchestrator.test.ts`

Expected: FAIL because the orchestrator factory does not accept `liveChatContextProvider` and input does not include `chatId`.

- [ ] **Step 3: Implement orchestrator loading**

Update `AnswerDraftInput`:

```ts
export type AnswerDraftInput = {
  question: string;
  chatId?: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};
```

Add a dependency type:

```ts
type LiveChatContextProvider = {
  loadRecentMessages(input: { chatId: string; limit?: number }): Promise<LiveChatMessage[]>;
};
```

Update `createAnswerDraftOrchestrator` to accept optional `liveChatContextProvider`, load stored messages when `chatId` is present, and pass `[...storedMessages, ...input.liveChatMessages]` to `contextBuilder.buildContext`.

- [ ] **Step 4: Run orchestrator tests**

Run: `npm test -- answer-draft-orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/tests/answer-draft-orchestrator.test.ts
git commit -m "feat: load live chat context for answer drafts"
```

## Task 3: Runtime Wiring

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [ ] **Step 1: Write failing runtime test**

Update the enabled runtime test to inject and assert `createConversationMessageRepository` and `createLiveChatContextProvider` dependencies:

```ts
const conversationMessages = { listRecentByChat: vi.fn() };
const createConversationMessageRepository = vi.fn(() => conversationMessages);
const liveChatContextProvider = { loadRecentMessages: vi.fn(async () => []) };
const createLiveChatContextProvider = vi.fn(() => liveChatContextProvider);
```

Then assert:

```ts
expect(createConversationMessageRepository).toHaveBeenCalledWith({ queryable: pool });
expect(createLiveChatContextProvider).toHaveBeenCalledWith({ repository: conversationMessages });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- answer-draft-runtime.test.ts`

Expected: FAIL because runtime dependencies are not wired yet.

- [ ] **Step 3: Implement runtime wiring**

Import:

```ts
import {
  createPostgresConversationMessageRepository,
  type ConversationMessageQueryable,
} from "../conversation/postgres-conversation-message-repository.js";
import { createLiveChatContextProvider } from "../memory/live-chat-context-provider.js";
```

Extend `AnswerDraftRuntimeDependencies` with:

```ts
createConversationMessageRepository?: (dependencies: {
  queryable: ConversationMessageQueryable;
}) => { listRecentByChat(input: { chatId: string; limit: number }): Promise<unknown[]> };
createLiveChatContextProvider?: typeof createLiveChatContextProvider;
```

Create repository and provider after pool creation, then pass the provider into `createAnswerDraftOrchestrator`.

- [ ] **Step 4: Run runtime tests**

Run: `npm test -- answer-draft-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/answer-draft-runtime.ts apps/core/tests/answer-draft-runtime.test.ts
git commit -m "feat: wire live chat context into answer runtime"
```

## Task 4: Full Verification And PR Update

**Files:**
- Modify PR body only through `gh pr edit`.

- [ ] **Step 1: Run full TypeScript verification**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run full TypeScript tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run Python worker tests**

Run: `python -m pytest` from `workers/ai`

Expected: all tests pass.

- [ ] **Step 4: Run Docker Compose validation**

Run: `docker compose config`

Expected: exit 0.

- [ ] **Step 5: Push and update PR**

```bash
git push origin codex/iris-document-source-registry
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<updated body with Phase 2V summary>"
```

Expected: PR #3 contains Phase 2V summary and checked test plan.

## Self-Review

- Spec coverage: provider, orchestrator, runtime wiring, prompt anchor preservation, error behavior, and tests are covered.
- Placeholder scan: no incomplete placeholder markers are present.
- Type consistency: `chatId`, `liveChatMessages`, `liveChatLimit`, `loadRecentMessages`, and `listRecentByChat` names are consistent across tasks.
