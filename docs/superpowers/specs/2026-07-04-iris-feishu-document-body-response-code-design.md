# Iris Feishu Document Body Response Code Design

## Context

Iris syncs Feishu document bodies into snapshots before reindexing. The current body fetcher accepts
HTTP 200 responses that omit Feishu's numeric `code` field when the rest of the body contains a wiki
node token or raw document content. That can turn malformed upstream responses into trusted
document snapshots.

## Decision

Require a numeric Feishu `code` on successful wiki-node and raw-content responses:

- `code: 0` is required before wiki node metadata or raw document content is trusted.
- numeric non-zero `code` keeps the existing explicit Feishu error handling.
- missing or non-numeric `code` throws a malformed-response error.
- non-OK HTTP responses keep the existing status-based errors.

This is a read-quality and safety guard: if Feishu gives Iris an unexpected shape, Iris should fail
the sync job and leave a diagnosable document-sync error instead of indexing uncertain content.

## Data Flow

Direct docx/docs URLs call the raw-content endpoint and then parse content. Wiki URLs first resolve
the wiki node into a document token and then call raw content. Both response readers now require
`code: 0` before returning values.

## Error Handling

Missing code errors are specific:

- `Feishu wiki node response did not include code`
- `Feishu document raw content response did not include code`

Existing timeout, invalid JSON, non-OK HTTP, non-zero code, unsupported wiki object type, and empty
content behavior remains unchanged.

## Testing

Add focused body-fetcher tests for:

- direct raw content response with content but no `code`;
- wiki node response with node data but no `code`, confirming raw content is not fetched.

Run focused body-fetcher tests, then the full verification suite.
