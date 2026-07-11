# Iris Internal API Token Hardening Design

## Context

Iris exposes `/internal/*` endpoints for the first 20-30 person rollout. These routes can be
protected with `IRIS_INTERNAL_API_TOKEN`, but the current request parser accepts any whitespace
between `Bearer` and the token. That makes the boundary less explicit than the rollout runbook
describes.

## Decision

Keep the v1 deployment model unchanged: internal authentication remains optional for local
development and required whenever Core is reachable outside a developer laptop. When a token is
configured, Iris must accept only one clean bearer credential:

- the authorization scheme remains case-insensitive;
- the separator after `Bearer` must be one or more literal spaces;
- the presented token must be a single visible ASCII value with no whitespace or commas;
- a configured token containing whitespace, control characters, or commas is rejected at startup;
- token comparison should avoid early content comparisons once lengths match.

## Data Flow

`buildApp()` normalizes the configured token before routes are registered. The `onRequest` hook
continues to guard `/internal` and `/internal/*` before JSON parsing. Non-internal routes such as
`/health` and `/feishu/events` remain outside this token guard.

## Error Handling

Invalid configured tokens fail fast with a clear configuration error. Invalid or malformed request
headers return the existing `401 internal_api_unauthorized` response so callers do not receive
token-format hints.

## Testing

Add focused API tests that first fail against the current parser:

- `Bearer\toperator-secret` must be rejected.
- `Bearer operator-secret, Bearer other` must be rejected as a combined credential.
- configured tokens with whitespace or commas must throw during app construction.

Run the focused test file, then the full verification suite.
