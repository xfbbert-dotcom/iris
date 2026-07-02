# Iris Reindex DLQ Management Design

Date: 2026-07-02
Status: Phase 2S proposed design
Product name: Iris

## 1. Purpose

Phase 2R added bounded retry and dead-letter queue behavior for document reindex jobs. It made failures visible through `deadLetterJobCount`, but operators still cannot inspect, replay, or clear the failed jobs.

Phase 2S closes that operational loop by adding internal DLQ management APIs for reindex jobs.

The selected direction is option A: DLQ list, replay, and delete APIs, without building an admin UI in this phase.

## 2. Design Goals

Phase 2S must provide:

- DLQ item listing for recent failed reindex jobs;
- stable IDs for newly dead-lettered jobs;
- replay of a single DLQ item back to the main queue;
- deletion of a single DLQ item;
- batch replay of multiple DLQ items;
- compatibility with old Phase 2R DLQ payloads that do not have IDs;
- deterministic unit tests for in-memory and Redis queue implementations;
- internal HTTP API coverage;
- no dependency on a live Redis server for unit tests.

The product goal is simple: when Iris cannot reindex a document after retries, an operator should be able to see what failed and decide whether to try again or clear the failure.

## 3. Dead-Letter Payload

Phase 2R stored:

```ts
{
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: string;
}
```

Phase 2S stores new payloads as:

```ts
{
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: string;
}
```

The ID is generated when a job enters the DLQ. It is opaque and only needs to be stable for that DLQ item.

Old DLQ payloads without `id` remain listable. The list operation exposes a deterministic compatibility ID derived from the payload position and content hash, but replay and delete only support items that have stored IDs. This avoids unsafe mutation when the stored item cannot be uniquely identified.

## 4. Queue Contract

Extend `DocumentReindexQueue` with DLQ management methods:

```ts
listDeadLetters(input: {
  limit: number;
}): Promise<DocumentReindexDeadLetter[]>;

replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;

deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;

replayDeadLetters(input: {
  ids: string[];
}): Promise<{
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
}>;
```

`DocumentReindexDeadLetter`:

```ts
{
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
  replayable: boolean;
}
```

`replayable` is `false` for legacy items without stored IDs.

## 5. Replay Semantics

Replay means:

```text
remove item from DLQ
reset job.attempts to 0
push job to the main reindex queue
return replayed
```

Replay must not use the original first-enqueue idempotency set. The job already passed through the main queue before it reached DLQ; replay is an explicit operator action and must be allowed.

If queue push fails after DLQ removal in Redis, the operation may return an error to the HTTP layer. Phase 2S does not introduce a two-phase transaction or Lua-based atomic replay. That hardening can be added if replay becomes frequent or high-risk.

## 6. Delete Semantics

Delete means:

```text
remove item from DLQ
return deleted
```

Delete does not remove document snapshots, fragments, document sources, or prior audit records. It only clears the failed reindex job from DLQ.

## 7. Redis Storage

Use the existing Redis DLQ list key:

```text
iris:reindex:documents:dlq
```

Redis listing reads a bounded range:

```text
LRANGE dlq 0 limit-1
```

Redis delete/replay finds the stored payload by ID, removes exactly one matching payload with:

```text
LREM dlq 1 payload
```

Replay then pushes the reset job to:

```text
RPUSH queue <job with attempts 0>
```

This is intentionally simple for v1. If duplicate IDs somehow exist, only the first matching payload should be removed.

## 8. Internal APIs

Add internal routes:

```http
GET /internal/reindex/dead-letters?limit=20
POST /internal/reindex/dead-letters/:id/replay
DELETE /internal/reindex/dead-letters/:id
POST /internal/reindex/dead-letters/replay
```

Disabled runtime response:

```json
HTTP 503
{
  "ok": false,
  "error": "reindex_worker_unavailable"
}
```

List response:

```json
HTTP 200
{
  "ok": true,
  "deadLetters": [
    {
      "id": "dlq_abc",
      "job": {
        "idempotencyKey": "reindex:profile:snapshot",
        "embeddingProfileId": "profile",
        "documentSnapshotId": "snapshot",
        "reason": "manual_profile_reindex",
        "enqueuedAt": "2026-07-02T01:00:00.000Z",
        "attempts": 3
      },
      "errorMessage": "embedding failed",
      "failedAt": "2026-07-02T01:05:00.000Z",
      "replayable": true
    }
  ]
}
```

Single replay response:

```json
HTTP 200
{
  "ok": true,
  "status": "replayed"
}
```

Delete response:

```json
HTTP 200
{
  "ok": true,
  "status": "deleted"
}
```

Batch replay response:

```json
HTTP 200
{
  "ok": true,
  "replayedCount": 2,
  "notFoundIds": [],
  "unsupportedLegacyIds": []
}
```

Invalid request response:

```json
HTTP 400
{
  "ok": false,
  "error": "invalid_request"
}
```

Unexpected queue failure response:

```json
HTTP 500
{
  "ok": false,
  "error": "reindex_dead_letter_operation_failed"
}
```

## 9. Runtime Boundary

Extend `ReindexWorkerRuntime` with:

```ts
deadLetters: {
  list(input: { limit: number }): Promise<DocumentReindexDeadLetter[]>;
  replay(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  delete(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
  replayBatch(input: { ids: string[] }): Promise<{
    replayedCount: number;
    notFoundIds: string[];
    unsupportedLegacyIds: string[];
  }>;
};
```

The app routes use this runtime boundary. The worker loop does not need to know about management APIs.

## 10. Error Handling

Invalid limits:

- non-numeric, non-integer, or negative limits return `400 invalid_request`;
- omitted limit defaults to 20;
- limits above 100 are capped at 100.

Invalid IDs:

- blank single IDs return `400 invalid_request`;
- empty batch ID lists return `400 invalid_request`;
- batch lists above 100 IDs return `400 invalid_request`.

Not found and unsupported legacy IDs are not server errors. They return successful HTTP responses with explicit status values.

## 11. Out Of Scope

This phase does not implement:

- Admin Console UI;
- DLQ search by document ID;
- DLQ pagination cursors;
- Redis Lua atomic replay;
- replay scheduling or delayed retry;
- alerting;
- audit-log persistence for replay/delete operations;
- authentication changes for internal routes.

These can layer on top of the management boundary later.

## 12. Testing Strategy

Queue tests:

- new dead-letter payloads include IDs;
- in-memory DLQ list returns bounded recent items;
- in-memory replay removes DLQ item and pushes reset job to queue;
- in-memory delete removes DLQ item;
- Redis list uses `LRANGE`;
- Redis replay removes a matching payload and pushes a reset job;
- Redis delete removes a matching payload;
- legacy DLQ items are listable but not replayable or deletable.

Runtime tests:

- runtime exposes DLQ management methods through the queue.

Route tests:

- missing runtime returns `503 reindex_worker_unavailable`;
- list returns serialized DLQ items;
- replay returns status;
- delete returns status;
- batch replay returns counts and ID lists;
- invalid requests return `400 invalid_request`;
- thrown runtime errors return `500 reindex_dead_letter_operation_failed`.

Final verification:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 13. Product Impact

After Phase 2S:

- Iris operators can inspect failed reindex jobs;
- transient failures that reached DLQ can be retried manually;
- stale failures can be cleared;
- future Admin Console work can consume real management APIs instead of inventing new backend behavior.
