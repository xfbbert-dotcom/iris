# Iris Internal Answer Draft API Design

Date: 2026-07-02
Status: Phase 2I approved design
Product name: Iris

## 1. Purpose

Phase 2I exposes Iris's answer draft capability through an internal API endpoint.

Phase 2G introduced `AnswerDraftOrchestrator`, and Phase 2H added a real OpenAI-compatible model provider adapter. Phase 2I adds a narrow Fastify route that accepts a question and live chat messages, calls an injected orchestrator, and returns the draft answer plus metadata.

This phase does not wire the full production dependency graph. It creates the API boundary that admin tools, test harnesses, workers, or future Feishu action layers can call.

## 2. Design Goals

Phase 2I must provide:

- `POST /internal/answer-drafts`;
- request validation for question and live chat messages;
- optional `fragmentLimit` and `liveChatLimit`;
- dependency injection for `AnswerDraftOrchestrator`;
- `503` when no orchestrator is configured;
- `500` when orchestrator generation fails;
- deterministic Fastify injection tests with fake orchestrator;
- no Feishu sending side effects.

The route should be internal-only by convention in this phase. Authentication and API gateway policy are out of scope.

## 3. Out Of Scope

This phase does not implement:

- public authentication;
- admin UI;
- production dependency wiring for retrieval and model provider;
- Feishu mention handling;
- Feishu replies;
- approval workflow;
- streaming;
- rate limits.

Those features can attach to the route or action layer later.

## 4. API Contract

Endpoint:

```text
POST /internal/answer-drafts
```

Request:

```json
{
  "question": "What changed?",
  "liveChatMessages": [
    { "speaker": "Alice", "text": "Please answer from context." }
  ],
  "fragmentLimit": 8,
  "liveChatLimit": 20
}
```

Response `200`:

```json
{
  "answerText": "Draft answer.",
  "promptContext": "...",
  "allowedFragments": [
    {
      "id": "fragment-1",
      "documentSourceId": "source-1",
      "documentSnapshotId": "snapshot-1",
      "sourceUri": "https://example.com/doc",
      "chunkIndex": 0,
      "text": "Evidence text",
      "contentHash": "hash",
      "embedding": [1, 0, 0, 0, 0, 0],
      "createdAt": "2026-07-02T01:00:00.000Z",
      "distance": 0.12
    }
  ],
  "deniedDocumentIds": [],
  "retrievedFragmentCount": 1
}
```

Response `400`:

```json
{ "ok": false, "error": "invalid_request" }
```

Response `503`:

```json
{ "ok": false, "error": "answer_draft_orchestrator_unavailable" }
```

Response `500`:

```json
{ "ok": false, "error": "answer_draft_failed" }
```

## 5. Validation

Request validation should require:

- `question` is a non-empty string after trimming;
- `liveChatMessages` is an array;
- each live chat message has non-empty string `speaker` and `text`;
- optional limits are finite numbers when provided.

The route should pass limits through to the orchestrator. The orchestrator and lower layers already sanitize their own limits where needed.

## 6. App Integration

Extend `BuildAppDependencies`:

```ts
answerDraftOrchestrator?: Pick<AnswerDraftOrchestrator, "generateDraft">;
```

When present, the route calls:

```ts
answerDraftOrchestrator.generateDraft({
  question,
  liveChatMessages,
  fragmentLimit,
  liveChatLimit
});
```

When absent, the route returns `503`.

## 7. Testing Strategy

Unit tests should cover:

- valid request calls fake orchestrator and returns draft;
- missing orchestrator returns `503`;
- invalid request returns `400`;
- orchestrator errors return `500`;
- route does not affect Feishu event ingestion behavior.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 8. Future Integration Points

Phase 2J can add one of:

- production wiring for document retrieval context builder and model provider;
- internal authentication;
- admin review UI;
- confirmation-gated Feishu reply action;
- async job handoff for long-running draft generation.

Recommended next phase after 2I:

> Wire the internal answer draft API to real runtime dependencies behind explicit configuration, then add authentication before exposing it beyond local/internal networks.
