# Iris Answer Draft Permission Audit Design

## Context

The permission guard can already write audit events for denied documents and permission-check errors. The composed answer draft runtime does not pass an audit log into the context builder, so source-policy denials are only visible as `deniedDocumentIds` in the response.

For an internal 20-30 person deployment, the first audit step should be small: preserve the existing request behavior, but allow operators and tests to capture why document fragments were excluded.

## Goal

Wire an optional `AuditLog` into `createAnswerDraftRuntime()` so permission guard denials/errors are recorded during answer draft context assembly.

## Non-Goals

- No new persistent audit table.
- No console logging.
- No API response shape change.
- No Feishu live permission API calls.

## Behavior

When `dependencies.auditLog` is provided to `createAnswerDraftRuntime()`, the runtime passes it to `createDocumentRetrievalContextBuilder()`.

The existing permission guard then records:

- `permission_guard_denied` when `canReadDocument()` returns `false`;
- `permission_guard_error` when `canReadDocument()` throws.

No audit events are recorded when no audit log is configured.

## Testing

Add a runtime test that uses `source-policy`, injects an `InMemoryAuditLog`, and verifies disabled, denied, stale, missing, and lookup-error sources generate audit events while the allowed fragment remains in prompt context. Source-registry lookup errors are `permission_guard_error`; ordinary local policy exclusions are `permission_guard_denied`.
