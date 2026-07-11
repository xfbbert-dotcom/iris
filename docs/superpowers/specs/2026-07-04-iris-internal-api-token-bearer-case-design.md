# Iris Internal API Token Bearer Case Design

## Goal

Make internal API authorization tolerant of standard HTTP authorization scheme casing without
weakening the shared secret check. Operator tools may send `bearer <token>` instead of
`Bearer <token>`, and Iris should treat both as the same bearer scheme.

## Architecture

The internal API token guard parses the `Authorization` header as a bearer credential. The scheme
comparison is case-insensitive, while the credential value remains an exact string match against
`IRIS_INTERNAL_API_TOKEN`.

This keeps common HTTP client behavior compatible with Iris while preserving the core invariant:
only the configured shared secret authorizes `/internal/*` requests.

## Invariants

- `Authorization: Bearer <token>` authorizes internal requests.
- `Authorization: bearer <token>` also authorizes internal requests.
- Wrong or missing credentials still return `401 { "ok": false, "error": "internal_api_unauthorized" }`.
- The token value is not lowercased, trimmed, or otherwise normalized during comparison.

## Out Of Scope

- Multiple authentication schemes.
- Token rotation.
- Per-user admin identity.
