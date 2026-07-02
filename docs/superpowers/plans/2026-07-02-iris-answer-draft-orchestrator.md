# Iris Answer Draft Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2G of Iris: generate an answer draft from a safe document retrieval context through a replaceable model provider.

**Architecture:** Add a small `AnswerDraftOrchestrator` that depends on `DocumentRetrievalContextBuilder` and a new `ModelProvider` interface. The orchestrator returns a draft and metadata only; it does not call real models or send Feishu messages.

**Tech Stack:** TypeScript, Vitest, existing `DocumentRetrievalContextBuilder`, existing `LiveChatMessage` type.

---

## Scope

This plan implements the approved Phase 2G design in `docs/superpowers/specs/2026-07-02-iris-answer-draft-orchestrator-design.md`.

It includes:

- `ModelProvider` interface;
- `AnswerDraftOrchestrator`;
- tests for context builder wiring, model provider wiring, metadata propagation, and error handling.

It intentionally does not implement:

- real model provider;
- Feishu sending;
- streaming;
- citations;
- approval workflow;
- UI.

## File Structure

Create:

```text
apps/core/src/agent/
  answer-draft-orchestrator.ts

apps/core/tests/
  answer-draft-orchestrator.test.ts
```

Responsibilities:

- `answer-draft-orchestrator.ts`: owns model provider types, orchestrator input/output types, and draft generation coordination.
- `answer-draft-orchestrator.test.ts`: verifies orchestration and error handling with fakes.

## Task 1: Add Answer Draft Orchestrator

**Files:**
- Create: `apps/core/src/agent/answer-draft-orchestrator.ts`
- Create: `apps/core/tests/answer-draft-orchestrator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/core/tests/answer-draft-orchestrator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createAnswerDraftOrchestrator,
  type ModelProvider,
} from "../src/agent/answer-draft-orchestrator.js";

describe("AnswerDraftOrchestrator", () => {
  it("builds safe context, calls model provider, and returns draft metadata", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext: "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [
          {
            id: "fragment-1",
            documentSourceId: "source-1",
            documentSnapshotId: "snapshot-1",
            sourceUri: "https://example.com/doc",
            chunkIndex: 0,
            text: "Allowed text",
            contentHash: "hash",
            embedding: [1, 0, 0, 0, 0, 0],
            createdAt: new Date("2026-07-02T01:00:00.000Z"),
          },
        ],
        deniedDocumentIds: ["source-denied"],
        retrievedFragmentCount: 2,
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "  Draft answer.  " })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    const result = await orchestrator.generateDraft({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith({
      question: "What changed?",
      promptContext: "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
    });
    expect(result).toEqual({
      answerText: "Draft answer.",
      promptContext: "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
      allowedFragments: [
        expect.objectContaining({ id: "fragment-1", documentSourceId: "source-1" }),
      ],
      deniedDocumentIds: ["source-denied"],
      retrievedFragmentCount: 2,
    });
  });

  it("rejects blank questions before building context", async () => {
    const contextBuilder = { buildContext: vi.fn() };
    const model = { generateAnswerDraft: vi.fn() };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    await expect(
      orchestrator.generateDraft({ question: "   ", liveChatMessages: [] }),
    ).rejects.toThrow("question must not be blank");
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects blank model output", async () => {
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        })),
      },
      model: { generateAnswerDraft: vi.fn(async () => ({ answerText: " \n " })) },
    });

    await expect(
      orchestrator.generateDraft({ question: "What changed?", liveChatMessages: [] }),
    ).rejects.toThrow("model answer draft must not be blank");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts
```

Expected: FAIL because `answer-draft-orchestrator.ts` does not exist.

- [ ] **Step 3: Implement orchestrator**

Create `apps/core/src/agent/answer-draft-orchestrator.ts`:

```ts
import type { RetrievedDocumentFragment } from "../documents/document-fragment-repository.js";
import type {
  DocumentRetrievalContextBuilder,
  DocumentRetrievalContextResult,
} from "../memory/document-retrieval-context.js";
import type { LiveChatMessage } from "../memory/context-assembly.js";

export type GenerateAnswerDraftInput = {
  question: string;
  promptContext: string;
};

export type GenerateAnswerDraftResult = {
  answerText: string;
};

export interface ModelProvider {
  generateAnswerDraft(input: GenerateAnswerDraftInput): Promise<GenerateAnswerDraftResult>;
}

export type AnswerDraftInput = {
  question: string;
  liveChatMessages: LiveChatMessage[];
  fragmentLimit?: number;
  liveChatLimit?: number;
};

export type AnswerDraftResult = {
  answerText: string;
  promptContext: string;
  allowedFragments: RetrievedDocumentFragment[];
  deniedDocumentIds: string[];
  retrievedFragmentCount: number;
};

export interface AnswerDraftOrchestrator {
  generateDraft(input: AnswerDraftInput): Promise<AnswerDraftResult>;
}

export function createAnswerDraftOrchestrator({
  contextBuilder,
  model,
}: {
  contextBuilder: Pick<DocumentRetrievalContextBuilder, "buildContext">;
  model: ModelProvider;
}): AnswerDraftOrchestrator {
  return {
    async generateDraft(input) {
      const question = input.question.trim();
      if (question.length === 0) {
        throw new Error("question must not be blank");
      }

      const context = await contextBuilder.buildContext({
        queryText: question,
        liveChatMessages: input.liveChatMessages,
        fragmentLimit: input.fragmentLimit,
        liveChatLimit: input.liveChatLimit,
      });

      const modelResult = await model.generateAnswerDraft({
        question,
        promptContext: context.promptContext,
      });
      const answerText = modelResult.answerText.trim();
      if (answerText.length === 0) {
        throw new Error("model answer draft must not be blank");
      }

      return toAnswerDraftResult(answerText, context);
    },
  };
}

function toAnswerDraftResult(
  answerText: string,
  context: DocumentRetrievalContextResult,
): AnswerDraftResult {
  return {
    answerText,
    promptContext: context.promptContext,
    allowedFragments: context.allowedFragments,
    deniedDocumentIds: context.deniedDocumentIds,
    retrievedFragmentCount: context.retrievedFragmentCount,
  };
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-orchestrator.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit orchestrator**

Run:

```powershell
git add apps/core/src/agent/answer-draft-orchestrator.ts apps/core/tests/answer-draft-orchestrator.test.ts
git commit -m "feat: add answer draft orchestrator"
```

Expected: commit succeeds.

## Task 2: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Python worker tests**

Run from `workers/ai`:

```powershell
python -m pytest
```

Expected: PASS.

- [ ] **Step 4: Validate Docker Compose**

Run:

```powershell
docker compose config
```

Expected: resolved compose config prints successfully.

- [ ] **Step 5: Push branch and update PR**

Run:

```powershell
git push origin codex/iris-document-source-registry
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR #3 remains open and mergeable.

## Self-Review Checklist

- The orchestrator does not call a real model provider.
- The orchestrator does not send Feishu messages.
- It always goes through `DocumentRetrievalContextBuilder`.
- Blank user questions and blank model output are rejected.
- Tests are deterministic and offline.
