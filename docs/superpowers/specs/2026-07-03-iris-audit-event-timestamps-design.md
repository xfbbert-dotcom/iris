# Iris Audit Event Timestamps Design

## Context

Iris can now expose recent in-memory audit events, but events do not include a timestamp. During internal debugging, operators need to know whether a permission denial happened just now or came from an earlier test/request.

## Goal

Add `recordedAt` to stored in-memory audit events.

## Behavior

- Callers still pass plain `AuditEvent` objects to `record()`.
- `InMemoryAuditLog` adds `recordedAt` when storing the event.
- `recordedAt` is a `Date` in memory and serializes as an ISO string through the internal audit events API.
- Tests may inject a deterministic `now()` function.
- Existing bounded retention and event cloning behavior remains unchanged.

## Non-Goals

- No persistent audit table.
- No client-provided timestamps.
- No timestamp filtering API.

## Testing

- Unit tests verify `recordedAt` is attached and uses injected `now()`.
- API tests verify `recordedAt` is returned as an ISO string.
