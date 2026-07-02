# Iris Reindex Runtime and API Design

Date: 2026-07-02
Status: Phase 2P proposed design
Product name: Iris

## 1. Purpose

Phase 2N introduced the document reindex planner and worker. Phase 2O added a Redis-backed queue, an automatic worker polling loop, runtime configuration, and an app lifecycle hook.

Phase 2P connects these pieces into a default runtime composer and exposes an internal API for manually enqueueing profile reindex work. After this phase, setting `IRIS_REINDEX_WORKER_ENABLED=true` can create a real background worker from environment-backed Redis, Postgres, embedding provider, and reindex dependencies. Operators can also call an internal endpoint to enqueue missing snapshot/profile work.

The selected direction is option B: runtime composer plus internal manual reindex API.

## 2. Design Goals

Phase 2P must provide:

- a `createReindexWorkerRuntime` composer;
- production wiring for Redis queue, Postgres repositories, semantic indexer, and worker loop;
- an internal `POST /internal/reindex/document-profile` route;
- request validation for `embeddingProfileId` and `limit`;
- clear unavailable/invalid/failure responses;
- no default Redis or Postgres connection unless reindex worker runtime is enabled or explicitly injected;
- deterministic tests with fake dependencies;
- no work added to the Feishu callback acknowledgement path.

The core goal is to make reindexing operational: jobs can be planned through an internal API and consumed by a background loop.

## 3. Out Of Scope

This phase does not implement:

- admin UI;
- progress dashboards;
- worker health endpoint;
- queue depth endpoint;
- Redis Streams or visibility timeout;
- retry counters or dead-letter queue;
- automatic event-to-document-sync-to-reindex wiring;
- Feishu permission refresh during indexing;
- external public API authentication.

The internal API is an application boundary for local/private operation. Public access control can be layered on later.

## 4. Runtime Composer

Add:

```ts
export type ReindexWorkerRuntime = {
  planner: {
    planDocumentProfileReindex(input: {
      embeddingProfileId: string;
      limit: number;
    }): Promise<{ enqueuedCount: number; skippedCount: number }>;
  };
  start(): void;
  close(): Promise<void>;
};
```

Composer:

```ts
createReindexWorkerRuntime({ env, dependencies }): ReindexWorkerRuntime | undefined
```

Behavior:

```text
readReindexWorkerRuntimeConfig(env)
if disabled:
  return undefined

read database config
read embedding provider config
require embedding provider config
require embedding dimensions
assert dimensions are 6 or 1536

create Postgres pool
create Redis client and connect
create embedding profile repository
find or create active embedding profile
create document snapshot repository
create document fragment repository
create RedisDocumentReindexQueue
create DocumentReindexPlanner
create DocumentSemanticIndexer
create DocumentReindexWorker
create DocumentReindexWorkerLoop
return runtime
```

The runtime should not connect Redis when disabled.

## 5. Embedding Profile Resolution

The runtime uses the same embedding provider configuration shape already used by answer drafts:

```text
IRIS_EMBEDDING_PROVIDER=openai-compatible
IRIS_EMBEDDING_BASE_URL=https://api.example.com/v1
IRIS_EMBEDDING_API_KEY=example-key
IRIS_EMBEDDING_MODEL=text-embedding-small
IRIS_EMBEDDING_DIMENSIONS=1536
```

When reindex worker runtime is enabled, `IRIS_EMBEDDING_PROVIDER` and `IRIS_EMBEDDING_DIMENSIONS` are required. The worker must know which profile to index and must use an embedding provider that produces vectors with matching dimensions.

The runtime creates or finds:

```ts
{
  provider: "openai-compatible",
  model: embeddingConfig.model,
  dimensions: embeddingConfig.dimensions,
  displayName: `OpenAI-compatible ${embeddingConfig.model} (${embeddingConfig.dimensions}d)`
}
```

This returns the `embeddingProfileId` used by `DocumentSemanticIndexer`.

## 6. Redis Client Wiring

Use the official `redis` package added in Phase 2O.

Runtime flow:

```text
const redis = createClient({ url: config.redisUrl })
await redis.connect()
```

The app lifecycle hook currently calls `runtime.start()` synchronously. Redis `connect()` is async, so Phase 2P should keep the composer synchronous by creating a lazy queue client that connects on first Redis operation, or make runtime creation return an already constructed runtime whose queue operations await a shared connection promise.

Recommended implementation:

```text
const redisClientPromise = createClient({ url: config.redisUrl }).connect().then(() => client)
queue client methods await redisClientPromise before eval/lPop
close awaits redisClientPromise if it was created, then quits
```

This preserves the existing app lifecycle shape while avoiding unhandled async startup complexity.

## 7. Internal Reindex API

Add:

```http
POST /internal/reindex/document-profile
```

Request:

```json
{
  "embeddingProfileId": "openai-compatible:text-embedding-small:1536",
  "limit": 100
}
```

Validation:

- `embeddingProfileId` must be a non-empty string after trim;
- `limit` must be a positive integer;
- reject extra behavior-changing fields because this endpoint has one job.

Responses:

Runtime unavailable:

```json
HTTP 503
{ "ok": false, "error": "reindex_worker_unavailable" }
```

Invalid request:

```json
HTTP 400
{ "ok": false, "error": "invalid_request" }
```

Success:

```json
HTTP 200
{ "ok": true, "enqueuedCount": 42, "skippedCount": 0 }
```

Planner failure:

```json
HTTP 500
{ "ok": false, "error": "reindex_plan_failed" }
```

## 8. App Wiring

`buildApp` already accepts `createReindexWorkerRuntime` and starts/closes it. Phase 2P changes the default:

```text
dependencies.createReindexWorkerRuntime ?? createReindexWorkerRuntime
```

This means:

- tests can still inject a fake runtime;
- default app startup remains safe because disabled config returns `undefined`;
- enabling the worker through env creates the production runtime.

The route uses the runtime's planner:

```text
if runtime missing:
  503
else:
  runtime.planner.planDocumentProfileReindex(parsedBody)
```

The route only enqueues work. It does not embed, fetch documents, or block on worker completion.

## 9. Error Handling

Composer errors:

- missing database config should throw when runtime is enabled;
- missing embedding config should throw when runtime is enabled;
- unsupported embedding dimensions should throw;
- Redis connection failures should surface when the queue is first used or runtime closes.

Route errors:

- invalid body returns 400;
- unavailable runtime returns 503;
- planner exceptions return 500.

Worker loop errors:

- continue using Phase 2O behavior: call `onError` and keep polling.

## 10. Testing Strategy

Runtime composer tests should cover:

- disabled config returns `undefined`;
- enabled config composes pool, Redis queue, planner, worker loop, and embedding profile;
- missing embedding provider config throws;
- unsupported dimensions throw;
- `close()` closes Redis and Postgres resources.

Route tests should cover:

- unavailable runtime returns 503;
- invalid request returns 400;
- valid request calls planner and returns enqueued counts;
- planner failure returns 500.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 11. Product Impact

After Phase 2P:

- Iris has a real opt-in background reindex runtime;
- operators can enqueue missing document/profile embeddings through an internal API;
- the Redis worker loop can consume those jobs automatically;
- the Feishu gateway remains fast and isolated;
- future admin screens and worker health endpoints can attach to a working runtime instead of scaffolding.
