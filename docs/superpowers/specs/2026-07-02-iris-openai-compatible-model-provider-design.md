# Iris OpenAI-Compatible Model Provider Design

Date: 2026-07-02
Status: Phase 2H approved design
Product name: Iris

## 1. Purpose

Phase 2H adds Iris's first real model provider adapter behind the `ModelProvider` interface.

Phase 2G introduced `AnswerDraftOrchestrator`, which can generate a draft through a replaceable `ModelProvider`. Phase 2H implements an OpenAI-compatible chat completions adapter so Iris can generate real answer drafts from safe prompt context without coupling the orchestrator to a specific vendor.

This phase still does not send messages to Feishu. It only makes answer draft generation capable of using a configured model provider.

## 2. Design Goals

Phase 2H must provide:

- OpenAI-compatible `/chat/completions` model provider;
- environment-driven provider configuration;
- no hard-coded API keys;
- request timeout support;
- deterministic tests with fake `fetch`;
- clear errors for missing config, HTTP failures, malformed responses, and empty model output;
- no changes to `AnswerDraftOrchestrator` contract.

The adapter should be generic enough for OpenAI-compatible providers such as OpenAI, DeepSeek, SiliconFlow, local vLLM, or other compatible gateways.

## 3. Out Of Scope

This phase does not implement:

- streaming responses;
- tool calling;
- JSON mode;
- multimodal input;
- retries and backoff;
- provider-specific SDKs;
- Feishu sending;
- model selection UI;
- cost tracking.

Those features can be added behind the same `ModelProvider` boundary later.

## 4. Configuration

Add model provider config readers in `apps/core/src/config/env.ts`.

Environment variables:

- `IRIS_MODEL_PROVIDER`: provider kind. Phase 2H supports `openai-compatible`.
- `IRIS_MODEL_BASE_URL`: base URL, for example `https://api.openai.com/v1`.
- `IRIS_MODEL_API_KEY`: bearer token.
- `IRIS_MODEL_NAME`: model name.
- `IRIS_MODEL_TIMEOUT_MS`: optional request timeout. Default: `30000`.

Blank strings should be treated as missing values, matching existing Feishu config behavior.

The config reader should return undefined when `IRIS_MODEL_PROVIDER` is missing. If `IRIS_MODEL_PROVIDER=openai-compatible`, base URL, API key, and model name are required.

## 5. Provider Contract

The adapter implements the Phase 2G `ModelProvider` interface:

```ts
export interface ModelProvider {
  generateAnswerDraft(input: {
    question: string;
    promptContext: string;
  }): Promise<{ answerText: string }>;
}
```

The adapter should call:

```text
POST <baseUrl>/chat/completions
Authorization: Bearer <apiKey>
Content-Type: application/json
```

Body:

```json
{
  "model": "<model>",
  "messages": [
    {
      "role": "system",
      "content": "You are Iris..."
    },
    {
      "role": "user",
      "content": "Question:\n...\n\nContext:\n..."
    }
  ],
  "temperature": 0.2
}
```

The system instruction should emphasize:

- answer only from the provided safe context;
- acknowledge uncertainty;
- do not reveal denied or unavailable content;
- write as Iris, a company AI assistant.

## 6. Response Handling

The adapter should parse the first choice:

```text
choices[0].message.content
```

It must throw when:

- request times out;
- fetch fails;
- response status is not 2xx;
- response JSON cannot be parsed;
- `choices[0].message.content` is missing or blank.

The returned `answerText` should be trimmed.

## 7. Testing Strategy

Unit tests should cover:

- config reader returns undefined when model provider is missing;
- config reader trims values and parses timeout;
- config reader rejects incomplete openai-compatible config;
- provider sends expected URL, headers, and body;
- provider trims answer text;
- provider throws on non-2xx status;
- provider throws on malformed response;
- provider aborts through timeout signal.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 8. Future Integration Points

Phase 2I can add one of:

- wiring configured provider into app runtime;
- answer citations and model prompt policy refinement;
- Feishu draft review endpoint;
- confirmation-gated Feishu reply action;
- retry/backoff and provider observability.

Recommended next phase after 2H:

> Wire the configured model provider into a runtime answer draft endpoint or internal service, while keeping Feishu sending behind a separate confirmation-gated action layer.
