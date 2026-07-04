# Iris Internal API Token Guard Design

## Goal

Protect Iris internal operator endpoints when Core is reachable through a public Feishu callback
ingress. The first rollout may rely on trusted networking, but Core should support a simple shared
secret guard before a full admin authentication system exists.

## Architecture

Core reads an optional `IRIS_INTERNAL_API_TOKEN` value. When the token is configured:

- every `/internal/*` request must include `Authorization: Bearer <token>`
- the bearer authorization scheme is matched case-insensitively, while the token value is compared
  exactly
- unauthorized internal requests return `401 { "ok": false, "error": "internal_api_unauthorized" }`
- the guard runs before body parsing, so malformed unauthorized JSON still returns 401
- internal route detection strips query strings before matching, so `/internal?probe=1` and
  `/internal/status?details=1` stay inside the same guard boundary
- `/feishu/events` remains available for Feishu callbacks and keeps its existing Feishu signature
  verification path
- `/health` remains unauthenticated for process health checks

When the token is not configured, internal endpoints keep the existing local-development behavior.

## Invariants

- The guard must run before internal route handlers.
- The guard must evaluate the request path before the query string.
- The guard must accept bearer scheme casing variants without normalizing the token value.
- The guard must not affect Feishu event callbacks.
- The guard must not affect `/health`.
- Blank tokens are treated as absent.
- This is a temporary rollout control, not a replacement for a future admin auth system.

## Out Of Scope

- User accounts.
- Role-based access control.
- Token rotation APIs.
- Per-route permissions.
