# Iris Authorized Wiki Document Registration Design

## Goal

Phase 3H adds an internal entry point for registering a Feishu knowledge-base/wiki document that an administrator has authorized Iris to read. After registration, Iris should enqueue the source for document sync so it can become available for semantic retrieval.

## Context

The document source model already supports `authorized_wiki_document`, and the Feishu document body fetcher already permits that source type for docx/docs URLs. The missing product surface is an operational API that turns an authorized wiki document into a tracked source and starts the sync pipeline.

## Architecture

The document sync runtime owns this operation because it already composes:

- the Postgres document source registry;
- the Redis document sync queue;
- the manual document sync planner.

The runtime exposes:

```ts
registerAuthorizedWikiDocument(input)
```

It performs two steps:

1. `documentSources.registerAuthorizedWikiDocument(input)`
2. `manualPlanner.enqueueSource({ documentSourceId: source.id })`

The API route stays thin and only validates request shape.

## API

```http
POST /internal/document-sync/authorized-wiki-documents
Content-Type: application/json

{
  "sourceUri": "https://docs.feishu.cn/docx/doc_token",
  "authorizedSpaceId": "space-1",
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
- `500 authorized_wiki_document_registration_failed`

## Invariants

- Registration uses source URI deduplication in the registry.
- The source type must be `authorized_wiki_document`.
- Registration should not bypass the manual enqueue planner's permission/capability checks.
- This phase registers one explicitly authorized document at a time.

## Out Of Scope

- Crawling all pages in a wiki space.
- Feishu wiki node traversal.
- Permission grant UI.
- User-submitted file upload parsing.
