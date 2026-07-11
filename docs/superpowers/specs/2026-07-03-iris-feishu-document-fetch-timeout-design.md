# Iris Feishu Document Fetch Timeout Design

## Context

Iris document sync reads Feishu document bodies through `createFeishuDocumentBodyFetcher`. Model and embedding provider calls already use `AbortController` timeouts, but Feishu wiki-node lookup and raw-content fetches do not. If Feishu OpenAPI or the network stalls, a document sync worker can remain occupied by one external request instead of failing the job and allowing the queue policy to handle retry/dead-letter behavior.

## Decision

Add an explicit timeout to Feishu document body fetches:

- `createFeishuDocumentBodyFetcher` accepts `timeoutMs`, defaulting to `10000`.
- The wiki-node lookup and raw-content request both pass an `AbortSignal` to `fetch`.
- `AbortError` is mapped to stable, operation-specific errors:
  - `Feishu wiki node request timed out`
  - `Feishu document raw content request timed out`
- Runtime configuration exposes `IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS`, also defaulting to `10000`, and passes it into the fetcher.

## Scope

This does not add retries, change queue semantics, or change document source state transitions. A timed-out fetch remains a normal document sync fetch failure; existing worker and queue retry behavior decides what happens next.

## Quality Bar

Focused tests must prove direct raw-content requests and wiki-node lookups receive abort signals and report timeout errors. Runtime/config tests must prove the timeout is configurable and wired into document sync runtime composition. Full verification must run before commit and push.
