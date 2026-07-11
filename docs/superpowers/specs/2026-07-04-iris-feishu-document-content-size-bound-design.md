# Iris Feishu Document Content Size Bound Design

## Goal

Prevent an oversized Feishu document raw-content response from being stored, chunked, embedded, or
passed into Iris answer context during the initial internal rollout.

## Architecture

Add a configurable max document content size to the Feishu OpenAPI configuration:

- Environment variable: `IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS`
- Default: `2000000`
- Validation: positive safe integer

`createFeishuDocumentBodyFetcher` receives `maxContentChars` and rejects trimmed raw content whose
length exceeds the configured value. The rejection is an ordinary fetch failure, so
`DocumentSyncRunner` already records a failed snapshot and marks the source `failed`; operators can
later adjust the limit and manually re-enqueue the source.

The core bound is applied after JSON parsing and after trimming the content string. A later
increment adds a `content-length` preflight for raw-content responses that are obviously too large
before parsing. It still does not solve full streaming protection for chunked or missing-length HTTP
JSON bodies; that remains a future improvement. It does prevent oversized document text from
entering snapshots, chunking, embedding, retrieval, or prompt assembly.

## Invariants

- Normal Feishu document raw content below the limit still syncs.
- Oversized raw content fails with a clear error before returning `DocumentBodyFetchResult`.
- Invalid content-size configuration fails during startup/config reading.
- Document sync runtime passes the configured value into the Feishu body fetcher.
- The internal rollout runbook documents the default and override variable.

## Out Of Scope

- Streaming JSON response size enforcement before `response.json()`.
- Per-space, per-source, or per-group content limits.
- Partial ingestion or truncation of oversized documents.
- Changing document chunking or embedding batch behavior.
