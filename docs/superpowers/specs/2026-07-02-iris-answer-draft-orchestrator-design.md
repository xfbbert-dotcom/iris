# Iris Answer Draft Orchestrator Design

Date: 2026-07-02
Status: Phase 2G approved design
Product name: Iris

## 1. Purpose

Phase 2G adds Iris's first answer draft orchestration layer.

Phase 2F can build a safe prompt context from a user question, live group chat, retrieved document fragments, and live permission filtering. Phase 2G consumes that context through a replaceable model provider and returns an answer draft with retrieval metadata.

This phase does not send messages to Feishu. It produces a draft answer that later action layers can decide how to use.

Constitutional alignment:

> Agent Orchestrator decides whether Iris should answer, ask a follow-up question, summarize, detect unresolved work, generate a task draft, generate a knowledge draft, or prepare another action.
> Approval & Action Layer gates high-impact actions.

## 2. Design Goals

Phase 2G must provide:

- an `AnswerDraftOrchestrator`;
- a narrow `ModelProvider` interface;
- model input that includes the user question and safe prompt context;
- output containing draft answer text and retrieval metadata;
- deterministic tests with fake context builder and fake model provider;
- no network dependency;
- no Feishu sending side effects.

The orchestrator should be small. It coordinates context building and draft generation; it does not own retrieval internals, permission checks, or message delivery.

## 3. Out Of Scope

This phase does not implement:

- real OpenAI or vendor model calls;
- streaming;
- Feishu message sending;
- proactive trigger decisions;
- approval workflow;
- citation formatting in final Feishu messages;
- moderation;
- memory writing after answers;
- UI.

Those features should attach to this orchestrator through model provider and action-layer boundaries later.

## 4. Core Flow

Answer draft generation follows this order:

```text
question + live chat
-> DocumentRetrievalContextBuilder.buildContext
-> ModelProvider.generateAnswerDraft
-> return answer draft + prompt context + retrieval metadata
```

The orchestrator must not bypass `DocumentRetrievalContextBuilder`, because that builder owns answer-time permission filtering and context anchoring.

## 5. Model Provider Contract

The first model provider interface should be simple:

```ts
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
```

The provider may later be backed by OpenAI, another hosted model, or a local model. Phase 2G tests use fakes.

## 6. Orchestrator Contract

The orchestrator input should include:

- `question`;
- `liveChatMessages`;
- optional `fragmentLimit`;
- optional `liveChatLimit`.

The output should include:

- `answerText`;
- `promptContext`;
- `allowedFragments`;
- `deniedDocumentIds`;
- `retrievedFragmentCount`.

The orchestrator should trim model answer text before returning it. Empty model output is an error.

## 7. Error Handling

The orchestrator must throw when:

- `question.trim()` is empty;
- model output is blank after trimming.

It should let context builder errors and model provider errors surface to the caller. Later phases can add retry and fallback policies once real providers exist.

## 8. Testing Strategy

Unit tests should cover:

- context builder is called with the user question and limits;
- model provider receives the exact prompt context returned by the builder;
- orchestrator returns answer text and retrieval metadata;
- model answer text is trimmed;
- blank questions are rejected before context building;
- blank model output is rejected.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 9. Future Integration Points

Phase 2H can add one of:

- real model provider configuration;
- answer citations;
- answer quality policy and refusal behavior;
- draft review endpoint;
- Feishu reply action with confirmation.

Recommended next phase after 2G:

> Add a real model provider adapter behind the `ModelProvider` interface, while keeping Feishu sending separate from draft generation.
