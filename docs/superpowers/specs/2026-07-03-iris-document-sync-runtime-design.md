# Iris Document Sync Runtime Design

Date: 2026-07-03
Status: Phase 3A design

## Goal

Phase 3A wires the document sync runtime so Iris can consume document sync jobs and fetch Feishu docx/docs bodies through the existing sync runner.

This phase composes existing parts:

- `DocumentSyncQueue`
- `DocumentSyncWorker`
- `DocumentSyncWorkerLoop`
- Postgres document source registry
- Postgres document snapshot repository
- Feishu tenant token provider
- Feishu document body fetcher

## Scope

In scope:

- Add document sync worker runtime config.
- Add `createDocumentSyncRuntime`.
- Use Postgres for document source and snapshot state.
- Use Feishu document body fetcher for docx/docs URLs.
- Expose runtime status with pending job count and latest batch snapshot.
- Keep runtime disabled by default.

Out of scope:

- Redis-backed document sync queue.
- API endpoint for runtime status.
- Startup integration in the main app.
- Wiki/file fetch support.
- Reindex enqueue after successful sync.

## Configuration

New environment variables:

- `IRIS_DOCUMENT_SYNC_WORKER_ENABLED`
- `IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS`, default `1000`
- `IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT`, default `10`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_OPEN_BASE_URL`, default `https://open.feishu.cn`

If the document sync worker is enabled, `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are required.

## Runtime Composition

The runtime creates:

```text
Postgres pool
-> Postgres document source registry
-> Postgres document snapshot repository
-> Feishu tenant access token provider
-> Feishu document body fetcher
-> DocumentSyncRunner
-> in-memory DocumentSyncQueue
-> DocumentSyncWorker
-> DocumentSyncWorkerLoop
```

The queue is intentionally in-memory in this phase. Document registration already enqueues to the event runtime's own in-memory queue today, so this phase is a composition milestone rather than a production durability milestone.

## Status

Runtime status should include:

- enabled
- running
- intervalMs
- batchLimit
- pendingJobCount
- latestBatch

No dead-letter fields are added yet because the queue contract does not support retry/DLQ.

## Constitutional Alignment

This phase moves document body fetching out of Feishu event ingestion and into a dedicated async worker runtime. It preserves the whitepaper separation of Gateway, fact layer, document sync, and answer-time permission enforcement.
