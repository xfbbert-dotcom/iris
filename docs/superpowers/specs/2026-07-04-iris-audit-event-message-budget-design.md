# Iris Audit Event Message Budget Design

## Goal

Prevent oversized permission-check diagnostics from bloating audit events and internal audit APIs.

## Architecture

Add `normalizeAuditEventMessage` as the shared audit-event message boundary. The helper:

- Trims short messages.
- Falls back to `unknown error` for blank messages.
- Truncates oversized messages to `1000` characters with ` ... [truncated]`.

The helper is applied in two places:

- `permission-guard` normalizes permission-check error messages before passing audit events to any
  `AuditLog` implementation.
- `InMemoryAuditLog` normalizes incoming event messages before storing them, protecting direct
  callers and future audit producers.

## Invariants

- Permission filtering remains fail-closed.
- Audit recording remains best-effort and cannot block permission filtering.
- Short audit messages remain unchanged except for trimming.
- Audit retention, summary grouping, and event ordering are unchanged.

## Out Of Scope

- Redacting secret patterns inside audit messages.
- Bounding audit `documentId`, `operatorHint`, or `fragmentIds`.
- Changing audit retention limits or persistence backend design.
- Adding durable audit storage.
