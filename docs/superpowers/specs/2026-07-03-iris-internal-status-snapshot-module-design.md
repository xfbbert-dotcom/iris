# Iris Internal Status Snapshot Module Design

## Problem

The internal status snapshot builder now owns schema version, aggregate health, summary lists, component ordering, and component-level status derivation. Keeping that logic inside `app.ts` makes the HTTP app entrypoint harder to maintain and leaves the derivation rules coupled to a broad API test file.

## Decision

Move snapshot derivation into `src/admin/internal-status-snapshot.ts` and export `buildInternalStatusSnapshot`.

`app.ts` remains responsible for collecting live component statuses. The admin module is responsible for turning a component map and generation time into the status response shape.

## Testing

Add `tests/internal-status-snapshot.test.ts` to cover the pure builder directly. The existing `/internal/status` API tests remain in place to verify route integration.

## Quality Bar

- API response shape remains unchanged.
- Snapshot derivation has focused unit coverage.
- `app.ts` no longer contains component summary/status derivation helpers.
