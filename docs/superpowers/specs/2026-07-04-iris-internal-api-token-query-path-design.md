# Iris Internal API Token Query Path Design

## Goal

Keep the internal operator API protection boundary exact when requests include query strings. A
token-protected Core instance should reject `/internal` probes before route lookup even when the
request URL is `/internal?probe=1`.

## Architecture

The Fastify `onRequest` token guard continues to run before body parsing. Before deciding whether a
request is internal, Core derives the request path by stripping the query string from
`request.url`. The guard then protects the normalized path when it is exactly `/internal` or starts
with `/internal/`.

This keeps `/internal/status?details=1` and `/internal?probe=1` under the same token boundary while
leaving `/health` and `/feishu/events` outside the shared internal token guard.

## Invariants

- Token-protected `/internal/*` requests with query strings require `Authorization: Bearer <token>`.
- Token-protected `/internal` root probes with query strings return the same 401 shape as other
  unauthorized internal requests.
- Path normalization only strips the query string; it does not broaden the guard to non-internal
  routes.
- `/health` and `/feishu/events` remain unauthenticated by `IRIS_INTERNAL_API_TOKEN`.

## Out Of Scope

- A route handler for `/internal`.
- Admin identity and role-based authorization.
- Rate limiting or probe throttling.
