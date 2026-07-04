# Iris Runtime Control Audit Design

## Goal

Make global, group, and capability runtime-control changes visible through the existing internal
audit event surface. During a 20-30 person rollout, operators need to answer "who changed the
operating state?" even before a full admin console and durable audit store exist.

## Architecture

Extend the in-memory audit event union with `runtime_control_updated`. The event keeps the existing
`documentId` and `fragmentIds` fields for read-side compatibility:

- `documentId: "runtime-control"`
- `fragmentIds: []` at runtime, typed as the existing `string[]` field for audit-log compatibility
- `runtimeControlScope`: `global`, `group`, or `capability`
- `targetId`: group ID or capability name when applicable
- `enabled`: requested next value
- `previousEnabled`: value before the mutation
- `operatorHint`: optional trimmed `X-Iris-Operator` header value

Record the audit event after a runtime-control mutation request is validated and applied. Capability
updates record one event per changed capability so operators can inspect each flag independently.
The optional operator hint is a diagnostic label, not an authenticated identity or authorization
input.

Audit writes are best-effort. Runtime control is an emergency operator surface; a broken audit sink
must not prevent globally disabling Iris.

## Invariants

- Invalid runtime-control requests do not record audit events.
- Successful global, group, and capability changes record `runtime_control_updated`.
- `GET /internal/audit/events?type=runtime_control_updated` returns these events.
- `X-Iris-Operator` may populate `operatorHint`, but missing or invalid hints do not block mutation.
- `GET /internal/audit/events?...&operatorHint=<value>` filters raw audit events by the same
  sanitized operator hint value.
- `GET /internal/audit/events/summary?...&operatorHint=<value>` uses the same filter before
  grouping summaries.
- Audit write failures do not change the runtime-control API response or mutation result.
- This remains in-memory until the later durable admin/audit phase.

## Out Of Scope

- Authenticated actor identity in audit events.
- Persistent audit storage.
- A dedicated runtime-control audit endpoint.
- Retrying failed audit writes.
