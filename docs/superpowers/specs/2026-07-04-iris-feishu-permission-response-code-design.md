# Iris Feishu Permission Response Code Design

## Context

The live Feishu permission guard is the final gate before document fragments enter answer prompts.
The current checker treats an HTTP 200 response with a missing Feishu `code` field as successful.
That can accidentally allow malformed upstream responses into model context instead of surfacing a
`permission_guard_error` audit event.

## Decision

Keep the existing permission semantics:

- HTTP 403 and 404 remain explicit deny/not-found outcomes and return `false`.
- Non-OK responses other than 403/404 remain transient failures and throw.
- HTTP 200 responses with `code: 0` remain successful.
- HTTP 200 responses with a numeric non-zero `code` remain fail-closed as `false`.
- HTTP 200 responses that are not objects, or that omit a numeric `code`, must throw as malformed
  permission responses.

This patch intentionally does not classify individual Feishu business error codes. That can be a
separate decision once we pin official Feishu code tables for the document and wiki APIs.

## Data Flow

`createFeishuDocumentPermissionChecker()` calls the wiki node endpoint for wiki URLs and the docx
metadata endpoint for direct document URLs. Both paths pass through the same success response
reader, so malformed successful responses fail closed before any document ID is trusted or any
fragment is allowed.

## Error Handling

Malformed successful responses throw `Feishu document permission response did not include code`.
The existing answer-time permission guard catches thrown checker errors, excludes the fragments, and
records `permission_guard_error` when an audit log is available.

## Testing

Add focused tests for:

- direct doc metadata returning HTTP 200 without `code`;
- wiki node resolution returning HTTP 200 without `code`, ensuring metadata is not checked after a
  malformed wiki response.

Run focused permission checker tests, then the full verification suite.
