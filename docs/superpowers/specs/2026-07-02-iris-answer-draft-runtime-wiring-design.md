# Iris Answer Draft Runtime Wiring Design

Date: 2026-07-02
Status: Phase 2J approved design
Product name: Iris

## 1. Purpose

Phase 2J wires the answer draft stack into runtime when explicitly enabled.

Phase 2I exposed `POST /internal/answer-drafts`, but the app only used an injected fake or externally provided orchestrator. Phase 2J adds a runtime composer that can create the real answer draft dependency graph from environment config: Postgres-backed fragment repository, OpenAI-compatible model provider, answer-time context builder, and answer draft orchestrator.

This phase still does not send messages to Feishu. It makes the internal draft API capable of real execution only when the operator opts in through explicit configuration.

## 2. Design Goals

Phase 2J must provide:

- explicit runtime enable flag;
- conservative config validation;
- runtime composer for answer draft dependencies;
- no silent fallback to unsafe permissions;
- no hidden model or database startup if disabled;
- clear `undefined` result when runtime is disabled;
- deterministic tests with fake dependency factories;
- unchanged injected orchestrator behavior for tests and future callers.

The internal API should continue returning `503` when no orchestrator is configured or composed.

## 3. Out Of Scope

This phase does not implement:

- real Feishu live permission API checks;
- internal API authentication;
- Feishu replies;
- background jobs;
- streaming;
- retry and provider observability;
- admin UI.

Those features remain future phases.

## 4. Configuration

Add answer draft runtime config to `apps/core/src/config/env.ts`.

Environment variables:

- `IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS`: must be `true` to enable runtime composition.
- `IRIS_INTERNAL_DRAFT_PERMISSION_MODE`: Phase 2J supports only `allow-indexed`.

Existing required variables when enabled:

- `DATABASE_URL`;
- `IRIS_MODEL_PROVIDER=openai-compatible`;
- `IRIS_MODEL_BASE_URL`;
- `IRIS_MODEL_API_KEY`;
- `IRIS_MODEL_NAME`;
- optional `IRIS_MODEL_TIMEOUT_MS`.

If `IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS` is absent or not `true`, runtime composition returns undefined.

If enabled, missing database/model config should throw during composition. This is intentional: explicit enablement means misconfiguration should be visible.

`allow-indexed` is an internal development mode. It allows retrieved indexed fragments through the permission guard by returning true for source ids. It must be documented as not a substitute for Feishu live permission checks.

## 5. Runtime Composer

Create:

```text
apps/core/src/runtime/answer-draft-runtime.ts
```

Primary function:

```ts
createAnswerDraftRuntime(env?: EnvLike): AnswerDraftRuntime | undefined
```

Runtime output:

```ts
type AnswerDraftRuntime = {
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft">;
  close(): Promise<void>;
};
```

When enabled, compose:

```text
read database config
-> create Postgres pool
-> create DocumentFragmentRepository
-> create OpenAICompatibleModelProvider
-> create DocumentRetrievalContextBuilder
-> create AnswerDraftOrchestrator
```

The query embedder in Phase 2J can reuse the OpenAI-compatible provider only for answer generation? No. Embedding still needs an `EmbeddingProvider`. Because Phase 2H implemented chat completions only, Phase 2J should use an explicit deterministic development query embedder only when `IRIS_INTERNAL_DRAFT_PERMISSION_MODE=allow-indexed`.

To keep the runtime useful without pretending to have production embeddings, Phase 2J should create a `StaticQueryEmbeddingProvider` that returns a 6-dimensional query vector. This matches Phase 2E's `vector(6)` test schema and makes runtime wiring testable. It must be marked internal/development only. A real embedding provider is a future phase.

## 6. App Integration

`buildApp()` should preserve existing dependency injection behavior:

1. If `dependencies.answerDraftOrchestrator` is provided, use it.
2. Else call `createAnswerDraftRuntime()`.
3. If runtime returns an orchestrator, use it for `/internal/answer-drafts`.
4. Else route returns `503` as today.

`buildApp()` should not force runtime composition during tests when an orchestrator is injected.

The app should expose runtime cleanup:

```ts
app.addHook("onClose", async () => {
  await answerDraftRuntime?.close();
});
```

## 7. Testing Strategy

Unit tests should cover:

- runtime config returns disabled when flag is missing;
- runtime config parses enabled `allow-indexed` mode;
- runtime config rejects unsupported permission mode;
- runtime composer returns undefined when disabled;
- runtime composer creates orchestrator and closes pool when enabled using fake factories;
- `buildApp()` does not compose runtime when orchestrator is injected;
- `buildApp()` can use composed runtime when no orchestrator is injected.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 8. Future Integration Points

Phase 2K can add one of:

- real embedding provider adapter;
- Feishu live permission checker;
- internal API authentication;
- model/runtime observability;
- confirmation-gated Feishu reply action.

Recommended next phase after 2J:

> Replace `allow-indexed` development permission mode and static query embeddings with real Feishu permission checks and a real embedding provider before exposing the draft API beyond trusted internal development use.
