# Iris Audit Zero-Limit Regression Design

## Goal

Lock down the audit API behavior for `limit=0`. This is a small but important diagnostic edge case: operators should be able to ask for a zero-sized window and receive an empty result with accurate metadata, not accidentally receive every retained event because of JavaScript `slice(-0)` behavior.

## Scope

This phase adds regression tests only. The production implementation already handles this behavior through the shared audit query diagnostics helper and `InMemoryAuditLog.summarizeRecent`.

Covered endpoints:

- `GET /internal/audit/events?limit=0`
- `GET /internal/audit/events/summary?limit=0`

## Expected Behavior

Both endpoints return:

- `inspectedEventCount: 0`
- `matchingEventCount: 0`
- empty result arrays
- `retainedEventCount` still reporting the number of audit events held in memory

## Quality Bar

The tests protect a subtle edge case that can make internal diagnostics misleading. They do not change runtime behavior.
