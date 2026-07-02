# Iris Document Sync Runtime API Design

Date: 2026-07-03
Status: Phase 3D design

## Goal

Phase 3D wires `DocumentSyncRuntime` into the core app lifecycle and exposes internal status for operators.

## Scope

In scope:

- Compose `DocumentSyncRuntime` during `buildApp`.
- Start it when available.
- Close it during Fastify shutdown.
- Add `GET /internal/document-sync/status`.
- Return disabled status when the runtime is not configured.
- Return `500 document_sync_status_failed` when status lookup fails.

Out of scope:

- Document sync retry/DLQ APIs.
- Manual document sync enqueue APIs.
- Admin source enable/disable APIs.

## API

```text
GET /internal/document-sync/status
```

Disabled response:

```json
{ "ok": true, "enabled": false, "running": false }
```

Enabled response mirrors `DocumentSyncRuntime.getStatus()`:

```json
{
  "ok": true,
  "enabled": true,
  "running": true,
  "intervalMs": 1000,
  "batchLimit": 10,
  "pendingJobCount": 3,
  "latestBatch": {}
}
```

## Constitutional Alignment

This phase makes the async document body sync lane operational and observable. It keeps Feishu ingestion, document sync, and semantic reindexing as separate runtimes while giving operators one more status surface to understand Iris health.
