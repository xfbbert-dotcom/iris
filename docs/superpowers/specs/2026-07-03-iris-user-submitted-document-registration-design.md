# Iris User Submitted Document Registration Design

## Goal

Phase 3I adds an internal entry point for registering documents manually provided by users. This covers the third document class from the product framing: documents or links a user explicitly gives Iris.

## Context

The source registry already supports `user_submitted_document`, including the `submittedByUserId` evidence chain. What is missing is a runtime/API path that turns a submitted link into a tracked source and starts document sync.

## Architecture

The document sync runtime exposes:

```ts
registerUserSubmittedDocument(input)
```

It performs:

1. `documentSources.registerUserSubmittedDocument(input)`
2. `manualPlanner.enqueueSource({ documentSourceId: source.id })`

The API route validates input and delegates to the runtime.

## API

```http
POST /internal/document-sync/user-submitted-documents
Content-Type: application/json

{
  "sourceUri": "https://docs.feishu.cn/docx/doc_token",
  "submittedByUserId": "ou_1",
  "title": "Optional title"
}
```

Successful response:

```json
{
  "ok": true,
  "source": { "...": "DocumentSource" },
  "enqueue": {
    "status": "enqueued",
    "documentSourceId": "source-1"
  }
}
```

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `500 user_submitted_document_registration_failed`

## Invariants

- Registration uses source URI deduplication in the registry.
- The source type must be `user_submitted_document` unless an existing higher-priority source already owns the URI.
- The submitting user ID is recorded as evidence.
- The sync enqueue path still goes through the manual planner and does not bypass permission or capability checks.

## Out Of Scope

- Binary file upload.
- OCR or file export.
- Supporting non-Feishu file formats in the body fetcher.
- User-facing UI.
