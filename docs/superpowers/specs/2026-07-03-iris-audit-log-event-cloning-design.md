# Iris Audit Log Event Cloning Design

## Context

`InMemoryAuditLog` now has bounded retention, but it still stores the same event object passed to `record()`. If a caller mutates `fragmentIds` after recording, the stored audit event changes too.

Audit records should be evidence. They must not be accidentally changed through shared object references.

## Goal

Clone audit events on write so in-memory audit history is isolated from caller-side mutation.

## Behavior

- `record(event)` stores a copy of the event.
- `fragmentIds` is copied into a new array.
- Optional `message` is preserved.
- Retention behavior remains unchanged.

## Non-Goals

- No deep clone utility.
- No timestamp or persistent audit storage.
- No API response changes.

## Testing

Add a focused test that records an event, mutates the original event and its `fragmentIds`, and verifies `auditLog.events[0]` keeps the original values.
